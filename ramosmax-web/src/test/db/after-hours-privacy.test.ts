import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';
import { invoicedJob } from './billing-helpers';
import {
  authorize, becomeClient, becomeOwner, closeSession, collect, eligibleWorker, makeUser,
  openSession, requestId, SEED, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

type Db = Parameters<Parameters<typeof asAdminDb>[0]>[0];

/** Two workers, each with a closed session and a handover of their own. */
async function twoWorkers(db: Db) {
  const boss = await supervisor(db);
  const made = [];
  for (const float of [60_000, 70_000]) {
    const staff = await eligibleWorker(db);
    await authorize(db, { staff, by: boss, floatUgx: float });
    const session = await openSession(db, staff);
    const closed = await closeSession(db, session.session_id, staff);
    made.push({ staff, session: session.session_id, handover: closed.handover_id! });
  }
  return { boss, first: made[0], second: made[1] };
}

const countOf = async (db: Db, table: string, where = 'true', params: unknown[] = []) => {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from public.${table} where ${where}`, params);
  return Number(rows[0].n);
};

/**
 * PRIVACY, PROVED AT THE TABLE.
 *
 * Every query below runs as the role itself, against the tables — not through
 * a screen. A worker on the forecourt reads their own night's work and
 * nothing about anybody else's.
 */
describe('after-hours privacy: a worker sees their own and no one else’s', () => {
  it('reads their own session, custody and handover only', async () => {
    await asAdminDb(async (db) => {
      const { first, second } = await twoWorkers(db);

      await becomeClient(db, first.staff);
      expect(await countOf(db, 'after_hours_sessions')).toBe(1);
      expect(await countOf(db, 'after_hours_sessions', 'id = $1', [second.session])).toBe(0);
      expect(await countOf(db, 'cash_handovers')).toBe(1);
      expect(await countOf(db, 'cash_handovers', 'id = $1', [second.handover])).toBe(0);
      expect(await countOf(db, 'after_hours_cash', 'staff_uid = $1', [second.staff])).toBe(0);
      await becomeOwner(db);
    });
  });

  it('reads their own authorisation only', async () => {
    await asAdminDb(async (db) => {
      const { first, second } = await twoWorkers(db);
      await becomeClient(db, first.staff);
      const { rows } = await db.query<{ staff_uid: string }>(
        `select staff_uid from public.after_hours_access`);
      expect(rows.every((r) => r.staff_uid === first.staff)).toBe(true);
      expect(rows.some((r) => r.staff_uid === second.staff)).toBe(false);
      await becomeOwner(db);
    });
  });

  it('cannot change what the server expects them to hand over', async () => {
    await asAdminDb(async (db) => {
      const { first } = await twoWorkers(db);
      await becomeClient(db, first.staff);
      for (const [table, column] of [
        ['after_hours_sessions', 'expected_cash_ugx'],
        ['cash_handovers', 'expected_cash_ugx'],
        ['cash_handovers', 'actual_amount_ugx'],
        ['after_hours_cash', 'cash_delta_ugx'],
      ]) {
        expect(
          await db.expectError(`update public.${table} set ${column} = 1`),
          `${table}.${column}`,
        ).toMatch(/permission denied|denied for table/i);
      }
      await becomeOwner(db);
    });
  });

  it('cannot insert a custody entry, a session or a handover', async () => {
    await asAdminDb(async (db) => {
      const { first } = await twoWorkers(db);
      await becomeClient(db, first.staff);
      for (const sql of [
        `insert into public.after_hours_cash (entry_number, kind, session_id, session_number,
           staff_uid, staff_name, amount_ugx) values ('X', 'payment', gen_random_uuid(), 'X',
           auth.uid(), 'X', 1)`,
        `insert into public.cash_handovers (handover_number, session_id, session_number,
           staff_uid, staff_name, expected_cash_ugx)
         values ('X', gen_random_uuid(), 'X', auth.uid(), 'X', 1)`,
        `insert into public.after_hours_access (authorization_number, staff_uid, staff_name,
           staff_role, starts_at, expires_at, reason)
         values ('X', auth.uid(), 'X', 'worker', now(), now() + interval '1 hour', 'X')`,
      ]) {
        expect(await db.expectError(sql)).toMatch(/permission denied/i);
      }
      await becomeOwner(db);
    });
  });

  it('a worker without after_hours.request sees nothing at all', async () => {
    await asAdminDb(async (db) => {
      await twoWorkers(db);
      const outsider = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, outsider);
      expect(await countOf(db, 'after_hours_sessions')).toBe(0);
      expect(await countOf(db, 'after_hours_access')).toBe(0);
      expect(await countOf(db, 'after_hours_cash')).toBe(0);
      expect(await countOf(db, 'cash_discrepancies')).toBe(0);
      await becomeOwner(db);
    });
  });
});

describe('after-hours privacy: my_after_hours serves the caller and only the caller', () => {
  it('returns the caller’s own record', async () => {
    await asAdminDb(async (db) => {
      const { first } = await twoWorkers(db);
      await becomeClient(db, first.staff);
      const { rows } = await db.query<{ mine: Record<string, unknown> }>(
        `select app.my_after_hours() as mine`);
      await becomeOwner(db);
      const handovers = rows[0].mine.handovers as Array<Record<string, unknown>>;
      expect(handovers).toHaveLength(1);
      expect(Number(handovers[0].expectedCashUgx)).toBe(60_000);
    });
  });

  it('never mentions another worker’s handover', async () => {
    await asAdminDb(async (db) => {
      const { first, second } = await twoWorkers(db);
      await becomeClient(db, first.staff);
      const { rows } = await db.query<{ mine: unknown }>(`select app.my_after_hours() as mine`);
      await becomeOwner(db);
      const text = JSON.stringify(rows[0].mine);
      expect(text).not.toContain(second.staff);
      expect(text).not.toContain('70000');
    });
  });

  it('refuses a role with no after-hours standing at all', async () => {
    await asAdminDb(async (db) => {
      const outsider = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, outsider);
      expect(await db.expectError(`select app.my_after_hours()`))
        .toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});

describe('after-hours privacy: the supervising roles', () => {
  it('a manager with cash_handover.approve sees the handovers to receive', async () => {
    await asAdminDb(async (db) => {
      const { first, second } = await twoWorkers(db);
      const counter = await makeUser(db, {
        role: 'manager', permissions: ['cash_handover.approve'],
      });
      await becomeClient(db, counter);
      expect(await countOf(db, 'cash_handovers', 'id = $1', [first.handover])).toBe(1);
      expect(await countOf(db, 'cash_handovers', 'id = $1', [second.handover])).toBe(1);
      await becomeOwner(db);
    });
  });

  it('an auditor reads the operational picture and cannot change it', async () => {
    await asAdminDb(async (db) => {
      const { first } = await twoWorkers(db);
      await becomeClient(db, SEED.auditor);
      expect(await countOf(db, 'after_hours_sessions', 'id = $1', [first.session])).toBe(1);
      expect(await db.expectError(
        `select * from app.receive_cash_handover($1, 60000, $2)`,
        [first.handover, requestId('auditor')])).toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });

  it('a customer’s payment still carries no session detail to the wrong reader', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 411X');
      expect(await collect(db, { invoice: job.invoice, amount: 15_000, by: staff })).toBeNull();

      // The tag is on the payment, which only the billing readers see; the
      // SESSION behind it stays closed to somebody with no after-hours standing.
      const outsider = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, outsider);
      expect(await countOf(db, 'after_hours_sessions', 'id = $1', [session.session_id])).toBe(0);
      await becomeOwner(db);
    });
  });
});

describe('after-hours privacy: the events feed', () => {
  it('delivers a personal event to its recipient only', async () => {
    await asAdminDb(async (db) => {
      const { first, second } = await twoWorkers(db);
      await becomeClient(db, first.staff);
      const { rows } = await db.query<{ recipient_uid: string }>(
        `select recipient_uid from public.after_hours_events`);
      expect(rows.every((r) => r.recipient_uid === first.staff)).toBe(true);
      expect(rows.some((r) => r.recipient_uid === second.staff)).toBe(false);
      await becomeOwner(db);
    });
  });

  it('delivers an audience event only to holders of that permission', async () => {
    await asAdminDb(async (db) => {
      const { first } = await twoWorkers(db);
      const counter = await makeUser(db, {
        role: 'manager', permissions: ['cash_handover.approve'],
      });
      const outsider = await makeUser(db, { role: 'cashier' });

      await becomeClient(db, counter);
      expect(await countOf(db, 'after_hours_events',
        `audience = 'cash_handover.approve' and reference_id = $1`, [first.handover]))
        .toBeGreaterThan(0);
      await becomeClient(db, outsider);
      expect(await countOf(db, 'after_hours_events',
        `audience = 'cash_handover.approve'`)).toBe(0);
      await becomeOwner(db);
    });
  });
});
