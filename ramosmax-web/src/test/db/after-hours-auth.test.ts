import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';
import {
  authorize, becomeClient, becomeOwner, eligibleWorker, makeUser, permissionsOf, requestId, SEED,
  supervisor,
} from './after-hours-helpers';

afterAll(closePool);

/**
 * TEMPORARY AUTHORISATION.
 *
 * An after-hours authorisation is not a new kind of access. It writes
 * ordinary temporary grants, which stop being returned by
 * `app.effective_permissions` the moment the server clock passes their
 * expiry. Every test here proves the enforcement by MOVING THE CLOCK ON THE
 * GRANT, never by running a sweep: if expiry depended on a job, these would
 * fail.
 */
describe('after-hours authorisation: what it may hand out', () => {
  it('grants the default seven when the approver does not choose', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });

      expect(auth.granted).toContain('after_hours.operate');
      expect(auth.granted).toContain('after_hours.cash.collect');
      expect(auth.granted).toContain('invoices.create');
      expect(auth.granted).not.toContain('customers.manage');

      const live = await permissionsOf(db, staff);
      expect(live).toContain('after_hours.operate');
      expect(live).toContain('jobs.create');
    });
  });

  it('refuses anything outside the grantable list', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      for (const forbidden of [
        'payments.reverse', 'payroll.approve', 'users.manage', 'finance.adjust',
        'settings.manage', 'discounts.apply', 'attendance.verify', 'dividends.pay',
        'shares.issue', 'audit.view',
      ]) {
        expect(
          await db.expectError(
            `select * from app.authorize_after_hours($1, now() + interval '4 hours',
               'Evening', $2, null, array['after_hours.operate', $3]::text[])`,
            [staff, requestId('forbidden'), forbidden]),
          forbidden,
        ).toMatch(/cannot include/i);
      }
      await becomeOwner(db);
    });
  });

  it('always includes after_hours.operate, whatever was asked for', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss, permissions: ['jobs.view'] });
      expect(auth.granted).toContain('after_hours.operate');
      expect(auth.granted).toContain('jobs.view');
    });
  });

  it('never grants what the person already holds permanently', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['jobs.view']);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss, permissions: ['jobs.view'] });
      expect(auth.granted).not.toContain('jobs.view');
      expect(auth.granted).toContain('after_hours.operate');
    });
  });

  it('never grants what is explicitly denied', async () => {
    await asAdminDb(async (db) => {
      const staff = await makeUser(db, {
        role: 'worker', permissions: ['after_hours.request'],
        deniedPermissions: ['jobs.create'],
      });
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      expect(auth.granted).not.toContain('jobs.create');
      expect(await permissionsOf(db, staff)).not.toContain('jobs.create');
    });
  });
});

describe('after-hours authorisation: who may be authorised', () => {
  it('refuses to authorise yourself', async () => {
    await asAdminDb(async (db) => {
      const boss = await makeUser(db, {
        role: 'manager', permissions: ['after_hours.approve', 'after_hours.request'],
      });
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Myself', $2)`,
        [boss, requestId('self')])).toMatch(/cannot authorise yourself/i);
      await becomeOwner(db);
    });
  });

  it('refuses somebody who is not eligible', async () => {
    await asAdminDb(async (db) => {
      // A cashier holds no `after_hours.request`: eligibility is a permanent
      // permission the Worker role carries and this one does not.
      const staff = await makeUser(db, { role: 'cashier' });
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening', $2)`,
        [staff, requestId('noteligible')])).toMatch(/not eligible/i);
      await becomeOwner(db);
    });
  });

  it('refuses when after-hours operation is explicitly denied', async () => {
    await asAdminDb(async (db) => {
      const staff = await makeUser(db, {
        role: 'worker', permissions: ['after_hours.request'],
        deniedPermissions: ['after_hours.operate'],
      });
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening', $2)`,
        [staff, requestId('denied')])).toMatch(/explicitly denied/i);
      await becomeOwner(db);
    });
  });

  it('refuses an inactive account', async () => {
    await asAdminDb(async (db) => {
      const staff = await makeUser(db, {
        role: 'worker', permissions: ['after_hours.request'], active: false,
      });
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening', $2)`,
        [staff, requestId('inactive')])).toMatch(/not active|not eligible/i);
      await becomeOwner(db);
    });
  });

  it('refuses a manager trying to authorise an Administrator', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, {
        role: 'admin', permissions: ['after_hours.request'],
      });
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening', $2)`,
        [target, requestId('escalate')])).toMatch(/only an administrator can manage/i);
      await becomeOwner(db);
    });
  });

  it('refuses two overlapping authorisations for the same person', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const first = await authorize(db, { staff, by: boss, hours: 6 });
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '3 hours', 'Again', $2)`,
        [staff, requestId('overlap')])).toContain(first.authorization_number);
      await becomeOwner(db);
    });
  });
});

describe('after-hours authorisation: the window and the float', () => {
  it('refuses a window longer than the policy allows', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '20 hours', 'Long', $2)`,
        [staff, requestId('long')])).toMatch(/at most 16 hours/i);
      await becomeOwner(db);
    });
  });

  it('refuses a window that ends before it starts', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() - interval '1 hour', 'Backwards', $2)`,
        [staff, requestId('backwards')])).toMatch(/after the start time/i);
      await becomeOwner(db);
    });
  });

  it('refuses a float above the policy maximum', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await becomeClient(db, boss);
      expect(await db.expectError(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening', $2,
           null, null, 2000000)`,
        [staff, requestId('bigfloat')])).toMatch(/opening float can be at most/i);
      await becomeOwner(db);
    });
  });

  it('accepts a float at the policy maximum', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss, floatUgx: 1_000_000 });
      const { rows } = await db.query<{ opening_float_ugx: string }>(
        `select opening_float_ugx from public.after_hours_access where id = $1`,
        [auth.authorization_id]);
      expect(Number(rows[0].opening_float_ugx)).toBe(1_000_000);
    });
  });
});

