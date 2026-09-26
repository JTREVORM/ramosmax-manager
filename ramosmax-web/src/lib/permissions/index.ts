/**
 * Client-side permission resolution.
 *
 * Ports `effectivePermissions()` from functions/src/access.js and
 * `AppUser.effectivePermissions` from the Flutter app. It drives what the UI
 * SHOWS.
 *
 * It is NOT a security boundary. RLS and the SECURITY DEFINER functions are.
 * A button hidden here is a convenience; a permission enforced in the database
 * is the control. Never rely on anything in this file to protect data.
 */
import {
  ADMIN_ONLY_PERMISSIONS,
  AUTHORIZATION_ONLY_PERMISSIONS,
  PASSWORD_RESET_ROLES_FOR_NON_ADMINS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_RANKS,
  ROLES,
  type Permission,
  type Role,
} from './catalogue.generated';

export * from './catalogue.generated';

const CATALOGUE = new Set<string>(PERMISSIONS);

export interface TemporaryGrant {
  permissionKey: string;
  startsAt: string | Date;
  expiresAt: string | Date;
  revokedAt?: string | Date | null;
}

/** The subset of the profile that decides access. */
export interface AccessProfile {
  role: Role;
  active: boolean;
  mustChangePassword?: boolean;
  accessExpiresAt?: string | Date | null;
  permissions?: readonly string[];
  deniedPermissions?: readonly string[];
  temporaryGrants?: readonly TemporaryGrant[];
}

const ms = (v: string | Date | null | undefined): number | null =>
  v == null ? null : new Date(v).getTime();

/** May sign in: active, known role, access not expired (access.js isAccountEnabled). */
export function isAccountEnabled(p: AccessProfile | null, now = Date.now()): boolean {
  if (!p || !p.active || !(p.role in ROLE_RANKS)) return false;
  const expires = ms(p.accessExpiresAt);
  return expires == null || expires > now;
}

/**
 * May USE RamosMAX: enabled AND not waiting for a password change. Someone
 * holding a temporary password can sign in but do nothing except replace it
 * (access.js isAccountLive, firestore.rules isActive()).
 */
export function isAccountLive(p: AccessProfile | null, now = Date.now()): boolean {
  return isAccountEnabled(p, now) && p!.mustChangePassword !== true;
}

/** A temporary grant is effective only inside its window, on the server clock. */
export function isGrantLive(grant: TemporaryGrant, now = Date.now()): boolean {
  if (grant.revokedAt) return false;
  const starts = ms(grant.startsAt);
  const expires = ms(grant.expiresAt);
  if (expires == null || expires <= now) return false;
  return starts == null || starts <= now;
}

/**
 * (role defaults ∪ direct grants ∪ live temporary grants) − denials.
 * Empty for inactive, expired or must-change-password accounts.
 */
export function effectivePermissions(p: AccessProfile | null, now = Date.now()): Set<Permission> {
  if (!isAccountLive(p, now)) return new Set();
  const profile = p!;

  const roleDefaults = ROLE_PERMISSIONS[profile.role];
  const result = new Set<Permission>(roleDefaults === '*' ? PERMISSIONS : roleDefaults);

  for (const key of profile.permissions ?? []) {
    if (CATALOGUE.has(key)) result.add(key as Permission);
  }
  for (const grant of profile.temporaryGrants ?? []) {
    if (CATALOGUE.has(grant.permissionKey) && isGrantLive(grant, now)) {
      result.add(grant.permissionKey as Permission);
    }
  }
  for (const key of profile.deniedPermissions ?? []) {
    result.delete(key as Permission);
  }
  return result;
}

/** Permanent access: role defaults + explicit grants − denials. */
export function permanentPermissions(p: AccessProfile): Set<Permission> {
  const roleDefaults = ROLE_PERMISSIONS[p.role];
  const result = new Set<Permission>(roleDefaults === '*' ? PERMISSIONS : roleDefaults);
  for (const key of p.permissions ?? []) {
    if (CATALOGUE.has(key)) result.add(key as Permission);
  }
  for (const key of p.deniedPermissions ?? []) result.delete(key as Permission);
  return result;
}

export const isPermission = (key: string): key is Permission => CATALOGUE.has(key);

export const isAdminOnly = (key: Permission) => ADMIN_ONLY_PERMISSIONS.includes(key);

export const isAuthorizationOnly = (key: Permission) =>
  AUTHORIZATION_ONLY_PERMISSIONS.includes(key);

export const roleRank = (role: Role) => ROLE_RANKS[role] ?? 0;

/**
 * Admins may administer anyone; everyone else only roles ranked below their
 * own, and never an Administrator (access.js requireCanAdminister).
 */
export function canAdminister(actor: Role, target: Role): boolean {
  if (actor === 'admin') return true;
  if (target === 'admin') return false;
  return roleRank(target) < roleRank(actor);
}

/**
 * The roles this person may put somebody else into.
 *
 * An Administrator may assign any role; everybody else only roles ranked
 * BELOW their own, and never Administrator — the same rule
 * `app.require_can_assign_role` enforces in the database.
 */
export function assignableRoles(actor: Role): Role[] {
  if (actor === 'admin') return [...ROLES];
  return ROLES.filter((role: Role) => role !== 'admin' && roleRank(role) < roleRank(actor));
}

/** Admins for anyone they may administer; others only for the listed roles. */
export function canResetPassword(actor: Role, target: Role): boolean {
  if (!canAdminister(actor, target)) return false;
  return actor === 'admin' || PASSWORD_RESET_ROLES_FOR_NON_ADMINS.includes(target);
}
