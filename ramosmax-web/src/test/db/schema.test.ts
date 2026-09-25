import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, asClient, closePool } from './harness';

afterAll(closePool);

/**
 * Verifies the database foundation by EXECUTING it, not by parsing SQL.
 */

describe('schema objects', () => {
  it('creates the private app schema and the public business tables', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select table_schema || '.' || table_name as name
          from information_schema.tables
         where table_schema in ('app', 'public') and table_type = 'BASE TABLE'
         order by 1`);
      const names = rows.map((r) => r.name);
      for (const expected of [
        'app.login_throttle',
        'app.permission_groups',
        'app.permissions',
        'app.request_keys',
        'app.role_permissions',
        'app.roles',
        'public.audit_logs',
        'public.settings',
        'public.temporary_grants',
        'public.users',
      ]) {
        expect(names).toContain(expected);
      }
    });
  });

  it('creates every access helper and administration function', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' order by 1`,
      );
      const names = rows.map((r) => r.proname);
      for (const fn of [
        'is_signed_in',
        'is_active',
        'current_role_id',
        'is_admin',
        'effective_permissions',
        'has_permission',
        'has_either_permission',
        'own_with',
        'require_active',
        'require_permission',
        'require_can_grant',
        'require_not_authorization_only',
        'require_can_administer',
        'require_can_assign_role',
        'require_can_reset_password',
        'require_another_active_admin',
        'require_allowed_denials',
        'is_account_live',
        'require_not_self',
        'normalize_phone',
        'mask_phone',
        'eat_day',
        'audit',
        'audit_auth',
        'password_problems',
        'generate_password',
        'new_sign_in_identity',
        'is_account_enabled',
        'phone_hash',
        'record_sign_in_failure',
        'resolve_sign_in',
        'set_user_role',
        'set_user_active',
        'set_user_permissions',
        'grant_temporary_permission',
        'revoke_temporary_permission',
        'prepare_password_reset',
        'create_user',
        'is_client_session',
      ]) {
        expect(names).toContain(fn);
      }
    });
  });

  it('loads the catalogue with exactly the reference contents', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select (select count(*) from app.permissions)                        as permissions,
               (select count(*) from app.permission_groups)                  as groups,
               (select count(*) from app.roles)                              as roles,
               (select count(*) from app.permissions where is_admin_only)    as admin_only,
               (select count(*) from app.permissions
                 where is_authorization_only)                                as authz_only`);
      expect(Number(rows[0].permissions)).toBe(127);
      expect(Number(rows[0].groups)).toBe(14);
      expect(Number(rows[0].roles)).toBe(6);
      expect(Number(rows[0].admin_only)).toBe(9);
      expect(Number(rows[0].authz_only)).toBe(2);
    });
  });

  it('gives each role exactly its reference default count', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select role_id, count(*)::int as n from app.role_permissions group by 1`,
      );
      const byRole = Object.fromEntries(rows.map((r) => [r.role_id, r.n]));
      expect(byRole).toEqual({ manager: 80, cashier: 24, worker: 10, shareholder: 5, auditor: 32 });
    });
  });
});

describe('row level security posture', () => {
  it('enables AND forces RLS on every business table', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`);
      for (const row of rows) {
        expect(row.enabled, `${row.relname} RLS enabled`).toBe(true);
        expect(row.forced, `${row.relname} RLS forced`).toBe(true);
      }
      expect(rows.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('enables RLS on the private app tables too', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select c.relname, c.relrowsecurity as enabled
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'app' and c.relkind = 'r'`);
      for (const row of rows) {
        expect(row.enabled, `app.${row.relname} RLS enabled`).toBe(true);
      }
    });
  });

  it('leaves request_keys and login_throttle with NO policy at all', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select tablename, count(*)::int as policies
          from pg_policies where schemaname = 'app'
           and tablename in ('request_keys', 'login_throttle')
         group by 1`);
      expect(rows).toEqual([]);
    });
  });
});

describe('write privileges — the "allow write: if false" equivalent', () => {
  it('grants authenticated NO insert, update or delete on any business table', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select table_name, privilege_type
          from information_schema.role_table_grants
         where grantee = 'authenticated'
           and table_schema = 'public'
           and privilege_type in ('INSERT', 'UPDATE', 'DELETE')`);
      // The only permitted exceptions are the append-only audit insert and the
      // column-scoped self-update on users, both of which are constrained
      // further by policy and by column grants.
      const unexpected = rows.filter(
        (r) =>
          !(r.table_name === 'audit_logs' && r.privilege_type === 'INSERT') &&
          !(r.table_name === 'users' && r.privilege_type === 'UPDATE'),
      );
      expect(unexpected).toEqual([]);
    });
  });

  it('scopes the users UPDATE grant to session columns only', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select column_name from information_schema.column_privileges
         where grantee = 'authenticated' and table_name = 'users'
           and privilege_type = 'UPDATE' order by 1`);
      expect(rows.map((r) => r.column_name)).toEqual(['last_login_at', 'notification_preferences']);
    });
  });

  it('grants anon nothing at all on the business tables', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        select table_name, privilege_type from information_schema.role_table_grants
         where grantee = 'anon' and table_schema = 'public'`);
      expect(rows).toEqual([]);
    });
  });
});

