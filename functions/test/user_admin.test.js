// Cloud Function authorization tests against the Auth + Firestore emulators.
// Run with `npm test` (starts the emulators via `firebase emulators:exec`).
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import * as admin from '../src/user_admin.js';
import { effectivePermissions } from '../src/access.js';

const PROJECT = 'demo-ramosmax';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Run through `npm test` so the Firebase emulators are started.');
}

initializeApp({ projectId: PROJECT }, 'user-admin-tests');
const app = (await import('firebase-admin/app')).getApp('user-admin-tests');
const db = getFirestore(app);
const auth = getAuth(app);
const notes = [];
const deps = { db, auth, notify: async (uid, type, recordId) => { notes.push({ uid, type, recordId }); } };

const H = 3600_000;

async function reset() {
  notes.length = 0;
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

let phoneSeq = 100;
async function seedUser(uid, role, extra = {}) {
  const phoneNumber = extra.phoneNumber ?? `+256772000${String(phoneSeq++).padStart(3, '0')}`;
  await auth.createUser({ uid, phoneNumber });
  await db.doc(`users/${uid}`).set({
    uid, role, active: true, phoneNumber, fullName: `${role} ${uid}`,
    permissions: [], deniedPermissions: [], temporaryPermissions: {}, ...extra,
  });
  return uid;
}

const user = async (uid) => (await db.doc(`users/${uid}`).get()).data();
async function audits(action) {
  const snap = await db.collection('audit_logs').where('action', '==', action).get();
  return snap.docs.map((d) => d.data());
}

/** Asserts an HttpsError with [code] (and optional details.reason). */
async function rejects(promise, code, reason) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (reason) assert.equal(e.details?.reason, reason);
    return true;
  });
}

beforeEach(reset);

