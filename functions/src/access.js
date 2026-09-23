// ===========================================================================
// RamosMAX access model - pure logic shared by every privileged function.
// ===========================================================================
// No Firebase calls in this file: it decides, it does not read or write.
// The effective-permission calculation mirrors `hasPermission()` in
// firebase/firestore.rules and `AppUser.effectivePermissions` in Dart.
// ===========================================================================

import { createRequire } from 'node:module';
import { HttpsError } from 'firebase-functions/v2/https';

const require = createRequire(import.meta.url);
const catalog = require('./access_catalog.json');

export const ALL_PERMISSIONS = Object.freeze([...catalog.permissions]);
const PERMISSION_SET = new Set(ALL_PERMISSIONS);
export const ROLES = Object.freeze(Object.keys(catalog.roles));
export const ADMIN_ONLY = new Set(catalog.adminOnlyPermissions);
export const SPECIALIZATIONS = Object.freeze([...catalog.specializations]);

/**
 * Phase 8: permissions that exist only inside an after-hours authorisation
 * window (after_hours.js). Never granted permanently or through the generic
 * temporary-access grant.
 */
export const AUTHORIZATION_ONLY = new Set(catalog.authorizationOnlyPermissions ?? []);

export function requireNotAuthorizationOnly(permission) {
  if (AUTHORIZATION_ONLY.has(permission)) {
    throw precondition('This permission is given only by an after-hours authorisation (After-Hours → Authorise).', 'authorization_only');
  }
}

/** Longest temporary grant anyone may hand out. */
export const MAX_TEMPORARY_MS = 30 * 24 * 3600_000;

/** Clock skew tolerated between the device choosing "now" and the server. */
const START_TOLERANCE_MS = 5 * 60_000;

export const isPermission = (p) => typeof p === 'string' && PERMISSION_SET.has(p);
export const isRole = (r) => typeof r === 'string' && ROLES.includes(r);
export const roleRank = (r) => catalog.roleRanks[r] ?? 0;

export function rolePermissions(role) {
  const perms = catalog.roles[role];
  if (perms === '*') return new Set(ALL_PERMISSIONS);
  return new Set(perms ?? []);
}

/** Firestore Timestamp | Date | millis -> millis (or null). */
export function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  return null;
}

/**
 * A `temporaryPermissions` map entry is live at [now]. Entries are
 * `{startsAt, expiresAt, grantId}`; a bare Timestamp (Phase 1 format) is an
 * expiry with no start.
 */
export function isTemporaryLive(entry, now) {
  const expires = toMillis(entry?.expiresAt ?? entry);
  if (expires == null || expires <= now) return false;
  const starts = toMillis(entry?.startsAt);
  return starts == null || starts <= now;
}

/** May sign in: active, known role, access not expired. */
export function isAccountEnabled(user, now) {
  if (!user || user.active !== true || !isRole(user.role)) return false;
  const expires = toMillis(user.accessExpiresAt);
  return expires == null || expires > now;
}

/**
 * May use RamosMAX: enabled AND not waiting for a password change. Someone
 * holding a temporary password can sign in but do nothing except replace
 * it. Mirrors `isActive()` in firebase/firestore.rules.
 */
export function isAccountLive(user, now) {
  return isAccountEnabled(user, now) && user.mustChangePassword !== true;
}

/**
 * (role defaults + explicit grants + live temporary grants) - denials.
 * Empty for inactive, expired or malformed accounts.
 */
export function effectivePermissions(user, now) {
  if (!isAccountLive(user, now)) return new Set();
  const result = rolePermissions(user.role);
  for (const p of user.permissions ?? []) if (isPermission(p)) result.add(p);
  for (const [p, entry] of Object.entries(user.temporaryPermissions ?? {})) {
    if (isPermission(p) && isTemporaryLive(entry, now)) result.add(p);
  }
  for (const p of user.deniedPermissions ?? []) result.delete(p);
  return result;
}

/** Permanent access: role defaults + explicit grants - denials. */
export function permanentPermissions(user) {
  const result = rolePermissions(user.role);
  for (const p of user.permissions ?? []) if (isPermission(p)) result.add(p);
  for (const p of user.deniedPermissions ?? []) result.delete(p);
  return result;
}

