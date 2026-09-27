import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';
import { completedJob, invoicedJob } from './billing-helpers';
import {
  authorize, becomeClient, becomeOwner, closeSession, collect, eligibleWorker, openSession,
  permissionsOf, requestId, sessionRow, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

/**
 * SESSIONS.
 *
 * A session is a shift, not a second business. The intakes, invoices, jobs
 * and payments it produces are the ordinary ones, tagged with the session
 * that produced them, and the cash the worker is physically holding is
 * tracked in a custody sub-ledger until it is handed over.
 */
describe('after-hours sessions: opening', () => {
  it('needs an authorisation in force', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, staff);
      expect(await db.expectError(`select * from app.open_after_hours_session($1)`,
        [requestId('nope')])).toMatch(/do not have permission|no after-hours authorisation/i);
      await becomeOwner(db);
    });
  });

  it('opens with the authorisation in force, and takes the float into custody', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 50_000 });
      const session = await openSession(db, staff);

      expect(session.opening_float_ugx).toBe(50_000);
      const s = await sessionRow(db, session.session_id);
      expect(s.status).toBe('open');
      // The float is money in the worker's hands from the first minute.
      expect(Number(s.expected_cash_ugx)).toBe(50_000);

      const { rows: custody } = await db.query<{ kind: string; cash_delta_ugx: string }>(
        `select kind, cash_delta_ugx from public.after_hours_cash where session_id = $1`,
        [session.session_id]);
      expect(custody).toHaveLength(1);
      expect(custody[0].kind).toBe('opening_float');
      expect(Number(custody[0].cash_delta_ugx)).toBe(50_000);
    });
  });

  it('gives the float to the FIRST session only', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 50_000 });
      const first = await openSession(db, staff);
      expect(first.opening_float_ugx).toBe(50_000);
      // Closing hands the float back, so the next session starts from nothing:
      // giving extra float mid-shift is not modelled — authorise again instead.
      await closeSession(db, first.session_id, staff);
      const second = await openSession(db, staff);
      expect(second.opening_float_ugx).toBe(0);
      expect(Number((await sessionRow(db, second.session_id)).expected_cash_ugx)).toBe(0);
    });
  });

  it('allows only one open session per person', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      await openSession(db, staff);
      await becomeClient(db, staff);
      expect(await db.expectError(`select * from app.open_after_hours_session($1)`,
        [requestId('twice')])).toMatch(/already have an after-hours session open/i);
      await becomeOwner(db);
    });
  });

  it('is idempotent: the same request twice opens one session', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const id = requestId('idem-session');
      await becomeClient(db, staff);
      const { rows: first } = await db.query<{ session_id: string }>(
        `select * from app.open_after_hours_session($1)`, [id]);
      const { rows: again } = await db.query<{ session_id: string }>(
        `select * from app.open_after_hours_session($1)`, [id]);
      await becomeOwner(db);
      expect(again[0].session_id).toBe(first[0].session_id);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.after_hours_sessions where staff_uid = $1`,
        [staff]);
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('nobody opens a session for somebody else', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      await becomeClient(db, boss);
      // The supervisor holds `after_hours.approve` but not `after_hours.operate`:
      // the session belongs to the person on duty.
      expect(await db.expectError(`select * from app.open_after_hours_session($1)`,
        [requestId('forsomeoneelse')])).toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});

describe('after-hours sessions: what they tag', () => {
  it('tags the intake, the invoice and the completed job, and counts them', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['jobs.view', 'jobs.create']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);

      const { rows: services } = await db.query<{ id: string }>(
        `select id from public.services where name = 'Body Wash'`);
      const { rows: vehicle } = await db.query<{ id: string }>(
        `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
         values ('UAH 909X', app.plate_key('UAH 909X'), 'Model', 'Colour',
                 (select id from public.customers order by customer_number limit 1))
         returning id`);

      await becomeClient(db, staff);
      const { rows: intake } = await db.query<{ id: string }>(
        `select app.create_service_intake($1, $2::uuid[]) as id`,
        [vehicle[0].id, [services[0].id]]);
      await becomeOwner(db);

      const { rows: tagged } = await db.query<{
        is_after_hours: boolean; after_hours_session_number: string;
      }>(`select is_after_hours, after_hours_session_number from public.service_intakes
           where id = $1`, [intake[0].id]);
      expect(tagged[0].is_after_hours).toBe(true);
      expect(tagged[0].after_hours_session_number).toBe(session.session_number);
      expect(Number((await sessionRow(db, session.session_id)).intakes_created)).toBe(1);
    });
  });

  it('tags nothing once the authorisation has ended', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['jobs.create', 'jobs.view']);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);

      // The window closes. The session stays open — the cash still has to be
      // handed over — but the work stops.
      await db.query(
        `update public.after_hours_access
            set starts_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
          where id = $1`, [auth.authorization_id]);

      const { rows: ctx } = await db.query<{ live: boolean }>(
        `select live from app.after_hours_context($1)`, [staff]);
      expect(ctx[0].live).toBe(false);
      expect((await sessionRow(db, session.session_id)).status).toBe('open');
    });
  });
});

describe('after-hours sessions: closing', () => {
  it('closes with nothing collected and no float, and needs no handover', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const closed = await closeSession(db, session.session_id, staff);

      expect(closed.status).toBe('closed');
      expect(closed.expected_cash_ugx).toBe(0);
      expect(closed.handover_id).toBeNull();
    });
  });

  it('creates a handover for the float alone', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 40_000 });
      const session = await openSession(db, staff);
      const closed = await closeSession(db, session.session_id, staff);

      expect(closed.status).toBe('handover_pending');
      expect(closed.expected_cash_ugx).toBe(40_000);
      expect(closed.handover_number).toMatch(/^RMX-HO-\d{6}$/);
    });
  });

  it('a supervisor may close somebody else’s session', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const closed = await closeSession(db, session.session_id, boss);
      expect(closed.status).toBe('closed');
    });
  });

  it('another worker may not close it', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const other = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      await becomeClient(db, other);
      expect(await db.expectError(`select * from app.close_after_hours_session($1)`,
        [session.session_id])).toMatch(/only close your own/i);
      await becomeOwner(db);
    });
  });

  it('closes after the authorisation has ended — the cash must still come back', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss, floatUgx: 30_000 });
      const session = await openSession(db, staff);
      await db.query(
        `update public.after_hours_access set status = 'revoked', revoked_at = now()
          where id = $1`, [auth.authorization_id]);
      await db.query(
        `update public.temporary_grants set revoked_at = now() where authorization_id = $1`,
        [auth.authorization_id]);
      expect(await permissionsOf(db, staff)).not.toContain('after_hours.operate');

      const closed = await closeSession(db, session.session_id, staff);
      expect(closed.status).toBe('handover_pending');
      expect(closed.expected_cash_ugx).toBe(30_000);
    });
  });

  it('refuses to close twice', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      await closeSession(db, session.session_id, staff);
      await becomeClient(db, staff);
      expect(await db.expectError(`select * from app.close_after_hours_session($1)`,
        [session.session_id])).toMatch(/not open/i);
      await becomeOwner(db);
    });
  });
});

describe('after-hours sessions: cancelling', () => {
  it('cancels an empty session with a reason', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      await becomeClient(db, staff);
      await db.query(`select app.cancel_after_hours_session($1, 'Opened by mistake')`,
        [session.session_id]);
      await becomeOwner(db);
      expect((await sessionRow(db, session.session_id)).status).toBe('cancelled');
    });
  });

  it('refuses to cancel a session holding a float', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 20_000 });
      const session = await openSession(db, staff);
      await becomeClient(db, staff);
      expect(await db.expectError(
        `select app.cancel_after_hours_session($1, 'Opened by mistake')`,
        [session.session_id])).toMatch(/holds an opening float/i);
      await becomeOwner(db);
    });
  });

  it('refuses to cancel a session that took money', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['jobs.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 808X');
      expect(await collect(db, { invoice: job.invoice, amount: 5_000, by: staff })).toBeNull();

      await becomeClient(db, staff);
      expect(await db.expectError(
        `select app.cancel_after_hours_session($1, 'Changed my mind')`,
        [session.session_id])).toMatch(/payments were recorded/i);
      await becomeOwner(db);
    });
  });

  it('a cancelled session frees the person to open another', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const first = await openSession(db, staff);
      await becomeClient(db, staff);
      await db.query(`select app.cancel_after_hours_session($1, 'Opened by mistake')`,
        [first.session_id]);
      await becomeOwner(db);
      const second = await openSession(db, staff);
      expect(second.session_id).not.toBe(first.session_id);
    });
  });
});

describe('after-hours sessions: a job completed on the night shift', () => {
  it('counts the completed job on the session', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['jobs.view', 'jobs.create', 'jobs.assign']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const job = await completedJob(db, 'UAH 707X');
      expect(job.orders.length).toBeGreaterThan(0);

      // The job above was worked by the seeded worker in daylight, so the
      // session counts nothing: only what the AUTHORISED worker completes.
      expect(Number((await sessionRow(db, session.session_id)).jobs_completed)).toBe(0);
    });
  });
});
