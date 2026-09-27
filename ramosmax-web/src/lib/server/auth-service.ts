import 'server-only';
import { authProvider } from './auth-provider';
import { serviceDb } from './db';
import { endSession, sessionIssuedAt, sessionUserId, startSession } from './session';

/**
 * Sign-in, sign-out and password change.
 *
 * This is the web port of functions/src/session.js. Every rule it enforced is
 * enforced here, in the same order:
 *
 *   1. normalise the phone number (server-side; the client's copy is only UX);
 *   2. refuse while the number is throttled;
 *   3. resolve the number to its HIDDEN identity — never revealing whether a
 *      number is registered;
 *   4. verify the credential;
 *   5. on failure, record it and answer with the SAME generic message for
 *      every cause;
 *   6. on success, clear the counter and let the PROFILE decide (active,
 *      access period, role);
 *   7. start the session and report whether a password change is forced.
 *
 * The audit trail is written by the database functions, inside the same
 * transaction as the decision.
 */

/**
 * Where to send someone whose cookie is validly signed but no longer usable
 * (deactivated, expired, or revoked by a password change). It clears the
 * cookie and then shows the sign-in page; redirecting straight to /login would
 * loop, because proxy.ts would send a signed cookie back to the dashboard.
 */
export const SESSION_ENDED = '/api/auth/sign-out?redirect=/login';

/** One message for every "wrong phone or password" case. */
const BAD_CREDENTIALS = 'Incorrect phone number or password.';

export type SignInResult =
  { ok: true; mustChangePassword: boolean } | { ok: false; reason: string; message: string };

export async function signIn(phoneInput: string, password: string): Promise<SignInResult> {
  const db = await serviceDb();

  const [{ normalize_phone: phone }] = await db.rpc<{ normalize_phone: string | null }>(
    'normalize_phone',
    [phoneInput],
  );
  if (!phone) {
    return {
      ok: false,
      reason: 'phone',
      message: 'Enter a valid phone number, e.g. 0772 123 456.',
    };
  }

  if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
    return { ok: false, reason: 'invalid_credentials', message: BAD_CREDENTIALS };
  }

  const [{ throttle_remaining_minutes: locked }] = await db.rpc<{
    throttle_remaining_minutes: number;
  }>('throttle_remaining_minutes', [phone]);
  if (locked > 0) {
    return {
      ok: false,
      reason: 'too_many_attempts',
      message: `Too many sign-in attempts. Wait ${locked} minute${locked === 1 ? '' : 's'} and try again.`,
    };
  }

  const [{ sign_in_identity_for_phone: email }] = await db.rpc<{
    sign_in_identity_for_phone: string | null;
  }>('sign_in_identity_for_phone', [phone]);

  // An unknown number and a wrong password are answered identically, so the
  // response never reveals whether a phone number has an account.
  if (!email) {
    await db.rpc('record_sign_in_failure', [phone]);
    return { ok: false, reason: 'invalid_credentials', message: BAD_CREDENTIALS };
  }

  const userId = await authProvider().verifyPassword(email, password);
  if (!userId) {
    await db.rpc('record_sign_in_failure', [phone]);
    return { ok: false, reason: 'invalid_credentials', message: BAD_CREDENTIALS };
  }

  await db.rpc('clear_sign_in_failures', [phone]);

  const [decision] = await db.rpc<{
    outcome: string;
    must_change_password: boolean;
    message: string | null;
  }>('resolve_sign_in', [userId]);

  if (decision.outcome !== 'ok') {
    return {
      ok: false,
      reason: decision.outcome,
      message: decision.message ?? 'You cannot sign in at the moment.',
    };
  }

  await startSession(userId);
  return { ok: true, mustChangePassword: decision.must_change_password };
}

export async function signOut(): Promise<void> {
  await endSession();
}

export type ChangePasswordResult = { ok: true } | { ok: false; reason: string; message: string };

