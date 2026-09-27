import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { backend, localPool } from './db';

/**
 * The credential store.
 *
 * This is the ONLY part of authentication that differs between a real Supabase
 * project and local development. Everything that constitutes a RamosMAX
 * business rule — the throttle, the account decision, the password policy, the
 * audit trail, the forced change — lives outside this interface and is shared.
 *
 * Keeping the seam this narrow is deliberate: it is what lets the local
 * development path be genuine rather than a mock, and what makes swapping in
 * Supabase a configuration change rather than a rewrite.
 */
export interface AuthProvider {
  /** Verifies a credential. Returns the user id, or null when it is wrong. */
  verifyPassword(email: string, password: string): Promise<string | null>;
  /** Replaces a user's password. */
  setPassword(userId: string, password: string): Promise<void>;
  /** Creates a credential record with a hidden identity. Returns the user id. */
  createIdentity(email: string, password: string): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* Supabase (production)                                                       */
/* -------------------------------------------------------------------------- */

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

const supabaseProvider: AuthProvider = {
  async verifyPassword(email, password) {
    // A throwaway client: verifying must never disturb the caller's session.
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.user) return null;

    // Verifying a password issues a GoTrue session, whether or not anybody
    // wants one. RamosMAX does not: the browser is never given a Supabase
    // token, and the session it carries is this application's own signed
    // cookie. So the session just created is handed straight back, with the
    // access token it came with — which is what `admin.signOut` has always
    // wanted, and what it never used to be given.
    //
    // `local` scope: this ends the throwaway session and nothing else.
    // Verifying somebody's password must not sign them out elsewhere.
    if (data.session?.access_token) {
      await adminClient().auth.admin
        .signOut(data.session.access_token, 'local')
        .catch(() => {
          // A session left behind is untidy, not dangerous — nothing accepts a
          // Supabase token here. Never fail a sign-in over it.
        });
    }
    return data.user.id;
  },

  async setPassword(userId, password) {
    const { error } = await adminClient().auth.admin.updateUserById(userId, { password });
    if (error) throw new Error(error.message);
  },

  async createIdentity(email, password) {
    const { data, error } = await adminClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(error?.message ?? 'Could not create the account.');
    return data.user.id;
  },
};

/* -------------------------------------------------------------------------- */
/* local development                                                           */
/* -------------------------------------------------------------------------- */
/**
 * DEVELOPMENT ONLY. Verifies against the bcrypt hash in auth.users using
 * pgcrypto — the SAME hashing scheme GoTrue uses — so the credential check is
 * genuine rather than mocked. It is selected only when no Supabase project is
 * configured, and it is deleted once one is.
 */
const localProvider: AuthProvider = {
  async verifyPassword(email, password) {
    const pool = await localPool();
    const { rows } = await pool.query(
      `select id from auth.users
        where email = $1 and encrypted_password = crypt($2, encrypted_password)`,
      [email, password],
    );
    return (rows[0]?.id as string) ?? null;
  },

  async setPassword(userId, password) {
    const pool = await localPool();
    await pool.query(
      `update auth.users set encrypted_password = crypt($2, gen_salt('bf')), updated_at = now()
        where id = $1`,
      [userId, password],
    );
  },

  async createIdentity(email, password) {
    const pool = await localPool();
    const { rows } = await pool.query(
      `insert into auth.users (email, encrypted_password, email_confirmed_at)
       values ($1, crypt($2, gen_salt('bf')), now()) returning id`,
      [email, password],
    );
    return rows[0].id as string;
  },
};

export function authProvider(): AuthProvider {
  return backend() === 'supabase' ? supabaseProvider : localProvider;
}
