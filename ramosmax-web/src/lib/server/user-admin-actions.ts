'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';
import { authProvider } from './auth-provider';
import { backend, localPool, serviceDb } from './db';
import { currentPermissions, currentUser } from './auth-service';
import type { ActionResult } from './operations-actions';

/**
 * Server Actions for user management.
 *
 * Most forward to one SECURITY DEFINER function, which re-checks the caller.
 * Two cannot: creating a user and resetting a password both have a CREDENTIAL
 * side effect, and the credential store is not something a browser session may
 * touch. Those two check the caller's permission first, then act with service
 * privileges — and the functions they call re-check the permission anyway, so
 * a mistake here is caught by the database rather than trusted.
 */

async function run(fn: string, params: unknown[], revalidate: string[]): Promise<ActionResult> {
  try {
    const rows = await callRpc<Record<string, unknown>>(fn, params);
    for (const path of revalidate) revalidatePath(path);
    const first = rows[0] ? Object.values(rows[0])[0] : undefined;
    return { ok: true, id: typeof first === 'string' ? first : undefined };
  } catch (e) {
    return {
      ok: false,
      message: ((e as Error).message ?? 'Something went wrong.').replace(/^error:\s*/i, ''),
    };
  }
}

const text = (form: FormData, key: string): string | null => {
  const value = form.get(key);
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

/** An empty string means "clear this field"; null means "leave it alone". */
const editable = (form: FormData, key: string): string | null =>
  form.has(key) ? String(form.get(key)).trim() : null;

const list = (form: FormData, key: string): string[] =>
  form.getAll(key).map(String).filter((v) => v !== '');

const USERS = ['/users'];

/* --------------------------------------------------------------- profile */

export async function updateUserProfileAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  return run('update_user_profile', [
    id, editable(form, 'full_name'), editable(form, 'email'), editable(form, 'position'),
    editable(form, 'department'), editable(form, 'specialization'), null,
  ], [...USERS, `/users/${id}`]);
}

export async function changeUserPhoneAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  return run('change_user_phone', [id, text(form, 'phone_number'), text(form, 'reason')],
    [...USERS, `/users/${id}`]);
}

export async function linkStaffAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  return run('link_staff', [id, text(form, 'staff_id')], [...USERS, `/users/${id}`]);
}

/* ---------------------------------------------------------------- access */

export async function setUserRoleAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  return run('set_user_role', [id, text(form, 'role'), text(form, 'reason')],
    [...USERS, `/users/${id}`]);
}

export async function setUserActiveAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  return run('set_user_active', [id, form.get('active') === 'true', text(form, 'reason')],
    [...USERS, `/users/${id}`]);
}

export async function setUserPermissionsAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  return run('set_user_permissions', [
    id, list(form, 'granted'), list(form, 'denied'), text(form, 'reason'),
  ], [...USERS, `/users/${id}`]);
}

export async function grantTemporaryPermissionAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  const hours = Number(text(form, 'hours') ?? '4');
  const expires = new Date(Date.now() + (Number.isFinite(hours) ? hours : 4) * 3_600_000);
  return run('grant_temporary_permission', [
    id, text(form, 'permission'), null, expires.toISOString(), text(form, 'reason'),
  ], [...USERS, `/users/${id}`]);
}

export async function revokeTemporaryPermissionAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  return run('revoke_temporary_permission', [text(form, 'grant_id'), text(form, 'reason')],
    [...USERS, `/users/${id}`]);
}

/* ----------------------------------------------------- credential effects */

/**
 * Creates a person.
 *
 * A credential has to exist before a profile can point at it, and the
 * credential store is not reachable from a browser session. So: check the
 * caller here, create the identity, then let `app.create_user` re-check the
 * caller and write the profile. If the profile write fails, the credential is
 * removed again rather than left as a way in.
 */
export async function createUserAction(form: FormData): Promise<ActionResult> {
  const granted = await currentPermissions();
  if (!granted.has('users.create')) {
    return { ok: false, message: 'You do not have permission to create users.' };
  }
  const actor = await currentUser();
  if (!actor) return { ok: false, message: 'Not signed in.' };

  const phone = text(form, 'phone_number');
  const fullName = text(form, 'full_name');
  const role = text(form, 'role');
  const staffId = text(form, 'staff_id');
  if (!phone || !fullName || !role) {
    return { ok: false, message: 'Enter the name, phone number and role.' };
  }

  const db = await serviceDb();
  let identity: string;
  let password: string;
  let authUserId: string;
  try {
    const rows = await db.rpc<{ identity: string; password: string }>('new_user_credentials', []);
    identity = rows[0].identity;
    password = rows[0].password;
    authUserId = await authProvider().createIdentity(identity, password);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  try {
    await callRpc('create_user', [authUserId, phone, fullName, role, staffId,
      text(form, 'reason')]);
  } catch (e) {
    // Leave no credential behind that no profile points at.
    await removeIdentity(authUserId);
    return {
      ok: false,
      message: ((e as Error).message ?? 'That user could not be created.')
        .replace(/^error:\s*/i, ''),
    };
  }

  revalidatePath('/users');
  // The temporary password is shown ONCE, to the person who created the
  // account, and is never written to the audit trail.
  return { ok: true, id: password };
}

/**
 * Issues a new temporary password.
 *
 * The database decides whether the caller may, and generates the password;
 * this hands it to the credential store and shows it once.
 */
export async function resetUserPasswordAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('user_id'));
  try {
    const rows = await callRpc<Record<string, unknown>>('prepare_password_reset',
      [id, text(form, 'reason')]);
    const password = String(Object.values(rows[0])[0]);
    await authProvider().setPassword(id, password);
    await authProvider().revokeSessions(id);
    revalidatePath(`/users/${id}`);
    return { ok: true, id: password };
  } catch (e) {
    return {
      ok: false,
      message: ((e as Error).message ?? 'That password could not be reset.')
        .replace(/^error:\s*/i, ''),
    };
  }
}

/** Removes a credential that no profile points at. */
async function removeIdentity(userId: string): Promise<void> {
  try {
    if (backend() === 'supabase') {
      const { createClient } = await import('@supabase/supabase-js');
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      await admin.auth.admin.deleteUser(userId);
      return;
    }
    const pool = await localPool();
    await pool.query(`delete from auth.users where id = $1`, [userId]);
  } catch {
    // Nothing more to do here: the profile write already failed, and this is
    // the tidy-up. It is logged by the database's own audit trail either way.
  }
}
