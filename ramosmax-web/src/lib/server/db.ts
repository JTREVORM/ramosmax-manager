import 'server-only';

/**
 * Server-side database access.
 *
 * RamosMAX business logic lives in SECURITY DEFINER functions and in RLS, so
 * the server reaches the database by calling those functions and by reading
 * under the caller's own authority — never by deciding anything itself.
 *
 * TWO INDEPENDENT DECISIONS, and keeping them apart is the point:
 *
 *   * WHERE CREDENTIALS LIVE — `backend()`. With a Supabase project
 *     configured, passwords are GoTrue's; without one, they are bcrypt hashes
 *     in a local `auth.users`, checked with the same pgcrypto scheme GoTrue
 *     uses. `auth-provider.ts` is that seam and nothing else depends on it.
 *
 *   * HOW THE DATABASE IS REACHED — always a PostgreSQL connection, from
 *     `DATABASE_URL`. Locally that is a database on this machine; in a
 *     deployment it is the Supabase project's own connection string.
 *
 * They are separate because the reads this application makes are SQL — joins,
 * aggregates and window functions written once, in one place, next to the
 * rules they serve. PostgREST cannot run those, and rewriting every one of
 * them as a view would move business logic out of the database and into the
 * shape of an HTTP API. So the transport stays SQL and RLS stays in charge:
 * every read takes the `authenticated` role and sets the same
 * `request.jwt.claims` PostgREST would, so a page sees exactly what a direct
 * client query would see, and nothing more.
 */

export type Backend = 'supabase' | 'local';

/** Where CREDENTIALS live. Not where the data is read from. */
export function backend(): Backend {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ? 'supabase' : 'local';
}

export interface Db {
  /** Calls a SECURITY DEFINER function and returns its rows. */
  rpc<T = Record<string, unknown>>(fn: string, args?: unknown[]): Promise<T[]>;
}

/* -------------------------------------------------------------------------- */
/* local (development)                                                         */
/* -------------------------------------------------------------------------- */

type PgPool = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

let pool: PgPool | null = null;

/** The shared connection pool, to whatever `DATABASE_URL` points at. */
export async function localPool(): Promise<PgPool> {
  if (!pool) {
    const pg = await import('pg');
    const { Pool } = pg;

    // node-postgres hands back `bigint` as a STRING, because a 64-bit integer
    // does not always fit a JS number. Every money column in RamosMAX is
    // `bigint`, so left alone the application would compare `'0' === 0` (false)
    // and silently hide the actions that depend on it. PostgREST serialises the
    // same columns as JSON numbers, so parsing them here is also what keeps the
    // local and Supabase paths identical.
    //
    // Whole shillings never approach 2^53; anything that does is a bug or a
    // corrupted row, and must be loud rather than quietly rounded.
    pg.types.setTypeParser(20, (value: string) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Refusing to round a bigint that exceeds a safe integer: ${value}`);
      }
      return parsed;
    });

    const connectionString =
      process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';

    pool = new Pool({
      connectionString,
      // Supabase requires TLS, and its chain is not in Node's trust store.
      // `rejectUnauthorized: false` is what the Supabase client libraries and
      // `scripts/apply-migrations.mjs` do; the connection is still encrypted.
      ssl: /supabase\.(co|com)/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
      // A serverless deployment runs many short-lived instances, so each one
      // keeps very few connections and hands them back quickly. The pooled
      // (Supavisor) connection string is what makes this safe at scale.
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    }) as unknown as PgPool;
  }
  return pool;
}

/* -------------------------------------------------------------------------- */

/**
 * Runs a read AS THE SIGNED-IN USER, so RLS applies to server-rendered pages
 * exactly as it would to a direct client query.
 *
 * This matters more than it looks. The connection is made as an owner role —
 * `postgres` on Supabase, a superuser locally — and such a role bypasses
 * row-level security entirely, even with FORCE ROW LEVEL SECURITY set. Reading
 * through it directly would quietly show every row to every role. So each
 * request opens a transaction, takes the `authenticated` role and sets the same
 * `request.jwt.claims` PostgREST would, which is precisely how the RLS tests
 * run. From that point on the connection has no more authority than the person
 * using it.
 *
 * The transaction is also what makes a transaction-mode pooler safe: `SET
 * LOCAL` lasts exactly as long as the statement's own transaction, so a
 * connection handed to the next request carries nothing over.
 */
export async function queryAsUser<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pooled = (await localPool()) as unknown as {
    connect(): Promise<{
      query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
      release(): void;
    }>;
  };
  const client = await pooled.connect();
  try {
    await client.query('begin');
    // `set_config(..., true)` rather than `SET LOCAL ...= '<json>'`: the claim
    // is a BOUND PARAMETER, so a user id can never be read as SQL. It comes
    // from a cookie this server signed, but the value that decides who you are
    // is the last place to rely on that.
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
    const { rows } = await client.query(sql, params as never);
    await client.query('commit');
    return rows as T[];
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Calls a SECURITY DEFINER function AS THE SIGNED-IN USER, so the function's
 * own permission checks see the real caller. This is how every Phase C
 * mutation reaches the database.
 */
export async function rpcAsUser<T = Record<string, unknown>>(
  userId: string,
  fn: string,
  params: unknown[] = [],
): Promise<T[]> {
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
  return queryAsUser<T>(userId, `select * from app.${fn}(${placeholders})`, params);
}

/**
 * A database handle with SERVICE-LEVEL privileges — the owner role, without
 * the `SET LOCAL ROLE authenticated` that `queryAsUser` applies.
 *
 * Use it only where there is no signed-in caller to act as: resolving a phone
 * number to a hidden identity before anybody is signed in, and the scheduled
 * notification run. The SECURITY DEFINER functions still re-check permissions
 * themselves, so this is a way to reach them, never a way around them.
 *
 * It is server-only, as the `server-only` import at the top of this file
 * enforces at build time: importing it from a Client Component fails the build
 * rather than shipping the connection string to a browser.
 */
export async function serviceDb(): Promise<Db> {
  const client = await localPool();
  return {
    async rpc<T>(fn: string, args: unknown[] = []) {
      const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await client.query(`select * from app.${fn}(${placeholders})`, args);
      return rows as T[];
    },
  };
}
