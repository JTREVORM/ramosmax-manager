// ===========================================================================
// RamosMAX user administration - trusted server-side operations.
// ===========================================================================
// Every change to who can use RamosMAX, and what they can do, happens here.
// The Firestore rules deny these writes to every client, admins included, so
// a modified app cannot bypass the checks below.
//
// Each handler:
//   1. identifies the caller from the verified Firebase ID token (never from
//      anything the client sends);
//   2. loads the caller's live profile and computes their permissions on the
//      server;
//   3. validates every input field;
//   4. applies the change and its audit entries in ONE transaction, so there
//      is never a change without its audit record;
//   5. returns only what the app needs (ids), never other users' data.
//
// Handlers take their dependencies explicitly so they can be exercised
// against the Firebase emulators in functions/test.
// ===========================================================================

import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { generatePassword, isSignInIdentity, newSignInIdentity, passwordProblems } from './passwords.js';

import {
  deny, invalid, precondition,
  effectivePermissions, permanentPermissions, isAccountEnabled, isAccountLive, isTemporaryLive, isPermission,
  requirePermission, requireNotSelf, requireCanAdminister, requireCanAssignRole, requireCanGrant,
  requireCanResetPassword,
  requireAllowedDenials, requirePhone, requireName, optionalEmail, optionalText, normalizeStaffId,
  formatStaffId, optionalSpecialization, requireReason, requirePermissionList,
  requireTemporaryWindow, requireProfilePhotoPath, maskPhone, toMillis,
} from './access.js';

const USERS = 'users';
const STAFF = 'staff';
const AUDIT = 'audit_logs';
const COUNTERS = 'counters';
export const TEMP_GRANTS = 'temporary_grants';

export const NotificationType = Object.freeze({
  accountActivated: 'account_activated',
  accountDeactivated: 'account_deactivated',
  roleChanged: 'role_changed',
  temporaryPermissionGranted: 'temporary_permission_granted',
  temporaryPermissionExpiring: 'temporary_permission_expiring',
  // Phase 4
  workOrderAssigned: 'job_assigned',
  loyaltyRewardUnlocked: 'loyalty_reward_unlocked',
  // Phase 5
  recurringExpenseDue: 'recurring_expense_due',
  lowStock: 'inventory_low_stock',
  // Phase 6
  attendanceReview: 'attendance_review',
  attendanceRejected: 'attendance_rejected',
  allowanceAwaitingApproval: 'allowance_awaiting_approval',
  allowanceApproved: 'allowance_approved',
  payrollReview: 'payroll_review',
  payrollApproved: 'payroll_approved',
  payrollPaid: 'payroll_paid',
  lossIncidentCreated: 'loss_incident_created',
  lossRecoveryScheduled: 'loss_recovery_scheduled',
  deductionAwaitingApproval: 'deduction_awaiting_approval',
  deductionApplied: 'deduction_applied',
  // Phase 7: generic texts only - never a name, share count or amount.
  shareTransactionPending: 'share_transaction_pending',
  shareTransactionCompleted: 'share_transaction_completed',
  dividendDeclared: 'dividend_declared',
  dividendApproved: 'dividend_approved',
  dividendPaid: 'dividend_paid',
});

const alreadyExists = (message, reason) => new HttpsError('already-exists', message, { reason });
const notFound = (message, reason = 'not_found') => new HttpsError('not-found', message, { reason });

export function requireUid(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw invalid('Choose a valid user.', 'uid');
  }
  return value;
}

export function requireObject(data) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalid('The request is not valid.', 'payload');
  }
  return data;
}

export function actorFrom(uid, snap, now) {
  const data = snap.exists ? snap.data() : null;
  if (isAccountEnabled(data, now) && data.mustChangePassword === true) {
    throw deny('Change your temporary password before continuing.', 'password_change_required');
  }
  if (!isAccountLive(data, now)) {
    throw deny('Your RamosMAX account is not active.', 'actor_inactive');
  }
  return { uid, data, perms: effectivePermissions(data, now) };
}

export async function loadActor(db, uid, now) {
  return actorFrom(uid, await db.collection(USERS).doc(uid).get(), now);
}

/** Appends an audit entry inside [tx]. Attributed to the verified caller. */
function audit(tx, db, actor, action, targetUid, { previousValue = null, newValue = null, reason = null, description = null } = {}) {
  tx.set(db.collection(AUDIT).doc(), {
    userId: actor.uid,
    userRole: actor.data.role,
    action,
    module: 'users',
    recordId: targetUid,
    targetUserId: targetUid,
    description,
    reason,
    previousValue,
    newValue,
    source: 'cloud_function',
    timestamp: FieldValue.serverTimestamp(),
  });
}