describe('createUser', () => {
  test('admin creates a user: Auth account, profile, allocated staff record, audit', async () => {
    await seedUser('boss', 'admin');
    const res = await admin.createUser(deps, 'boss', {
      fullName: '  Jane   Washer ', phoneNumber: '0772 555 111', role: 'worker', specialization: 'car_washer',
      position: 'Washer', department: 'Bay 1', linkStaff: true, permissions: ['payments.view'], password: 'Kv7!mQ2p#Rt9',
    });
    assert.equal(res.staffId, 'RMX-STF-0001');
    assert.equal(res.temporaryPassword, undefined, 'a password chosen by the creator is not echoed back');
    const authUser = await auth.getUser(res.uid);
    assert.equal(authUser.phoneNumber, '+256772555111');
    assert.match(authUser.email, /@users\.ramosmax\.invalid$/);
    assert.ok(authUser.providerData.some((p) => p.providerId === 'password'), 'Firebase holds the password');

    const u = await user(res.uid);
    assert.equal(u.fullName, 'Jane Washer');
    assert.equal(u.role, 'worker');
    assert.equal(u.active, true);
    assert.equal(u.mustChangePassword, true);
    assert.equal(u.passwordSet, true);
    assert.equal(u.phoneVerified, undefined, 'SMS verification fields are gone');
    assert.equal(u.staffId, 'RMX-STF-0001');
    assert.deepEqual(u.permissions, ['payments.view']);
    assert.equal(u.createdBy, 'boss');

    const staff = (await db.doc('staff/RMX-STF-0001').get()).data();
    assert.equal(staff.linkedUid, res.uid);
    assert.equal(staff.position, 'Washer');

    const [created] = await audits('user.created');
    assert.equal(created.userId, 'boss');
    assert.equal(created.userRole, 'admin');
    assert.equal(created.recordId, res.uid);
    assert.ok(created.timestamp);
    assert.equal((await audits('staff.linked'))[0].newValue.staffId, 'RMX-STF-0001');
    assert.equal((await audits('permission.granted'))[0].newValue.permission, 'payments.view');

    const second = await admin.createUser(deps, 'boss', { fullName: 'Second', phoneNumber: '0772555112', role: 'cashier', linkStaff: true });
    assert.equal(second.staffId, 'RMX-STF-0002');
  });

  test('duplicate phone number, staff ID already linked, bad input', async () => {
    await seedUser('boss', 'admin');
    await seedUser('w1', 'worker', { phoneNumber: '+256772555111', staffId: 'RMX-STF-0007' });
    await db.doc('staff/RMX-STF-0007').set({ staffId: 'RMX-STF-0007', linkedUid: 'w1' });

    await rejects(admin.createUser(deps, 'boss', { fullName: 'Dup', phoneNumber: '0772555111', role: 'worker' }),
      'already-exists', 'user_exists');
    await rejects(admin.createUser(deps, 'boss', { fullName: 'New', phoneNumber: '0772555999', role: 'worker', staffId: 'rmx-stf-0007' }),
      'already-exists', 'staff_linked');
    await assert.rejects(auth.getUserByPhoneNumber('+256772555999'), /no user record/i, 'orphan Auth user was cleaned up');

    await rejects(admin.createUser(deps, 'boss', { fullName: 'X', phoneNumber: '0772555998', role: 'worker' }), 'invalid-argument', 'name');
    await rejects(admin.createUser(deps, 'boss', { fullName: 'Bad Phone', phoneNumber: '12345', role: 'worker' }), 'invalid-argument', 'phone');
    await rejects(admin.createUser(deps, 'boss', { fullName: 'Bad Role', phoneNumber: '0772555998', role: 'owner' }), 'invalid-argument', 'role');
    await rejects(admin.createUser(deps, 'boss', { fullName: 'Bad Perm', phoneNumber: '0772555998', role: 'worker', permissions: ['everything'] }),
      'invalid-argument', 'permission');
    await rejects(admin.createUser(deps, 'boss', { fullName: 'Spec', phoneNumber: '0772555998', role: 'cashier', specialization: 'detailer' }),
      'invalid-argument', 'specialization');
  });

  test('only holders of users.create may create; non-admins never create admins', async () => {
    for (const role of ['manager', 'cashier', 'worker', 'auditor', 'shareholder']) {
      await seedUser(role, role);
      await rejects(admin.createUser(deps, role, { fullName: 'Someone', phoneNumber: '0772555990', role: 'worker' }),
        'permission-denied');
    }
    await seedUser('mgr2', 'manager', { permissions: ['users.create'] });
    await rejects(admin.createUser(deps, 'mgr2', { fullName: 'Evil Admin', phoneNumber: '0772555991', role: 'admin' }),
      'permission-denied', 'assign_admin');
    await rejects(admin.createUser(deps, 'mgr2', { fullName: 'Peer', phoneNumber: '0772555992', role: 'manager' }),
      'permission-denied', 'rank');
    const ok = await admin.createUser(deps, 'mgr2', { fullName: 'New Worker', phoneNumber: '0772555993', role: 'worker' });
    assert.ok(ok.uid);
  });

  test('deactivated or unknown callers cannot do anything', async () => {
    await seedUser('gone', 'admin', { active: false });
    await rejects(admin.createUser(deps, 'gone', { fullName: 'X Y', phoneNumber: '0772555994', role: 'worker' }),
      'permission-denied', 'actor_inactive');
    await rejects(admin.createUser(deps, 'nobody', { fullName: 'X Y', phoneNumber: '0772555994', role: 'worker' }),
      'permission-denied', 'actor_inactive');
  });
});