/**
 * Changing one's own password. Allowed while a forced change is pending — that
 * is the only thing such an account may do — but never for a disabled account.
 */
export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const userId = await sessionUserId();
  if (!userId) {
    return {
      ok: false,
      reason: 'unauthenticated',
      message: 'Your session has ended. Please sign in again.',
    };
  }

  const db = await serviceDb();
  const provider = authProvider();

  const profile = await loadProfileForPasswordChange(userId);
  if (!profile) {
    return { ok: false, reason: 'actor_inactive', message: 'Your RamosMAX account is not active.' };
  }

  const [{ throttle_remaining_minutes: locked }] = await db.rpc<{
    throttle_remaining_minutes: number;
  }>('throttle_remaining_minutes', [profile.phoneNumber]);
  if (locked > 0) {
    return {
      ok: false,
      reason: 'too_many_attempts',
      message: `Too many attempts. Wait ${locked} minute${locked === 1 ? '' : 's'} and try again.`,
    };
  }

  const verified = await provider.verifyPassword(profile.email, currentPassword);
  if (verified !== userId) {
    await db.rpc('record_sign_in_failure', [profile.phoneNumber]);
    return { ok: false, reason: 'wrong_password', message: 'Your current password is incorrect.' };
  }

  const [{ password_problems: problems }] = await db.rpc<{ password_problems: string[] }>(
    'password_problems',
    [newPassword, profile.phoneNumber, profile.staffId, profile.fullName],
  );
  if (problems && problems.length > 0) {
    return { ok: false, reason: 'weak_password', message: problems.join(' ') };
  }

  if (newPassword === currentPassword) {
    return {
      ok: false,
      reason: 'same_password',
      message: 'Choose a new password that is different from the current one.',
    };
  }

  // ORDER MATTERS, and each step is safe to stop at.
  //
  //   1. the credential store, first: if this fails nothing has changed;
  //   2. the profile, which clears the forced change, stamps
  //      `password_changed_at` and writes the audit entry in one transaction.
  //      If it fails, the new password works and the person is asked to change
  //      it again — with the new one as the current one. Never a lock-out.
  //   3. the stamp that ends every OTHER session;
  //   4. a fresh cookie for this device, which must be issued AFTER step 3 or
  //      it would invalidate itself.
  await provider.setPassword(userId, newPassword);
  await db.rpc('complete_password_change', [userId]);
  await endOtherSessions(userId);
  await startSession(userId);

  return { ok: true };
}

/**
 * Ends every session this person has open.
 *
 * This is an APPLICATION session concern, not a credential-store one, and
 * putting it on the credential store is what broke the hosted password
 * change: `AuthProvider.revokeSessions` took a RamosMAX user id and handed it
 * to `supabase.auth.admin.signOut`, whose first argument is a logged-in JWT.
 * GoTrue answered exactly what you would expect of a uuid offered as a token —
 * "token contains an invalid number of segments" — and the request 500ed after
 * the password had already been changed.
 *
 * There was never a Supabase session to end. The browser is never given a
 * Supabase token; the session is this application's own signed cookie, and a
 * cookie is revoked by refusing to accept it. `currentUser()` refuses any
 * issued before `password_changed_at` or `sessions_valid_from`, and this
 * stamps the second of those.
 */
export async function endOtherSessions(userId: string): Promise<void> {
  const db = await serviceDb();
  await db.rpc('end_sessions', [userId]);
}

interface PasswordChangeProfile {
  email: string;
  phoneNumber: string;
  fullName: string;
  staffId: string | null;
}