/**
 * Sets (or deletes) one entry of the profile's `temporaryPermissions` map.
 * Permission keys contain dots (`payments.record`), so the path MUST be a
 * FieldPath: the string `temporaryPermissions.payments.record` would write a
 * nested map that neither the rules nor the app would recognise.
 */
function updateWithTemporary(tx, ref, permission, value, otherFields = {}) {
  const rest = Object.entries(otherFields).flat();
  tx.update(ref, new FieldPath('temporaryPermissions', permission), value, ...rest);
}

function accessChange(actorUid) {
  return {
    lastAccessChangeAt: FieldValue.serverTimestamp(),
    lastAccessChangeBy: actorUid,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actorUid,
  };
}

/**
 * Runs [fn] in a transaction with fresh copies of the caller's and the
 * target's profiles. Authorization decisions are made on these fresh reads,
 * so a concurrent demotion of the caller is honoured.
 */
async function withTarget(db, callerUid, targetUid, now, fn) {
  return db.runTransaction(async (tx) => {
    const actorRef = db.collection(USERS).doc(callerUid);
    const targetRef = db.collection(USERS).doc(targetUid);
    const [actorSnap, targetSnap] = await Promise.all([tx.get(actorRef), tx.get(targetRef)]);
    const actor = actorFrom(callerUid, actorSnap, now);
    if (!targetSnap.exists) throw notFound('That user could not be found.');
    return fn(tx, actor, { uid: targetUid, ref: targetRef, data: targetSnap.data() });
  });
}

/**
 * Refuses a change that would leave RamosMAX without an active Administrator.
 * Must be called before any write in the transaction.
 */
async function requireAnotherActiveAdmin(tx, db, targetUid, now) {
  const admins = await tx.get(
    db.collection(USERS).where('role', '==', 'admin').where('active', '==', true),
  );
  const others = admins.docs.filter((d) => d.id !== targetUid && isAccountLive(d.data(), now));
  if (others.length === 0) {
    throw precondition(
      'RamosMAX must always have at least one active Administrator. Add another Administrator first.',
      'last_admin',
    );
  }
}

export async function notifySafely(deps, uid, type, recordId) {
  if (!deps.notify) return;
  try {
    await deps.notify(uid, type, recordId);
  } catch (e) {
    // Notifications are best-effort; the access change has already happened.
    console.warn(`notification ${type} failed`, e?.code ?? e?.message);
  }
}

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