describe('setUserRole', () => {
  test('admin changes a role; audited with previous, new and reason; notified', async () => {
    await seedUser('boss', 'admin');
    await seedUser('w1', 'worker', { specialization: 'detailer' });
    await admin.setUserRole(deps, 'boss', { uid: 'w1', role: 'manager', reason: 'Promotion' });
    const u = await user('w1');
    assert.equal(u.role, 'manager');
    assert.equal(u.specialization, null);
    assert.ok(effectivePermissions(u, Date.now()).has('payments.record'), 'gains manager permissions at once');
    const [a] = await audits('user.role_changed');
    assert.deepEqual([a.previousValue.role, a.newValue.role, a.reason, a.userId], ['worker', 'manager', 'Promotion', 'boss']);
    assert.deepEqual(notes.map((n) => n.type), ['role_changed']);
  });

  test('self-change, missing reason, non-admin assigning admin, manager touching admins are refused', async () => {
    await seedUser('boss', 'admin');
    await seedUser('boss2', 'admin');
    await seedUser('mgr', 'manager', { permissions: ['users.roles.manage'] });
    await seedUser('w1', 'worker');
    await seedUser('c1', 'cashier');
    await rejects(admin.setUserRole(deps, 'boss', { uid: 'boss', role: 'worker', reason: 'test' }), 'permission-denied', 'self_modification');
    await rejects(admin.setUserRole(deps, 'boss', { uid: 'w1', role: 'manager' }), 'invalid-argument', 'reason');
    await rejects(admin.setUserRole(deps, 'mgr', { uid: 'w1', role: 'admin', reason: 'please' }), 'permission-denied', 'assign_admin');
    await rejects(admin.setUserRole(deps, 'mgr', { uid: 'boss2', role: 'worker', reason: 'coup' }), 'permission-denied', 'admin_target');
    await rejects(admin.setUserRole(deps, 'mgr', { uid: 'mgr', role: 'cashier', reason: 'x y z' }), 'permission-denied', 'self_modification');
    await rejects(admin.setUserRole(deps, 'c1', { uid: 'w1', role: 'cashier', reason: 'x y z' }), 'permission-denied');
    await rejects(admin.setUserRole(deps, 'w1', { uid: 'w1', role: 'admin', reason: 'x y z' }), 'permission-denied');
    await admin.setUserRole(deps, 'mgr', { uid: 'w1', role: 'cashier', reason: 'Till cover' });
    assert.equal((await user('w1')).role, 'cashier');
    assert.equal((await user('boss2')).role, 'admin');
  });
});

