// Phone + password sign-in, password changes/resets, phone changes and the
// migration of SMS-era accounts - against the Auth + Firestore emulators.
// Passwords are really verified by the Auth emulator (Identity Toolkit API).
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { getApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import { generatePassword, passwordProblems } from '../src/passwords.js';
import * as session from '../src/session.js';
import * as admin from '../src/user_admin.js';

const PROJECT = 'demo-ramosmax';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Run through `npm test` so the Firebase emulators are started.');
}
initializeApp({ projectId: PROJECT }, 'session-tests');
const app = getApp('session-tests');
const db = getFirestore(app);
const auth = getAuth(app);
const deps = {
  db,
  auth,
  notify: async () => {},
  verifyPassword: session.makePasswordVerifier({ apiKey: 'emulator-key' }),
};

async function reset() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}
beforeEach(reset);

let seq = 10;
/** A live account (no pending password change) with a real password. */
async function seedUser(uid, role, extra = {}) {
  const phoneNumber = extra.phoneNumber ?? `+256700100${String(seq++).padStart(3, '0')}`;
  const password = extra.password ?? 'Seed!Pass42x';
  await auth.createUser({ uid, phoneNumber, email: `${uid}x@users.ramosmax.invalid`, password });
  const { password: _omit, ...rest } = extra;
  await db.doc(`users/${uid}`).set({
    uid, role, active: true, phoneNumber, fullName: `${role} ${uid}`, mustChangePassword: false, passwordSet: true,
    permissions: [], deniedPermissions: [], temporaryPermissions: {}, ...rest,
  });
  return { uid, phoneNumber, password };
}

const signIn = (phoneNumber, password) => session.signInWithPhonePassword(deps, { phoneNumber, password });
const tokenUid = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).uid;
const profile = async (uid) => (await db.doc(`users/${uid}`).get()).data();
async function audits(action) {
  return (await db.collection('audit_logs').where('action', '==', action).get()).docs.map((d) => d.data());
}

/** Everything the app's Firestore holds, as one string - to prove a password is absent. */
async function firestoreDump() {
  const parts = [];
  for (const col of await db.listCollections()) {
    for (const doc of (await col.get()).docs) {
      parts.push(JSON.stringify(doc.data()));
      for (const sub of await doc.ref.listCollections()) {
        for (const s of (await sub.get()).docs) parts.push(JSON.stringify(s.data()));
      }
    }
  }
  return parts.join('\n');
}

async function rejects(promise, code, reason) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (reason) assert.equal(e.details?.reason, reason);
    return true;
  });
}

describe('password policy and generator', () => {
  test('generated passwords are random and meet the policy', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      assert.equal(p.length, 12);
      assert.deepEqual(passwordProblems(p), [], p);
      assert.doesNotMatch(p, /[0O1lI]/, 'no ambiguous characters');
      seen.add(p);
    }
    assert.equal(seen.size, 200);
  });

  test('weak and personal passwords are rejected', () => {
    assert.ok(passwordProblems('short1A!').length === 0);
    for (const bad of ['123456', 'password', 'Ramos123', 'abcdefgh', 'ABCDEFG1!', 'Abcdefgh!']) {
      assert.ok(passwordProblems(bad).length > 0, bad);
    }
    assert.ok(passwordProblems('Xy!772123456', { phoneNumber: '+256772123456' }).length > 0);
    assert.ok(passwordProblems('Rmx-Stf-0001!a', { staffId: 'RMX-STF-0001' }).length > 0);
    assert.ok(passwordProblems('Walter!2026x', { fullName: 'Walter Worker' }).length > 0);
  });
});

