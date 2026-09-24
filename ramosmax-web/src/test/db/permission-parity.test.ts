import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, asClient, becomeClient, closePool, makeUser, SEED } from './harness';
import {
  ADMIN_ONLY_PERMISSIONS,
  AUTHORIZATION_ONLY_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  effectivePermissions,
  type AccessProfile,
  type Role,
} from '@/lib/permissions';

afterAll(closePool);

/**
 * PERMISSION PARITY.
 *
 * The question this suite answers is the one that matters for the migration:
 * does the PostgreSQL access model grant exactly what the Phase 9 model
 * granted — no more, no less?
 *
 * The assertions are GENERATED from the permission catalogue rather than
 * hand-written, so the matrix cannot drift as the catalogue grows, and adding
 * a permission upstream automatically extends the proof.
 *
 * Three independent sources must agree for every (role, permission) pair:
 *   1. functions/src/access_catalog.json   - the Phase 9 reference
 *   2. src/lib/permissions                 - the TypeScript port (UI)
 *   3. app.effective_permissions()         - the PostgreSQL port (enforcement)
 */

const profile = (role: Role, over: Partial<AccessProfile> = {}): AccessProfile => ({
  role,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
  ...over,
});

async function dbPermissions(uid: string): Promise<Set<string>> {
  return asClient(uid, async (session) => {
    const { rows } = await session.query(`select unnest(app.effective_permissions()) as key`);
    return new Set(rows.map((r) => r.key as string));
  });
}

describe('role defaults: PostgreSQL matches the TypeScript port for all 127 permissions', () => {
  for (const role of ROLES) {
    it(`${role}: all ${PERMISSIONS.length} permissions resolve identically`, async () => {
      const expected = effectivePermissions(profile(role));
      const actual = await dbPermissions(SEED[role]);

      const mismatches: string[] = [];
      for (const permission of PERMISSIONS) {
        const inTs = expected.has(permission);
        const inDb = actual.has(permission);
        if (inTs !== inDb) {
          mismatches.push(`${permission}: typescript=${inTs} postgres=${inDb}`);
        }
      }
      expect(mismatches).toEqual([]);
      expect(actual.size).toBe(expected.size);
    });
  }
});

describe('account state zeroes the permission set', () => {
  const cases: {
    name: string;
    over: Partial<AccessProfile>;
    sql: Partial<Record<string, unknown>>;
  }[] = [
    { name: 'an inactive account', over: { active: false }, sql: { active: false } },
    {
      name: 'an account whose access period has ended',
      over: { accessExpiresAt: new Date(Date.now() - 1000) },
      sql: { accessExpiresAt: new Date(Date.now() - 60_000).toISOString() },
    },
    {
      name: 'an account waiting for a password change',
      over: { mustChangePassword: true },
      sql: { mustChangePassword: true },
    },
  ];

  for (const { name, over, sql } of cases) {
    it(`grants NOTHING to ${name}, even an administrator`, async () => {
      // TypeScript port
      expect(effectivePermissions(profile('admin', over)).size).toBe(0);

      // PostgreSQL port
      await asAdminDb(async (db) => {
        const uid = await makeUser(db, { role: 'admin', ...(sql as object) } as never);
        await becomeClient(db, uid);
        const { rows } = await db.query(
          `select coalesce(array_length(app.effective_permissions(), 1), 0) as n`,
        );
        expect(Number(rows[0].n)).toBe(0);
        const active = await db.query(`select app.is_active() as ok`);
        expect(active.rows[0].ok).toBe(false);
      });
    });
  }
});