describe('constraints actually execute', () => {
  it('rejects a phone number that is not E.164', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `insert into auth.users (email) values ('x@users.ramosmax.invalid') returning id`,
      );
      const error = await db.expectError(
        `insert into public.users (id, phone_number, full_name, role)
         values ($1, '0772123456', 'Bad Phone', 'worker')`,
        [rows[0].id],
      );
      expect(error).toMatch(/users_phone_e164/);
    });
  });

  it('rejects a temporary grant whose window is inverted', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
        values ('00000000-0000-4000-8000-000000000004', 'payments.record',
                now() + interval '1 hour', now())`);
      expect(error).toMatch(/temporary_grants_window/);
    });
  });

  it('rejects a temporary grant longer than 30 days', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
        values ('00000000-0000-4000-8000-000000000004', 'payments.record',
                now(), now() + interval '31 days')`);
      expect(error).toMatch(/temporary_grants_max_length/);
    });
  });

  it('rejects a duplicate phone number', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `insert into auth.users (email) values ('y@users.ramosmax.invalid') returning id`,
      );
      const error = await db.expectError(
        `insert into public.users (id, phone_number, full_name, role)
         values ($1, '+256772000001', 'Duplicate', 'worker')`,
        [rows[0].id],
      );
      expect(error).toMatch(/users_phone_number_key|duplicate key/);
    });
  });

  it('rejects an unknown role', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `insert into auth.users (email) values ('z@users.ramosmax.invalid') returning id`,
      );
      const error = await db.expectError(
        `insert into public.users (id, phone_number, full_name, role)
         values ($1, '+256772999999', 'Bad Role', 'superuser')`,
        [rows[0].id],
      );
      expect(error).toMatch(/users_role_fkey|foreign key/);
    });
  });

  it('rejects a permission that is not in the catalogue', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(`
        insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
        values ('00000000-0000-4000-8000-000000000004', 'not.a.permission',
                now(), now() + interval '1 hour')`);
      expect(error).toMatch(/permission_key_fkey|foreign key/);
    });
  });
});

describe('append-only enforcement', () => {
  it('refuses to UPDATE an audit entry, even with full privileges', async () => {
    await asAdminDb(async (db) => {
      await db.query(`
        insert into public.audit_logs (user_id, user_role, action, module, source)
        values ('00000000-0000-4000-8000-000000000001', 'admin', 'test.entry', 'test', 'server')`);
      const error = await db.expectError(`update public.audit_logs set action = 'tampered'`);
      expect(error).toMatch(/append-only/);
    });
  });

  it('refuses to DELETE an audit entry, even with full privileges', async () => {
    await asAdminDb(async (db) => {
      await db.query(`
        insert into public.audit_logs (user_id, user_role, action, module, source)
        values ('00000000-0000-4000-8000-000000000001', 'admin', 'test.entry', 'test', 'server')`);
      const error = await db.expectError(`delete from public.audit_logs`);
      expect(error).toMatch(/append-only/);
    });
  });

  it('grants authenticated no UPDATE or DELETE privilege on audit_logs', async () => {
    await asClient('00000000-0000-4000-8000-000000000001', async (session) => {
      expect(await session.denied(`update public.audit_logs set action = 'x'`)).toBe(true);
      expect(await session.denied(`delete from public.audit_logs`)).toBe(true);
    });
  });
});

describe('updated_at maintenance', () => {
  // now() is transaction-scoped in PostgreSQL, so the assertion is that the
  // trigger OVERRIDES whatever the statement supplied, not that the clock moved.
  it('overrides a back-dated updated_at supplied by the caller', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(`
        update public.users
           set full_name = 'Test Worker',
               updated_at = timestamptz '2001-01-01 00:00:00+00'
         where id = '00000000-0000-4000-8000-000000000004'
        returning updated_at, updated_at = now() as is_transaction_time`);
      expect(rows[0].is_transaction_time).toBe(true);
      expect(new Date(rows[0].updated_at as string).getFullYear()).toBeGreaterThan(2001);
    });
  });
});

// ---------------------------------------------------------------------------
describe('reference numbers', () => {
  it('pads to the width and grows past it instead of repeating', async () => {
    await asAdminDb(async (db) => {
      // lpad TRUNCATES a string longer than its width, which made the 1,470th
      // reference collide with the 147th. Padding must only ever pad.
      // Sequences do not roll back, so start from a known point.
      await db.query(`select setval('app.test_reference_seq', 1, false)`);
      const { rows } = await db.query<{ short: string; exact: string; long: string }>(`
        select app.next_reference('test_reference_seq', 'T-', 3) as short,
               app.next_reference('test_reference_seq', 'T-', 1) as exact,
               app.next_reference('test_reference_seq', 'T-', 8) as long`);
      expect(rows[0].short).toBe('T-001');
      expect(rows[0].exact).toBe('T-2');
      expect(rows[0].long).toBe('T-00000003');

      await db.query(`select setval('app.test_reference_seq', 1469)`);
      const { rows: big } = await db.query<{ n: string }>(
        `select app.next_reference('test_reference_seq', 'T-', 3) as n`);
      expect(big[0].n).toBe('T-1470');
    });
  });
});
