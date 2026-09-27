import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';

afterAll(closePool);

/**
 * PGCRYPTO IS NOT IN `public`.
 *
 * A hosted Supabase project installs its extensions into a schema called
 * `extensions` and gives the `postgres` role a search_path that includes it. A
 * SECURITY DEFINER function does not use the role's search_path — it uses its
 * own pinned one — so `digest()` is reachable from a migration and from a
 * script, and unreachable from inside the functions that do the work.
 *
 * That is not hypothetical. It returned 500 on the first real sign-in against
 * the hosted project while every migration had applied cleanly, and it would
 * have taken every payment, payroll and share movement with it: two functions
 * call `digest`, and thirty call those two.
 *
 * The local bootstrap used to put pgcrypto in `public`, which every pinned
 * search_path includes, so 1,652 tests passed against a project where nothing
 * could be written. It now installs it where the platform does. These tests
 * are what make that setup mean something.
 */
describe('pgcrypto lives outside the pinned search_path', () => {
  it('is installed somewhere that is NOT `public`', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ schema: string }>(
        `select n.nspname as schema from pg_extension e
           join pg_namespace n on n.oid = e.extnamespace
          where e.extname = 'pgcrypto'`);
      expect(rows[0]?.schema, 'pgcrypto must be installed').toBeDefined();
      // If this ever reads `public` again, every test below passes for the
      // wrong reason and the hosted project breaks without warning.
      expect(rows[0].schema).not.toBe('public');
    });
  });

  it('is not reachable unqualified from a search_path of `public, pg_temp`', async () => {
    await asAdminDb(async (db) => {
      // The failure itself, reproduced: a function pinned the way every
      // RamosMAX definer function is pinned, but without `app` in front of it
      // to find the wrapper. If pgcrypto ever moves back into `public` this
      // stops failing, and that is the signal.
      // PostgreSQL validates a `language sql` body when the function is
      // created, so the refusal arrives here rather than on the call. That is
      // also why every migration applied cleanly: they were created by a role
      // whose own search_path DOES include `extensions`, and only the pinned
      // path used at call time left it out.
      const message = await db.expectError(
        `create or replace function app.probe_unqualified_digest() returns text
           language sql immutable
           set search_path = public, pg_temp
           as $probe$ select encode(digest('x'::text, 'sha256'::text), 'hex') $probe$`);
      expect(message).toMatch(/function digest\(.*\) does not exist/i);
    });
  });

  it('IS reachable from `app, public, pg_temp`, which is what every function pins',
    async () => {
      await asAdminDb(async (db) => {
        await db.query(
          `create or replace function app.probe_pinned_digest() returns text
             language sql immutable
             set search_path = app, public, pg_temp
             as $probe$ select encode(digest('x', 'sha256'), 'hex') $probe$`);
        const { rows } = await db.query<{ hash: string }>(
          `select app.probe_pinned_digest() as hash`);
        await db.query(`drop function app.probe_pinned_digest()`);
        expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });
});

describe('the wrapper that fixes it', () => {
  it('exists for both of pgcrypto’s overloads', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ args: string }>(
        `select pg_get_function_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'digest' order by 1`);
      expect(rows.map((r) => r.args)).toEqual(
        ['p_data bytea, p_type text', 'p_data text, p_type text']);
    });
  });

  it('names pgcrypto’s schema explicitly rather than relying on a path', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ prosrc: string; config: string | null }>(
        `select p.prosrc, array_to_string(p.proconfig, ',') as config
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'digest'
            and pg_get_function_arguments(p.oid) = 'p_data text, p_type text'`);
      const { rows: where } = await db.query<{ schema: string }>(
        `select n.nspname as schema from pg_extension e
           join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'`);
      expect(rows[0].prosrc).toContain(`${where[0].schema}.digest`);
      // Its own path cannot be influenced by whoever calls it.
      expect(rows[0].config).toBe('search_path=pg_catalog, pg_temp');
    });
  });

  it('agrees byte for byte with pgcrypto, so hashes already stored still match',
    async () => {
      await asAdminDb(async (db) => {
        const { rows: schema } = await db.query<{ schema: string }>(
          `select n.nspname as schema from pg_extension e
             join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'`);
        const { rows } = await db.query<{ same: boolean }>(
          `select encode(app.digest('ramosmax:+256772000001', 'sha256'), 'hex')
                = encode(${schema[0].schema}.digest('ramosmax:+256772000001', 'sha256'), 'hex')
                as same`);
        expect(rows[0].same).toBe(true);
      });
    });
});

describe('the two things that were broken by it', () => {
  it('hashes a phone number for the sign-in throttle', async () => {
    await asAdminDb(async (db) => {
      // This is the call that returned `function digest(text, unknown) does
      // not exist` on the first hosted sign-in.
      const { rows } = await db.query<{ hash: string; minutes: number }>(
        `select app.phone_hash('+256772000001') as hash,
                app.throttle_remaining_minutes('0772000001') as minutes`);
      expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(rows[0].minutes)).toBe(0);
    });
  });

  it('computes an idempotency fingerprint, which thirty functions need', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ fingerprint: string }>(
        `select encode(app.digest('payments.record:{"a":1}', 'sha256'), 'hex') as fingerprint`);
      expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('pins the search_path of every function on the authentication path', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app'
            and p.proname in ('phone_hash', 'new_sign_in_identity', 'digest',
                              'throttle_remaining_minutes', 'record_sign_in_failure',
                              'clear_sign_in_failures', 'sign_in_identity_for_phone',
                              'resolve_sign_in', 'claim_request')
            and (p.proconfig is null
                 or not exists (select 1 from unnest(p.proconfig) c
                                 where c like 'search_path=%'))
          order by 1`);
      expect(rows.map((r) => r.proname)).toEqual([]);
    });
  });

  it('leaves every SECURITY DEFINER function with a pinned search_path', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.prosecdef
            and (p.proconfig is null
                 or not exists (select 1 from unnest(p.proconfig) c
                                 where c like 'search_path=%'))`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});
