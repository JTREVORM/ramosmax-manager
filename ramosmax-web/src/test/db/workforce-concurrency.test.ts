import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, SEED } from './harness';
import { requestId } from './billing-helpers';

afterAll(closePool);

/**
 * IDEMPOTENCY AND CONCURRENCY for attendance, allowances, payroll and losses.
 *
 * These tests COMMIT. Proving that two SIMULTANEOUS requests cannot both
 * create the same day's attendance, pay the same allowance twice, or pay the
 * same payroll twice, requires real, separate, committing transactions — a
 * rolled-back transaction never races anything.
 *
 * Every test works on records it creates itself and asserts only about those.
 */

interface Runner {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/** Runs `fn` in its own committed transaction as `uid` (null = the owner). */
async function committedAs<T>(uid: string | null, fn: (run: Runner) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    if (uid !== null) {
      await client.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`,
      );
      await client.query('set local role authenticated');
    }
    const result = await fn({
      query: async (sql, params) => (await client.query(sql, params as never)).rows,
    });
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 8)}`;
const settle = async <T>(work: Promise<T>[]) =>
  (await Promise.allSettled(work)).map((r) => r.status);
const ugx = (v: unknown) => Number(v ?? 0);

/**
 * A committed employee with a salary.
 *
 * Paid WEEKLY, deliberately: this suite's people are permanent, and a weekly
 * salary keeps them out of the monthly payrolls the rolled-back suites work
 * with.
 */
async function employee(salary = 600_000, allowanceUgx: number | null = null): Promise<string> {
  return committedAs(null, async (run) => {
    const id = (
      await run.query(
        `insert into auth.users (email) values (app.new_sign_in_identity()) returning id`,
      )
    )[0].id as string;
    await run.query(
      `insert into public.users (id, phone_number, full_name, role, active)
       values ($1, $2, $3, 'worker', true)`,
      [
        id,
        `+2567${String(Math.floor(Math.random() * 89_999_999) + 10_000_000).slice(0, 8)}`,
        unique('Concurrent Worker'),
      ],
    );
    await run.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: SEED.admin, role: 'authenticated' })}'`,
    );
    await run.query(
      `select * from app.set_salary_profile($1, $2, '2020-01-01', 'weekly', true, $3)`,
      [id, salary, allowanceUgx],
    );
    return id;
  });
}

/** A committed account holding `amount`, of its own. */
async function fundedAccount(amount: number): Promise<string> {
  return committedAs(SEED.admin, async (run) => {
    const account = (
      await run.query(`select app.create_financial_account($1, 'bank', 'Test Bank') as id`, [
        `Test ${unique('Payroll Bank')}`,
      ])
    )[0].id as string;
    await run.query(`select * from app.record_opening_balance($1, $2, 'Test float')`, [
      account,
      amount,
    ]);
    return account;
  });
}

/**
 * Mondays in the last few years that no payroll has claimed yet.
 *
 * This suite commits, so every weekly period it uses stays used. Asking the
 * database which weeks are free keeps repeated runs independent.
 */
async function freeWeeks(count: number): Promise<string[]> {
  const rows = await committedAs(null, (run) =>
    run.query(
      `
    select g.d::date::text as d
      from generate_series(date_trunc('week', app.eat_day())::date - 300 * 7,
                           date_trunc('week', app.eat_day())::date - 7, interval '7 day') g(d)
     where not exists (select 1 from public.payroll p
                        where p.period_key = 'W' || g.d::date::text and p.status <> 'cancelled')
     order by random() limit $1`,
      [count],
    ),
  );
  if (rows.length < count) throw new Error('the development database has no free weeks left');
  return rows.map((r) => r.d as string);
}

const balanceOf = async (id: string) =>
  Number(
    (
      await committedAs(null, (run) =>
        run.query(`select balance_ugx from public.financial_accounts where id = $1`, [id]),
      )
    )[0].balance_ugx,
  );

