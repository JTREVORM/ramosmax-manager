import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, asClient, becomeClient, closePool, makeUser, SEED } from './harness';

afterAll(closePool);

/**
 * RLS ENFORCEMENT — the modified-client tests.
 *
 * Every case here is a browser that has been tampered with: it holds a VALID
 * session token but issues statements the UI would never send. It stands in
 * for functions/test/rules.test.js, which proved the same thing about a
 * modified Flutter client against the Firestore rules.
 *
 * The rule being proved: a modified client gains NOTHING that the Phase 9
 * Firebase implementation denied.
 */

const ALL_TABLES = ['users', 'temporary_grants', 'settings', 'audit_logs'] as const;

describe('anonymous access', () => {
  it('cannot read ANY business table', async () => {
    await asClient(null, async (session) => {
      for (const table of ALL_TABLES) {
        expect(await session.denied(`select * from public.${table}`), `anon read ${table}`).toBe(
          true,
        );
      }
    });
  });

  it('cannot write ANY business table', async () => {
    await asClient(null, async (session) => {
      expect(
        await session.denied(
          `insert into public.users (id, phone_number, full_name, role)
         values (gen_random_uuid(), '+256772777777', 'Intruder', 'admin')`,
        ),
      ).toBe(true);
      expect(await session.denied(`update public.users set role = 'admin'`)).toBe(true);
      expect(await session.denied(`delete from public.users`)).toBe(true);
      expect(
        await session.denied(
          `insert into public.audit_logs (user_id, user_role, action, module)
         values (gen_random_uuid(), 'admin', 'x', 'y')`,
        ),
      ).toBe(true);
    });
  });

  it('cannot reach the private throttle or idempotency tables', async () => {
    await asClient(null, async (session) => {
      expect(await session.denied(`select * from app.login_throttle`)).toBe(true);
      expect(await session.denied(`select * from app.request_keys`)).toBe(true);
    });
  });

  it('has no identity at all', async () => {
    await asClient(null, async (session) => {
      const { rows } = await session.query(`select auth.uid() is null as no_identity`);
      expect(rows[0].no_identity).toBe(true);
    });
  });

  // Stronger than the Firestore equivalent: in the reference implementation a
  // signed-out caller could still evaluate the rules' helper functions (they
  // simply returned false). Here `anon` holds no USAGE on the `app` schema, so
  // the access helpers are not reachable at all.
  it('cannot even execute the access helper functions', async () => {
    await asClient(null, async (session) => {
      for (const call of [
        `select app.is_active()`,
        `select app.current_role_id()`,
        `select app.effective_permissions()`,
        `select app.has_permission('users.view')`,
      ]) {
        expect(await session.denied(call), call).toBe(true);
      }
    });
  });
});

describe('accounts that are signed in but not live', () => {
  const states = [
    { name: 'inactive', fields: { active: false } },
    { name: 'expired', fields: { accessExpiresAt: new Date(Date.now() - 60_000).toISOString() } },
    { name: 'must_change_password', fields: { mustChangePassword: true } },
  ];

  for (const state of states) {
    it(`an ${state.name} ADMINISTRATOR reads no other user and no settings`, async () => {
      await asAdminDb(async (db) => {
        const uid = await makeUser(db, { role: 'admin', ...(state.fields as object) } as never);
        await becomeClient(db, uid);

        // Own profile stays readable — otherwise a forced password change
        // could never be completed. Everything else is closed.
        const own = await db.query(`select count(*)::int as n from public.users where id = $1`, [
          uid,
        ]);
        expect(Number(own.rows[0].n)).toBe(1);

        const others = await db.query(
          `select count(*)::int as n from public.users where id <> $1`,
          [uid],
        );
        expect(Number(others.rows[0].n)).toBe(0);

        const settings = await db.query(`select count(*)::int as n from public.settings`);
        expect(Number(settings.rows[0].n)).toBe(0);

        const audit = await db.query(`select count(*)::int as n from public.audit_logs`);
        expect(Number(audit.rows[0].n)).toBe(0);
      });
    });
  }

  it('a must_change_password user cannot append an audit entry', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'admin', mustChangePassword: true });
      await becomeClient(db, uid);
      expect(
        await db.denied(
          `insert into public.audit_logs (user_id, user_role, action, module, source)
         values ($1, 'admin', 'x', 'y', 'client')`,
          [uid],
        ),
      ).toBe(true);
    });
  });
});

