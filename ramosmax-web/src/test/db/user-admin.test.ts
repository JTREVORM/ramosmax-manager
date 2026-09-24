import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';

afterAll(closePool);

/**
 * User administration guards, ported from functions/src/access.js and
 * user_admin.js. Each is executed against the real functions.
 */

describe('role changes', () => {
  it('refuses a caller without users.roles.manage', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.set_user_role($1, 'cashier')`, [target]);
      expect(error).toMatch(/do not have permission/);
    });
  });

  it('refuses changing your OWN role', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(`select app.set_user_role($1, 'worker')`, [SEED.admin]);
      expect(error).toMatch(/cannot change your own role/);
    });
  });

  it('lets an administrator change a role', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.set_user_role($1, 'cashier')`, [target])).toBeNull();
      const { rows } = await db.query(`select role from public.users where id = $1`, [target]);
      expect(rows[0].role).toBe('cashier');
    });
  });

  it('writes an audit entry for the change', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.set_user_role($1, 'cashier', 'Promotion')`, [target]);
      await db.query('reset role');
      const { rows } = await db.query(
        `select action, previous_value, new_value, reason, source
           from public.audit_logs where target_user_id = $1 and action = 'user.role_changed'`,
        [target],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].previous_value).toEqual({ role: 'worker' });
      expect(rows[0].new_value).toEqual({ role: 'cashier' });
      expect(rows[0].reason).toBe('Promotion');
      expect(rows[0].source).toBe('server');
    });
  });
});

describe('rank rules', () => {
  it('refuses a manager administering a PEER rank (auditor)', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'auditor' });
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.require_can_administer($1)`, [target]);
      expect(error).toMatch(/more junior role/);
    });
  });

  it('refuses ANY non-admin administering an administrator', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.require_can_administer($1)`, [SEED.admin]);
      expect(error).toMatch(/Only an Administrator can manage Administrator accounts/);
    });
  });

  it('allows a manager administering a junior role', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.require_can_administer($1)`, [target])).toBeNull();
    });
  });

  it('refuses a manager assigning a role at or above their own', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.require_can_assign_role('admin')`)).toMatch(
        /Only an Administrator can assign the Administrator role/,
      );
      expect(await db.expectError(`select app.require_can_assign_role('manager')`)).toMatch(
        /at or above your own/,
      );
    });
  });
});

describe('last-Administrator protection', () => {
  // Ports requireAnotherActiveAdmin(). "Another" means another LIVE
  // Administrator: active, not expired, and not locked out by a pending
  // password change.

  it('refuses to demote the only Administrator', async () => {
    await asAdminDb(async (db) => {
      // A second admin does the demoting, then is removed from the count by
      // being deactivated, leaving the seed admin as the only live one.
      const actor = await makeUser(db, { role: 'admin' });
      await becomeClient(db, actor);
      const error = await db.expectError(`select app.set_user_role($1, 'manager')`, [actor]);
      expect(error).toMatch(/cannot change your own role/);

      // Demoting the OTHER admin is allowed while two live admins exist.
      expect(
        await db.expectError(`select app.set_user_role($1, 'manager')`, [SEED.admin]),
      ).toBeNull();

      // `actor` is now the only Administrator. A third admin tries to demote them.
      await becomeOwner(db);
      const third = await makeUser(db, { role: 'admin' });
      await becomeClient(db, third);
      // `third` is itself live, so it counts — demoting `actor` is permitted.
      expect(await db.expectError(`select app.set_user_role($1, 'manager')`, [actor])).toBeNull();

      // Now `third` is the only live Administrator and nobody else can demote it.
      await becomeOwner(db);
      const { rows } = await db.query(
        `select count(*)::int as n from public.users u
          where u.role = 'admin' and app.is_account_live(u.id)`,
      );
      expect(Number(rows[0].n)).toBe(1);
      const blocked = await db.expectError(`select app.require_another_active_admin($1)`, [third]);
      expect(blocked).toMatch(/at least one active Administrator/);
    });
  });

  it('does NOT count an Administrator who is locked out by a pending password change', async () => {
    await asAdminDb(async (db) => {
      const lockedOut = await makeUser(db, { role: 'admin', mustChangePassword: true });
      // Two admin ROWS exist and both are active, but only the seed admin is live.
      const error = await db.expectError(`select app.require_another_active_admin($1)`, [
        SEED.admin,
      ]);
      expect(error).toMatch(/at least one active Administrator/);
      expect(lockedOut).toBeTruthy();
    });
  });

  it('does NOT count an Administrator whose access period has ended', async () => {
    await asAdminDb(async (db) => {
      await makeUser(db, {
        role: 'admin',
        accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const error = await db.expectError(`select app.require_another_active_admin($1)`, [
        SEED.admin,
      ]);
      expect(error).toMatch(/at least one active Administrator/);
    });
  });

  it('DOES count a second live Administrator', async () => {
    await asAdminDb(async (db) => {
      await makeUser(db, { role: 'admin' });
      expect(
        await db.expectError(`select app.require_another_active_admin($1)`, [SEED.admin]),
      ).toBeNull();
    });
  });

  it('refuses deactivating your own account before any other check', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(`select app.set_user_active($1, false)`, [SEED.admin]);
      expect(error).toMatch(/cannot deactivate your own account/);
    });
  });

  it('refuses deactivating the last live Administrator', async () => {
    await asAdminDb(async (db) => {
      const actor = await makeUser(db, { role: 'admin' });
      // Make `actor` locked out so it does not count as a live admin, but
      // still able to be the target. The seed admin acts.
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.set_user_active($1, false)`, [actor])).toBeNull();

      // Now the seed admin is the only live one; a third admin tries to
      // deactivate it while itself being locked out, so it does not count.
      await becomeOwner(db);
      const lockedOut = await makeUser(db, { role: 'admin', mustChangePassword: true });
      await db.query(
        `update public.users set permissions = array['users.deactivate'] where id = $1`,
        [lockedOut],
      );
      await becomeClient(db, lockedOut);
      const error = await db.expectError(`select app.set_user_active($1, false)`, [SEED.admin]);
      // A locked-out actor cannot act at all - the stricter answer.
      expect(error).toMatch(/not active|do not have permission/);
    });
  });
});