export async function createUser(deps, callerUid, rawData, now = Date.now()) {
  const { db, auth } = deps;
  const data = requireObject(rawData);
  const actor = await loadActor(db, callerUid, now);
  requirePermission(actor.perms, 'users.create');

  const fullName = requireName(data.fullName);
  const phoneNumber = requirePhone(data.phoneNumber);
  const email = optionalEmail(data.email);
  const role = data.role;
  requireCanAssignRole(actor.data, role);
  const specialization = optionalSpecialization(data.specialization, role);
  const position = optionalText(data.position, 'Position');
  const department = optionalText(data.department, 'Department');
  const active = data.active !== false;

  const grants = requirePermissionList(data.permissions, 'Permissions');
  const denials = requirePermissionList(data.deniedPermissions, 'Denied permissions');
  if (grants.length > 0 || denials.length > 0) {
    requirePermission(actor.perms, 'users.permissions.manage');
    for (const p of grants) requireCanGrant(actor.data, actor.perms, p);
    if (grants.some((p) => denials.includes(p))) {
      throw invalid('A permission cannot be both granted and denied.', 'overlap');
    }
    requireAllowedDenials(role, denials);
  }

  let requestedStaffId = null;
  if (data.staffId != null && data.staffId !== '') {
    requestedStaffId = normalizeStaffId(data.staffId);
    if (!requestedStaffId) {
      throw invalid('Staff IDs use capital letters, digits and dashes, e.g. RMX-STF-0001.', 'staff_id');
    }
  }
  const allocateStaffId = !requestedStaffId && data.linkStaff === true;

  // The temporary password: chosen (generated) on the creator's device, or
  // generated here when none is supplied (e.g. the CLI). Either way it must
  // meet the policy, and it is never written to Firestore or any log.
  const passwordSupplied = data.password != null && data.password !== '';
  const temporaryPassword = passwordSupplied ? data.password : generatePassword();
  const problems = passwordProblems(temporaryPassword, { phoneNumber, staffId: requestedStaffId, fullName });
  if (problems.length > 0) throw invalid(`The password is not strong enough. ${problems[0]}`, 'weak_password');

  // Firebase Auth account: phone number (the unique login key) plus a hidden
  // Email/Password identity that holds the credential.
  let uid = null;
  let createdAuthUser = false;
  let existingAuth = null;
  try {
    existingAuth = await auth.getUserByPhoneNumber(phoneNumber);
    uid = existingAuth.uid;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  if (uid) {
    // An Auth account without a profile can be left over from the retired
    // SMS sign-in. With a profile, this is a duplicate.
    if ((await db.collection(USERS).doc(uid).get()).exists) {
      throw alreadyExists('A RamosMAX user already exists with this phone number.', 'user_exists');
    }
    await auth.updateUser(uid, {
      email: isSignInIdentity(existingAuth.email) ? existingAuth.email : newSignInIdentity(),
      password: temporaryPassword,
    });
  } else {
    try {
      uid = (await auth.createUser({ phoneNumber, email: newSignInIdentity(), password: temporaryPassword })).uid;
      createdAuthUser = true;
    } catch (e) {
      if (e.code === 'auth/phone-number-already-exists') {
        throw alreadyExists('A RamosMAX user already exists with this phone number.', 'user_exists');
      }
      if (e.code === 'auth/invalid-phone-number') {
        throw invalid('Enter a valid phone number, e.g. 0772 123 456.', 'phone');
      }
      throw e;
    }
  }

  try {
    const staffId = await db.runTransaction(async (tx) => {
      const userRef = db.collection(USERS).doc(uid);
      const counterRef = db.collection(COUNTERS).doc(STAFF);

      // --- reads ---
      if ((await tx.get(userRef)).exists) {
        throw alreadyExists('A RamosMAX user already exists with this phone number.', 'user_exists');
      }
      let staffId = requestedStaffId;
      let staffSnap = null;
      let nextCounter = null;
      if (staffId) {
        staffSnap = await tx.get(db.collection(STAFF).doc(staffId));
        const linked = staffSnap.exists ? staffSnap.get('linkedUid') : null;
        if (linked && linked !== uid) {
          throw alreadyExists(`Staff ID ${staffId} is already linked to another user.`, 'staff_linked');
        }
      } else if (allocateStaffId) {
        const counter = await tx.get(counterRef);
        let n = counter.exists ? Number(counter.get('next')) || 1 : 1;
        for (let i = 0; i < 50 && !staffId; i++, n++) {
          const candidate = await tx.get(db.collection(STAFF).doc(formatStaffId(n)));
          if (!candidate.exists) {
            staffId = formatStaffId(n);
            staffSnap = candidate;
          }
        }
        if (!staffId) throw precondition('Could not allocate a staff ID. Enter one manually.', 'staff_id');
        nextCounter = n;
      }
      const actorFresh = actorFrom(callerUid, await tx.get(db.collection(USERS).doc(callerUid)), now);

      // --- writes ---
      const stamp = FieldValue.serverTimestamp();
      tx.set(userRef, {
        uid,
        phoneNumber,
        role,
        active,
        fullName,
        email,
        staffId: staffId ?? null,
        position,
        department,
        specialization,
        profilePhotoPath: null,
        permissions: grants,
        deniedPermissions: denials,
        temporaryPermissions: {},
        accessExpiresAt: null,
        // Credential state only - never the credential itself.
        passwordSet: true,
        mustChangePassword: true,
        passwordChangedAt: null,
        passwordResetAt: stamp,
        passwordResetBy: callerUid,
        fcmTokens: [],
        statusReason: null,
        statusChangedAt: stamp,
        statusChangedBy: callerUid,
        lastAccessChangeAt: stamp,
        lastAccessChangeBy: callerUid,
        createdAt: stamp,
        updatedAt: stamp,
        createdBy: callerUid,
        updatedBy: callerUid,
        lastLoginAt: null,
      });

      if (staffId) {
        const staffRef = db.collection(STAFF).doc(staffId);
        const employment = { fullName, phoneNumber, email, specialization, linkedUid: uid, updatedAt: stamp, updatedBy: callerUid };
        if (position) employment.position = position;
        if (department) employment.department = department;
        if (staffSnap?.exists) {
          tx.update(staffRef, employment);
        } else {
          tx.set(staffRef, {
            staffId,
            position,
            department,
            profilePhotoPath: null,
            employmentStatus: 'active',
            createdAt: stamp,
            createdBy: callerUid,
            ...employment,
          });
        }
      }
      if (nextCounter != null) tx.set(counterRef, { next: nextCounter }, { merge: true });

      audit(tx, db, actorFresh, 'user.created', uid, {
        newValue: { role, active, staffId: staffId ?? null },
        description: `Created ${role} account`,
      });
      if (staffId) {
        audit(tx, db, actorFresh, 'staff.linked', uid, { newValue: { staffId, uid } });
      }
      for (const permission of grants) {
        audit(tx, db, actorFresh, 'permission.granted', uid, { newValue: { permission } });
      }
      for (const permission of denials) {
        audit(tx, db, actorFresh, 'permission.denied', uid, { newValue: { permission } });
      }
      return staffId;
    });
    // A password the creator already chose is not echoed back. One generated
    // here is returned exactly once, to be handed to the employee.
    return { uid, staffId: staffId ?? null, ...(passwordSupplied ? {} : { temporaryPassword }) };
  } catch (e) {
    // Don't leave an orphan Auth account we created a moment ago.
    if (createdAuthUser) await auth.deleteUser(uid).catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// updateUserProfile - name, contact and employment details, phone number
// ---------------------------------------------------------------------------

const PROFILE_FIELDS = ['fullName', 'email', 'position', 'department', 'specialization', 'profilePhotoPath'];
const STAFF_SYNCED_FIELDS = ['fullName', 'email', 'position', 'department', 'specialization', 'profilePhotoPath', 'phoneNumber'];

export async function updateUserProfile(deps, callerUid, rawData, now = Date.now()) {
  const { db, auth } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  const actor = await loadActor(db, callerUid, now);
  requirePermission(actor.perms, 'users.edit');

  const targetSnap = await db.collection(USERS).doc(uid).get();
  if (!targetSnap.exists) throw notFound('That user could not be found.');
  const target = targetSnap.data();
  const isSelf = uid === callerUid;
  if (!isSelf) requireCanAdminister(actor.data, target);

  const changes = {};
  if ('fullName' in data) changes.fullName = requireName(data.fullName);
  if ('email' in data) changes.email = optionalEmail(data.email);
  if ('position' in data) changes.position = optionalText(data.position, 'Position');
  if ('department' in data) changes.department = optionalText(data.department, 'Department');
  if ('specialization' in data) changes.specialization = optionalSpecialization(data.specialization, target.role);
  if ('profilePhotoPath' in data) changes.profilePhotoPath = requireProfilePhotoPath(data.profilePhotoPath, target.staffId);
  for (const key of Object.keys(changes)) {
    if (changes[key] === (target[key] ?? null)) delete changes[key];
  }

  if ('phoneNumber' in data && requirePhone(data.phoneNumber) !== target.phoneNumber) {
    // The phone number is the login identity: it has its own function.
    throw invalid('Use "Change phone number" to change the sign-in phone number.', 'use_change_phone');
  }
  if (Object.keys(changes).length === 0) {
    throw precondition('Nothing has changed.', 'no_changes');
  }

  await db.runTransaction(async (tx) => {
    const ref = db.collection(USERS).doc(uid);
    const fresh = (await tx.get(ref)).data();
    const staffRef = fresh.staffId ? db.collection(STAFF).doc(fresh.staffId) : null;
    const staffSnap = staffRef ? await tx.get(staffRef) : null;

    const update = { ...changes, updatedAt: FieldValue.serverTimestamp(), updatedBy: callerUid };
    tx.update(ref, update);
    syncStaff(tx, staffSnap, update, callerUid);

    const previousValue = {};
    const newValue = {};
    for (const f of PROFILE_FIELDS) {
      if (f in changes) {
        previousValue[f] = fresh[f] ?? null;
        newValue[f] = changes[f];
      }
    }
    audit(tx, db, actor, 'user.updated', uid, { previousValue, newValue });
  });
  return { uid };
}

function syncStaff(tx, staffSnap, update, callerUid) {
  if (!staffSnap?.exists) return;
  const staffUpdate = {};
  for (const f of STAFF_SYNCED_FIELDS) if (f in update) staffUpdate[f] = update[f];
  if (Object.keys(staffUpdate).length > 0) {
    tx.update(staffSnap.ref, { ...staffUpdate, updatedAt: FieldValue.serverTimestamp(), updatedBy: callerUid });
  }
}

// ---------------------------------------------------------------------------
// changeUserPhone - the sign-in identity
// ---------------------------------------------------------------------------
// The phone number lives on the Firebase Auth record (where Firebase keeps it
// unique) and on the profile. Both change together; the UID, staff link,
// password and history are unchanged. Existing sessions end so the person
// signs in again with the new number and their current password.

export async function changeUserPhone(deps, callerUid, rawData, now = Date.now()) {
  const { db, auth } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  const newPhone = requirePhone(data.phoneNumber);
  const reason = requireReason(data.reason, { required: false });

  const actor = await loadActor(db, callerUid, now);
  requirePermission(actor.perms, 'users.edit');
  requireNotSelf(callerUid, uid, 'Ask another administrator to change your own phone number.');
  const targetSnap = await db.collection(USERS).doc(uid).get();
  if (!targetSnap.exists) throw notFound('That user could not be found.');
  const target = targetSnap.data();
  requireCanAdminister(actor.data, target);
  if (newPhone === target.phoneNumber) throw precondition('Nothing has changed.', 'no_changes');

  let inUse = false;
  try {
    inUse = (await auth.getUserByPhoneNumber(newPhone)).uid !== uid;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  if (inUse) throw alreadyExists('This phone number is already used by another account.', 'phone_in_use');
  try {
    await auth.updateUser(uid, { phoneNumber: newPhone });
  } catch (e) {
    if (e.code === 'auth/phone-number-already-exists') {
      throw alreadyExists('This phone number is already used by another account.', 'phone_in_use');
    }
    throw e;
  }

  try {
    await withTarget(db, callerUid, uid, now, async (tx, actorFresh, fresh) => {
      requireCanAdminister(actorFresh.data, fresh.data);
      const staffSnap = fresh.data.staffId ? await tx.get(db.collection(STAFF).doc(fresh.data.staffId)) : null;
      const update = { phoneNumber: newPhone, updatedAt: FieldValue.serverTimestamp(), updatedBy: callerUid };
      tx.update(fresh.ref, update);
      syncStaff(tx, staffSnap, update, callerUid);
      audit(tx, db, actorFresh, 'user.phone_changed', uid, {
        previousValue: { phoneNumber: maskPhone(fresh.data.phoneNumber) },
        newValue: { phoneNumber: maskPhone(newPhone) },
        reason,
        description: 'Sign-in phone number changed; existing sessions ended',
      });
    });
  } catch (e) {
    // Keep Auth and Firestore consistent: put the old number back.
    await auth.updateUser(uid, { phoneNumber: target.phoneNumber }).catch(() => {});
    throw e;
  }
  await auth.revokeRefreshTokens(uid);
  return { uid };
}

// ---------------------------------------------------------------------------
// resetUserPassword - administrator-issued temporary password
// ---------------------------------------------------------------------------
// Admins: anyone they may administer. Managers (users.passwords.reset): Workers
// only. Nobody resets their own password here (they use changeOwnPassword).
// The generated password is returned ONCE and never stored or logged. The
// account must change it at next sign-in, and existing sessions end now.
// For an account from the retired SMS sign-in (no password yet) this attaches
// a password to the SAME Firebase UID - that is the migration path.

export async function resetUserPassword(deps, callerUid, rawData, now = Date.now()) {
  const { db, auth } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  const reason = requireReason(data.reason);

  const authorize = (actor, target) => {
    requirePermission(actor.perms, 'users.passwords.reset');
    requireNotSelf(callerUid, uid, 'Use "Change password" to change your own password.');
    requireCanResetPassword(actor.data, target);
  };
  // Authorise before touching the credential...
  const actor = await loadActor(db, callerUid, now);
  const targetSnap = await db.collection(USERS).doc(uid).get();
  if (!targetSnap.exists) throw notFound('That user could not be found.');
  authorize(actor, targetSnap.data());

  const temporaryPassword = generatePassword();
  const authUser = await auth.getUser(uid);
  const migrated = !isSignInIdentity(authUser.email);
  await auth.updateUser(uid, {
    ...(migrated ? { email: newSignInIdentity() } : {}),
    password: temporaryPassword,
  });

  // ...and re-check on fresh data while recording it.
  await withTarget(db, callerUid, uid, now, async (tx, actorFresh, target) => {
    authorize(actorFresh, target.data);
    tx.update(target.ref, {
      passwordSet: true,
      mustChangePassword: true,
      passwordResetAt: FieldValue.serverTimestamp(),
      passwordResetBy: callerUid,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: callerUid,
    });
    audit(tx, db, actorFresh, 'password.reset', uid, {
      newValue: { mustChangePassword: true, ...(migrated ? { migratedFromSms: true } : {}) },
      reason,
      description: migrated
        ? 'Password set for an account from the retired SMS sign-in'
        : 'Temporary password issued; must be changed at next sign-in',
    });
  });
  await auth.revokeRefreshTokens(uid);
  return { uid, temporaryPassword };
}

// ---------------------------------------------------------------------------
// setUserRole
// ---------------------------------------------------------------------------

export async function setUserRole(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  const reason = requireReason(data.reason);
  const role = data.role;

  const result = await withTarget(db, callerUid, uid, now, async (tx, actor, target) => {
    requirePermission(actor.perms, 'users.roles.manage');
    requireNotSelf(callerUid, uid, 'You cannot change your own role.');
    requireCanAdminister(actor.data, target.data);
    requireCanAssignRole(actor.data, role);
    const previous = target.data.role;
    if (previous === role) throw precondition('The user already has this role.', 'no_changes');
    requireAllowedDenials(role, target.data.deniedPermissions ?? []);
    if (previous === 'admin' && target.data.active === true) {
      await requireAnotherActiveAdmin(tx, db, uid, now);
    }

    tx.update(target.ref, {
      role,
      // Specialisation describes a worker's trade; it means nothing for other roles.
      ...(role === 'worker' ? {} : { specialization: null }),
      ...accessChange(callerUid),
    });
    audit(tx, db, actor, 'user.role_changed', uid, {
      previousValue: { role: previous },
      newValue: { role },
      reason,
    });
    return { previous };
  });

  await notifySafely(deps, uid, NotificationType.roleChanged, uid);
  return { uid, role, previousRole: result.previous };
}

// ---------------------------------------------------------------------------
// setUserActive - activation / deactivation (never deletes the account)
// ---------------------------------------------------------------------------

export async function setUserActive(deps, callerUid, rawData, now = Date.now()) {
  const { db, auth } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  if (typeof data.active !== 'boolean') throw invalid('Choose activate or deactivate.', 'active');
  const active = data.active;
  const reason = requireReason(data.reason, { required: !active });

  await withTarget(db, callerUid, uid, now, async (tx, actor, target) => {
    requirePermission(actor.perms, active ? 'users.activate' : 'users.deactivate');
    requireNotSelf(callerUid, uid, active ? 'You cannot activate your own account.' : 'You cannot deactivate your own account.');
    requireCanAdminister(actor.data, target.data);
    const previous = target.data.active === true;
    if (previous === active) {
      throw precondition(active ? 'This account is already active.' : 'This account is already inactive.', 'no_changes');
    }
    if (!active && target.data.role === 'admin') {
      await requireAnotherActiveAdmin(tx, db, uid, now);
    }

    tx.update(target.ref, {
      active,
      statusReason: reason,
      statusChangedAt: FieldValue.serverTimestamp(),
      statusChangedBy: callerUid,
      ...accessChange(callerUid),
    });
    audit(tx, db, actor, active ? 'user.activated' : 'user.deactivated', uid, {
      previousValue: { active: previous },
      newValue: { active },
      reason,
    });
  });

  if (!active) {
    // Rules already refuse every request from an inactive profile; revoking
    // refresh tokens also ends their Firebase sessions. The Auth account is
    // kept so the person can be re-activated later.
    await auth.revokeRefreshTokens(uid);
  }
  await notifySafely(deps, uid, active ? NotificationType.accountActivated : NotificationType.accountDeactivated, uid);
  return { uid, active };
}

// ---------------------------------------------------------------------------
// setUserPermissions - explicit grants and denials (full replacement)
// ---------------------------------------------------------------------------

export async function setUserPermissions(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  const grants = requirePermissionList(data.permissions, 'Permissions');
  const denials = requirePermissionList(data.deniedPermissions, 'Denied permissions');
  const reason = requireReason(data.reason, { required: false });
  if (grants.some((p) => denials.includes(p))) {
    throw invalid('A permission cannot be both granted and denied.', 'overlap');
  }

  return withTarget(db, callerUid, uid, now, async (tx, actor, target) => {
    requirePermission(actor.perms, 'users.permissions.manage');
    requireNotSelf(callerUid, uid, 'You cannot change your own permissions.');
    requireCanAdminister(actor.data, target.data);
    requireAllowedDenials(target.data.role, denials);

    const oldGrants = new Set(target.data.permissions ?? []);
    const oldDenials = new Set(target.data.deniedPermissions ?? []);
    const added = grants.filter((p) => !oldGrants.has(p));
    const removed = [...oldGrants].filter((p) => !grants.includes(p));
    const newlyDenied = denials.filter((p) => !oldDenials.has(p));
    const undenied = [...oldDenials].filter((p) => !denials.includes(p));

    if (added.length + removed.length + newlyDenied.length + undenied.length === 0) {
      throw precondition('Nothing has changed.', 'no_changes');
    }
    // Adding a grant or lifting a denial hands out access: you must hold it.
    for (const p of [...added, ...undenied]) requireCanGrant(actor.data, actor.perms, p);
    // Admin-only permissions are only ever touched by an Admin.
    if (actor.data.role !== 'admin') {
      for (const p of [...removed, ...newlyDenied]) {
        if (isPermission(p)) requireCanGrant(actor.data, actor.perms, p);
      }
    }

    tx.update(target.ref, { permissions: grants, deniedPermissions: denials, ...accessChange(callerUid) });
    for (const permission of added) audit(tx, db, actor, 'permission.granted', uid, { newValue: { permission }, reason });
    for (const permission of removed) audit(tx, db, actor, 'permission.grant_removed', uid, { previousValue: { permission }, reason });
    for (const permission of newlyDenied) audit(tx, db, actor, 'permission.denied', uid, { newValue: { permission }, reason });
    for (const permission of undenied) audit(tx, db, actor, 'permission.denial_removed', uid, { previousValue: { permission }, reason });
    return { uid, permissions: grants, deniedPermissions: denials };
  });
}

// ---------------------------------------------------------------------------
// Temporary permissions
// ---------------------------------------------------------------------------
// The enforcement index lives on the profile (`temporaryPermissions` map:
// permission -> {startsAt, expiresAt, grantId}) so the security rules can
// check it with the single profile read they already make. The full record -
// who granted it, why, and what became of it - lives in
// users/{uid}/temporary_grants/{grantId}. Both are written together.

export async function grantTemporaryPermission(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  const permission = data.permission;
  if (!isPermission(permission)) throw invalid('Choose a valid permission.', 'permission');
  const reason = requireReason(data.reason);
  const { startsAt, expiresAt } = requireTemporaryWindow(data.startsAt, data.expiresAt, now);

  const grantId = await withTarget(db, callerUid, uid, now, async (tx, actor, target) => {
    requirePermission(actor.perms, 'users.permissions.temporary', 'users.permissions.manage');
    requireNotSelf(callerUid, uid, 'You cannot grant yourself temporary access.');
    requireCanAdminister(actor.data, target.data);
    requireCanGrant(actor.data, actor.perms, permission);
    if (!isAccountLive(target.data, now)) {
      throw precondition('This account is inactive. Activate it before granting access.', 'target_inactive');
    }
    if ((target.data.deniedPermissions ?? []).includes(permission)) {
      throw precondition('This permission is explicitly denied for this user. Remove the denial first.', 'denied');
    }
    if (permanentPermissions(target.data).has(permission)) {
      throw precondition('The user already has this permission permanently.', 'already_granted');
    }

    const existing = (target.data.temporaryPermissions ?? {})[permission];
    const grantsCol = target.ref.collection(TEMP_GRANTS);
    const ref = grantsCol.doc();
    let supersededSnap = null;
    if (existing?.grantId) supersededSnap = await tx.get(grantsCol.doc(existing.grantId));

    if (supersededSnap?.exists && supersededSnap.get('status') === 'active') {
      tx.update(supersededSnap.ref, {
        status: 'superseded',
        endedAt: FieldValue.serverTimestamp(),
        endedBy: callerUid,
        supersededBy: ref.id,
      });
    }
    const starts = Timestamp.fromMillis(startsAt);
    const expires = Timestamp.fromMillis(expiresAt);
    tx.set(ref, {
      grantId: ref.id,
      uid,
      permission,
      startsAt: starts,
      expiresAt: expires,
      reason,
      status: 'active',
      grantedBy: callerUid,
      grantedByName: actor.data.fullName ?? null,
      grantedByRole: actor.data.role,
      createdAt: FieldValue.serverTimestamp(),
      expiryNotified: false,
    });
    updateWithTemporary(tx, target.ref, permission,
      { startsAt: starts, expiresAt: expires, grantId: ref.id }, accessChange(callerUid));
    audit(tx, db, actor, 'permission.temporary_granted', uid, {
      newValue: {
        permission,
        grantId: ref.id,
        startsAt: new Date(startsAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      },
      reason,
    });
    return ref.id;
  });

  await notifySafely(deps, uid, NotificationType.temporaryPermissionGranted, grantId);
  return { uid, grantId, startsAt, expiresAt };
}

export async function revokeTemporaryPermission(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  const grantId = requireUid(data.grantId);
  const reason = requireReason(data.reason);

  return withTarget(db, callerUid, uid, now, async (tx, actor, target) => {
    requirePermission(actor.perms, 'users.permissions.temporary', 'users.permissions.manage');
    requireNotSelf(callerUid, uid, 'You cannot change your own access.');
    requireCanAdminister(actor.data, target.data);

    const grantRef = target.ref.collection(TEMP_GRANTS).doc(grantId);
    const grant = await tx.get(grantRef);
    if (!grant.exists) throw notFound('That temporary permission could not be found.');
    if (grant.get('status') !== 'active' || toMillis(grant.get('expiresAt')) <= now) {
      throw precondition('This temporary permission has already ended.', 'not_active');
    }
    const permission = grant.get('permission');

    tx.update(grantRef, {
      status: 'revoked',
      endedAt: FieldValue.serverTimestamp(),
      endedBy: callerUid,
      endReason: reason,
    });
    const indexed = (target.data.temporaryPermissions ?? {})[permission];
    if (indexed?.grantId === grantId) {
      updateWithTemporary(tx, target.ref, permission, FieldValue.delete(), accessChange(callerUid));
    }
    audit(tx, db, actor, 'permission.temporary_revoked', uid, {
      previousValue: { permission, grantId },
      reason,
    });
    return { uid, grantId };
  });
}

// ---------------------------------------------------------------------------
// linkStaff - connect a user account to an employee record (or unlink)
// ---------------------------------------------------------------------------

export async function linkStaff(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.uid);
  let staffId = null;
  if (data.staffId != null && data.staffId !== '') {
    staffId = normalizeStaffId(data.staffId);
    if (!staffId) throw invalid('Staff IDs use capital letters, digits and dashes, e.g. RMX-STF-0001.', 'staff_id');
  }
  const createIfMissing = data.createIfMissing === true;

  return withTarget(db, callerUid, uid, now, async (tx, actor, target) => {
    requirePermission(actor.perms, 'users.edit');
    requireCanAdminister(actor.data, target.data);
    const current = target.data.staffId ?? null;
    if (current === staffId) throw precondition('Nothing has changed.', 'no_changes');

    const currentRef = current ? db.collection(STAFF).doc(current) : null;
    const currentSnap = currentRef ? await tx.get(currentRef) : null;
    const nextRef = staffId ? db.collection(STAFF).doc(staffId) : null;
    const nextSnap = nextRef ? await tx.get(nextRef) : null;

    if (nextSnap && !nextSnap.exists && !createIfMissing) {
      throw notFound(`No staff record exists with ID ${staffId}.`, 'staff_missing');
    }
    const linked = nextSnap?.exists ? nextSnap.get('linkedUid') : null;
    if (linked && linked !== uid) {
      throw alreadyExists(`Staff ID ${staffId} is already linked to another user.`, 'staff_linked');
    }

    const stamp = FieldValue.serverTimestamp();
    if (currentSnap?.exists && currentSnap.get('linkedUid') === uid) {
      tx.update(currentRef, { linkedUid: null, updatedAt: stamp, updatedBy: callerUid });
    }
    if (nextRef) {
      if (nextSnap.exists) {
        tx.update(nextRef, { linkedUid: uid, updatedAt: stamp, updatedBy: callerUid });
      } else {
        const t = target.data;
        tx.set(nextRef, {
          staffId,
          fullName: t.fullName ?? null,
          phoneNumber: t.phoneNumber,
          email: t.email ?? null,
          position: t.position ?? null,
          department: t.department ?? null,
          specialization: t.specialization ?? null,
          profilePhotoPath: null,
          employmentStatus: 'active',
          linkedUid: uid,
          createdAt: stamp,
          createdBy: callerUid,
          updatedAt: stamp,
          updatedBy: callerUid,
        });
      }
    }
    // A photo lives under its staff record's folder, so it cannot follow.
    tx.update(target.ref, { staffId, profilePhotoPath: null, updatedAt: stamp, updatedBy: callerUid });
    if (current) audit(tx, db, actor, 'staff.unlinked', uid, { previousValue: { staffId: current, uid } });
    if (staffId) audit(tx, db, actor, 'staff.linked', uid, { newValue: { staffId, uid } });
    return { uid, staffId };
  });
}

// ---------------------------------------------------------------------------
// Scheduled housekeeping for temporary permissions
// ---------------------------------------------------------------------------
// Enforcement never depends on this job: rules and the app compare expiry
// with the current time. The sweep keeps records tidy (status "expired",
// stale index entries removed) and sends "ending soon" notices.

export const EXPIRY_WARNING_MS = 30 * 60_000;

export async function sweepTemporaryGrants(deps, now = Date.now()) {
  const { db } = deps;
  const nowTs = Timestamp.fromMillis(now);
  let expired = 0;
  let warned = 0;

  const due = await db.collectionGroup(TEMP_GRANTS)
    .where('status', '==', 'active')
    .where('expiresAt', '<=', nowTs)
    .limit(400)
    .get();
  for (const doc of due.docs) {
    const userRef = doc.ref.parent.parent;
    const permission = doc.get('permission');
    await db.runTransaction(async (tx) => {
      const [grant, user] = await Promise.all([tx.get(doc.ref), tx.get(userRef)]);
      if (!grant.exists || grant.get('status') !== 'active') return;
      tx.update(doc.ref, { status: 'expired', endedAt: FieldValue.serverTimestamp() });
      const indexed = user.exists ? (user.get('temporaryPermissions') ?? {})[permission] : null;
      if (indexed?.grantId === doc.id && !isTemporaryLive(indexed, now)) {
        updateWithTemporary(tx, userRef, permission, FieldValue.delete());
      }
    });
    expired++;
  }

  const soon = await db.collectionGroup(TEMP_GRANTS)
    .where('status', '==', 'active')
    .where('expiresAt', '>', nowTs)
    .where('expiresAt', '<=', Timestamp.fromMillis(now + EXPIRY_WARNING_MS))
    .limit(400)
    .get();
  for (const doc of soon.docs) {
    if (doc.get('expiryNotified') === true) continue;
    await doc.ref.update({ expiryNotified: true });
    await notifySafely(deps, doc.ref.parent.parent.id, NotificationType.temporaryPermissionExpiring, doc.id);
    warned++;
  }
  return { expired, warned };
}
