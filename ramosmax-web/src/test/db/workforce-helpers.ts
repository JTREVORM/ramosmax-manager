/**
 * Fixtures for the Phase F suites.
 *
 * Everything here goes through the real functions — a salary is set by an
 * Administrator, attendance is recorded by a manager, an allowance is
 * calculated by the same rule the business uses. Nothing is inserted behind
 * the server's back, because a fixture that skips the rules proves nothing.
 */
import { asAdminDb, becomeClient, becomeOwner, makeUser, type Session, SEED } from './harness';
import { requestId } from './billing-helpers';
import { accountId, fund } from './finance-helpers';

/** A worker with a salary, ready to attend, earn and be paid. */
export async function employ(
  db: Session,
  options: {
    role?: string;
    salaryUgx?: number;
    from?: string;
    frequency?: string;
    allowanceEligible?: boolean;
    allowanceUgx?: number | null;
  } = {},
): Promise<string> {
  const uid = await makeUser(db, { role: options.role ?? 'worker' });
  await becomeClient(db, SEED.admin);
  await db.query(`select * from app.set_salary_profile($1, $2, $3, $4, $5, $6, true, 'Fixture')`, [
    uid,
    options.salaryUgx ?? 600_000,
    options.from ?? '2020-01-01',
    options.frequency ?? 'monthly',
    options.allowanceEligible ?? true,
    options.allowanceUgx ?? null,
  ]);
  await becomeOwner(db);
  return uid;
}

export interface AttendanceRow {
  attendance_id: string;
  attendance_number: string;
  arrival_status: string;
  minutes_late: number;
  late: boolean;
}

/**
 * A manager records [staff] as arriving at [time] (HH:MM in EAT) on [day].
 * A null time records an absence.
 */
export async function attend(
  db: Session,
  staff: string,
  day: string,
  time: string | null = '08:00',
  arrival = time === null ? 'absent' : 'present',
  by: string = SEED.manager,
): Promise<AttendanceRow> {
  await becomeClient(db, by);
  const { rows } = await db.query<AttendanceRow>(
    `select * from app.record_attendance($1, $2, $3::date, (($3::date + $4::time) at time zone 'Africa/Kampala'), null, null)`,
    [staff, arrival, day, time],
  );
  await becomeOwner(db);
  return { ...rows[0], minutes_late: Number(rows[0].minutes_late) };
}

/** Verified attendance is what an allowance is calculated from. */
export async function verify(db: Session, ids: string[], by: string = SEED.manager): Promise<void> {
  await becomeClient(db, by);
  await db.query(`select app.verify_attendance($1::uuid[], 'approve', 'Checked')`, [ids]);
  await becomeOwner(db);
}

export interface AllowanceRow {
  allowance_id: string;
  allowance_number: string;
  staff_name: string;
  amount_ugx: number;
  status: string;
  skipped_reason: string | null;
}

export async function calculateAllowances(
  db: Session,
  day: string,
  by: string = SEED.manager,
): Promise<AllowanceRow[]> {
  await becomeClient(db, by);
  const { rows } = await db.query<AllowanceRow>(
    `select * from app.calculate_allowances($1::date)`,
    [day],
  );
  await becomeOwner(db);
  return rows.map((r) => ({ ...r, amount_ugx: Number(r.amount_ugx) }));
}

/** The allowance calculated for one person on one day, whatever its state. */
export async function allowanceOf(db: Session, staff: string, day: string) {
  const { rows } = await db.query<Record<string, string | null>>(
    `select * from public.worker_allowances
      where staff_uid = $1 and business_day = $2::date and status <> 'cancelled'`,
    [staff, day],
  );
  return rows[0] ?? null;
}

/**
 * The shared cash account, holding at least [amount].
 *
 * An opening balance can be recorded only once, and the workflow scripts
 * commit one. Where it already exists the float is topped up the way the
 * business would: an authorised adjustment.
 */
export async function payingAccount(db: Session, amount = 5_000_000): Promise<string> {
  const id = await accountId(db, 'cash_at_hand');
  const { rows } = await db.query<{ opening_balance_recorded: boolean }>(
    `select opening_balance_recorded from public.financial_accounts where id = $1`,
    [id],
  );
  await becomeClient(db, SEED.admin);
  if (rows[0].opening_balance_recorded) {
    await db.query(`select * from app.record_account_adjustment($1, 'in', $2, 'Test float', $3)`, [
      id,
      amount,
      requestId('float'),
    ]);
  } else {
    await db.query(`select * from app.record_opening_balance($1, $2, 'Test float')`, [id, amount]);
  }
  await becomeOwner(db);
  return id;
}

/** Money in UGX, as a number. */
export const ugx = (v: unknown): number => Number(v ?? 0);