describe('sign in with phone number + password', () => {
  test('correct phone + password returns a session token for that account; audited', async () => {
    const w = await seedUser('w1', 'worker', { phoneNumber: '+256772123456' });
    const res = await signIn('0772 123 456', w.password);
    assert.equal(tokenUid(res.token), 'w1');
    assert.equal(res.mustChangePassword, false);
    const [a] = await audits('session.sign_in');
    assert.deepEqual([a.userId, a.userRole, a.module], ['w1', 'worker', 'auth']);
  });

  test('wrong password and unknown phone get the same answer (no account enumeration)', async () => {
    const w = await seedUser('w1', 'worker');
    await rejects(signIn(w.phoneNumber, 'Wrong!Pass99'), 'unauthenticated', 'invalid_credentials');
    await rejects(signIn('0772 999 000', w.password), 'unauthenticated', 'invalid_credentials');
    await rejects(signIn(w.phoneNumber, ''), 'unauthenticated', 'invalid_credentials');
    await rejects(signIn('12345', w.password), 'invalid-argument', 'phone');
    assert.equal((await audits('session.sign_in_failed')).length, 1, 'failures on a real account are audited');
  });

  test('inactive, expired and unregistered accounts cannot sign in', async () => {
    const w = await seedUser('w1', 'worker', { active: false });
    await rejects(signIn(w.phoneNumber, w.password), 'permission-denied', 'inactive');
    const e = await seedUser('e1', 'worker', { accessExpiresAt: new Date(Date.now() - 1000) });
    await rejects(signIn(e.phoneNumber, e.password), 'permission-denied', 'expired');
    await auth.createUser({ uid: 'ghost', phoneNumber: '+256700999111', email: 'ghostx@users.ramosmax.invalid', password: 'Ghost!Pass42' });
    await rejects(signIn('+256700999111', 'Ghost!Pass42'), 'permission-denied', 'not_registered');
  });

  test('repeated failures lock the phone number for a while', async () => {
    const w = await seedUser('w1', 'worker');
    for (let i = 0; i < session.MAX_FAILURES; i++) {
      await rejects(signIn(w.phoneNumber, `Wrong!Pass${i}9`), 'unauthenticated');
    }
    await rejects(signIn(w.phoneNumber, w.password), 'resource-exhausted', 'too_many_attempts');
    // After the window it works again.
    const later = Date.now() + session.THROTTLE_WINDOW_MS + 1000;
    const res = await session.signInWithPhonePassword(deps, { phoneNumber: w.phoneNumber, password: w.password }, later);
    assert.equal(tokenUid(res.token), 'w1');
  });
});

describe('new accounts and the first sign-in', () => {
  test('creation sets a temporary password that must be replaced; no password in Firestore', async () => {
    await seedUser('boss', 'admin');
    const temp = 'Tq7!mV2p#Kd9';
    const { uid } = await admin.createUser(deps, 'boss', { fullName: 'John Doe', phoneNumber: '0772 123 456', role: 'worker', password: temp });
    assert.equal((await profile(uid)).mustChangePassword, true);

    const first = await signIn('0772123456', temp);
    assert.equal(first.mustChangePassword, true);
    assert.equal(tokenUid(first.token), uid);

    // While the change is pending, the account cannot do anything privileged.
    await rejects(admin.setUserRole(deps, uid, { uid: 'boss', role: 'worker', reason: 'sneaky' }), 'permission-denied', 'password_change_required');

    await rejects(session.changeOwnPassword(deps, uid, { currentPassword: 'Not!ThePass1', newPassword: 'Fresh!Pass42' }), 'invalid-argument', 'wrong_password');
    await rejects(session.changeOwnPassword(deps, uid, { currentPassword: temp, newPassword: 'weakpass' }), 'invalid-argument', 'weak_password');
    await rejects(session.changeOwnPassword(deps, uid, { currentPassword: temp, newPassword: temp }), 'invalid-argument', 'same_password');
    const changed = await session.changeOwnPassword(deps, uid, { currentPassword: temp, newPassword: 'Fresh!Pass42' });
    assert.equal(tokenUid(changed.token), uid);
    assert.equal((await profile(uid)).mustChangePassword, false);

    await rejects(signIn('0772123456', temp), 'unauthenticated', 'invalid_credentials');
    assert.equal((await signIn('0772123456', 'Fresh!Pass42')).mustChangePassword, false);
    assert.equal((await audits('password.changed')).length, 1);

    const dump = await firestoreDump();
    assert.ok(!dump.includes(temp) && !dump.includes('Fresh!Pass42'), 'no password anywhere in Firestore');
    assert.doesNotMatch(dump, /"(password|passwordHash|plainPassword|temporaryPassword)"/);
  });

  test('a generated temporary password is returned once and only when the server generated it', async () => {
    await seedUser('boss', 'admin');
    const res = await admin.createUser(deps, 'boss', { fullName: 'Gen User', phoneNumber: '0772 123 457', role: 'cashier' });
    assert.deepEqual(passwordProblems(res.temporaryPassword), []);
    assert.equal(tokenUid((await signIn('0772123457', res.temporaryPassword)).token), res.uid);
    await rejects(admin.createUser(deps, 'boss', { fullName: 'Weak Pass', phoneNumber: '0772 123 458', role: 'worker', password: 'password' }),
      'invalid-argument', 'weak_password');
  });

  test('a manager with users.create can create a worker; a plain manager cannot', async () => {
    await seedUser('m1', 'manager');
    await seedUser('m2', 'manager', { permissions: ['users.create'] });
    await rejects(admin.createUser(deps, 'm1', { fullName: 'New Worker', phoneNumber: '0772123459', role: 'worker' }), 'permission-denied');
    const res = await admin.createUser(deps, 'm2', { fullName: 'New Worker', phoneNumber: '0772123459', role: 'worker' });
    assert.ok(res.temporaryPassword);
  });
});

