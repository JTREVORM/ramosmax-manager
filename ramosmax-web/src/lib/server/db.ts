import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Server-side database access.
 *
 * RamosMAX business logic lives in SECURITY DEFINER functions, so the server
 * reaches the database by calling those functions and nothing else. This
 * module is the single seam between the application and however the database
 * happens to be reached.
 *
 * Two backends:
 *   * 'supabase' — a Supabase project, through supabase-js .rpc(). This is the
 *     production path.
 *   * 'local'    — a direct PostgreSQL connection, used in development when no
 *     Supabase project is configured, so the same functions can be exercised
 *     against a real database.
 *
 * The BUSINESS RULES are identical either way: both call the same functions
 * with the same arguments. Only the transport differs.
 */

export type Backend = 'supabase' | 'local';

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

/** The shared development connection pool. Never used against Supabase. */
export async function localPool(): Promise<PgPool> {
  if (!pool) {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev',
      max: 5,
    }) as unknown as PgPool;
  }
  return pool;
}

/* -------------------------------------------------------------------------- */

/**
 * Runs a read AS THE SIGNED-IN USER, so RLS applies to server-rendered pages
 * exactly as it would to a direct client query.
 *
 * This matters more than it looks. The local development pool connects as a
 * SUPERUSER, and a superuser bypasses row-level security entirely — even with
 * FORCE ROW LEVEL SECURITY set. Reading through that connection would quietly
 * show every row to every role. So each request opens a transaction, takes the
 * `authenticated` role and sets the same `request.jwt.claims` PostgREST would,
 * which is precisely how the RLS tests run.
 */
export async function queryAsUser<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (backend() === 'supabase') {
    throw new Error('Use the Supabase client for user-scoped reads.');
  }
  const pooled = (await localPool()) as unknown as {
    connect(): Promise<{
      query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
      release(): void;
    }>;
  };
  const client = await pooled.connect();
  try {
    await client.query('begin');
    await client.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`,
    );
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
 * A database handle with SERVICE-LEVEL privileges. Use it only in server code
 * that has already decided the caller is allowed to act — the SECURITY DEFINER
 * functions still re-check permissions themselves.
 *
 * The service-role key never leaves the server.
 */
export async function serviceDb(): Promise<Db> {
  if (backend() === 'supabase') {
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    return {
      async rpc<T>(fn: string, args: unknown[] = []) {
        const { data, error } = await client.schema('app').rpc(fn, argsToObject(fn, args));
        if (error) throw new Error(error.message);
        return (Array.isArray(data) ? data : [data]) as T[];
      },
    };
  }

  const client = await localPool();
  return {
    async rpc<T>(fn: string, args: unknown[] = []) {
      const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await client.query(`select * from app.${fn}(${placeholders})`, args);
      return rows as T[];
    },
  };
}

/**
 * Named arguments for PostgREST. Positional arguments are a local-only
 * convenience; Supabase RPC takes an object, so each function's parameter
 * names are declared here once.
 */
const PARAMETER_NAMES: Record<string, string[]> = {
  throttle_remaining_minutes: ['p_phone'],
  record_sign_in_failure: ['p_phone'],
  clear_sign_in_failures: ['p_phone'],
  sign_in_identity_for_phone: ['p_phone'],
  resolve_sign_in: ['p_user'],
  complete_password_change: ['p_user'],
  normalize_phone: ['p_input'],
  password_problems: ['p_password', 'p_phone', 'p_staff_id', 'p_full_name'],
};

function argsToObject(fn: string, args: unknown[]): Record<string, unknown> {
  const names = PARAMETER_NAMES[fn];
  if (!names) throw new Error(`No parameter names declared for app.${fn}`);
  return Object.fromEntries(args.map((value, i) => [names[i], value]));
}
