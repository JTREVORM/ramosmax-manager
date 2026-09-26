import 'server-only';
import { queryAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reads for user management, the audit trail and the settings screen.
 *
 * Every query runs AS THE SIGNED-IN USER, so RLS decides what comes back:
 * somebody without `users.view` sees only their own record, and the audit
 * trail answers nobody without `audit.view` at all.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

export interface UserRow {
  id: string;
  phone_number: string;
  phone_masked: string;
  full_name: string;
  email: string | null;
  role: string;
  active: boolean;
  must_change_password: boolean;
  access_expires_at: string | null;
  access_expired: boolean;
  staff_id: string | null;
  position: string | null;
  department: string | null;
  specialization: string | null;
  permissions: string[];
  denied_permissions: string[];
  last_login_at: string | null;
  created_at: string;
  temporary_count: number;
}

const USER_COLUMNS = `
  u.id, u.phone_number, app.mask_phone(u.phone_number) as phone_masked, u.full_name, u.email,
  u.role, u.active, u.must_change_password, u.access_expires_at,
  (u.access_expires_at is not null and u.access_expires_at <= now()) as access_expired,
  u.staff_id, u.position, u.department, u.specialization, u.permissions, u.denied_permissions,
  u.last_login_at, u.created_at,
  (select count(*)::int from public.temporary_grants g
    where g.user_id = u.id and g.revoked_at is null and g.expires_at > now()) as temporary_count`;

export async function listUsers(role?: string, search?: string): Promise<UserRow[]> {
  const uid = await requireUser();
  return queryAsUser<UserRow>(
    uid,
    `select ${USER_COLUMNS} from public.users u
      where ($1::text is null or u.role = $1)
        and ($2::text is null or lower(u.full_name) like '%' || lower($2) || '%'
             or u.phone_number like '%' || $2 || '%')
      order by u.active desc, u.full_name`,
    [role && role !== 'all' ? role : null, search ?? null],
  );
}

export async function getUser(id: string): Promise<UserRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<UserRow>(
    uid, `select ${USER_COLUMNS} from public.users u where u.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface TemporaryGrantRow {
  id: string;
  user_id: string;
  permission_key: string;
  starts_at: string;
  expires_at: string;
  reason: string | null;
  granted_by_name: string | null;
  live: boolean;
  authorization_id: string | null;
}

export async function listTemporaryGrants(userId: string): Promise<TemporaryGrantRow[]> {
  const uid = await requireUser();
  return queryAsUser<TemporaryGrantRow>(
    uid,
    `select g.id, g.user_id, g.permission_key, g.starts_at, g.expires_at, g.reason,
            (select full_name from public.users b where b.id = g.granted_by) as granted_by_name,
            (g.revoked_at is null and g.starts_at <= now() and g.expires_at > now()) as live,
            g.authorization_id
       from public.temporary_grants g
      where g.user_id = $1 order by g.expires_at desc limit 50`,
    [userId],
  );
}

/**
 * What this person actually holds right now, temporary grants included.
 *
 * Through `app.user_access`, which re-checks the caller: your own list always,
 * somebody else's only with `users.view`.
 */
export async function effectivePermissionsOf(userId: string): Promise<string[]> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ p: string[] }>(
    uid, `select app.user_access($1) as p`, [userId]);
  return rows[0]?.p ?? [];
}

/* -------------------------------------------------------------------------- */
/* audit                                                                       */
/* -------------------------------------------------------------------------- */

export interface AuditRow {
  id: string;
  action: string;
  module: string;
  record_id: string | null;
  description: string | null;
  reason: string | null;
  previous_value: unknown;
  new_value: unknown;
  occurred_at: string;
  user_name: string | null;
  user_role: string | null;
  target_name: string | null;
}

export async function listAuditLogs(
  module?: string,
  before?: string,
  limit = 100,
): Promise<AuditRow[]> {
  const uid = await requireUser();
  return queryAsUser<AuditRow>(
    uid,
    `select a.id, a.action, a.module, a.record_id, a.description, a.reason,
            a.previous_value, a.new_value, a.occurred_at, a.user_role,
            (select full_name from public.users u where u.id = a.user_id) as user_name,
            (select full_name from public.users u where u.id = a.target_user_id) as target_name
       from public.audit_logs a
      where ($1::text is null or a.module = $1)
        and ($2::timestamptz is null or a.occurred_at < $2)
      order by a.occurred_at desc
      limit least(greatest($3::int, 1), 200)`,
    [module && module !== 'all' ? module : null, before ?? null, limit],
  );
}

export async function auditModules(): Promise<string[]> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ module: string }>(
    uid, `select distinct module from public.audit_logs order by module`);
  return rows.map((r) => r.module);
}

/* -------------------------------------------------------------------------- */
/* settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface SettingRow {
  key: string;
  value: Record<string, unknown>;
  updated_at: string | null;
  updated_by_name: string | null;
}

export async function listSettings(): Promise<SettingRow[]> {
  const uid = await requireUser();
  return queryAsUser<SettingRow>(
    uid,
    `select s.key, s.value, s.updated_at,
            (select full_name from public.users u where u.id = s.updated_by) as updated_by_name
       from public.settings s order by s.key`,
  );
}
