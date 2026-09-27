import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import {
  autoPost, issue, openDay, ownAccount, requestId, shareClass, shareholder, shareholderRow,
  testClassCode, ugx,
} from './ownership-helpers';
import { ledgerDisagreements } from './finance-helpers';

afterAll(closePool);

/**
 * DIVIDENDS.
 *
 * RamosMAX does not work out profit or what is legally distributable, and
 * applies no tax: an authorised person enters the amount the business
 * approved. What the system guarantees is that the ALLOCATION is right, that
 * it is FROZEN at the record date, and that the money and the record move
 * together.
 */

/**
 * Its own share class, so a dividend over it can only reach its own people:
 * the committing suites leave holders behind, and a dividend restricted to a
 * class is exactly how the reference scopes eligibility.
 */
async function scene(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) {
  const classId = await shareClass(db, testClassCode(), 100_000);
  await autoPost(db);
  const account = await ownAccount(db, 500_000_000);
  const john = await shareholder(db, 'John Owner', '0772800001');
  const mary = await shareholder(db, 'Mary Owner', '0772800002');
  const past = await openDay(db);
  const { rows } = await db.query<{ today: string }>(`select app.eat_day()::text as today`);
  return { account, john, mary, classId, days: { past, today: rows[0].today } };
}

/** A dividend with allocations calculated over a past record date. */
async function calculated(
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  options: { pool?: number; perShare?: number; recordDate: string; classId: string },
) {
  await becomeClient(db, SEED.admin);
  const { rows } = await db.query<{ dividend_id: string; dividend_number: string }>(
    `select * from app.create_dividend('FY2026', $1::date, $2, $3, $4, $5, null, null, $6)`,
    [
      options.recordDate, requestId('dividend'),
      options.perShare ? 'per_share' : 'pool',
      options.pool ?? null, options.perShare ?? null, options.classId,
    ]);
  const { rows: calc } = await db.query<Record<string, string>>(
    `select * from app.calculate_dividend($1)`, [rows[0].dividend_id]);
  await becomeOwner(db);
  return { id: rows[0].dividend_id, number: rows[0].dividend_number, calc: calc[0] };
}

const allocationsOf = async (
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  dividend: string,
) => {
  const { rows } = await db.query<Record<string, string>>(
    `select * from public.dividend_allocations where dividend_id = $1 and current
      order by shares_at_record_date desc, shareholder_number`, [dividend]);
  return rows;
};

