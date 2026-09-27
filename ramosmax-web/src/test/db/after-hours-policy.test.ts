import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';
import {
  authorize, becomeClient, becomeOwner, closeSession, eligibleWorker, makeUser, openSession,
  SEED, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

describe('the after-hours policy', () => {
  it('has the reference defaults until somebody saves one', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ p: Record<string, unknown> }>(
        `select app.after_hours_policy() as p`);
      expect(rows[0].p.allowedPaymentMethods).toEqual(['cash', 'mtn_merchant', 'airtel_merchant']);
      expect(rows[0].p.maxAuthorizationHours).toBe(16);
      expect(Number(rows[0].p.maxOpeningFloatUgx)).toBe(1_000_000);
    });
  });

  it('is saved by settings.manage, and audited', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_after_hours_policy('{"maxAuthorizationHours":10}'::jsonb,
           'Shorter evenings')`);
      await becomeOwner(db);
      const { rows } = await db.query<{ p: Record<string, unknown> }>(
        `select app.after_hours_policy() as p`);
      expect(rows[0].p.maxAuthorizationHours).toBe(10);

      const { rows: audit } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.audit_logs
          where action = 'after_hours_policy.updated'`);
      expect(Number(audit[0].n)).toBeGreaterThan(0);
    });
  });

  it('refuses a window outside 1–24 hours', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      for (const hours of [0, 25]) {
        expect(await db.expectError(
          `select app.update_after_hours_policy($1::jsonb, 'Try')`,
          [JSON.stringify({ maxAuthorizationHours: hours })]), String(hours))
          .toMatch(/between 1 and 24 hours/i);
      }
      await becomeOwner(db);
    });
  });

  it('refuses an empty or unknown payment method list', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      for (const methods of [[], ['cheque'], ['cash', 'cheque']]) {
        expect(await db.expectError(
          `select app.update_after_hours_policy($1::jsonb, 'Try')`,
          [JSON.stringify({ allowedPaymentMethods: methods })]), JSON.stringify(methods))
          .toMatch(/at least one valid payment method/i);
      }
      await becomeOwner(db);
    });
  });

  it('refuses a float ceiling above ten million', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.update_after_hours_policy('{"maxOpeningFloatUgx":20000000}'::jsonb, 'Try')`))
        .toMatch(/maximum opening float/i);
      await becomeOwner(db);
    });
  });

  it('refuses a setting nobody recognises', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.update_after_hours_policy('{"allowEverything":true}'::jsonb, 'Try')`))
        .toMatch(/not recognised/i);
      await becomeOwner(db);
    });
  });

  it('a saved policy changes what an authorisation may do', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.update_after_hours_policy('{"maxOpeningFloatUgx":10000}'::jsonb, 'Tighter')`);
      await becomeOwner(db);

      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening',
           'policy-float-test-0001', null, null, 50000)`, [staff]))
        .toMatch(/opening float can be at most/i);
      await becomeOwner(db);
    });
  });
});

describe('the after-hours sweep: labels and reminders, never enforcement', () => {
  it('labels an ended authorisation expired', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      await db.query(
        `update public.after_hours_access
            set starts_at = now() - interval '9 hours', expires_at = now() - interval '1 minute'
          where id = $1`, [auth.authorization_id]);

      await becomeClient(db, boss);
      await db.query(`select * from app.sweep_after_hours()`);
      await becomeOwner(db);

      const { rows } = await db.query<{ status: string }>(
        `select status from public.after_hours_access where id = $1`, [auth.authorization_id]);
      expect(rows[0].status).toBe('expired');
    });
  });

  it('warns once, thirty minutes before the end', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      await db.query(
        `update public.after_hours_access set expires_at = now() + interval '10 minutes'
          where id = $1`, [auth.authorization_id]);

      await becomeClient(db, boss);
      await db.query(`select * from app.sweep_after_hours()`);
      await db.query(`select * from app.sweep_after_hours()`);
      await becomeOwner(db);

      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.after_hours_events
          where type = 'after_hours_expiring' and reference_id = $1`, [auth.authorization_id]);
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('reminds once about a handover still outstanding', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 40_000 });
      const session = await openSession(db, staff);
      const closed = await closeSession(db, session.session_id, staff);
      await db.query(
        `update public.cash_handovers set created_at = now() - interval '3 hours' where id = $1`,
        [closed.handover_id]);

      await becomeClient(db, boss);
      await db.query(`select * from app.sweep_after_hours()`);
      await db.query(`select * from app.sweep_after_hours()`);
      await becomeOwner(db);

      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.after_hours_events
          where type = 'cash_handover_reminder' and reference_id = $1 and audience = 'recipient'`,
        [closed.handover_id]);
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('reminds nobody about a handover that has just closed', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 40_000 });
      const session = await openSession(db, staff);
      const closed = await closeSession(db, session.session_id, staff);

      await becomeClient(db, boss);
      await db.query(`select * from app.sweep_after_hours()`);
      await becomeOwner(db);

      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.after_hours_events
          where type = 'cash_handover_reminder' and reference_id = $1`, [closed.handover_id]);
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it('is not what stops a permission: the grant had already gone', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      await db.query(
        `update public.temporary_grants
            set starts_at = now() - interval '9 hours', expires_at = now() - interval '1 minute'
          where authorization_id = $1`, [auth.authorization_id]);

      const { rows: before } = await db.query<{ p: string[] }>(
        `select app.effective_permissions($1) as p`, [staff]);
      expect(before[0].p).not.toContain('after_hours.operate');

      // The sweep has not run at all, and the record still reads `active`.
      const { rows } = await db.query<{ status: string }>(
        `select status from public.after_hours_access where id = $1`, [auth.authorization_id]);
      expect(rows[0].status).toBe('active');
    });
  });

  it('needs approval standing to run at all', async () => {
    await asAdminDb(async (db) => {
      const outsider = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, outsider);
      expect(await db.expectError(`select * from app.sweep_after_hours()`))
        .toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });
});

describe('authorising by length instead of an end time', () => {
  it('measures the window against the database clock', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      const { rows } = await db.query<{ authorization_id: string }>(
        `select * from app.authorize_after_hours($1, null, 'Evening', 'hours-path-000001',
           null, null, null, 16)`, [staff]);
      await becomeOwner(db);

      const { rows: auth } = await db.query<{ hours: string }>(
        `select round(extract(epoch from (expires_at - starts_at)) / 3600)::text as hours
           from public.after_hours_access where id = $1`, [rows[0].authorization_id]);
      // Exactly the policy maximum, accepted.
      expect(Number(auth[0].hours)).toBe(16);
    });
  });

  it('still refuses a length beyond the policy', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, null, 'Evening', 'hours-path-000002',
           null, null, null, 20)`, [staff])).toMatch(/at most 16 hours/i);
      await becomeOwner(db);
    });
  });

  it('refuses both an end time and a length, or neither', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening',
           'hours-path-000003', null, null, null, 4)`, [staff]))
        .toMatch(/how long the authorisation lasts/i);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, null, 'Evening', 'hours-path-000004')`,
        [staff])).toMatch(/how long the authorisation lasts/i);
      await becomeOwner(db);
    });
  });
});