describe('after-hours authorisation: it ends by itself', () => {
  it('stops granting the moment the window closes — with no sweep', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss, hours: 4 });
      expect(await permissionsOf(db, staff)).toContain('after_hours.operate');

      // Move the window into the past. Nothing else runs: no job, no status
      // change, no cleanup. The permission simply stops being returned.
      await db.query(
        `update public.temporary_grants
            set starts_at = now() - interval '5 hours', expires_at = now() - interval '1 minute'
          where authorization_id = $1`, [auth.authorization_id]);

      expect(await permissionsOf(db, staff)).not.toContain('after_hours.operate');
      expect(await permissionsOf(db, staff)).not.toContain('after_hours.cash.collect');
      // The record still says `active`: the LABEL lags, the enforcement does not.
      const { rows } = await db.query<{ status: string }>(
        `select status from public.after_hours_access where id = $1`, [auth.authorization_id]);
      expect(rows[0].status).toBe('active');
    });
  });

  it('grants nothing before the window opens', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss, hours: 4 });
      await db.query(
        `update public.temporary_grants set starts_at = now() + interval '2 hours'
          where authorization_id = $1`, [auth.authorization_id]);
      expect(await permissionsOf(db, staff)).not.toContain('after_hours.operate');
    });
  });

  it('revocation removes the permissions at once', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      expect(await permissionsOf(db, staff)).toContain('after_hours.operate');

      await becomeClient(db, boss);
      await db.query(`select app.revoke_after_hours($1, 'Sent home early')`,
        [auth.authorization_id]);
      await becomeOwner(db);

      expect(await permissionsOf(db, staff)).not.toContain('after_hours.operate');
      const { rows } = await db.query<{ status: string }>(
        `select status from public.after_hours_access where id = $1`, [auth.authorization_id]);
      expect(rows[0].status).toBe('revoked');
    });
  });

  it('refuses to revoke an authorisation that has already ended', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      await becomeClient(db, boss);
      await db.query(`select app.revoke_after_hours($1, 'Sent home early')`,
        [auth.authorization_id]);
      expect(await db.expectError(`select app.revoke_after_hours($1, 'Again')`,
        [auth.authorization_id])).toMatch(/already ended/i);
      await becomeOwner(db);
    });
  });

  it('a newer authorisation supersedes an older live grant', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const first = await authorize(db, { staff, by: boss, hours: 4 });
      // End the first cleanly, then authorise again for the same evening.
      await becomeClient(db, boss);
      await db.query(`select app.revoke_after_hours($1, 'Shift changed')`,
        [first.authorization_id]);
      await becomeOwner(db);
      const second = await authorize(db, { staff, by: boss, hours: 4 });

      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.temporary_grants
          where user_id = $1 and revoked_at is null and expires_at > now()
            and authorization_id = $2`, [staff, second.authorization_id]);
      expect(Number(rows[0].n)).toBe(second.granted.length);
      const { rows: old } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.temporary_grants
          where authorization_id = $1 and revoked_at is null`, [first.authorization_id]);
      expect(Number(old[0].n)).toBe(0);
    });
  });
});

describe('after-hours authorisation: it cannot leak into permanent access', () => {
  it('the generic temporary editor refuses the authorisation-only permissions', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, SEED.admin);
      for (const key of ['after_hours.operate', 'after_hours.cash.collect']) {
        expect(await db.expectError(
          `select app.grant_temporary_permission($1, $2, now(), now() + interval '2 hours', 'Try')`,
          [staff, key]), key).toMatch(/authorisation|authorization/i);
      }
      await becomeOwner(db);
    });
  });

  it('the permanent permission editor refuses them too', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.set_user_permissions($1, array['after_hours.operate']::text[], null, 'Try')`,
        [staff])).toMatch(/authorisation|authorization/i);
      await becomeOwner(db);
    });
  });

  it('is idempotent: the same request twice authorises once', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      const id = requestId('idem');
      await becomeClient(db, boss);
      const { rows: first } = await db.query<{ authorization_id: string }>(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening', $2)`,
        [staff, id]);
      const { rows: again } = await db.query<{ authorization_id: string }>(
        `select * from app.authorize_after_hours($1, now() + interval '4 hours', 'Evening', $2)`,
        [staff, id]);
      await becomeOwner(db);
      expect(again[0].authorization_id).toBe(first[0].authorization_id);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.after_hours_access where staff_uid = $1`, [staff]);
      expect(Number(rows[0].n)).toBe(1);
    });
  });
});