describe('dividends: the record date', () => {
  it('refuses to calculate before the record date has been reached', async () => {
    await asAdminDb(async (db) => {
      const { account, john, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000 });
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ dividend_id: string }>(
        `select * from app.create_dividend('FY2026', app.eat_day() + 10, $1, 'pool', 1000000)`,
        [requestId('future')]);
      expect(await db.expectError(`select * from app.calculate_dividend($1)`, [rows[0].dividend_id]))
        .toMatch(/once the record date .* has been reached/i);
    });
  });

  /**
   * THE TESTED EXAMPLE FROM THE REFERENCE: John held 500 on the record date
   * and sold 250 afterwards. His allocation is still based on 500.
   */
  it('uses ownership at the END of the record date, not today', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 500, account, amount: 50_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.transfer_shares($1, $2, '${classId}', 250, 'Sold later', $3, app.eat_day() - 5)`,
        [john, mary, requestId('sold')]);
      await becomeOwner(db);

      const dividend = await calculated(db, { pool: 10_000_000, recordDate: record[0].d, classId });
      const allocations = await allocationsOf(db, dividend.id);
      expect(allocations).toHaveLength(1);
      expect(ugx(allocations[0].shares_at_record_date)).toBe(500);
      expect(ugx(allocations[0].net_ugx)).toBe(10_000_000);
    });
  });

  it('gives nothing to someone who bought after the record date', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      await issue(db, {
        shareholder: mary, classId, shares: 100, account, amount: 10_000_000, effective: days.today,
      });
      const dividend = await calculated(db, { pool: 1_000_000, recordDate: record[0].d, classId });
      const allocations = await allocationsOf(db, dividend.id);
      expect(allocations).toHaveLength(1);
      expect(allocations[0].shareholder_name).toBe('John Owner');
    });
  });

  /** THE RECORD-DATE LOCK: the snapshot cannot drift after it is taken. */
  it('locks ownership on and before the record date once calculated', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string; before: string }>(
        `select (app.eat_day() - 15)::text as d, (app.eat_day() - 16)::text as before`);
      const dividend = await calculated(db, { pool: 1_000_000, recordDate: record[0].d, classId });

      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select * from app.transfer_shares($1, $2, '${classId}', 50, 'Backdated', $3, $4::date)`,
        [john, mary, requestId('locked'), record[0].before]))
        .toMatch(/fixed by a calculated dividend/i);
      // A later date is fine.
      await db.query(`select * from app.transfer_shares($1, $2, '${classId}', 50, 'After', $3)`,
        [john, mary, requestId('after')]);

      // And cancelling the dividend releases the lock.
      await db.query(`select app.cancel_dividend($1, 'Not going ahead')`, [dividend.id]);
      await db.query(
        `select * from app.transfer_shares($1, $2, '${classId}', 10, 'Backdated now', $3, $4::date)`,
        [john, mary, requestId('released'), record[0].before]);
    });
  });

  it('freezes the allocations: later ownership changes never touch them', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      const dividend = await calculated(db, { pool: 1_000_000, recordDate: record[0].d, classId });
      const before = await allocationsOf(db, dividend.id);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.transfer_shares($1, $2, '${classId}', 100, 'All of it', $3)`,
        [john, mary, requestId('all')]);
      await becomeOwner(db);

      expect(await allocationsOf(db, dividend.id)).toEqual(before);
      expect(await db.expectError(
        `update public.dividend_allocations set shares_at_record_date = 1 where dividend_id = $1`,
        [dividend.id])).toMatch(/keeps its record-date snapshot/i);
      expect(await db.expectError(
        `update public.dividend_allocations set net_ugx = 1, gross_ugx = 1 where dividend_id = $1`,
        [dividend.id])).toMatch(/keeps its record-date snapshot/i);
    });
  });

  it('keeps a superseded allocation when it is recalculated', async () => {
    await asAdminDb(async (db) => {
      const { account, john, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      const dividend = await calculated(db, { pool: 1_000_000, recordDate: record[0].d, classId });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_dividend($1, null, null, null, 2000000, null, null, null, null, 'More')`,
        [dividend.id]);
      await db.query(`select * from app.calculate_dividend($1)`, [dividend.id]);
      await becomeOwner(db);

      const { rows } = await db.query<{ current: boolean; dividend_status: string; net_ugx: string }>(
        `select current, dividend_status, net_ugx from public.dividend_allocations
          where dividend_id = $1 order by version`, [dividend.id]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ current: false, dividend_status: 'superseded' });
      expect(ugx(rows[0].net_ugx)).toBe(1_000_000);
      expect(rows[1].current).toBe(true);
      expect(ugx(rows[1].net_ugx)).toBe(2_000_000);
    });
  });
});

describe('dividends: the calculation', () => {
  /** A pool of 10,000,000 over 1,000 shares is 10,000 a share. */
  it('splits a pool by shares, rounding each allocation DOWN', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.past,
      });
      await issue(db, {
        shareholder: mary, classId, shares: 900, account, amount: 90_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      const dividend = await calculated(db, { pool: 10_000_000, recordDate: record[0].d, classId });

      expect(ugx(dividend.calc.eligible_shares)).toBe(1000);
      expect(Number(dividend.calc.per_share_rate)).toBe(10_000);
      const allocations = await allocationsOf(db, dividend.id);
      expect(ugx(allocations.find((a) => a.shareholder_name === 'John Owner')!.net_ugx))
        .toBe(1_000_000);
      expect(ugx(allocations.find((a) => a.shareholder_name === 'Mary Owner')!.net_ugx))
        .toBe(9_000_000);
      expect(ugx(dividend.calc.unallocated_ugx)).toBe(0);
    });
  });

  it('reports the shillings rounding leaves over, and never invents them', async () => {
    await asAdminDb(async (db) => {
      const { account, john, mary, days, classId } = await scene(db);
      for (const id of [john, mary]) {
        await issue(db, {
        shareholder: id, classId, shares: 1, account, amount: 100_000, effective: days.past });
      }
      const third = await shareholder(db, 'Peter Owner', '0772800003');
      await issue(db, {
        shareholder: third, classId, shares: 1, account, amount: 100_000, effective: days.past });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      // 1,000 over 3 shares: 333 each, 1 shilling left over.
      const dividend = await calculated(db, { pool: 1000, recordDate: record[0].d, classId });
      const allocations = await allocationsOf(db, dividend.id);
      expect(allocations.map((a) => ugx(a.net_ugx))).toEqual([333, 333, 333]);
      expect(ugx(dividend.calc.allocated_ugx)).toBe(999);
      expect(ugx(dividend.calc.unallocated_ugx)).toBe(1);
    });
  });

  it('multiplies an amount per share by the shares held', async () => {
    await asAdminDb(async (db) => {
      const { account, john, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 250, account, amount: 25_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      const dividend = await calculated(db, { perShare: 4_000, recordDate: record[0].d, classId });
      const allocations = await allocationsOf(db, dividend.id);
      expect(ugx(allocations[0].net_ugx)).toBe(1_000_000);
      expect(ugx(dividend.calc.allocated_ugx)).toBe(1_000_000);
    });
  });

  it('applies no deduction at all: net equals gross', async () => {
    await asAdminDb(async (db) => {
      const { account, john, days, classId } = await scene(db);
      await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.past,
      });
      const { rows: record } = await db.query<{ d: string }>(
        `select (app.eat_day() - 15)::text as d`);
      const dividend = await calculated(db, { pool: 1_000_000, recordDate: record[0].d, classId });
      const allocations = await allocationsOf(db, dividend.id);
      expect(ugx(allocations[0].deductions_ugx)).toBe(0);
      expect(allocations[0].net_ugx).toBe(allocations[0].gross_ugx);
    });
  });

  it('refuses a dividend nobody is eligible for', async () => {
    await asAdminDb(async (db) => {
      const { days, classId } = await scene(db);
      await becomeClient(db, SEED.admin);
      // A class of its own that nobody holds.
      const { rows } = await db.query<{ dividend_id: string }>(
        `select * from app.create_dividend('FY2026', $1::date, $2, 'pool', 1000000,
                                           null, null, null, $3)`,
        [days.past, requestId('empty'), classId]);
      expect(await db.expectError(`select * from app.calculate_dividend($1)`, [rows[0].dividend_id]))
        .toMatch(/Nobody held eligible shares/i);
    });
  });
});