/** A recent working day nothing else in this suite has used for this person. */
const workingDay = async () =>
  (
    await committedAs(null, (run) =>
      run.query(`
    select max(g.d)::date::text as d
      from generate_series(app.eat_day() - 12, app.eat_day() - 1, interval '1 day') g(d)
     where extract(isodow from g.d) between 1 and 6`),
    )
  )[0].d as string;

// ---------------------------------------------------------------------------
describe('attendance', () => {
  it('lets only ONE of two simultaneous clock-ins win', async () => {
    const staff = await employee();
    const day = await workingDay();

    const outcomes = await settle(
      [1, 2].map(() =>
        committedAs(SEED.manager, (run) =>
          run.query(
            `select * from app.record_attendance($1, 'present', $2::date,
           (($2::date + time '08:00') at time zone 'Africa/Kampala'))`,
            [staff, day],
          ),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    const rows = await committedAs(null, (run) =>
      run.query(
        `select id from public.attendance where staff_uid = $1 and business_day = $2::date`,
        [staff, day],
      ),
    );
    expect(rows).toHaveLength(1);
  });

  it('lets only ONE of four simultaneous clock-ins win', async () => {
    const staff = await employee();
    const day = await workingDay();

    const outcomes = await settle(
      [1, 2, 3, 4].map((n) =>
        committedAs(SEED.manager, (run) =>
          run.query(
            `select * from app.record_attendance($1, 'present', $2::date,
           (($2::date + time '08:0${n}') at time zone 'Africa/Kampala'))`,
            [staff, day],
          ),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(
      await committedAs(null, (run) =>
        run.query(
          `select id from public.attendance where staff_uid = $1 and business_day = $2::date`,
          [staff, day],
        ),
      ),
    ).toHaveLength(1);
  });

  it('lets two different people clock in at the same moment', async () => {
    const a = await employee();
    const b = await employee();
    const day = await workingDay();

    const outcomes = await settle(
      [a, b].map((staff) =>
        committedAs(SEED.manager, (run) =>
          run.query(
            `select * from app.record_attendance($1, 'present', $2::date,
           (($2::date + time '08:00') at time zone 'Africa/Kampala'))`,
            [staff, day],
          ),
        ),
      ),
    );
    expect(outcomes).toEqual(['fulfilled', 'fulfilled']);
  });
});

// ---------------------------------------------------------------------------
describe('allowance payment', () => {
  /** A committed, approved allowance for one person on one day. */
  async function approvedAllowance(): Promise<{ id: string; staff: string; amount: number }> {
    const staff = await employee(600_000, 5_000);
    const day = await workingDay();
    return committedAs(SEED.manager, async (run) => {
      const attendance = (
        await run.query(
          `select attendance_id from app.record_attendance($1, 'present', $2::date,
           (($2::date + time '08:00') at time zone 'Africa/Kampala'))`,
          [staff, day],
        )
      )[0].attendance_id as string;
      await run.query(`select app.verify_attendance(array[$1]::uuid[], 'approve')`, [attendance]);
      await run.query(`select * from app.calculate_allowances($1::date)`, [day]);
      const allowance = (
        await run.query(`select id from public.worker_allowances where attendance_id = $1`, [
          attendance,
        ])
      )[0].id as string;
      await run.query(`select app.review_allowance(array[$1]::uuid[], 'full')`, [allowance]);
      return { id: allowance, staff, amount: 5_000 };
    });
  }

  it('pays once when two requests arrive at the same moment', async () => {
    const account = await fundedAccount(500_000);
    const allowance = await approvedAllowance();

    const outcomes = await settle(
      [1, 2].map(() =>
        committedAs(SEED.manager, (run) =>
          run.query(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
            allowance.id,
            account,
            requestId('concurrent-allowance'),
          ]),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(account)).toBe(495_000);
  });

  it('pays once for a repeated request id', async () => {
    const account = await fundedAccount(500_000);
    const allowance = await approvedAllowance();
    const key = requestId('allowance-idempotent');

    const first = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
        allowance.id,
        account,
        key,
      ]),
    );
    const again = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
        allowance.id,
        account,
        key,
      ]),
    );

    expect(again[0].transaction_number).toBe(first[0].transaction_number);
    expect(await balanceOf(account)).toBe(495_000);
  });

  it('spends no more than the account holds when several batches race for it', async () => {
    const account = await fundedAccount(12_000);
    const allowances = await Promise.all([
      approvedAllowance(),
      approvedAllowance(),
      approvedAllowance(),
    ]);

    // Each batch is UGX 5,000; only two of the three fit.
    const outcomes = await settle(
      allowances.map((a) =>
        committedAs(SEED.manager, (run) =>
          run.query(`select * from app.pay_allowances(array[$1]::uuid[], $2, $3)`, [
            a.id,
            account,
            requestId('allowance-race'),
          ]),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(2);
    expect(await balanceOf(account)).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
describe('payroll', () => {
  /**
   * A committed, prepared weekly payroll in a period of its own.
   *
   * Earlier runs of this suite leave their own weekly employees behind, so a
   * payroll may hold more than the person created here. Its net total is read
   * back from the payroll itself and every assertion is made against that.
   */
  async function payroll(
    salary = 600_000,
    week?: string,
  ): Promise<{ id: string; staff: string; net: number }> {
    const staff = await employee(salary);
    const monday = week ?? (await freeWeeks(1))[0];
    const id = await committedAs(SEED.admin, async (run) => {
      const created = (
        await run.query(
          `select payroll_id from app.create_payroll('weekly', null, null, $1::date)`,
          [monday],
        )
      )[0].payroll_id as string;
      await run.query(`select * from app.prepare_payroll($1)`, [created]);
      return created;
    });
    const net = Number(
      (
        await committedAs(null, (run) =>
          run.query(`select total_net_ugx from public.payroll where id = $1`, [id]),
        )
      )[0].total_net_ugx,
    );
    return { id, staff, net };
  }

  async function approve(id: string) {
    await committedAs(SEED.manager, async (run) => {
      await run.query(`select app.update_payroll_status($1, 'submit')`, [id]);
      await run.query(`select app.update_payroll_status($1, 'review', null, 'Checked')`, [id]);
    });
    await committedAs(SEED.admin, (run) =>
      run.query(`select app.update_payroll_status($1, 'approve')`, [id]),
    );
  }

  it('creates only ONE payroll when two requests name the same period', async () => {
    const [week] = await freeWeeks(1);

    const outcomes = await settle(
      [1, 2].map(() =>
        committedAs(SEED.manager, (run) =>
          run.query(`select * from app.create_payroll('weekly', null, null, $1::date)`, [week]),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(
      await committedAs(null, (run) =>
        run.query(`select id from public.payroll where period_key = $1 and status <> 'cancelled'`, [
          `W${week}`,
        ]),
      ),
    ).toHaveLength(1);
  });

  it('leaves ONE current payslip per person when two preparations race', async () => {
    const prepared = await payroll();

    await settle(
      [1, 2].map(() =>
        committedAs(SEED.manager, (run) =>
          run.query(`select * from app.prepare_payroll($1, 'Recalculating')`, [prepared.id]),
        ),
      ),
    );

    const rows = await committedAs(null, (run) =>
      run.query(
        `select id from public.payroll_items where payroll_id = $1 and staff_uid = $2 and current`,
        [prepared.id, prepared.staff],
      ),
    );
    expect(rows).toHaveLength(1);
  });

  it('approves once when two approvals arrive together', async () => {
    const prepared = await payroll();
    await committedAs(SEED.manager, async (run) => {
      await run.query(`select app.update_payroll_status($1, 'submit')`, [prepared.id]);
      await run.query(`select app.update_payroll_status($1, 'review', null, 'Checked')`, [
        prepared.id,
      ]);
    });

    const outcomes = await settle(
      [1, 2].map(() =>
        committedAs(SEED.admin, (run) =>
          run.query(`select app.update_payroll_status($1, 'approve')`, [prepared.id]),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    const rows = await committedAs(null, (run) =>
      run.query(`select status, approved_at from public.payroll where id = $1`, [prepared.id]),
    );
    expect(rows[0].status).toBe('approved');
  });

  it('pays once when two payments arrive at the same moment', async () => {
    const prepared = await payroll(600_000);
    const account = await fundedAccount(prepared.net + 100_000);
    await approve(prepared.id);

    const outcomes = await settle(
      [1, 2].map(() =>
        committedAs(SEED.admin, (run) =>
          run.query(`select * from app.pay_payroll($1, $2, $3)`, [
            prepared.id,
            account,
            requestId('concurrent-payroll'),
          ]),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(account)).toBe(100_000);
    const entries = await committedAs(null, (run) =>
      run.query(`select id from public.financial_transactions where reference_id = $1`, [
        prepared.id,
      ]),
    );
    expect(entries).toHaveLength(1);
  });

  it('pays once for a repeated payment request id', async () => {
    const prepared = await payroll(600_000);
    const account = await fundedAccount(prepared.net + 100_000);
    await approve(prepared.id);
    const key = requestId('payroll-idempotent');

    const first = await committedAs(SEED.admin, (run) =>
      run.query(`select * from app.pay_payroll($1, $2, $3)`, [prepared.id, account, key]),
    );
    const again = await committedAs(SEED.admin, (run) =>
      run.query(`select * from app.pay_payroll($1, $2, $3)`, [prepared.id, account, key]),
    );

    expect(again[0].transaction_number).toBe(first[0].transaction_number);
    expect(await balanceOf(account)).toBe(100_000);
  });

  it('refuses the same request id for a different payroll payment', async () => {
    const one = await payroll(600_000);
    const two = await payroll(600_000);
    const account = await fundedAccount(one.net + two.net + 100_000);
    await approve(one.id);
    await approve(two.id);
    const key = requestId('payroll-shared');

    await committedAs(SEED.admin, (run) =>
      run.query(`select * from app.pay_payroll($1, $2, $3)`, [one.id, account, key]),
    );
    await expect(
      committedAs(SEED.admin, (run) =>
        run.query(`select * from app.pay_payroll($1, $2, $3)`, [two.id, account, key]),
      ),
    ).rejects.toThrow(/already used for a different request/i);
    expect(await balanceOf(account)).toBe(two.net + 100_000);
  });

  it('spends no more than the account holds when two payrolls race for it', async () => {
    const one = await payroll(600_000);
    const two = await payroll(600_000);
    // Room for one of them and no more.
    const account = await fundedAccount(Math.max(one.net, two.net) + 100_000);
    await approve(one.id);
    await approve(two.id);

    const outcomes = await settle(
      [one, two].map((p) =>
        committedAs(SEED.admin, (run) =>
          run.query(`select * from app.pay_payroll($1, $2, $3)`, [
            p.id,
            account,
            requestId('payroll-race'),
          ]),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(account)).toBeGreaterThanOrEqual(0);
    expect(await balanceOf(account)).toBeLessThanOrEqual(100_000 + Math.abs(one.net - two.net));
  });
});

// ---------------------------------------------------------------------------
describe('loss recovery', () => {
  /** A committed incident, decided, with `recovery` approved against one person. */
  async function scheduledLoss(staff: string, recovery: number, instalment: number, from: string) {
    const incident = await committedAs(SEED.manager, async (run) => {
      const id = (
        await run.query(
          `select incident_id from app.create_loss_incident('damaged_equipment', 300000,
           'Concurrent fixture', $1, $2)`,
          [requestId('loss'), staff],
        )
      )[0].incident_id as string;
      await run.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: SEED.admin, role: 'authenticated' })}'`,
      );
      await run.query(`select app.decide_loss_incident($1, 'approve', 'Careless handling', $2)`, [
        id,
        recovery,
      ]);
      return id;
    });
    await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.schedule_loss_recovery($1, $2, $3::date)`, [
        incident,
        instalment,
        from,
      ]),
    );
    return incident;
  }

  it('schedules the recovery once when two requests arrive together', async () => {
    const staff = await employee();
    const incident = await committedAs(SEED.manager, async (run) => {
      const id = (
        await run.query(
          `select incident_id from app.create_loss_incident('stock_loss', 200000,
           'Concurrent fixture', $1, $2)`,
          [requestId('loss'), staff],
        )
      )[0].incident_id as string;
      await run.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: SEED.admin, role: 'authenticated' })}'`,
      );
      await run.query(`select app.decide_loss_incident($1, 'approve', 'Careless', 100000)`, [id]);
      return id;
    });

    const outcomes = await settle(
      [1, 2].map(() =>
        committedAs(SEED.manager, (run) =>
          run.query(`select * from app.schedule_loss_recovery($1, 50000, app.eat_day() - 400)`, [
            incident,
          ]),
        ),
      ),
    );

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(
      await committedAs(null, (run) =>
        run.query(
          `select id from public.salary_deductions where loss_incident_id = $1 and status = 'active'`,
          [incident],
        ),
      ),
    ).toHaveLength(1);
  });

  /**
   * TWO PAYROLLS CANNOT BOTH TAKE THE SAME INSTALMENT. Each recomputes the
   * outstanding amount under a row lock at payment, so the second one either
   * takes what is left or is refused as stale.
   */
  it('recovers the instalment once when two payrolls are paid at the same moment', async () => {
    const staff = await employee(600_000);
    const weeks = await freeWeeks(2);
    const earliest = weeks.slice().sort()[0];

    // The person is paid weekly, so two weekly payrolls both plan the same
    // recovery.
    const incident = await scheduledLoss(staff, 150_000, 50_000, earliest);

    const payrolls: string[] = [];
    for (const week of weeks) {
      payrolls.push(
        await committedAs(SEED.manager, async (run) => {
          const id = (
            await run.query(
              `select payroll_id from app.create_payroll('weekly', null, null, $1::date)`,
              [week],
            )
          )[0].payroll_id as string;
          await run.query(`select * from app.prepare_payroll($1)`, [id]);
          await run.query(`select app.update_payroll_status($1, 'submit')`, [id]);
          await run.query(`select app.update_payroll_status($1, 'review', null, 'Checked')`, [id]);
          return id;
        }),
      );
    }
    for (const id of payrolls) {
      await committedAs(SEED.admin, (run) =>
        run.query(`select app.update_payroll_status($1, 'approve')`, [id]),
      );
    }
    const total = Number(
      (
        await committedAs(null, (run) =>
          run.query(
            `select coalesce(sum(total_net_ugx), 0) as n from public.payroll where id = any($1::uuid[])`,
            [payrolls],
          ),
        )
      )[0].n,
    );
    const account = await fundedAccount(total + 100_000);

    await settle(
      payrolls.map((id) =>
        committedAs(SEED.admin, (run) =>
          run.query(`select * from app.pay_payroll($1, $2, $3)`, [
            id,
            account,
            requestId('loss-race'),
          ]),
        ),
      ),
    );

    const rows = await committedAs(null, (run) =>
      run.query(`select recovered_ugx, outstanding_ugx from public.loss_incidents where id = $1`, [
        incident,
      ]),
    );
    // Whichever of the two got there first, the incident is short by exactly
    // the instalments that were actually applied — never by more.
    const applications = await committedAs(null, (run) =>
      run.query(
        `
      select coalesce(sum(a.amount_ugx), 0) as total
        from public.deduction_applications a
        join public.salary_deductions d on d.id = a.deduction_id
       where d.loss_incident_id = $1 and not a.reversed`,
        [incident],
      ),
    );
    expect(ugx(rows[0].recovered_ugx)).toBe(ugx(applications[0].total));
    expect(ugx(rows[0].recovered_ugx) + ugx(rows[0].outstanding_ugx)).toBe(150_000);
    expect(ugx(rows[0].recovered_ugx)).toBeLessThanOrEqual(100_000);
  });
});