describe('users table visibility', () => {
  it('lets a worker read only their own profile', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(`select id from public.users`);
      expect(rows.map((r) => r.id)).toEqual([SEED.worker]);
    });
  });

  it('lets a holder of users.view read the directory', async () => {
    await asClient(SEED.manager, async (session) => {
      const { rows } = await session.query(`select count(*)::int as n from public.users`);
      expect(Number(rows[0].n)).toBeGreaterThan(1);
    });
  });

  it('hides another user even when queried by explicit id', async () => {
    await asClient(SEED.cashier, async (session) => {
      const { rows } = await session.query(
        `select count(*)::int as n from public.users where id = $1`,
        [SEED.admin],
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});

describe('a modified client cannot escalate its own account', () => {
  const escalations: [string, string][] = [
    ['role', `update public.users set role = 'admin' where id = $1`],
    ['active', `update public.users set active = true where id = $1`],
    ['permissions', `update public.users set permissions = array['users.create'] where id = $1`],
    ['denied_permissions', `update public.users set denied_permissions = '{}' where id = $1`],
    ['access_expires_at', `update public.users set access_expires_at = null where id = $1`],
    ['must_change_password', `update public.users set must_change_password = false where id = $1`],
    ['staff_id', `update public.users set staff_id = 'RMX-STF-9999' where id = $1`],
    ['phone_number', `update public.users set phone_number = '+256772999111' where id = $1`],
  ];

  for (const [field, sql] of escalations) {
    it(`cannot change its own ${field}`, async () => {
      await asClient(SEED.worker, async (session) => {
        expect(await session.denied(sql, [SEED.worker])).toBe(true);
      });
    });
  }

  it('CAN update its own session bookkeeping fields', async () => {
    await asClient(SEED.worker, async (session) => {
      const error = await session.expectError(
        `update public.users set last_login_at = now(), notification_preferences = '{"push":false}'
          where id = $1`,
        [SEED.worker],
      );
      expect(error).toBeNull();
    });
  });

  it('cannot update ANOTHER user, even in an allowed column', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rowCount } = await session.query(
        `update public.users set last_login_at = now() where id = $1`,
        [SEED.admin],
      );
      // RLS makes the row invisible, so the statement affects nothing.
      expect(rowCount).toBe(0);
    });
  });

  it('cannot insert or delete a user at all', async () => {
    await asClient(SEED.admin, async (session) => {
      expect(
        await session.denied(
          `insert into public.users (id, phone_number, full_name, role)
         values (gen_random_uuid(), '+256772888888', 'Ghost', 'admin')`,
        ),
      ).toBe(true);
      expect(await session.denied(`delete from public.users where id = $1`, [SEED.worker])).toBe(
        true,
      );
    });
  });
});

describe('a modified client cannot write the access model directly', () => {
  it('cannot grant itself a temporary permission', async () => {
    await asClient(SEED.worker, async (session) => {
      expect(
        await session.denied(
          `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
         values ($1, 'payments.record', now(), now() + interval '1 hour')`,
          [SEED.worker],
        ),
      ).toBe(true);
    });
  });

  it('cannot revoke or extend an existing grant', async () => {
    await asClient(SEED.worker, async (session) => {
      expect(
        await session.denied(
          `update public.temporary_grants set expires_at = now() + interval '29 days'`,
        ),
      ).toBe(true);
      expect(await session.denied(`delete from public.temporary_grants`)).toBe(true);
    });
  });

  it('cannot edit the permission catalogue or the role matrix', async () => {
    await asClient(SEED.admin, async (session) => {
      expect(
        await session.denied(
          `insert into app.role_permissions (role_id, permission_key) values ('worker', 'users.create')`,
        ),
      ).toBe(true);
      expect(await session.denied(`update app.permissions set is_admin_only = false`)).toBe(true);
      expect(await session.denied(`update app.roles set rank = 999 where id = 'worker'`)).toBe(
        true,
      );
    });
  });

  it('cannot write settings', async () => {
    await asClient(SEED.admin, async (session) => {
      expect(
        await session.denied(
          `update public.settings set value = '{"dailyAllowanceUgx": 999999}' where key = 'payroll_policy'`,
        ),
      ).toBe(true);
      expect(
        await session.denied(`insert into public.settings (key, value) values ('evil', '{}')`),
      ).toBe(true);
    });
  });
});