describe('dividends: declaration and approval', () => {
  const ready = async (db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) => {
    const { account, john, days, classId } = await scene(db);
    await issue(db, {
        shareholder: john, classId, shares: 100, account, amount: 10_000_000, effective: days.past,
    });
    const { rows: record } = await db.query<{ d: string }>(`select (app.eat_day() - 15)::text as d`);
    const dividend = await calculated(db, { pool: 1_000_000, recordDate: record[0].d, classId });
    return { ...dividend, account, john };
  };

  it('refuses to declare before the allocations are calculated', async () => {
    await asAdminDb(async (db) => {
      const { days } = await scene(db);
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ dividend_id: string }>(
        `select * from app.create_dividend('FY2026', $1::date, $2, 'pool', 1000000)`,
        [days.past, requestId('undeclared')]);
      expect(await db.expectError(
        `select app.update_dividend_status($1, 'declare')`, [rows[0].dividend_id]))
        .toMatch(/Calculate the allocations before declaring/i);
    });
  });

  it('walks declare → approve, and refuses approval before declaration', async () => {
    await asAdminDb(async (db) => {
      const dividend = await ready(db);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.update_dividend_status($1, 'approve')`, [dividend.id]))
        .toMatch(/Only a declared dividend can be approved/i);
      await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend.id]);
      expect((await db.query<{ update_dividend_status: string }>(
        `select app.update_dividend_status($1, 'approve')`, [dividend.id]))
        .rows[0].update_dividend_status).toBe('approved');
    });
  });

  it('insists on an Administrator while the policy says so', async () => {
    await asAdminDb(async (db) => {
      const dividend = await ready(db);
      const approver = await makeUser(db, {
        role: 'manager', permissions: ['dividends.approve', 'dividends.view'],
      });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend.id]);
      await becomeClient(db, approver);
      expect(await db.expectError(`select app.update_dividend_status($1, 'approve')`, [dividend.id]))
        .toMatch(/approved by an Administrator/i);
    });
  });

  it('refuses a declarer approving their own, once the policy allows a manager', async () => {
    await asAdminDb(async (db) => {
      const dividend = await ready(db);
      const person = await makeUser(db, {
        role: 'manager', permissions: ['dividends.declare', 'dividends.approve', 'dividends.view'],
      });
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_shareholding_policy('dividend', '{"requireAdminApproval":false}'::jsonb, 'Small business')`);
      await becomeClient(db, person);
      await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend.id]);
      expect(await db.expectError(`select app.update_dividend_status($1, 'approve')`, [dividend.id]))
        .toMatch(/Another person must approve/i);
    });
  });

  it('refuses an approval that pays the approver’s own shareholding', async () => {
    await asAdminDb(async (db) => {
      const dividend = await ready(db);
      const person = await makeUser(db, {
        role: 'manager', permissions: ['dividends.approve', 'dividends.view'],
      });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.link_shareholder_account($1, $2)`, [dividend.john, person]);
      await db.query(
        `select app.update_shareholding_policy('dividend', '{"requireAdminApproval":false}'::jsonb, 'Small')`);
      await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend.id]);
      await becomeClient(db, person);
      expect(await db.expectError(`select app.update_dividend_status($1, 'approve')`, [dividend.id]))
        .toMatch(/your own shareholding/i);
    });
  });

  it('returns a declared dividend to draft, with a reason', async () => {
    await asAdminDb(async (db) => {
      const dividend = await ready(db);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend.id]);
      expect(await db.expectError(`select app.update_dividend_status($1, 'return')`, [dividend.id]))
        .toMatch(/reason/i);
      await db.query(`select app.update_dividend_status($1, 'return', 'Wrong period')`, [dividend.id]);
      await becomeOwner(db);
      const { rows } = await db.query<{ status: string; returned_reason: string }>(
        `select status, returned_reason from public.dividends where id = $1`, [dividend.id]);
      expect(rows[0]).toEqual({ status: 'draft', returned_reason: 'Wrong period' });
    });
  });
});

describe('dividends: payment', () => {
  const approved = async (db: Parameters<Parameters<typeof asAdminDb>[0]>[0], pool = 1_000_000) => {
    const { account, john, mary, days, classId } = await scene(db);
    await issue(db, {
        shareholder: john, classId, shares: 60, account, amount: 6_000_000, effective: days.past,
    });
    await issue(db, {
        shareholder: mary, classId, shares: 40, account, amount: 4_000_000, effective: days.past,
    });
    const { rows: record } = await db.query<{ d: string }>(`select (app.eat_day() - 15)::text as d`);
    const dividend = await calculated(db, { pool, recordDate: record[0].d, classId });
    await becomeClient(db, SEED.admin);
    await db.query(`select app.update_dividend_status($1, 'declare')`, [dividend.id]);
    await db.query(`select app.update_dividend_status($1, 'approve')`, [dividend.id]);
    await becomeOwner(db);
    return { ...dividend, account, john, mary };
  };

  it('pays each allocation with its own ledger entry, and takes the money', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      const { rows: before } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [dividend.account]);
      const allocations = await allocationsOf(db, dividend.id);

      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ status: string; amount_ugx: string; allocations_paid: number }>(
        `select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [dividend.id, allocations.map((a) => a.id), dividend.account, requestId('pay')]);
      await becomeOwner(db);

      expect(rows[0].status).toBe('paid');
      expect(ugx(rows[0].amount_ugx)).toBe(1_000_000);
      expect(Number(rows[0].allocations_paid)).toBe(2);

      const { rows: after } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [dividend.account]);
      expect(ugx(before[0].balance_ugx) - ugx(after[0].balance_ugx)).toBe(1_000_000);

      const { rows: entries } = await db.query<{ n: string; is_revenue: boolean }>(
        `select count(*)::text as n, bool_and(is_revenue) as is_revenue
           from public.financial_transactions
          where entry_type = 'dividend_payment' and source_account_id = $1`, [dividend.account]);
      expect(Number(entries[0].n), 'one entry per allocation').toBe(2);
      expect(entries[0].is_revenue).toBe(false);

      const { rows: today } = await db.query<{ dividends_paid_ugx: string }>(
        `select dividends_paid_ugx from public.finance_daily_summaries
          where business_day = app.eat_day()`);
      expect(ugx(today[0].dividends_paid_ugx)).toBeGreaterThanOrEqual(1_000_000);
      // A dividend is never an operating expense: none of these entries is one.
      const { rows: expenses } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where entry_type = 'expense_payment' and source_account_id = $1`, [dividend.account]);
      expect(Number(expenses[0].n), 'never an operating expense').toBe(0);

      expect(ugx((await shareholderRow(db, dividend.john)).dividends_paid_ugx)).toBe(600_000);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('pays part of a dividend, then the rest', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      const allocations = await allocationsOf(db, dividend.id);
      await becomeClient(db, SEED.admin);
      const first = await db.query<{ status: string }>(
        `select * from app.pay_dividend($1, array[$2]::uuid[], $3, $4)`,
        [dividend.id, allocations[0].id, dividend.account, requestId('part1')]);
      expect(first.rows[0].status).toBe('partially_paid');
      const second = await db.query<{ status: string }>(
        `select * from app.pay_dividend($1, array[$2]::uuid[], $3, $4)`,
        [dividend.id, allocations[1].id, dividend.account, requestId('part2')]);
      expect(second.rows[0].status).toBe('paid');
    });
  });

  it('pays once for a repeated request id', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      const allocations = await allocationsOf(db, dividend.id);
      const key = requestId('div-retry');
      const { rows: before } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [dividend.account]);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [dividend.id, allocations.map((a) => a.id), dividend.account, key]);
      await db.query(`select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [dividend.id, allocations.map((a) => a.id), dividend.account, key]);
      await becomeOwner(db);
      const { rows: after } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [dividend.account]);
      expect(ugx(before[0].balance_ugx) - ugx(after[0].balance_ugx)).toBe(1_000_000);
    });
  });

  it('refuses to pay an unapproved dividend, or an allocation twice', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      const allocations = await allocationsOf(db, dividend.id);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_dividend($1, array[$2]::uuid[], $3, $4)`,
        [dividend.id, allocations[0].id, dividend.account, requestId('once')]);
      expect(await db.expectError(`select * from app.pay_dividend($1, array[$2]::uuid[], $3, $4)`,
        [dividend.id, allocations[0].id, dividend.account, requestId('twice')]))
        .toMatch(/has already been paid/i);
    });
  });

  it('pays NOTHING when the account cannot cover the whole batch', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db, 100_000_000);
      const small = await ownAccount(db, 1_000_000);
      const allocations = await allocationsOf(db, dividend.id);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [dividend.id, allocations.map((a) => a.id), small, requestId('short')]))
        .toMatch(/only UGX|available/i);
      await becomeOwner(db);
      const { rows } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [small]);
      expect(ugx(rows[0].balance_ugx)).toBe(1_000_000);
      expect((await allocationsOf(db, dividend.id)).every((a) => a.payment_status === 'unpaid'))
        .toBe(true);
    });
  });

  it('reverses one payment: the money returns, the allocation is unpaid again', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      const allocations = await allocationsOf(db, dividend.id);
      const { rows: before } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [dividend.account]);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [dividend.id, allocations.map((a) => a.id), dividend.account, requestId('paid')]);
      const { rows } = await db.query<{ dividend_status: string }>(
        `select * from app.reverse_dividend_payment($1, 'Wrong account')`, [allocations[0].id]);
      await becomeOwner(db);

      expect(rows[0].dividend_status).toBe('partially_paid');
      const after = await allocationsOf(db, dividend.id);
      const reversed = after.find((a) => a.id === allocations[0].id)!;
      expect(reversed.payment_status).toBe('unpaid');
      expect((reversed.reversals as unknown as unknown[]).length, 'the reversal is recorded').toBe(1);
      expect(ugx((await shareholderRow(db, dividend.john)).dividends_paid_ugx)).toBe(0);

      const { rows: balance } = await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where id = $1`, [dividend.account]);
      expect(ugx(before[0].balance_ugx) - ugx(balance[0].balance_ugx)).toBe(400_000);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('refuses a generic finance reversal of a dividend payment', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      const allocations = await allocationsOf(db, dividend.id);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [dividend.id, allocations.map((a) => a.id), dividend.account, requestId('paid2')]);
      const { rows } = await db.query<{ id: string }>(
        `select id from public.financial_transactions where entry_type = 'dividend_payment' limit 1`);
      expect(await db.expectError(
        `select * from app.reverse_financial_transaction($1, 'Wrong door')`, [rows[0].id]))
        .toMatch(/dividend payment from its allocation/i);
    });
  });

  it('refuses to cancel a dividend with payments on it', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      const allocations = await allocationsOf(db, dividend.id);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_dividend($1, array[$2]::uuid[], $3, $4)`,
        [dividend.id, allocations[0].id, dividend.account, requestId('paid3')]);
      expect(await db.expectError(`select app.cancel_dividend($1, 'Changed our minds')`, [dividend.id]))
        .toMatch(/Reverse the payments .* before cancelling/i);
    });
  });

  it('cancels an unpaid dividend, keeping its allocations', async () => {
    await asAdminDb(async (db) => {
      const dividend = await approved(db);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.cancel_dividend($1, 'Not going ahead')`, [dividend.id]);
      await becomeOwner(db);
      const { rows } = await db.query<{ status: string; record_locked: boolean }>(
        `select status, record_locked from public.dividends where id = $1`, [dividend.id]);
      expect(rows[0]).toEqual({ status: 'cancelled', record_locked: false });
      const { rows: allocations } = await db.query<{ dividend_status: string }>(
        `select dividend_status from public.dividend_allocations where dividend_id = $1`,
        [dividend.id]);
      expect(allocations.length).toBeGreaterThan(0);
      expect(allocations.every((a) => a.dividend_status === 'cancelled')).toBe(true);
      expect(await db.expectError(`delete from public.dividends where id = $1`, [dividend.id]))
        .toMatch(/never deletes/i);
    });
  });
});