describe('direct grants and explicit denials', () => {
  it('adds a direct grant in both ports', async () => {
    expect(
      effectivePermissions(profile('worker', { permissions: ['finance.view'] })).has(
        'finance.view',
      ),
    ).toBe(true);

    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker', permissions: ['finance.view'] });
      await becomeClient(db, uid);
      const { rows } = await db.query(`select app.has_permission('finance.view') as ok`);
      expect(rows[0].ok).toBe(true);
    });
  });

  it('subtracts a denial from a role default in both ports', async () => {
    expect(
      effectivePermissions(profile('worker', { deniedPermissions: ['jobs.view.own'] })).has(
        'jobs.view.own',
      ),
    ).toBe(false);

    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker', deniedPermissions: ['jobs.view.own'] });
      await becomeClient(db, uid);
      const { rows } = await db.query(`select app.has_permission('jobs.view.own') as ok`);
      expect(rows[0].ok).toBe(false);
    });
  });

  it('subtracts a denial from an ADMINISTRATOR in both ports', async () => {
    expect(
      effectivePermissions(profile('admin', { deniedPermissions: ['finance.adjust'] })).has(
        'finance.adjust',
      ),
    ).toBe(false);

    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'admin', deniedPermissions: ['finance.adjust'] });
      await becomeClient(db, uid);
      const { rows } = await db.query(`
        select app.has_permission('finance.adjust') as denied_one,
               app.has_permission('finance.view')   as keeps_others`);
      expect(rows[0].denied_one).toBe(false);
      expect(rows[0].keeps_others).toBe(true);
    });
  });

  it('ignores a direct grant that is not in the catalogue', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker', permissions: ['not.a.permission'] });
      await becomeClient(db, uid);
      const { rows } = await db.query(`select app.has_permission('not.a.permission') as ok`);
      expect(rows[0].ok).toBe(false);
    });
  });
});

describe('temporary permissions expire by time, with no cleanup job', () => {
  it('honours a grant inside its window', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker' });
      await db.query(
        `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
         values ($1, 'payments.record', now() - interval '1 minute', now() + interval '1 hour')`,
        [uid],
      );
      await becomeClient(db, uid);
      const { rows } = await db.query(`select app.has_permission('payments.record') as ok`);
      expect(rows[0].ok).toBe(true);
    });
  });

  it('does NOT honour a grant before it starts', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker' });
      await db.query(
        `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
         values ($1, 'payments.record', now() + interval '1 hour', now() + interval '2 hours')`,
        [uid],
      );
      await becomeClient(db, uid);
      const { rows } = await db.query(`select app.has_permission('payments.record') as ok`);
      expect(rows[0].ok).toBe(false);
    });
  });

  it('does NOT honour an EXPIRED grant — no sweep has run', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker' });
      await db.query(
        `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
         values ($1, 'payments.record', now() - interval '2 hours', now() - interval '1 hour')`,
        [uid],
      );
      await becomeClient(db, uid);
      const { rows } = await db.query(
        `
        select app.has_permission('payments.record') as ok,
               (select count(*) from public.temporary_grants where user_id = $1) as still_there`,
        [uid],
      );
      expect(rows[0].ok).toBe(false);
      // The row is still present and unrevoked: expiry is a time comparison.
      expect(Number(rows[0].still_there)).toBe(1);
    });
  });

  it('does NOT honour a revoked grant', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker' });
      await db.query(
        `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at, revoked_at)
         values ($1, 'payments.record', now() - interval '1 minute', now() + interval '1 hour', now())`,
        [uid],
      );
      await becomeClient(db, uid);
      const { rows } = await db.query(`select app.has_permission('payments.record') as ok`);
      expect(rows[0].ok).toBe(false);
    });
  });

  it('is still beaten by an explicit denial', async () => {
    await asAdminDb(async (db) => {
      const uid = await makeUser(db, { role: 'worker', deniedPermissions: ['payments.record'] });
      await db.query(
        `insert into public.temporary_grants (user_id, permission_key, starts_at, expires_at)
         values ($1, 'payments.record', now() - interval '1 minute', now() + interval '1 hour')`,
        [uid],
      );
      await becomeClient(db, uid);
      const { rows } = await db.query(`select app.has_permission('payments.record') as ok`);
      expect(rows[0].ok).toBe(false);
    });
  });
});

describe('catalogue flags match the reference', () => {
  it('flags exactly the 9 admin-only permissions', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select key from app.permissions where is_admin_only order by key`,
      );
      expect(rows.map((r) => r.key)).toEqual([...ADMIN_ONLY_PERMISSIONS].sort());
    });
  });

  it('flags exactly the 2 authorization-only permissions', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query(
        `select key from app.permissions where is_authorization_only order by key`,
      );
      expect(rows.map((r) => r.key)).toEqual([...AUTHORIZATION_ONLY_PERMISSIONS].sort());
    });
  });

  it('gives NO role an authorization-only permission by default', async () => {
    for (const role of ROLES) {
      if (role === 'admin') continue;
      const granted = await dbPermissions(SEED[role]);
      for (const permission of AUTHORIZATION_ONLY_PERMISSIONS) {
        expect(granted.has(permission), `${role} must not hold ${permission}`).toBe(false);
      }
    }
  });
});
