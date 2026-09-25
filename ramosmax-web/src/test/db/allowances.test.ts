import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import {
  allowanceOf,
  attend,
  calculateAllowances,
  employ,
  payingAccount,
  requestId,
  ugx,
  verify,
} from './workforce-helpers';
import { balanceOf, ledgerDisagreements } from './finance-helpers';

afterAll(closePool);

/** A recent WEDNESDAY, so the working-day rule never gets in the way. */
async function workingDay(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  const { rows } = await db.query<{ d: string }>(
    `select max(d)::text as d
       from generate_series(app.eat_day() - 14, app.eat_day() - 1, interval '1 day') g(d)
      where extract(isodow from g.d) = 3`,
  );
  return rows[0].d;
}

/**
 * Switches the policy to approving an on-time allowance on the spot. Safe to
 * call twice: the second call would be refused as no change.
 */
async function autoApprove(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  await becomeClient(db, SEED.admin);
  await db.expectError(`select app.update_payroll_policy($1::jsonb, 'Approve on the spot')`, [
    JSON.stringify({ allowanceApprovalRequired: false }),
  ]);
  await becomeOwner(db);
}

/** Attendance that has been approved — the only kind that earns an allowance. */
async function approvedDay(
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  staff: string,
  day: string,
  time: string | null = '08:00',
) {
  const record = await attend(db, staff, day, time, time === null ? 'absent' : 'present');
  await verify(db, [record.attendance_id]);
  return record;
}

describe('allowances: who earns one', () => {
  it('gives the policy default to an eligible worker with approved attendance', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await workingDay(db);
      await approvedDay(db, staff, day);
      const rows = await calculateAllowances(db, day);
      const mine = rows.find((r) => r.allowance_id !== null && r.staff_name !== null);
      expect(mine).toBeDefined();
      const allowance = await allowanceOf(db, staff, day);
      expect(ugx(allowance!.calculated_amount_ugx)).toBe(5_000);
    });
  });

  it('uses the salary profile’s own allowance when it has one', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { allowanceUgx: 8_000 });
      const day = await workingDay(db);
      await approvedDay(db, staff, day);
      await calculateAllowances(db, day);
      expect(ugx((await allowanceOf(db, staff, day))!.calculated_amount_ugx)).toBe(8_000);
    });
  });

  it('gives none for attendance that has not been verified', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await workingDay(db);
      await attend(db, staff, day, '08:00');
      await calculateAllowances(db, day);
      expect(await allowanceOf(db, staff, day)).toBeNull();
    });
  });

  it('gives none for an absence', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await workingDay(db);
      await approvedDay(db, staff, day, null);
      await calculateAllowances(db, day);
      expect(await allowanceOf(db, staff, day)).toBeNull();
    });
  });

  it('gives none to someone the profile marks ineligible', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { allowanceEligible: false });
      const day = await workingDay(db);
      await approvedDay(db, staff, day);
      await calculateAllowances(db, day);
      expect(await allowanceOf(db, staff, day)).toBeNull();
    });
  });

  it('gives none to someone with no salary profile at all', async () => {
    await asAdminDb(async (db) => {
      const staff = await makeUser(db, { role: 'worker' });
      const day = await workingDay(db);
      await approvedDay(db, staff, day);
      const rows = await calculateAllowances(db, day);
      expect(rows.some((r) => r.skipped_reason === 'no_salary_profile')).toBe(true);
      expect(await allowanceOf(db, staff, day)).toBeNull();
    });
  });

  it('creates at most one allowance however often it is calculated', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await workingDay(db);
      await approvedDay(db, staff, day);
      await calculateAllowances(db, day);
      const second = await calculateAllowances(db, day);
      expect(second.filter((r) => r.allowance_id !== null)).toHaveLength(0);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.worker_allowances
          where staff_uid = $1 and business_day = $2::date`,
        [staff, day],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('refuses a future day', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select * from app.calculate_allowances(app.eat_day() + 1)`),
      ).toMatch(/future day/i);
    });
  });
});

/**
 * THE LATE-ARRIVAL RESOLUTION — the brief's FULL, DEDUCT and REJECT.
 *
 * Being late never removes the allowance by itself. Somebody decides, with a
 * reason, and the amount that is actually paid follows from that decision.
 */