async function loadProfileForPasswordChange(userId: string): Promise<PasswordChangeProfile | null> {
  const { backend, localPool } = await import('./db');

  if (backend() === 'supabase') {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data } = await client
      .from('users')
      .select('phone_number, full_name, staff_id, active, access_expires_at')
      .eq('id', userId)
      .single();
    if (!data || !data.active) return null;
    if (data.access_expires_at && new Date(data.access_expires_at) <= new Date()) return null;

    const { data: authUser } = await client.auth.admin.getUserById(userId);
    if (!authUser?.user?.email) return null;

    return {
      email: authUser.user.email,
      phoneNumber: data.phone_number as string,
      fullName: data.full_name as string,
      staffId: (data.staff_id as string | null) ?? null,
    };
  }

  const pool = await localPool();
  const { rows } = await pool.query(
    `select a.email, u.phone_number, u.full_name, u.staff_id
       from public.users u join auth.users a on a.id = u.id
      where u.id = $1 and app.is_account_enabled(u.id)`,
    [userId],
  );
  if (!rows[0]) return null;
  return {
    email: rows[0].email as string,
    phoneNumber: rows[0].phone_number as string,
    fullName: rows[0].full_name as string,
    staffId: (rows[0].staff_id as string | null) ?? null,
  };
}

/**
 * The signed-in user's profile and effective permissions, or null.
 *
 * `mustChangePassword` is reported separately from `live` because such an
 * account may still read its own profile — it has to, to complete the change —
 * while being denied everything else.
 */
export interface CurrentUser {
  id: string;
  fullName: string;
  role: string;
  staffId: string | null;
  active: boolean;
  mustChangePassword: boolean;
  accessExpired: boolean;
  permissions: string[];
}

export async function currentUser(): Promise<CurrentUser | null> {
  const userId = await sessionUserId();
  if (!userId) return null;

  // Read with service privileges, not as the user: this is the call that
  // DECIDES whether they may use the app at all, so it has to be able to see
  // an account that has just been deactivated or locked out. Everything the
  // pages then read goes through `queryAsUser`, under the person's own
  // authority. Reaching the database is the same either way; only where the
  // PASSWORD lives differs, and that is `auth-provider.ts`.
  const { localPool } = await import('./db');
  const pool = await localPool();
  const { rows } = await pool.query(
    `select u.id, u.full_name, u.role, u.staff_id, u.active, u.must_change_password,
            (u.access_expires_at is not null and u.access_expires_at <= now()) as access_expired,
            greatest(u.password_changed_at,
                     coalesce(u.sessions_valid_from, u.password_changed_at)) as sessions_from,
            coalesce(app.effective_permissions(u.id), '{}') as permissions
       from public.users u where u.id = $1`,
    [userId],
  );
  if (!rows[0]) return null;

  // Session revocation. A cookie issued before this moment is no longer
  // accepted, which is the whole of how a session is ended here — there is no
  // server-side session to delete, only a signed statement to stop believing.
  //
  // TWO stamps, whichever is later:
  //   * password_changed_at  — the person changed their own password, or an
  //                            administrator reset it;
  //   * sessions_valid_from  — the sign-in phone number changed, or an
  //                            administrator reset the password.
  // Reading only the first is why a phone-number change used to audit that it
  // had ended every session while leaving every cookie working.
  const revokedAt = rows[0].sessions_from as Date | null;
  if (revokedAt) {
    const issuedAt = await sessionIssuedAt();
    if (issuedAt !== null && issuedAt < new Date(revokedAt).getTime()) return null;
  }

  return {
    id: rows[0].id as string,
    fullName: rows[0].full_name as string,
    role: rows[0].role as string,
    staffId: (rows[0].staff_id as string | null) ?? null,
    active: rows[0].active as boolean,
    mustChangePassword: rows[0].must_change_password as boolean,
    accessExpired: rows[0].access_expired as boolean,
    permissions: (rows[0].permissions as string[]) ?? [],
  };
}

/**
 * The signed-in user's effective permissions as a set, for page guards.
 *
 * A guard decides which SCREEN to show. It is not what protects the data —
 * RLS returns nothing to someone who may not read it either way — but showing
 * an empty list to a person who has no business on that screen is confusing,
 * and the reference implementation shows them a clear message instead.
 */
export async function currentPermissions(): Promise<Set<string>> {
  const user = await currentUser();
  return new Set(user?.permissions ?? []);
}
