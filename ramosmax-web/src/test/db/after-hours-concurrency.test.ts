import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, SEED } from './harness';
import { requestId } from './billing-helpers';

afterAll(closePool);

/**
 * IDEMPOTENCY AND CONCURRENCY for after-hours work and cash handovers.
 *
 * These tests COMMIT. Two people counting the same cash at the same moment,
 * or a worker tapping "open session" twice on a slow connection, cannot be
 * proved with a rolled-back transaction.
 *
 * Every assertion is therefore RELATIVE or scoped to the fixtures this test
 * created: the database keeps whatever the other suites left behind.
 */

interface Runner {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

async function committedAs<T>(uid: string | null, fn: (run: Runner) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    if (uid !== null) {
      await client.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`);
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

/** A committed user with the given role and permissions. */
async function committedUser(role: string, permissions: string[]): Promise<string> {
  return committedAs(null, async (run) => {
    const id = (await run.query(
      `insert into auth.users (email) values (app.new_sign_in_identity()) returning id`))[0].id as string;
    await run.query(
      `insert into public.users (id, phone_number, full_name, role, active, permissions)
       values ($1, $2, $3, $4, true, $5)`,
      [id, `+2567${String(Math.floor(Math.random() * 89_999_999) + 10_000_000)}`,
       unique(`Concurrent ${role}`), role, permissions]);
    return id;
  });
}

async function authorized(staff: string, boss: string, floatUgx = 60_000): Promise<string> {
  return committedAs(boss, async (run) =>
    (await run.query(
      `select authorization_id as id from app.authorize_after_hours(
         $1, now() + interval '8 hours', 'Evening shift', $2, null, null, $3)`,
      [staff, requestId('auth'), floatUgx]))[0].id as string);
}

async function openSessionFor(staff: string): Promise<string> {
  return committedAs(staff, async (run) =>
    (await run.query(`select session_id as id from app.open_after_hours_session($1)`,
      [requestId('open')]))[0].id as string);
}

async function closedHandover(staff: string, session: string): Promise<string> {
  return committedAs(staff, async (run) =>
    (await run.query(`select handover_id as id from app.close_after_hours_session($1)`,
      [session]))[0].id as string);
}

const countWhere = async (table: string, where: string, params: unknown[]) =>
  Number((await committedAs(null, (run) =>
    run.query(`select count(*)::text as n from public.${table} where ${where}`, params)))[0].n);

describe('after-hours concurrency', () => {
  it('1. two simultaneous opens leave exactly one session', async () => {
    const boss = await committedUser('manager', ['after_hours.approve']);
    const staff = await committedUser('worker', ['after_hours.request']);
    await authorized(staff, boss, 0);

    const results = await settle([
      committedAs(staff, (run) =>
        run.query(`select * from app.open_after_hours_session($1)`, [requestId('race-a')])),
      committedAs(staff, (run) =>
        run.query(`select * from app.open_after_hours_session($1)`, [requestId('race-b')])),
    ]);
    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(await countWhere('after_hours_sessions', 'staff_uid = $1 and status = $2',
      [staff, 'open'])).toBe(1);
  });

  it('2. the same request id opens one session, however many times it is sent', async () => {
    const boss = await committedUser('manager', ['after_hours.approve']);
    const staff = await committedUser('worker', ['after_hours.request']);
    await authorized(staff, boss, 0);
    const id = requestId('idem-open');

    await settle([
      committedAs(staff, (run) =>
        run.query(`select * from app.open_after_hours_session($1)`, [id])),
      committedAs(staff, (run) =>
        run.query(`select * from app.open_after_hours_session($1)`, [id])),
    ]);
    expect(await countWhere('after_hours_sessions', 'staff_uid = $1', [staff])).toBe(1);
  });

  it('3. two simultaneous closes create exactly one handover', async () => {
    const boss = await committedUser('manager',
      ['after_hours.approve', 'after_hours.request', 'after_hours.view']);
    const staff = await committedUser('worker', ['after_hours.request']);
    await authorized(staff, boss);
    const session = await openSessionFor(staff);

    const results = await settle([
      committedAs(staff, (run) =>
        run.query(`select * from app.close_after_hours_session($1)`, [session])),
      committedAs(boss, (run) =>
        run.query(`select * from app.close_after_hours_session($1)`, [session])),
    ]);
    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(await countWhere('cash_handovers', 'session_id = $1', [session])).toBe(1);
  });

  it('4. two simultaneous counts record exactly one', async () => {
    const boss = await committedUser('manager', ['after_hours.approve']);
    const staff = await committedUser('worker', ['after_hours.request']);
    const first = await committedUser('manager', ['cash_handover.approve']);
    const second = await committedUser('manager', ['cash_handover.approve']);
    await authorized(staff, boss);
    const handover = await closedHandover(staff, await openSessionFor(staff));

    const results = await settle([
      committedAs(first, (run) =>
        run.query(`select * from app.receive_cash_handover($1, 60000, $2)`,
          [handover, requestId('count-a')])),
      committedAs(second, (run) =>
        run.query(`select * from app.receive_cash_handover($1, 55000, $2, 'Short')`,
          [handover, requestId('count-b')])),
    ]);
    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    // One count, and at most one discrepancy from it.
    expect(await countWhere('cash_discrepancies', 'handover_id = $1', [handover]))
      .toBeLessThanOrEqual(1);
    const { status } = (await committedAs(null, (run) =>
      run.query(`select status from public.cash_handovers where id = $1`, [handover])))[0] as {
      status: string;
    };
    expect(['received', 'discrepancy']).toContain(status);
  });

  it('5. two simultaneous submissions record exactly one declaration', async () => {
    const boss = await committedUser('manager', ['after_hours.approve']);
    const staff = await committedUser('worker', ['after_hours.request']);
    await authorized(staff, boss);
    const handover = await closedHandover(staff, await openSessionFor(staff));

    const results = await settle([
      committedAs(staff, (run) =>
        run.query(`select * from app.submit_cash_handover($1, 60000, $2)`,
          [handover, requestId('submit-a')])),
      committedAs(staff, (run) =>
        run.query(`select * from app.submit_cash_handover($1, 10000, $2)`,
          [handover, requestId('submit-b')])),
    ]);
    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    const { declared_amount_ugx } = (await committedAs(null, (run) =>
      run.query(`select declared_amount_ugx from public.cash_handovers where id = $1`,
        [handover])))[0] as { declared_amount_ugx: string };
    expect([60_000, 10_000]).toContain(Number(declared_amount_ugx));
  });

  it('6. two simultaneous resolutions close it once, and report one loss at most', async () => {
    const boss = await committedUser('manager', ['after_hours.approve']);
    const staff = await committedUser('worker', ['after_hours.request']);
    const counter = await committedUser('manager', ['cash_handover.approve']);
    const reviewer = await committedUser('manager',
      ['after_hours.discrepancy.review', 'losses.create']);
    await authorized(staff, boss);
    const handover = await closedHandover(staff, await openSessionFor(staff));
    const discrepancy = (await committedAs(counter, (run) =>
      run.query(`select discrepancy_id as id from app.receive_cash_handover($1, 55000, $2, 'Short')`,
        [handover, requestId('short')])))[0].id as string;

    const results = await settle([
      committedAs(reviewer, (run) =>
        run.query(
          `select * from app.resolve_cash_discrepancy($1, 'resolved', 'Recovering', $2, true)`,
          [discrepancy, requestId('res-a')])),
      committedAs(reviewer, (run) =>
        run.query(
          `select * from app.resolve_cash_discrepancy($1, 'waived', 'Letting it go', $2)`,
          [discrepancy, requestId('res-b')])),
    ]);
    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(await countWhere('loss_incidents', 'source_id = $1', [discrepancy]))
      .toBeLessThanOrEqual(1);
  });

  it('7. two simultaneous authorisations for the same evening leave one', async () => {
    const boss = await committedUser('manager', ['after_hours.approve']);
    const staff = await committedUser('worker', ['after_hours.request']);

    const results = await settle([
      committedAs(boss, (run) =>
        run.query(`select * from app.authorize_after_hours(
           $1, now() + interval '6 hours', 'Evening', $2)`, [staff, requestId('auth-a')])),
      committedAs(boss, (run) =>
        run.query(`select * from app.authorize_after_hours(
           $1, now() + interval '6 hours', 'Evening', $2)`, [staff, requestId('auth-b')])),
    ]);
    expect(results.filter((r) => r === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await countWhere('after_hours_access', 'staff_uid = $1 and status = $2',
      [staff, 'active'])).toBe(1);
  });

  it('8. a close racing a payment still agrees with the payments themselves', async () => {
    const boss = await committedUser('manager', ['after_hours.approve']);
    const staff = await committedUser('worker', ['after_hours.request', 'invoices.view']);
    await authorized(staff, boss, 50_000);
    const session = await openSessionFor(staff);

    // An invoice the worker can pay. The intake and the invoice go through the
    // real functions as a cashier; the work in between is arranged directly.
    const vehicle = await committedAs(null, async (run) =>
      (await run.query(
        `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
         values ($1, app.plate_key($1), 'Model', 'Colour',
                 (select id from public.customers order by customer_number limit 1))
         returning id`, [`UAJ ${Math.floor(Math.random() * 900 + 100)}Z`]))[0].id as string);
    const intake = await committedAs(SEED.cashier, async (run) => {
      const service = (await run.query(
        `select id from public.services where name = 'Body Wash'`))[0].id as string;
      return (await run.query(`select app.create_service_intake($1, array[$2::uuid]) as id`,
        [vehicle, service]))[0].id as string;
    });
    // The work itself goes through the real flow: assigned, accepted, started
    // and completed by the seeded manager and worker, in daylight.
    const orders = await committedAs(null, async (run) =>
      (await run.query(`select id from public.worker_orders where service_intake_id = $1`,
        [intake])).map((o) => o.id as string));
    await committedAs(SEED.manager, async (run) => {
      for (const order of orders) {
        await run.query(`select app.assign_worker_order($1, $2)`, [order, SEED.worker]);
      }
    });
    await committedAs(SEED.worker, async (run) => {
      for (const order of orders) {
        for (const action of ['accept', 'start', 'complete']) {
          await run.query(`select app.update_worker_order_status($1, $2)`, [order, action]);
        }
      }
    });
    const invoice = await committedAs(SEED.cashier, async (run) =>
      (await run.query(`select app.create_invoice($1) as id`, [intake]))[0].id as string);

    await settle([
      committedAs(staff, (run) =>
        run.query(`select * from app.record_payment($1, 15000, 'cash', $2)`,
          [invoice, requestId('race-pay')])),
      committedAs(staff, (run) =>
        run.query(`select * from app.close_after_hours_session($1)`, [session])),
    ]);

    // Whatever order they landed in, the frozen figure equals the float plus
    // the cash payments the session actually holds.
    const [{ expected_cash_ugx: expected }] = (await committedAs(null, (run) =>
      run.query(`select expected_cash_ugx from public.after_hours_sessions where id = $1`,
        [session]))) as [{ expected_cash_ugx: string }];
    const [{ cash }] = (await committedAs(null, (run) =>
      run.query(
        `select coalesce(sum(amount_ugx) filter
                  (where method = 'cash' and status <> 'reversed'), 0)::text as cash
           from public.payments where after_hours_session_id = $1`, [session]))) as [
      { cash: string },
    ];
    expect(Number(expected)).toBe(50_000 + Number(cash));
  });
});