describe('allowances: FULL, DEDUCT and REJECT', () => {
  const lateAllowance = async (
    db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
    time = '09:30',
  ) => {
    const staff = await employ(db);
    const day = await workingDay(db);
    await approvedDay(db, staff, day, time);
    await calculateAllowances(db, day);
    return { staff, day, allowance: (await allowanceOf(db, staff, day))! };
  };

  it('leaves a late allowance waiting for a decision', async () => {
    await asAdminDb(async (db) => {
      const { allowance } = await lateAllowance(db);
      expect(allowance.status).toBe('calculated');
      expect(allowance.late).toBe(true);
      expect(allowance.suggested_decision).toBe('deduct');
      expect(ugx(allowance.suggested_deduction_ugx)).toBe(2_500);
      expect(allowance.approved_amount_ugx).toBeNull();
    });
  });

  it('suggests REJECT for a severely late arrival', async () => {
    await asAdminDb(async (db) => {
      const { allowance } = await lateAllowance(db, '10:30');
      expect(allowance.severely_late).toBe(true);
      expect(allowance.suggested_decision).toBe('reject');
      expect(ugx(allowance.suggested_deduction_ugx)).toBe(5_000);
    });
  });

  it('FULL pays the whole allowance', async () => {
    await asAdminDb(async (db) => {
      const { staff, day, allowance } = await lateAllowance(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.review_allowance(array[$1]::uuid[], 'full', 'Bus broke down')`, [
        allowance.id,
      ]);
      await becomeOwner(db);
      const after = (await allowanceOf(db, staff, day))!;
      expect(after.status).toBe('approved');
      expect(after.decision).toBe('full');
      expect(ugx(after.deduction_ugx)).toBe(0);
      expect(ugx(after.approved_amount_ugx)).toBe(5_000);
    });
  });

  it('DEDUCT takes the policy amount and pays the rest', async () => {
    await asAdminDb(async (db) => {
      const { staff, day, allowance } = await lateAllowance(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.review_allowance(array[$1]::uuid[], 'deduct', 'Late again')`, [
        allowance.id,
      ]);
      await becomeOwner(db);
      const after = (await allowanceOf(db, staff, day))!;
      expect(after.status).toBe('approved');
      expect(ugx(after.deduction_ugx)).toBe(2_500);
      expect(ugx(after.approved_amount_ugx)).toBe(2_500);
    });
  });

  it('DEDUCT accepts a different amount inside the maximum', async () => {
    await asAdminDb(async (db) => {
      const { staff, day, allowance } = await lateAllowance(db);
      await becomeClient(db, SEED.manager);
      await db.query(
        `select app.review_allowance(array[$1]::uuid[], 'deduct', 'Half an hour', 1000)`,
        [allowance.id],
      );
      await becomeOwner(db);
      const after = (await allowanceOf(db, staff, day))!;
      expect(ugx(after.deduction_ugx)).toBe(1_000);
      expect(ugx(after.approved_amount_ugx)).toBe(4_000);
    });
  });

  it('refuses a deduction above the policy maximum', async () => {
    await asAdminDb(async (db) => {
      const { allowance } = await lateAllowance(db);
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(
          `select app.review_allowance(array[$1]::uuid[], 'deduct', 'Very late', 9000)`,
          [allowance.id],
        ),
      ).toMatch(/cannot exceed UGX 5,000/i);
    });
  });

  it('refuses a deduction that would leave nothing', async () => {
    await asAdminDb(async (db) => {
      const { allowance } = await lateAllowance(db);
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(
          `select app.review_allowance(array[$1]::uuid[], 'deduct', 'All of it', 5000)`,
          [allowance.id],
        ),
      ).toMatch(/must leave part of the allowance/i);
    });
  });

  it('REJECT pays nothing and keeps the reason', async () => {
    await asAdminDb(async (db) => {
      const { staff, day, allowance } = await lateAllowance(db, '10:30');
      await becomeClient(db, SEED.manager);
      await db.query(
        `select app.review_allowance(array[$1]::uuid[], 'reject', 'Half a day missed')`,
        [allowance.id],
      );
      await becomeOwner(db);
      const after = (await allowanceOf(db, staff, day))!;
      expect(after.status).toBe('rejected');
      expect(ugx(after.approved_amount_ugx)).toBe(0);
      expect(after.rejection_reason).toBe('Half a day missed');
    });
  });

  it('needs a reason for DEDUCT and REJECT', async () => {
    await asAdminDb(async (db) => {
      const { allowance } = await lateAllowance(db);
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select app.review_allowance(array[$1]::uuid[], 'deduct')`, [
          allowance.id,
        ]),
      ).toMatch(/reason/i);
      expect(
        await db.expectError(`select app.review_allowance(array[$1]::uuid[], 'reject')`, [
          allowance.id,
        ]),
      ).toMatch(/reason/i);
    });
  });

  it('records a PROPOSAL from someone who may adjust but not approve', async () => {
    await asAdminDb(async (db) => {
      const { staff, day, allowance } = await lateAllowance(db);
      const adjuster = await makeUser(db, {
        role: 'worker',
        permissions: ['allowances.adjust', 'allowances.view'],
      });
      await becomeClient(db, adjuster);
      await db.query(
        `select app.review_allowance(array[$1]::uuid[], 'deduct', 'Thirty minutes late')`,
        [allowance.id],
      );
      await becomeOwner(db);
      const after = (await allowanceOf(db, staff, day))!;
      expect(after.status).toBe('pending_approval');
      expect(after.proposed_decision).toBe('deduct');
      expect(after.decision).toBeNull();
      expect(after.approved_amount_ugx).toBeNull();
    });
  });

  it('will not let anyone decide their own allowance', async () => {
    await asAdminDb(async (db) => {
      const manager = await makeUser(db, { role: 'manager' });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.set_salary_profile($1, 900000, '2020-01-01')`, [manager]);
      await becomeOwner(db);
      const day = await workingDay(db);
      await approvedDay(db, manager, day, '09:30');
      await calculateAllowances(db, day);
      const allowance = (await allowanceOf(db, manager, day))!;
      await becomeClient(db, manager);
      expect(
        await db.expectError(
          `select app.review_allowance(array[$1]::uuid[], 'full', 'I was held up')`,
          [allowance.id],
        ),
      ).toMatch(/cannot decide your own allowance/i);
    });
  });

  it('refuses to decide an allowance twice', async () => {
    await asAdminDb(async (db) => {
      const { allowance } = await lateAllowance(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.review_allowance(array[$1]::uuid[], 'full', 'Fine')`, [
        allowance.id,
      ]);
      expect(
        await db.expectError(
          `select app.review_allowance(array[$1]::uuid[], 'reject', 'Changed my mind')`,
          [allowance.id],
        ),
      ).toMatch(/is approved/i);
    });
  });
});

describe('allowances: payment moves money once', () => {
  const approvedAllowance = async (db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) => {
    const staff = await employ(db);
    const day = await workingDay(db);
    await approvedDay(db, staff, day, '08:00');
    await autoApprove(db);
    await calculateAllowances(db, day);
    return { staff, day, allowance: (await allowanceOf(db, staff, day))! };
  };

  it('posts ONE ledger entry for the batch and takes the money from the account', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 1_000_000);
      const before = await balanceOf(db, 'cash_at_hand');
      const a = await approvedAllowance(db);
      const b = await approvedAllowance(db);

      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{
        transaction_id: string;
        count: number;
        total_ugx: string;
        balance_ugx: string;
      }>(`select * from app.pay_allowances($1::uuid[], $2, $3, 'Weekly run')`, [
        [a.allowance.id, b.allowance.id],
        account,
        requestId('allowance-pay'),
      ]);
      await becomeOwner(db);

      expect(Number(rows[0].count)).toBe(2);
      expect(ugx(rows[0].total_ugx)).toBe(10_000);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before - 10_000);

      const { rows: entries } = await db.query<{ n: string; entry_type: string }>(
        `select count(*)::text as n, min(t.entry_type) as entry_type
           from public.financial_transactions t where t.id = $1`,
        [rows[0].transaction_id],
      );
      expect(Number(entries[0].n)).toBe(1);
      expect(entries[0].entry_type).toBe('allowance_payment');
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('pays once for a repeated request id', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 1_000_000);
      const before = await balanceOf(db, 'cash_at_hand');
      const a = await approvedAllowance(db);
      const key = requestId('allowance-retry');

      await becomeClient(db, SEED.manager);
      const first = await db.query<{ transaction_id: string }>(
        `select * from app.pay_allowances($1::uuid[], $2, $3)`,
        [[a.allowance.id], account, key],
      );
      const second = await db.query<{ transaction_id: string }>(
        `select * from app.pay_allowances($1::uuid[], $2, $3)`,
        [[a.allowance.id], account, key],
      );
      await becomeOwner(db);

      expect(second.rows[0].transaction_id).toBe(first.rows[0].transaction_id);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before - 5_000);
    });
  });

  it('refuses to pay an allowance that is not approved', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 1_000_000);
      const staff = await employ(db);
      const day = await workingDay(db);
      await approvedDay(db, staff, day, '09:30');
      await calculateAllowances(db, day);
      const allowance = (await allowanceOf(db, staff, day))!;
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
          allowance.id,
          account,
          requestId('allowance-bad'),
        ]),
      ).toMatch(/not approved|is calculated/i);
    });
  });

  it('refuses to pay more than the account holds', async () => {
    await asAdminDb(async (db) => {
      // Its own account, because the shared one carries whatever the
      // committing suites left in it.
      await becomeClient(db, SEED.admin);
      const { rows: account } = await db.query<{ id: string }>(
        `select app.create_financial_account($1, 'bank', 'Test Bank') as id`,
        [`Almost Empty ${Math.random().toString(36).slice(2, 8)}`],
      );
      await db.query(`select * from app.record_opening_balance($1, 1000, 'Test float')`, [
        account[0].id,
      ]);
      await becomeOwner(db);

      const a = await approvedAllowance(db);
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
          a.allowance.id,
          account[0].id,
          requestId('allowance-short'),
        ]),
      ).toMatch(/only UGX 1,000 available/i);
      await becomeOwner(db);
      const { rows: after } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`,
        [account[0].id],
      );
      expect(ugx(after[0].balance_ugx)).toBe(1_000);
    });
  });

  it('refuses to pay the same allowance twice', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 1_000_000);
      const a = await approvedAllowance(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
        a.allowance.id,
        account,
        requestId('allowance-1'),
      ]);
      expect(
        await db.expectError(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
          a.allowance.id,
          account,
          requestId('allowance-2'),
        ]),
      ).toMatch(/is paid|already/i);
    });
  });

  /** Phase E's guard: staff pay is reversed through its own workflow. */
  it('refuses a generic finance reversal and asks for the workforce one', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 1_000_000);
      const a = await approvedAllowance(db);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`,
        [a.allowance.id, account, requestId('allowance-rev')],
      );
      await becomeClient(db, SEED.admin);
      expect(
        await db.expectError(`select app.reverse_financial_transaction($1, 'Paid in error')`, [
          rows[0].transaction_id,
        ]),
      ).toMatch(/allowance|payroll|workforce/i);
    });
  });

  it('gives the money back through the workforce reversal', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 1_000_000);
      const before = await balanceOf(db, 'cash_at_hand');
      const a = await approvedAllowance(db);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`,
        [a.allowance.id, account, requestId('allowance-rev2')],
      );
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_allowance_payment($1, 'Paid in error')`, [
        rows[0].transaction_id,
      ]);
      await becomeOwner(db);

      expect(await balanceOf(db, 'cash_at_hand')).toBe(before);
      const after = (await allowanceOf(db, a.staff, a.day))!;
      expect(after.status).toBe('approved');
      expect(after.financial_transaction_id).toBeNull();
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });
});

describe('allowances: corrections and cancellation', () => {
  it('cancels the allowance when the attendance behind it is corrected', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await workingDay(db);
      const record = await approvedDay(db, staff, day, '08:00');
      await calculateAllowances(db, day);
      const allowance = (await allowanceOf(db, staff, day))!;

      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ cancelled_allowance_id: string | null }>(
        `select * from app.correct_attendance($1, 'They were not here after all', 'absent')`,
        [record.attendance_id],
      );
      await becomeOwner(db);

      expect(rows[0].cancelled_allowance_id).toBe(allowance.id);
      const { rows: after } = await db.query<{ status: string }>(
        `select status from public.worker_allowances where id = $1`,
        [allowance.id],
      );
      expect(after[0].status).toBe('cancelled');
    });
  });

  it('refuses to correct attendance whose allowance has been paid', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 1_000_000);
      const staff = await employ(db);
      const day = await workingDay(db);
      const record = await approvedDay(db, staff, day, '08:00');
      await autoApprove(db);
      await calculateAllowances(db, day);
      const allowance = (await allowanceOf(db, staff, day))!;

      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
        allowance.id,
        account,
        requestId('allowance-lock'),
      ]);
      expect(
        await db.expectError(`select * from app.correct_attendance($1, 'Wrong day', 'absent')`, [
          record.attendance_id,
        ]),
      ).toMatch(/has been paid/i);
    });
  });

  it('never deletes an allowance', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      const day = await workingDay(db);
      await approvedDay(db, staff, day, '08:00');
      await calculateAllowances(db, day);
      const allowance = (await allowanceOf(db, staff, day))!;
      expect(
        await db.expectError(`delete from public.worker_allowances where id = $1`, [allowance.id]),
      ).toMatch(/never deletes/i);
    });
  });
});