describe('setUserActive', () => {
  test('deactivation keeps the Auth account, revokes sessions, records reason; reactivation works', async () => {
    await seedUser('boss', 'admin');
    await seedUser('w1', 'worker');
    await rejects(admin.setUserActive(deps, 'boss', { uid: 'w1', active: false }), 'invalid-argument', 'reason');
    const before = (await auth.getUser('w1')).tokensValidAfterTime;
    await new Promise((r) => setTimeout(r, 1100));
    await admin.setUserActive(deps, 'boss', { uid: 'w1', active: false, reason: 'Left the company' });
    const u = await user('w1');
    assert.equal(u.active, false);
    assert.equal(u.statusReason, 'Left the company');
    assert.equal(u.statusChangedBy, 'boss');
    const authUser = await auth.getUser('w1');
    assert.equal(authUser.disabled, false, 'account kept for reactivation');
    assert.notEqual(authUser.tokensValidAfterTime, before, 'refresh tokens revoked');
    const [a] = await audits('user.deactivated');
    assert.deepEqual([a.previousValue.active, a.newValue.active, a.reason], [true, false, 'Left the company']);

    await rejects(admin.setUserActive(deps, 'boss', { uid: 'w1', active: false, reason: 'again' }), 'failed-precondition', 'no_changes');
    await admin.setUserActive(deps, 'boss', { uid: 'w1', active: true });
    assert.equal((await user('w1')).active, true);
    assert.equal((await audits('user.activated')).length, 1);
    assert.deepEqual(notes.map((n) => n.type), ['account_deactivated', 'account_activated']);
  });

  test('nobody activates or deactivates themselves; deactivated users cannot act', async () => {
    await seedUser('boss', 'admin');
    await seedUser('w1', 'worker', { active: false });
    await rejects(admin.setUserActive(deps, 'boss', { uid: 'boss', active: false, reason: 'bye bye' }), 'permission-denied', 'self_modification');
    await rejects(admin.setUserActive(deps, 'w1', { uid: 'w1', active: true }), 'permission-denied', 'actor_inactive');
  });

  test('the last active Admin cannot be removed, even by two admins racing each other', async () => {
    await seedUser('a1', 'admin');
    await seedUser('a2', 'admin');
    await seedUser('a3', 'admin', { active: false });
    const results = await Promise.allSettled([
      admin.setUserActive(deps, 'a1', { uid: 'a2', active: false, reason: 'race one' }),
      admin.setUserActive(deps, 'a2', { uid: 'a1', active: false, reason: 'race two' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 1, JSON.stringify(results.map((r) => r.reason?.details ?? r.status)));
    const failure = results.find((r) => r.status === 'rejected').reason;
    assert.ok(['last_admin', 'actor_inactive'].includes(failure.details?.reason), failure.message);
    const active = (await db.collection('users').where('role', '==', 'admin').where('active', '==', true).get()).size;
    assert.equal(active, 1);
  });

  test('racing demotions between the last two admins leave one admin', async () => {
    await seedUser('a1', 'admin');
    await seedUser('a2', 'admin');
    const results = await Promise.allSettled([
      admin.setUserRole(deps, 'a1', { uid: 'a2', role: 'manager', reason: 'race one' }),
      admin.setUserRole(deps, 'a2', { uid: 'a1', role: 'manager', reason: 'race two' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const admins = (await db.collection('users').where('role', '==', 'admin').get()).size;
    assert.equal(admins, 1);
  });
});

describe('setUserPermissions', () => {
  test('grants and denials are applied and audited per permission', async () => {
    await seedUser('boss', 'admin');
    await seedUser('w1', 'worker');
    await admin.setUserPermissions(deps, 'boss', { uid: 'w1', permissions: ['payments.record'], deniedPermissions: ['jobs.complete'] });
    let u = await user('w1');
    assert.deepEqual(u.permissions, ['payments.record']);
    assert.deepEqual(u.deniedPermissions, ['jobs.complete']);
    const p = effectivePermissions(u, Date.now());
    assert.ok(p.has('payments.record') && !p.has('jobs.complete'));
    assert.equal((await audits('permission.granted')).length, 1);
    assert.equal((await audits('permission.denied')).length, 1);

    await admin.setUserPermissions(deps, 'boss', { uid: 'w1', permissions: [], deniedPermissions: [] });
    u = await user('w1');
    assert.deepEqual([u.permissions, u.deniedPermissions], [[], []]);
    assert.equal((await audits('permission.grant_removed')).length, 1);
    assert.equal((await audits('permission.denial_removed')).length, 1);
  });

  test('self-escalation and unauthorised changes are refused', async () => {
    await seedUser('boss', 'admin');
    await seedUser('boss2', 'admin');
    await seedUser('mgr', 'manager', { permissions: ['users.permissions.manage'] });
    await seedUser('w1', 'worker');
    await seedUser('aud', 'auditor');
    await rejects(admin.setUserPermissions(deps, 'boss', { uid: 'boss', permissions: [], deniedPermissions: ['payroll.view'] }),
      'permission-denied', 'self_modification');
    await rejects(admin.setUserPermissions(deps, 'w1', { uid: 'w1', permissions: ['users.view'], deniedPermissions: [] }), 'permission-denied');
    await rejects(admin.setUserPermissions(deps, 'aud', { uid: 'w1', permissions: ['payments.record'], deniedPermissions: [] }), 'permission-denied');
    await rejects(admin.setUserPermissions(deps, 'mgr', { uid: 'w1', permissions: ['payroll.approve'], deniedPermissions: [] }),
      'permission-denied', 'not_held');
    await rejects(admin.setUserPermissions(deps, 'mgr', { uid: 'w1', permissions: ['users.create'], deniedPermissions: [] }),
      'permission-denied', 'admin_only_permission');
    await rejects(admin.setUserPermissions(deps, 'mgr', { uid: 'boss2', permissions: [], deniedPermissions: ['payroll.view'] }),
      'permission-denied', 'admin_target');
    await rejects(admin.setUserPermissions(deps, 'boss', { uid: 'boss2', permissions: [], deniedPermissions: ['users.roles.manage'] }),
      'failed-precondition', 'admin_user_permissions');
    await rejects(admin.setUserPermissions(deps, 'boss', { uid: 'w1', permissions: ['x.y'], deniedPermissions: [] }), 'invalid-argument', 'permission');
    await rejects(admin.setUserPermissions(deps, 'boss', { uid: 'w1', permissions: ['payments.view'], deniedPermissions: ['payments.view'] }),
      'invalid-argument', 'overlap');
    await admin.setUserPermissions(deps, 'mgr', { uid: 'w1', permissions: ['payments.record'], deniedPermissions: [] });
    assert.deepEqual((await user('w1')).permissions, ['payments.record']);
  });
});

describe('temporary permissions', () => {
  test('manager grants 18:00-22:00 after-hours access; it applies only inside the window', async () => {
    await seedUser('mgr', 'manager', { fullName: 'Mary Manager' });
    await seedUser('w1', 'worker');
    const start = Date.now() + 2 * H;
    const end = start + 4 * H;
    const { grantId } = await admin.grantTemporaryPermission(deps, 'mgr', {
      uid: 'w1', permission: 'payments.record', startsAt: start, expiresAt: end, reason: 'Evening cover',
    });
    const u = await user('w1');
    assert.equal(u.temporaryPermissions['payments.record'].grantId, grantId);
    assert.ok(!effectivePermissions(u, Date.now()).has('payments.record'), 'not before start');
    assert.ok(effectivePermissions(u, start + H).has('payments.record'), 'during the window');
    assert.ok(!effectivePermissions(u, end).has('payments.record'), 'expired at end');

    const rec = (await db.doc(`users/w1/temporary_grants/${grantId}`).get()).data();
    assert.deepEqual([rec.permission, rec.status, rec.grantedBy, rec.grantedByName, rec.reason],
      ['payments.record', 'active', 'mgr', 'Mary Manager', 'Evening cover']);
    assert.equal(rec.startsAt.toMillis(), start);
    const [a] = await audits('permission.temporary_granted');
    assert.equal(a.newValue.permission, 'payments.record');
    assert.equal(a.reason, 'Evening cover');
    assert.deepEqual(notes.map((n) => n.type), ['temporary_permission_granted']);
  });

  test('self-grants, escalation and bad windows are refused', async () => {
    await seedUser('boss', 'admin');
    await seedUser('mgr', 'manager');
    await seedUser('mgr2', 'manager');
    await seedUser('w1', 'worker', { deniedPermissions: ['invoices.create'] });
    const t = Date.now();
    const req = (uid, permission, s = t, e = t + H) => ({ uid, permission, startsAt: s, expiresAt: e, reason: 'cover shift' });
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('mgr', 'payroll.view')), 'permission-denied', 'self_modification');
    await rejects(admin.grantTemporaryPermission(deps, 'boss', req('boss', 'payroll.view')), 'permission-denied', 'self_modification');
    await rejects(admin.grantTemporaryPermission(deps, 'w1', req('w1', 'payments.record')), 'permission-denied');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('w1', 'payroll.approve')), 'permission-denied', 'not_held');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('w1', 'users.permissions.temporary')), 'permission-denied', 'admin_only_permission');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('mgr2', 'payments.record')), 'permission-denied', 'rank');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('boss', 'payments.record')), 'permission-denied', 'admin_target');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('w1', 'payments.record', t + 2 * H, t + H)), 'invalid-argument', 'window');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('w1', 'payments.record', t - 2 * H, t + H)), 'invalid-argument', 'window');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('w1', 'jobs.complete')), 'failed-precondition', 'already_granted');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', req('w1', 'invoices.create')), 'failed-precondition', 'denied');
    await rejects(admin.grantTemporaryPermission(deps, 'mgr', { ...req('w1', 'payments.record'), reason: '' }), 'invalid-argument', 'reason');
  });

  test('revocation removes access at once; re-granting supersedes', async () => {
    await seedUser('mgr', 'manager');
    await seedUser('w1', 'worker');
    const t = Date.now();
    const first = await admin.grantTemporaryPermission(deps, 'mgr', { uid: 'w1', permission: 'payments.record', startsAt: t, expiresAt: t + H, reason: 'cover one' });
    const second = await admin.grantTemporaryPermission(deps, 'mgr', { uid: 'w1', permission: 'payments.record', startsAt: t, expiresAt: t + 2 * H, reason: 'cover two' });
    assert.equal((await db.doc(`users/w1/temporary_grants/${first.grantId}`).get()).get('status'), 'superseded');
    await rejects(admin.revokeTemporaryPermission(deps, 'mgr', { uid: 'w1', grantId: first.grantId, reason: 'done now' }), 'failed-precondition', 'not_active');
    await admin.revokeTemporaryPermission(deps, 'mgr', { uid: 'w1', grantId: second.grantId, reason: 'Shift ended early' });
    const u = await user('w1');
    assert.equal(u.temporaryPermissions['payments.record'], undefined);
    assert.ok(!effectivePermissions(u, Date.now()).has('payments.record'));
    assert.equal((await db.doc(`users/w1/temporary_grants/${second.grantId}`).get()).get('status'), 'revoked');
    assert.equal((await audits('permission.temporary_revoked')).length, 1);
  });

  test('scheduled sweep marks expired grants and warns before expiry', async () => {
    await seedUser('mgr', 'manager');
    await seedUser('w1', 'worker');
    const t = Date.now();
    const soon = await admin.grantTemporaryPermission(deps, 'mgr', { uid: 'w1', permission: 'payments.record', startsAt: t, expiresAt: t + 20 * 60_000, reason: 'short cover' });
    const later = await admin.grantTemporaryPermission(deps, 'mgr', { uid: 'w1', permission: 'invoices.create', startsAt: t, expiresAt: t + 3 * H, reason: 'long cover' });
    notes.length = 0;

    let r = await admin.sweepTemporaryGrants(deps, t);
    assert.deepEqual(r, { expired: 0, warned: 1 });
    assert.deepEqual(notes.map((n) => [n.type, n.recordId]), [['temporary_permission_expiring', soon.grantId]]);
    r = await admin.sweepTemporaryGrants(deps, t);
    assert.equal(r.warned, 0, 'each grant is warned about once');

    r = await admin.sweepTemporaryGrants(deps, t + 30 * 60_000);
    assert.equal(r.expired, 1);
    assert.equal((await db.doc(`users/w1/temporary_grants/${soon.grantId}`).get()).get('status'), 'expired');
    const u = await user('w1');
    assert.equal(u.temporaryPermissions['payments.record'], undefined);
    assert.equal(u.temporaryPermissions['invoices.create'].grantId, later.grantId);
  });
});