// ---------------------------------------------------------------------------
// Authorization checks. Each throws an HttpsError with a message that is safe
// to show to the person using the app.
// ---------------------------------------------------------------------------

export function deny(message, reason = 'forbidden') {
  return new HttpsError('permission-denied', message, { reason });
}

export function invalid(message, reason = 'invalid') {
  return new HttpsError('invalid-argument', message, { reason });
}

export function precondition(message, reason, extra = {}) {
  return new HttpsError('failed-precondition', message, { reason, ...extra });
}

/** The caller holds at least one of [anyOf]. */
export function requirePermission(actorPerms, ...anyOf) {
  if (!anyOf.some((p) => actorPerms.has(p))) {
    throw deny('You do not have permission to do this.');
  }
}

export function requireNotSelf(actorUid, targetUid, message) {
  if (actorUid === targetUid) throw deny(message, 'self_modification');
}

/**
 * The actor may administer the target's account at all. Admin accounts are
 * managed only by admins; everyone else may manage only roles ranked below
 * their own.
 */
export function requireCanAdminister(actor, target) {
  if (actor.role === 'admin') return;
  if (target.role === 'admin') {
    throw deny('Only an Administrator can manage Administrator accounts.', 'admin_target');
  }
  if (roleRank(target.role) >= roleRank(actor.role)) {
    throw deny('You can only manage accounts with a more junior role than yours.', 'rank');
  }
}

export function requireCanAssignRole(actor, role) {
  if (!isRole(role)) throw invalid('Choose a valid role.', 'role');
  if (actor.role === 'admin') return;
  if (role === 'admin') {
    throw deny('Only an Administrator can assign the Administrator role.', 'assign_admin');
  }
  if (roleRank(role) >= roleRank(actor.role)) {
    throw deny('You cannot assign a role at or above your own.', 'rank');
  }
}

/**
 * Handing a permission to someone (as a grant, a temporary grant, or by
 * lifting a denial) requires holding it yourself, and admin-only permissions
 * can only be handed out by an Admin. Nobody can grant what they don't have.
 */
export function requireCanGrant(actor, actorPerms, permission) {
  if (!isPermission(permission)) throw invalid('Unknown permission.', 'permission');
  if (ADMIN_ONLY.has(permission) && actor.role !== 'admin') {
    throw deny('Only an Administrator can grant this permission.', 'admin_only_permission');
  }
  if (!actorPerms.has(permission)) {
    throw deny('You cannot grant a permission you do not hold yourself.', 'not_held');
  }
}

/** Roles whose passwords a non-admin (e.g. a Manager) may reset. */
export const PASSWORD_RESET_ROLES_FOR_NON_ADMINS = new Set(catalog.passwordResetRolesForNonAdmins);

/**
 * Password resets: Admins for anyone they may administer; everyone else
 * (with `users.passwords.reset`) only for the roles in
 * `passwordResetRolesForNonAdmins` - by default Managers reset Workers only,
 * not Cashiers, even though Cashiers rank below Managers.
 */
export function requireCanResetPassword(actor, target) {
  requireCanAdminister(actor, target);
  if (actor.role !== 'admin' && !PASSWORD_RESET_ROLES_FOR_NON_ADMINS.has(target.role)) {
    throw deny('You can only reset passwords for Workers.', 'reset_scope');
  }
}

/** Admins always keep user-management access; demote the account instead. */
export function requireAllowedDenials(targetRole, denied) {
  if (targetRole !== 'admin') return;
  if (denied.some((p) => p.startsWith('users.'))) {
    throw precondition(
      'Administrators always keep user-management access. Change the role instead.',
      'admin_user_permissions',
    );
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Mirrors PhoneNumbers.toE164 for Uganda; other countries must be E.164. */
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    if (!/^\+[1-9]\d{7,14}$/.test(digits)) return null;
    if (digits.startsWith('+256') && !/^\+256[347]\d{8}$/.test(digits)) return null;
    return digits;
  }
  if (digits.startsWith('256') && digits.length > 9) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return /^[347]\d{8}$/.test(digits) ? `+256${digits}` : null;
}

