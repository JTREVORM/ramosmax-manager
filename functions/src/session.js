// ===========================================================================
// Phone number + password sign-in, and changing one's own password.
// ===========================================================================
// Firebase Authentication holds every credential (Email/Password provider).
// The Email/Password identity is a random, hidden address; people only ever
// type their phone number. This file is the only place that maps one to the
// other, and it runs on the server:
//
//   phone + password ──► normalise phone ──► Auth record with that phone
//        ──► verify password with Firebase (Identity Toolkit) ──► profile checks
//        ──► custom token ──► app calls signInWithCustomToken ──► normal session
//
// Nothing here stores, returns or logs a password.
// ===========================================================================

import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { invalid, isAccountEnabled, isRole, normalizePhone, toMillis } from './access.js';
import { isSignInIdentity, MAX_LENGTH, passwordProblems } from './passwords.js';

const USERS = 'users';
const AUDIT = 'audit_logs';
const THROTTLE = 'login_throttle';

/** Failed attempts allowed per phone number before a cool-off. */
export const MAX_FAILURES = 5;
export const THROTTLE_WINDOW_MS = 15 * 60_000;

// One message for every "wrong phone or password" case, so the response
// never reveals whether a phone number has an account.
const BAD_CREDENTIALS = 'Incorrect phone number or password.';
const badCredentials = () => new HttpsError('unauthenticated', BAD_CREDENTIALS, { reason: 'invalid_credentials' });

/**
 * Checks an Email/Password credential with Firebase Authentication through
 * the Identity Toolkit REST API (the Admin SDK cannot verify passwords).
 * Talks to the Auth emulator when FIREBASE_AUTH_EMULATOR_HOST is set.
 * Returns {ok: true, uid} | {ok: false, reason: 'invalid'|'throttled'}.
 */