/** A loss incident already decided, with [recovery] approved against [staff]. */
export async function approvedLoss(
  db: Session,
  staff: string,
  amount = 300_000,
  recovery = 150_000,
): Promise<{ incident: string; lossNumber: string }> {
  await becomeClient(db, SEED.manager);
  const { rows } = await db.query<{ incident_id: string; loss_number: string }>(
    `select * from app.create_loss_incident('damaged_equipment', $1, 'A broken polisher', $2, $3)`,
    [amount, requestId('loss'), staff],
  );
  await db.query(`select app.review_loss_incident($1, 'Looking into it')`, [rows[0].incident_id]);
  await becomeClient(db, SEED.admin);
  await db.query(`select app.decide_loss_incident($1, 'approve', 'Careless handling', $2)`, [
    rows[0].incident_id,
    recovery,
  ]);
  await becomeOwner(db);
  return { incident: rows[0].incident_id, lossNumber: rows[0].loss_number };
}

export { asAdminDb, becomeClient, becomeOwner, makeUser, requestId, SEED, accountId, fund };

/** A payroll for a month, prepared from whatever the period holds. */
export async function preparePayroll(
  db: Session,
  year: number,
  month: number,
  by: string = SEED.manager,
): Promise<{ payroll: string; number: string }> {
  await becomeClient(db, by);
  const { rows } = await db.query<{ payroll_id: string; payroll_number: string }>(
    `select * from app.create_payroll('monthly', $1, $2)`,
    [year, month],
  );
  await db.query(`select * from app.prepare_payroll($1)`, [rows[0].payroll_id]);
  await becomeOwner(db);
  return { payroll: rows[0].payroll_id, number: rows[0].payroll_number };
}

/** One person's line in a payroll, as the server calculated it. */
export async function payslip(db: Session, payroll: string, staff: string) {
  const { rows } = await db.query<Record<string, string | null>>(
    `select * from public.payroll_items
      where payroll_id = $1 and staff_uid = $2 and current`,
    [payroll, staff],
  );
  return rows[0] ?? null;
}

/** Takes a payroll all the way to approved, ready to pay. */
export async function approvePayroll(db: Session, payroll: string): Promise<void> {
  await becomeClient(db, SEED.manager);
  await db.query(`select app.update_payroll_status($1, 'submit')`, [payroll]);
  await db.query(`select app.update_payroll_status($1, 'review', null, 'Checked')`, [payroll]);
  await becomeClient(db, SEED.admin);
  await db.query(`select app.update_payroll_status($1, 'approve')`, [payroll]);
  await becomeOwner(db);
}

/**
 * An account of its own holding exactly [amount].
 *
 * The shared `cash_at_hand` carries whatever the committing suites left in it,
 * so a test about running out of money needs an account nobody else touches.
 */
export async function ownAccount(db: Session, amount: number): Promise<string> {
  await becomeClient(db, SEED.admin);
  const { rows } = await db.query<{ id: string }>(
    `select app.create_financial_account($1, 'bank', 'Test Bank') as id`,
    [`Test Account ${Math.random().toString(36).slice(2, 8)}`],
  );
  if (amount > 0) {
    await db.query(`select * from app.record_opening_balance($1, $2, 'Test float')`, [
      rows[0].id,
      amount,
    ]);
  }
  await becomeOwner(db);
  return rows[0].id;
}

export interface TestPeriod {
  year: number;
  month: number;
  /** Two working days inside the period, both inside the backdating window. */
  days: string[];
  /** A working day in an earlier month. */
  earlier: string;
}

/**
 * A whole month to run a payroll over.
 *
 * The workflow scripts and the concurrency suite COMMIT, so the current month
 * may already have a payroll. This picks the most recent month that has none,
 * and two of its working days that are still inside the backdating window.
 */
export async function recentPeriod(db: Session): Promise<TestPeriod> {
  const { rows } = await db.query<{
    year: number;
    month: number;
    first_day: string;
    second_day: string;
    earlier: string;
  }>(`
    with candidates as (
      select date_trunc('month', app.eat_day() - 10)::date as first
      union all
      select (date_trunc('month', app.eat_day() - 10) - interval '1 month')::date
    ),
    chosen as (
      select c.first from candidates c
       where not exists (select 1 from public.payroll p
                          where p.period_key = to_char(c.first, 'YYYY-MM')
                            and p.status <> 'cancelled')
       order by c.first desc limit 1
    ),
    working as (
      select g.d::date as d
        from chosen, generate_series(chosen.first,
                                     (chosen.first + interval '1 month' - interval '1 day')::date,
                                     interval '1 day') g(d)
       where g.d::date <= app.eat_day() - 1
         and g.d::date >= app.eat_day() - 60
         and extract(isodow from g.d) between 1 and 6
       order by g.d desc limit 2
    )
    select extract(year from chosen.first)::int as year,
           extract(month from chosen.first)::int as month,
           (select min(d)::text from working) as first_day,
           (select max(d)::text from working) as second_day,
           (select max(g.d)::date::text
              from generate_series(chosen.first - 25, chosen.first - 1, interval '1 day') g(d)
             where extract(isodow from g.d) between 1 and 6) as earlier
      from chosen`);
  const row = rows[0];
  if (!row || row.first_day === null) {
    throw new Error('no free payroll month with working days inside the backdating window');
  }
  return {
    year: row.year,
    month: row.month,
    days: [row.first_day, row.second_day],
    earlier: row.earlier,
  };
}