describe('password resets', () => {
  test('who may reset whom', async () => {
    await seedUser('boss', 'admin');
    await seedUser('boss2', 'admin');
    await seedUser('mgr', 'manager');
    await seedUser('mgr2', 'manager');
    await seedUser('cash', 'cashier');
    await seedUser('w1', 'worker');
    await seedUser('w2', 'worker');
    await seedUser('aud', 'auditor');
    const r = (actor, uid) => admin.resetUserPassword(deps, actor, { uid, reason: 'Forgot password' });

    for (const uid of ['boss2', 'mgr', 'cash', 'w1', 'aud']) assert.ok((await r('boss', uid)).temporaryPassword, uid);
    // Reset targets must change their password before acting again; clear
    // that here so they can act in the rest of this test.
    await db.doc('users/mgr').update({ mustChangePassword: false });
    await db.doc('users/boss2').update({ mustChangePassword: false });

    assert.ok((await r('mgr', 'w2')).temporaryPassword, 'manager resets a worker');
    await rejects(r('mgr', 'cash'), 'permission-denied', 'reset_scope');
    await rejects(r('mgr', 'mgr2'), 'permission-denied', 'rank');
    await rejects(r('mgr', 'boss'), 'permission-denied', 'admin_target');
    await rejects(r('mgr', 'mgr'), 'permission-denied', 'self_modification');
    await rejects(r('boss', 'boss'), 'permission-denied', 'self_modification');
    await db.doc('users/w1').update({ mustChangePassword: false });
    await rejects(r('w1', 'w2'), 'permission-denied');
    await db.doc('users/cash').update({ mustChangePassword: false });
    await rejects(r('cash', 'w2'), 'permission-denied');
    await db.doc('users/aud').update({ mustChangePassword: false });
    await rejects(r('aud', 'w2'), 'permission-denied');
    await rejects(admin.resetUserPassword(deps, 'boss', { uid: 'w2' }), 'invalid-argument', 'reason');
  });

  test('a reset replaces the password, forces a change, ends sessions and is audited without the password', async () => {
    await seedUser('mgr', 'manager');
    const w = await seedUser('w1', 'worker');
    const before = (await auth.getUser('w1')).tokensValidAfterTime;
    await new Promise((res) => setTimeout(res, 1100));
    const { temporaryPassword } = await admin.resetUserPassword(deps, 'mgr', { uid: 'w1', reason: 'Employee forgot password' });

    await rejects(signIn(w.phoneNumber, w.password), 'unauthenticated', 'invalid_credentials');
    const res = await signIn(w.phoneNumber, temporaryPassword);
    assert.equal(res.mustChangePassword, true);
    assert.notEqual((await auth.getUser('w1')).tokensValidAfterTime, before, 'existing sessions revoked');

    const [a] = await audits('password.reset');
    assert.deepEqual([a.userId, a.recordId, a.reason], ['mgr', 'w1', 'Employee forgot password']);
    assert.ok(!(await firestoreDump()).includes(temporaryPassword), 'reset password is not stored or audited');
  });
});