export function makePasswordVerifier({ apiKey, emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST } = {}) {
  const base = emulatorHost
    ? `http://${emulatorHost}/identitytoolkit.googleapis.com`
    : 'https://identitytoolkit.googleapis.com';
  return async function verifyPassword(email, password) {
    if (!apiKey) throw new Error('Sign-in API key is not configured');
    const res = await fetch(`${base}/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, uid: body.localId };
    const code = String(body?.error?.message ?? '');
    if (code.startsWith('TOO_MANY_ATTEMPTS')) return { ok: false, reason: 'throttled' };
    if (/^(INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|USER_DISABLED|INVALID_EMAIL|MISSING_PASSWORD)/.test(code)) {
      return { ok: false, reason: 'invalid' };
    }
    // Never include the request (it holds the password) in the error.
    throw new Error(`Identity Toolkit error: ${code || res.status}`);
  };
}

const throttleRef = (db, phone) =>
  db.collection(THROTTLE).doc(createHash('sha256').update(`ramosmax:${phone}`).digest('hex'));

async function requireNotThrottled(db, phone, now) {
  const snap = await throttleRef(db, phone).get();
  const lockedUntil = toMillis(snap.get?.('lockedUntil'));
  if (lockedUntil && lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((lockedUntil - now) / 60_000));
    throw new HttpsError('resource-exhausted',
      `Too many sign-in attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`,
      { reason: 'too_many_attempts' });
  }
}

async function recordFailure(db, phone, now) {
  const ref = throttleRef(db, phone);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const first = toMillis(snap.get?.('firstFailureAt'));
    const fresh = !first || now - first > THROTTLE_WINDOW_MS;
    const failures = fresh ? 1 : (snap.get('failures') ?? 0) + 1;
    tx.set(ref, {
      failures,
      firstFailureAt: fresh ? Timestamp.fromMillis(now) : snap.get('firstFailureAt'),
      lockedUntil: failures >= MAX_FAILURES ? Timestamp.fromMillis(now + THROTTLE_WINDOW_MS) : null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

function sessionAudit(db, uid, role, action, extra = {}) {
  return db.collection(AUDIT).add({
    userId: uid,
    userRole: role ?? 'none',
    action,
    module: 'auth',
    recordId: uid,
    targetUserId: uid,
    source: 'cloud_function',
    timestamp: FieldValue.serverTimestamp(),
    description: null,
    reason: null,
    previousValue: null,
    newValue: null,
    ...extra,
  });
}

/** Resolves a phone number to its Auth record, or null. Server-side only. */
async function authRecordForPhone(auth, phone) {
  try {
    return await auth.getUserByPhoneNumber(phone);
  } catch (e) {
    if (e.code === 'auth/user-not-found') return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// signInWithPhonePassword (unauthenticated)
// ---------------------------------------------------------------------------

export async function signInWithPhonePassword(deps, rawData, now = Date.now()) {
  const { db, auth, verifyPassword } = deps;
  const data = rawData && typeof rawData === 'object' ? rawData : {};
  const phone = normalizePhone(data.phoneNumber);
  if (!phone) throw invalid('Enter a valid phone number, e.g. 0772 123 456.', 'phone');
  const password = data.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_LENGTH) {
    throw badCredentials();
  }

  await requireNotThrottled(db, phone, now);

  const record = await authRecordForPhone(auth, phone);
  // No account, or an account from the retired SMS sign-in that has no
  // password yet: same answer as a wrong password.
  if (!record || !isSignInIdentity(record.email)) {
    await recordFailure(db, phone, now);
    throw badCredentials();
  }

  const result = await verifyPassword(record.email, password);
  if (!result.ok || result.uid !== record.uid) {
    await recordFailure(db, phone, now);
    if (result.reason === 'throttled') {
      throw new HttpsError('resource-exhausted', 'Too many sign-in attempts. Wait a few minutes and try again.',
        { reason: 'too_many_attempts' });
    }
    await sessionAudit(db, record.uid, null, 'session.sign_in_failed', { description: 'Incorrect password' });
    throw badCredentials();
  }
  await throttleRef(db, phone).delete();

  // The password is right; now the RamosMAX profile decides.
  const profile = (await db.collection(USERS).doc(record.uid).get()).data();
  if (!profile || !isRole(profile.role)) {
    throw new HttpsError('permission-denied',
      'This phone number is not registered for RamosMAX access. Please contact an administrator.',
      { reason: 'not_registered' });
  }
  if (!isAccountEnabled(profile, now)) {
    const expired = profile.active === true;
    throw new HttpsError('permission-denied', expired
      ? 'Your RamosMAX access period has ended. Please contact an administrator.'
      : 'Your RamosMAX account is inactive. Please contact an administrator.',
    { reason: expired ? 'expired' : 'inactive' });
  }

  const token = await auth.createCustomToken(record.uid);
  await sessionAudit(db, record.uid, profile.role, 'session.sign_in', { description: 'Signed in with phone number and password' });
  return { token, mustChangePassword: profile.mustChangePassword === true };
}

// ---------------------------------------------------------------------------
// changeOwnPassword (signed in; also used for the forced first-login change)
// ---------------------------------------------------------------------------

export async function changeOwnPassword(deps, callerUid, rawData, now = Date.now()) {
  const { db, auth, verifyPassword } = deps;
  const data = rawData && typeof rawData === 'object' ? rawData : {};
  const { currentPassword, newPassword } = data;

  const ref = db.collection(USERS).doc(callerUid);
  const profile = (await ref.get()).data();
  // Allowed while a password change is pending; not for disabled accounts.
  if (!isAccountEnabled(profile, now)) {
    throw new HttpsError('permission-denied', 'Your RamosMAX account is not active.', { reason: 'actor_inactive' });
  }
  const record = await auth.getUser(callerUid);
  if (!isSignInIdentity(record.email)) {
    throw new HttpsError('failed-precondition', 'Ask an administrator to set a password for your account.',
      { reason: 'no_password' });
  }

  const phone = record.phoneNumber ?? profile.phoneNumber;
  await requireNotThrottled(db, phone, now);
  if (typeof currentPassword !== 'string' || currentPassword.length === 0 || currentPassword.length > MAX_LENGTH) {
    throw invalid('Your current password is incorrect.', 'wrong_password');
  }
  const check = await verifyPassword(record.email, currentPassword);
  if (!check.ok || check.uid !== callerUid) {
    await recordFailure(db, phone, now);
    throw invalid('Your current password is incorrect.', 'wrong_password');
  }

  const problems = passwordProblems(newPassword, {
    phoneNumber: phone, staffId: profile.staffId, fullName: profile.fullName,
  });
  if (problems.length > 0) throw invalid(problems.join(' '), 'weak_password');
  if (newPassword === currentPassword) {
    throw invalid('Choose a new password that is different from the current one.', 'same_password');
  }

  await auth.updateUser(callerUid, { password: newPassword });
  const wasForced = profile.mustChangePassword === true;
  await db.runTransaction(async (tx) => {
    tx.update(ref, {
      passwordSet: true,
      mustChangePassword: false,
      passwordChangedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: callerUid,
    });
    tx.set(db.collection(AUDIT).doc(), {
      userId: callerUid,
      userRole: profile.role,
      action: 'password.changed',
      module: 'auth',
      recordId: callerUid,
      targetUserId: callerUid,
      source: 'cloud_function',
      description: wasForced ? 'Temporary password replaced at sign-in' : 'Password changed by the user',
      reason: null,
      previousValue: null,
      newValue: { mustChangePassword: false },
      timestamp: FieldValue.serverTimestamp(),
    });
  });

  // Every other session (other phones) ends; this device continues with a
  // fresh sign-in token.
  await auth.revokeRefreshTokens(callerUid);
  return { token: await auth.createCustomToken(callerUid) };
}