export function requirePhone(input) {
  const phone = normalizePhone(input);
  if (!phone) throw invalid('Enter a valid phone number, e.g. 0772 123 456.', 'phone');
  return phone;
}

export function requireName(input) {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2) throw invalid('Enter the full name.', 'name');
  if (name.length > 80) throw invalid('The name is too long (80 characters maximum).', 'name');
  return name;
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function optionalEmail(input) {
  if (input == null || (typeof input === 'string' && input.trim() === '')) return null;
  if (typeof input !== 'string' || input.length > 120 || !EMAIL.test(input.trim())) {
    throw invalid('Enter a valid email address.', 'email');
  }
  return input.trim().toLowerCase();
}

export function optionalText(input, field, max = 60) {
  if (input == null) return null;
  if (typeof input !== 'string') throw invalid(`${field} is not valid.`, 'text');
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length > max) throw invalid(`${field} is too long (${max} characters maximum).`, 'text');
  return value === '' ? null : value;
}

export const STAFF_ID = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export function normalizeStaffId(input) {
  if (typeof input !== 'string') return null;
  const id = input.trim().toUpperCase();
  return STAFF_ID.test(id) ? id : null;
}

export function formatStaffId(n) {
  return `RMX-STF-${String(n).padStart(4, '0')}`;
}

export function optionalSpecialization(input, role) {
  if (input == null || input === '') return null;
  if (!SPECIALIZATIONS.includes(input)) throw invalid('Choose a valid specialisation.', 'specialization');
  if (role !== 'worker') throw invalid('Only workers have a specialisation.', 'specialization');
  return input;
}

export function requireReason(input, { required = true } = {}) {
  const reason = typeof input === 'string' ? input.trim() : '';
  if (reason === '') {
    if (required) throw invalid('Enter a reason for this change.', 'reason');
    return null;
  }
  if (reason.length < 3) throw invalid('The reason is too short.', 'reason');
  if (reason.length > 500) throw invalid('The reason is too long (500 characters maximum).', 'reason');
  return reason;
}

export function requirePermissionList(input, field) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw invalid(`${field} must be a list.`, 'permission');
  for (const p of input) {
    if (!isPermission(p)) throw invalid('One of the selected permissions is not recognised.', 'permission');
  }
  return [...new Set(input)].sort();
}

/**
 * Validates a temporary window (epoch millis). A start in the recent past is
 * treated as "now". Returns clamped {startsAt, expiresAt}.
 */
export function requireTemporaryWindow(startsAtInput, expiresAtInput, now) {
  const expiresAt = Number(expiresAtInput);
  let startsAt = startsAtInput == null ? now : Number(startsAtInput);
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt)) {
    throw invalid('Choose a valid start and end time.', 'window');
  }
  if (startsAt < now - START_TOLERANCE_MS) {
    throw invalid('The start time cannot be in the past.', 'window');
  }
  startsAt = Math.max(startsAt, now);
  if (expiresAt <= startsAt) throw invalid('The end time must be after the start time.', 'window');
  if (expiresAt - startsAt > MAX_TEMPORARY_MS) {
    throw invalid('Temporary access can last at most 30 days.', 'window');
  }
  if (startsAt - now > MAX_TEMPORARY_MS) {
    throw invalid('Temporary access must start within the next 30 days.', 'window');
  }
  return { startsAt, expiresAt };
}

export function requireProfilePhotoPath(input, staffId) {
  if (input == null || input === '') return null;
  if (!staffId) throw invalid('Link a staff record before adding a profile photo.', 'photo');
  const prefix = `staff/${staffId}/profile/`;
  if (typeof input !== 'string' || !input.startsWith(prefix) || input.slice(prefix.length).includes('/')
      || input.length > prefix.length + 100) {
    throw invalid('The profile photo could not be saved.', 'photo');
  }
  return input;
}

/** `+256 772 ••• 456` - phone numbers are masked in audit entries. */
export function maskPhone(e164) {
  if (typeof e164 !== 'string' || e164.length < 7) return e164 ?? null;
  return `${e164.slice(0, -6)}•••${e164.slice(-3)}`;
}
