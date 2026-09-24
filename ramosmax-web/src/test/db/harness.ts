/**
 * Database test harness.
 *
 * Every test connects the way PostgREST does: as a connection pool role that
 * then `SET ROLE`s to `anon` or `authenticated` and sets `request.jwt.claims`.
 * That is what makes these tests meaningful — they exercise the real privilege
 * system and the real RLS policies, not a mock.
 *
 * `asClient` runs inside a transaction that is always ROLLED BACK, so tests
 * never leak state into each other.
 */
import pg from 'pg';

export const DEV_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';

/** The seeded development accounts, one per role. */
export const SEED = {
  admin: '00000000-0000-4000-8000-000000000001',
  manager: '00000000-0000-4000-8000-000000000002',
  cashier: '00000000-0000-4000-8000-000000000003',
  worker: '00000000-0000-4000-8000-000000000004',
  shareholder: '00000000-0000-4000-8000-000000000005',
  auditor: '00000000-0000-4000-8000-000000000006',
} as const;

export type SeedRole = keyof typeof SEED;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: DEV_URL, max: 8 });
  return pool;
}

export async function closePool() {
  await pool?.end();
  pool = null;
}

export interface QueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

/** A client session, scoped to one rolled-back transaction. */
export interface Session {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  /** Runs a statement and returns the error message, or null when it succeeded. */
  expectError(sql: string, params?: unknown[]): Promise<string | null>;
  /** True when the statement was rejected for any reason. */
  denied(sql: string, params?: unknown[]): Promise<boolean>;
}

/**
 * Runs `fn` as a signed-in user (or as `anon` when uid is null), then rolls
 * back. This mirrors a single PostgREST request.
 */
export async function asClient<T>(
  uid: string | null,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    if (uid === null) {
      await client.query('set local role anon');
    } else {
      await client.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`,
      );
      await client.query('set local role authenticated');
    }

    const session: Session = {
      async query(sql, params) {
        const result = await client.query(sql, params as never);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      async expectError(sql, params) {
        // The savepoint is taken immediately BEFORE the statement, so rolling
        // back to it undoes only that statement. Taking it earlier would also
        // revert the `set local role` / `request.jwt.claims` that establish
        // who the caller is, silently turning later assertions into anonymous
        // ones.
        await client.query('savepoint attempt');
        try {
          await client.query(sql, params as never);
          await client.query('release savepoint attempt');
          return null;
        } catch (e) {
          await client.query('rollback to savepoint attempt').catch(() => {});
          return (e as Error).message;
        }
      },
      async denied(sql, params) {
        return (await session.expectError(sql, params)) !== null;
      },
    };

    return await fn(session);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

/** Runs `fn` with full privileges, for arranging fixtures. Always rolled back. */
export async function asAdminDb<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const session: Session = {
      async query(sql, params) {
        const result = await client.query(sql, params as never);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      async expectError(sql, params) {
        // See the note in asClient: the savepoint must be taken immediately
        // before the statement so a rollback cannot discard the session role.
        await client.query('savepoint attempt');
        try {
          await client.query(sql, params as never);
          await client.query('release savepoint attempt');
          return null;
        } catch (e) {
          await client.query('rollback to savepoint attempt').catch(() => {});
          return (e as Error).message;
        }
      },
      async denied(sql, params) {
        return (await session.expectError(sql, params)) !== null;
      },
    };
    return await fn(session);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

/**
 * Creates a throwaway user inside the caller's transaction and returns its id.
 * Because every harness transaction is rolled back, these never persist.
 */
export async function makeUser(
  session: Session,
  options: {
    role: string;
    active?: boolean;
    mustChangePassword?: boolean;
    accessExpiresAt?: string | null;
    permissions?: string[];
    deniedPermissions?: string[];
    phoneSuffix?: number;
  },
): Promise<string> {
  const suffix = options.phoneSuffix ?? Math.floor(Math.random() * 8_999_999) + 1_000_000;
  const { rows } = await session.query(
    `insert into auth.users (email) values (app.new_sign_in_identity()) returning id`,
  );
  const id = rows[0].id as string;
  await session.query(
    `insert into public.users
       (id, phone_number, full_name, role, active, must_change_password,
        access_expires_at, permissions, denied_permissions)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      `+2567${String(suffix).padStart(8, '0').slice(0, 8)}`,
      `Fixture ${options.role}`,
      options.role,
      options.active ?? true,
      options.mustChangePassword ?? false,
      options.accessExpiresAt ?? null,
      options.permissions ?? [],
      options.deniedPermissions ?? [],
    ],
  );
  return id;
}

/**
 * Switches the open transaction to act as `uid`. Used where a test must create
 * a fixture with full privileges and then act as a client on it.
 */
export async function becomeClient(session: Session, uid: string | null) {
  if (uid === null) {
    await session.query('set local role anon');
    return;
  }
  await session.query(
    `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`,
  );
  await session.query('set local role authenticated');
}

/** Returns to full privileges after `becomeClient`. */
export async function becomeOwner(session: Session) {
  await session.query('reset role');
}