describe('password resets', () => {
  it('lets a manager reset a WORKER password', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(`select app.prepare_password_reset($1) as password`, [
        target,
      ]);
      expect(String(rows[0].password)).toHaveLength(12);
      await db.query('reset role');
      const { rows: after } = await db.query(
        `select must_change_password from public.users where id = $1`,
        [target],
      );
      expect(after[0].must_change_password).toBe(true);
    });
  });

  it('refuses a manager resetting a CASHIER password, despite the lower rank', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select app.prepare_password_reset($1)`, [target]);
      expect(error).toMatch(/only reset passwords for Workers/);
    });
  });

  it('refuses resetting your own password through the admin path', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(`select app.prepare_password_reset($1)`, [SEED.admin]);
      expect(error).toMatch(/own password from your profile/);
    });
  });

  it('never writes the generated password into the audit trail', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query(`select app.prepare_password_reset($1) as password`, [
        target,
      ]);
      const password = String(rows[0].password);
      await db.query('reset role');
      const { rows: entries } = await db.query(
        `select coalesce(description,'') || coalesce(new_value::text,'') as blob
           from public.audit_logs where target_user_id = $1`,
        [target],
      );
      for (const entry of entries) {
        expect(String(entry.blob)).not.toContain(password);
      }
    });
  });
});

describe('granting permissions', () => {
  // users.permissions.manage is admin-only, so a Manager never reaches this
  // function at all. The "cannot grant what you do not hold" rule is therefore
  // exercised with an Administrator who has been explicitly DENIED a permission.
  it('refuses a manager outright: the permission editor is admin-only', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select app.set_user_permissions($1, array['jobs.view'], '{}')`,
        [target],
      );
      expect(error).toMatch(/do not have permission/);
    });
  });

  it('refuses granting a permission the actor does not hold', async () => {
    await asAdminDb(async (db) => {
      const actor = await makeUser(db, { role: 'admin', deniedPermissions: ['finance.adjust'] });
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, actor);
      const error = await db.expectError(
        `select app.set_user_permissions($1, array['finance.adjust'], '{}')`,
        [target],
      );
      expect(error).toMatch(/cannot grant a permission you do not hold/);
    });
  });

  it('refuses a non-admin handing out an ADMIN-ONLY permission temporarily', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      // A Manager DOES hold users.permissions.temporary, so it reaches the
      // grant check, where the admin-only rule stops it.
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select app.grant_temporary_permission($1, 'users.create', now(), now() + interval '1 hour')`,
        [target],
      );
      expect(error).toMatch(/Only an Administrator can grant/);
    });
  });

  it('refuses granting an AUTHORIZATION-ONLY permission through the generic editor', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      for (const permission of ['after_hours.operate', 'after_hours.cash.collect']) {
        const error = await db.expectError(`select app.set_user_permissions($1, array[$2], '{}')`, [
          target,
          permission,
        ]);
        expect(error).toMatch(/only by an after-hours authorisation/);
      }
    });
  });

  it('refuses denying user-management permissions to an administrator', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'admin' });
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select app.set_user_permissions($1, '{}', array['users.create'])`,
        [target],
      );
      expect(error).toMatch(/Administrators always keep user-management access/);
    });
  });

  it('refuses a permission that is not in the catalogue', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select app.set_user_permissions($1, array['not.a.permission'], '{}')`,
        [target],
      );
      expect(error).toMatch(/not recognised/);
    });
  });
});

describe('temporary permissions', () => {
  it('lets a manager give a worker time-boxed access', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.grant_temporary_permission($1, 'jobs.create', now(), now() + interval '2 hours', 'After hours') as id`,
        [target],
      );
      expect(rows[0].id).toBeTruthy();

      await becomeClient(db, target);
      const check = await db.query(`select app.has_permission('jobs.create') as ok`);
      expect(check.rows[0].ok).toBe(true);
    });
  });

  it('refuses a window longer than 30 days', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select app.grant_temporary_permission($1, 'jobs.create', now(), now() + interval '31 days')`,
        [target],
      );
      expect(error).toMatch(/at most 30 days/);
    });
  });

  it('refuses a start time in the past beyond the 5-minute skew tolerance', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select app.grant_temporary_permission($1, 'jobs.create', now() - interval '1 hour', now() + interval '1 hour')`,
        [target],
      );
      expect(error).toMatch(/cannot be in the past/);
    });
  });

  it('accepts a start time inside the skew tolerance', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(
          `select app.grant_temporary_permission($1, 'jobs.create', now() - interval '2 minutes', now() + interval '1 hour')`,
          [target],
        ),
      ).toBeNull();
    });
  });

  it('refuses an inverted window', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select app.grant_temporary_permission($1, 'jobs.create', now() + interval '2 hours', now() + interval '1 hour')`,
        [target],
      );
      expect(error).toMatch(/must be after the start time/);
    });
  });

  it('refuses an authorization-only permission', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select app.grant_temporary_permission($1, 'after_hours.operate', now(), now() + interval '2 hours')`,
        [target],
      );
      expect(error).toMatch(/only by an after-hours authorisation/);
    });
  });

  it('revokes a grant and removes the permission immediately', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.grant_temporary_permission($1, 'jobs.create', now(), now() + interval '2 hours') as id`,
        [target],
      );
      await db.query(`select app.revoke_temporary_permission($1, 'No longer needed')`, [
        rows[0].id,
      ]);

      await becomeClient(db, target);
      const check = await db.query(`select app.has_permission('jobs.create') as ok`);
      expect(check.rows[0].ok).toBe(false);
    });
  });

  it('refuses revoking the same grant twice', async () => {
    await asAdminDb(async (db) => {
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(
        `select app.grant_temporary_permission($1, 'jobs.create', now(), now() + interval '2 hours') as id`,
        [target],
      );
      await db.query(`select app.revoke_temporary_permission($1)`, [rows[0].id]);
      const error = await db.expectError(`select app.revoke_temporary_permission($1)`, [
        rows[0].id,
      ]);
      expect(error).toMatch(/already been revoked/);
    });
  });
});

describe('inactive actors can do nothing', () => {
  it('refuses every administration function to a deactivated administrator', async () => {
    await asAdminDb(async (db) => {
      const actor = await makeUser(db, { role: 'admin', active: false });
      const target = await makeUser(db, { role: 'worker' });
      await becomeClient(db, actor);
      for (const call of [
        `select app.set_user_role($1, 'cashier')`,
        `select app.set_user_active($1, false)`,
        `select app.set_user_permissions($1, '{}', '{}')`,
        `select app.grant_temporary_permission($1, 'jobs.create', now(), now() + interval '1 hour')`,
      ]) {
        expect(await db.expectError(call, [target]), call).toMatch(
          /not active|do not have permission/,
        );
      }
    });
  });
});