describe('temporary_grants visibility', () => {
  it('lets a worker see their own grants only', async () => {
    await asAdminDb(async (db) => {
      const other = await makeUser(db, { role: 'worker' });
      await db.query(
        `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
         values ($1, 'payments.record', now(), now() + interval '1 hour'),
                ($2, 'payments.record', now(), now() + interval '1 hour')`,
        [SEED.worker, other],
      );

      await becomeClient(db, SEED.worker);
      const { rows } = await db.query(`select user_id from public.temporary_grants`);
      expect(rows.every((r) => r.user_id === SEED.worker)).toBe(true);
      expect(rows.length).toBe(1);
    });
  });

  it("lets a holder of users.view see everyone's grants", async () => {
    await asAdminDb(async (db) => {
      await db.query(
        `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
         values ($1, 'payments.record', now(), now() + interval '1 hour')`,
        [SEED.worker],
      );
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query(`select count(*)::int as n from public.temporary_grants`);
      expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('audit log', () => {
  it('is readable only with audit.view', async () => {
    await asAdminDb(async (db) => {
      await db.query(
        `
        insert into public.audit_logs (user_id, user_role, action, module, source)
        values ($1, 'admin', 'test.read', 'test', 'server')`,
        [SEED.admin],
      );

      await becomeClient(db, SEED.auditor);
      const visible = await db.query(`select count(*)::int as n from public.audit_logs`);
      expect(Number(visible.rows[0].n)).toBeGreaterThan(0);
    });

    await asAdminDb(async (db) => {
      await db.query(
        `
        insert into public.audit_logs (user_id, user_role, action, module, source)
        values ($1, 'admin', 'test.read', 'test', 'server')`,
        [SEED.admin],
      );
      await becomeClient(db, SEED.worker);
      const hidden = await db.query(`select count(*)::int as n from public.audit_logs`);
      expect(Number(hidden.rows[0].n)).toBe(0);
    });
  });

  it('refuses an entry attributed to someone else', async () => {
    await asClient(SEED.worker, async (session) => {
      expect(
        await session.denied(
          `insert into public.audit_logs (user_id, user_role, action, module, source)
         values ($1, 'admin', 'forged', 'test', 'client')`,
          [SEED.admin],
        ),
      ).toBe(true);
    });
  });

  it('refuses an entry claiming a role the caller does not hold', async () => {
    await asClient(SEED.worker, async (session) => {
      expect(
        await session.denied(
          `insert into public.audit_logs (user_id, user_role, action, module, source)
         values ($1, 'admin', 'forged', 'test', 'client')`,
          [SEED.worker],
        ),
      ).toBe(true);
    });
  });

  it('refuses a client entry posing as the SERVER', async () => {
    await asClient(SEED.worker, async (session) => {
      expect(
        await session.denied(
          `insert into public.audit_logs (user_id, user_role, action, module, source)
         values ($1, 'worker', 'forged', 'test', 'server')`,
          [SEED.worker],
        ),
      ).toBe(true);
    });
  });

  it('refuses a client entry that injects a reason or a target', async () => {
    await asClient(SEED.worker, async (session) => {
      expect(
        await session.denied(
          `insert into public.audit_logs (user_id, user_role, action, module, source, reason)
         values ($1, 'worker', 'x', 'test', 'client', 'made up')`,
          [SEED.worker],
        ),
      ).toBe(true);
      expect(
        await session.denied(
          `insert into public.audit_logs (user_id, user_role, action, module, source, target_user_id)
         values ($1, 'worker', 'x', 'test', 'client', $2)`,
          [SEED.worker, SEED.admin],
        ),
      ).toBe(true);
    });
  });

  it('ACCEPTS a well-formed entry from an active user', async () => {
    await asClient(SEED.worker, async (session) => {
      const error = await session.expectError(
        `insert into public.audit_logs (user_id, user_role, action, module, source)
         values ($1, 'worker', 'module.opened', 'jobs', 'client')`,
        [SEED.worker],
      );
      expect(error).toBeNull();
    });
  });
});

describe('settings visibility', () => {
  it('is readable by any active user', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(`select count(*)::int as n from public.settings`);
      expect(Number(rows[0].n)).toBeGreaterThan(0);
    });
  });
});