describe('profile and staff link', () => {
  test('profile edits are audited; the phone number is not changed through them', async () => {
    await seedUser('boss', 'admin');
    await seedUser('w1', 'worker');
    await rejects(admin.updateUserProfile(deps, 'boss', { uid: 'w1', phoneNumber: '0772444446' }), 'invalid-argument', 'use_change_phone');
    await admin.updateUserProfile(deps, 'boss', { uid: 'w1', fullName: 'Renamed Worker', position: 'Detailer' });
    const u = await user('w1');
    assert.deepEqual([u.fullName, u.position], ['Renamed Worker', 'Detailer']);
    assert.equal((await audits('user.updated')).length, 1);
    await rejects(admin.updateUserProfile(deps, 'boss', { uid: 'w1', fullName: 'Renamed Worker' }), 'failed-precondition', 'no_changes');
  });

  test('staff linking: missing record, record linked elsewhere, relink and unlink', async () => {
    await seedUser('boss', 'admin');
    await seedUser('w1', 'worker');
    await seedUser('w2', 'worker', { staffId: 'RMX-STF-0002' });
    await db.doc('staff/RMX-STF-0002').set({ staffId: 'RMX-STF-0002', linkedUid: 'w2' });
    await db.doc('staff/RMX-STF-0003').set({ staffId: 'RMX-STF-0003', linkedUid: null });
    await rejects(admin.linkStaff(deps, 'boss', { uid: 'w1', staffId: 'RMX-STF-0099' }), 'not-found', 'staff_missing');
    await rejects(admin.linkStaff(deps, 'boss', { uid: 'w1', staffId: 'RMX-STF-0002' }), 'already-exists', 'staff_linked');
    await admin.linkStaff(deps, 'boss', { uid: 'w1', staffId: 'RMX-STF-0003' });
    assert.equal((await user('w1')).staffId, 'RMX-STF-0003');
    assert.equal((await db.doc('staff/RMX-STF-0003').get()).get('linkedUid'), 'w1');
    await admin.linkStaff(deps, 'boss', { uid: 'w1', staffId: 'RMX-STF-0100', createIfMissing: true });
    assert.equal((await db.doc('staff/RMX-STF-0003').get()).get('linkedUid'), null);
    assert.equal((await db.doc('staff/RMX-STF-0100').get()).get('linkedUid'), 'w1');
    await admin.linkStaff(deps, 'boss', { uid: 'w1', staffId: null });
    assert.equal((await user('w1')).staffId, null);
    assert.equal((await audits('staff.linked')).length, 2);
    assert.equal((await audits('staff.unlinked')).length, 2);
  });
});