describe('phone number changes', () => {
  test('duplicate rejected; old number stops working, new number works with the same password', async () => {
    await seedUser('boss', 'admin');
    const w = await seedUser('w1', 'worker', { staffId: 'RMX-STF-0001' });
    await db.doc('staff/RMX-STF-0001').set({ staffId: 'RMX-STF-0001', linkedUid: 'w1', phoneNumber: w.phoneNumber });
    const other = await seedUser('w2', 'worker');

    await rejects(admin.changeUserPhone(deps, 'boss', { uid: 'w1', phoneNumber: other.phoneNumber }), 'already-exists', 'phone_in_use');
    await rejects(admin.changeUserPhone(deps, 'boss', { uid: 'boss', phoneNumber: '0772 555 000' }), 'permission-denied', 'self_modification');
    await rejects(admin.changeUserPhone(deps, 'boss', { uid: 'w1', phoneNumber: '12' }), 'invalid-argument', 'phone');

    await admin.changeUserPhone(deps, 'boss', { uid: 'w1', phoneNumber: '0772 555 000', reason: 'New SIM card' });
    assert.equal((await auth.getUser('w1')).phoneNumber, '+256772555000');
    assert.equal((await profile('w1')).phoneNumber, '+256772555000');
    assert.equal((await db.doc('staff/RMX-STF-0001').get()).get('phoneNumber'), '+256772555000');

    await rejects(signIn(w.phoneNumber, w.password), 'unauthenticated', 'invalid_credentials');
    assert.equal(tokenUid((await signIn('0772555000', w.password)).token), 'w1', 'same account, same password');
    const [a] = await audits('user.phone_changed');
    assert.ok(!JSON.stringify(a).includes('772555000'), 'full numbers are masked in the audit log');

    await seedUser('mgr', 'manager');
    await rejects(admin.changeUserPhone(deps, 'mgr', { uid: 'w1', phoneNumber: '0772 555 001' }), 'permission-denied');
  });
});

describe('migration from the retired SMS sign-in', () => {
  test('an SMS-era account keeps its UID and profile; a reset gives it a password', async () => {
    await seedUser('boss', 'admin');
    // Phase 1/2 shape: Auth record with a phone number only, no password.
    await auth.createUser({ uid: 'legacy', phoneNumber: '+256772000777' });
    await db.doc('users/legacy').set({
      uid: 'legacy', role: 'cashier', active: true, phoneNumber: '+256772000777', fullName: 'Old Timer',
      phoneVerified: true, permissions: ['expenses.view'], deniedPermissions: [], temporaryPermissions: {},
    });

    await rejects(signIn('0772000777', 'Anything!1a'), 'unauthenticated', 'invalid_credentials');
    const { temporaryPassword } = await admin.resetUserPassword(deps, 'boss', { uid: 'legacy', reason: 'Move to password sign-in' });

    const res = await signIn('0772000777', temporaryPassword);
    assert.equal(tokenUid(res.token), 'legacy', 'same Firebase UID');
    assert.equal(res.mustChangePassword, true);
    const p = await profile('legacy');
    assert.deepEqual([p.role, p.permissions, p.fullName], ['cashier', ['expenses.view'], 'Old Timer'], 'profile untouched');
    const [a] = await audits('password.reset');
    assert.equal(a.newValue.migratedFromSms, true);
  });
});
