import { afterAll, describe, expect, it } from 'vitest';
import {
  asAdminDb, becomeClient, becomeOwner, becomeServer, closePool, makeUser, SEED,
} from './harness';

afterAll(closePool);

/**
 * ENDING SOMEBODY'S SESSIONS.
 *
 * There is no server-side session here to delete. The session is a signed
 * cookie carrying the moment it was issued, and it is ended by refusing to
 * accept it any longer — `currentUser()` compares that moment against two
 * stamps on the profile and returns nothing for a cookie older than either.
 *
 * This is the half of the hosted password-change failure that lives in the
 * database. The other half was an application bug: `revokeSessions` handed a
 * RamosMAX user id to `supabase.auth.admin.signOut`, whose first argument is a
 * logged-in JWT, and GoTrue answered "token contains an invalid number of
 * segments". `auth-service.test.ts` covers that one.
 */

const stamps = async (
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  id: string,
) => {
  const { rows } = await db.query<{
    password_changed_at: string | null;
    sessions_valid_from: string | null;
    must_change_password: boolean;
  }>(`select password_changed_at, sessions_valid_from, must_change_password
        from public.users where id = $1`, [id]);
  return rows[0];
};

describe('end_sessions', () => {
  it('stamps the moment everything issued before it stops being accepted', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      expect((await stamps(db, person)).sessions_valid_from).toBeNull();

      const { rows } = await db.query<{ end_sessions: string }>(
        `select app.end_sessions($1) as end_sessions`, [person]);
      expect(rows[0].end_sessions).not.toBeNull();

      const after = await stamps(db, person);
      expect(after.sessions_valid_from).not.toBeNull();
      expect(new Date(after.sessions_valid_from!).getTime())
        .toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  it('refuses an account that does not exist', async () => {
    await asAdminDb(async (db) => {
      expect(await db.expectError(`select app.end_sessions(gen_random_uuid())`))
        .toMatch(/could not be found/i);
    });
  });

  it('is not callable by a browser session, whatever their role', async () => {
    await asAdminDb(async (db) => {
      for (const uid of [SEED.admin, SEED.manager, SEED.worker]) {
        await becomeClient(db, uid);
        expect(await db.expectError(`select app.end_sessions($1)`, [uid]), uid)
          .toMatch(/permission denied for function/i);
        await becomeOwner(db);
      }
    });
  });
});

describe('every flow that claims to end sessions actually does', () => {
  it('a password change stamps password_changed_at', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      await db.query(`select app.complete_password_change($1)`, [person]);
      const after = await stamps(db, person);
      expect(after.password_changed_at).not.toBeNull();
      expect(after.must_change_password).toBe(false);
    });
  });

  it('an administrator’s reset ends them too — it used not to', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      const before = await stamps(db, person);
      expect(before.sessions_valid_from).toBeNull();

      // As the SERVER on the administrator's behalf: the claim is set, so the
      // permission check and the audit attribution are the administrator's,
      // but the role stays the owner's because this function is deliberately
      // not granted to a browser session. `serverRpcAsUser` is the
      // application's counterpart to this, and its absence is why creating a
      // user and resetting a password were both refused outright.
      await becomeServer(db, SEED.admin);
      await db.query(`select app.prepare_password_reset($1, 'Forgotten')`, [person]);
      await becomeOwner(db);

      const after = await stamps(db, person);
      // Without this, resetting somebody's password left them signed in on
      // whatever device they had open, holding a cookie that still worked.
      expect(after.sessions_valid_from).not.toBeNull();
      expect(after.must_change_password).toBe(true);
    });
  });

  it('a phone-number change ends them, which nothing used to read', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      await becomeClient(db, SEED.admin);
      await db.query(`select app.change_user_phone($1, '0772909091', 'New handset')`, [person]);
      await becomeOwner(db);
      expect((await stamps(db, person)).sessions_valid_from).not.toBeNull();
    });
  });

  it('leaves an untouched account accepting its cookie', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      const after = await stamps(db, person);
      expect(after.sessions_valid_from).toBeNull();
      expect(after.password_changed_at).toBeNull();
    });
  });
});

/**
 * TEMPORARY PASSWORDS FROM A CSPRNG.
 *
 * `app.generate_password` drew from `random()`, a deterministic PRNG seeded per
 * session. These are the passwords handed to a new member of staff and issued
 * by an administrator reset, so they are drawn from pgcrypto instead. The
 * policy, the alphabet and the look-alike exclusions are unchanged.
 */
describe('generated temporary passwords', () => {
  it('draws from pgcrypto, not from random()', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ prosrc: string }>(
        `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'generate_password'`);
      expect(rows[0].prosrc).not.toMatch(/\brandom\s*\(\s*\)/);
      expect(rows[0].prosrc).toMatch(/random_index/);

      const { rows: bytes } = await db.query<{ prosrc: string }>(
        `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'random_bytes'`);
      expect(bytes[0].prosrc).toMatch(/gen_random_bytes/);
    });
  });

  it('is uniform over the range, with the modulo bias rejected', async () => {
    await asAdminDb(async (db) => {
      // 10 does not divide 256, so a naive `byte % 10` would favour 1..6.
      // 4,000 draws over 10 buckets: every bucket must appear, and none may
      // run away with it. The bounds are wide enough not to be flaky and
      // narrow enough to fail a biased implementation.
      const { rows } = await db.query<{ bucket: number; n: number }>(
        `select app.random_index(10) as bucket, count(*)::int as n
           from generate_series(1, 4000) group by 1 order by 1`);
      expect(rows.length).toBe(10);
      for (const row of rows) {
        expect(Number(row.n), `bucket ${row.bucket}`).toBeGreaterThan(280);
        expect(Number(row.n), `bucket ${row.bucket}`).toBeLessThan(520);
      }
    });
  });

  it('refuses a range it cannot draw uniformly from one byte', async () => {
    await asAdminDb(async (db) => {
      expect(await db.expectError(`select app.random_index(0)`)).toMatch(/positive range/i);
      expect(await db.expectError(`select app.random_index(257)`)).toMatch(/256 or less/i);
    });
  });

  it('still satisfies the password policy every time', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ password: string; problems: string[] | null }>(
        `select p as password, app.password_problems(p) as problems
           from (select app.generate_password(12) as p
                   from generate_series(1, 40)) g`);
      expect(rows.length).toBe(40);
      for (const row of rows) {
        expect(row.problems ?? [], row.password).toEqual([]);
        expect(row.password.length).toBe(12);
        // The look-alike characters stay excluded.
        expect(row.password, row.password).not.toMatch(/[Il1O0]/);
      }
      expect(new Set(rows.map((r) => r.password)).size).toBe(40);
    });
  });
});
