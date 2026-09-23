// Storage security-rule tests (Phase 9) against the emulator, using the real
// firebase/storage.rules file. Run with `npm test` (starts the Storage
// emulator next to Firestore).
//
// Storage rules read the caller's Firestore profile (firestore.get /
// firestore.exists). Some Storage emulator builds cannot make that
// cross-service call and then DENY every rule that needs it (they fail
// closed). This file probes for that first:
//   * rules that do not depend on the profile (signed-out access, unknown
//     paths, "never delete / never replace evidence") are always tested;
//   * role-based cases run only where cross-service lookups work, and are
//     reported as SKIPPED - with the reason - where they do not.
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

const fsHost = (process.env.FIRESTORE_EMULATOR_HOST ?? '').split(':');
const stHost = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '').split(':');
const noEmulator = !fsHost[0] || !stHost[0] ? 'Storage emulator not running (npm test starts it)' : false;
const PROJECT = 'demo-ramosmax';

/** Can this Storage emulator evaluate firestore.exists() in rules? */
async function probeCrossService() {
  if (noEmulator) return false;
  const probe = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { host: fsHost[0], port: Number(fsHost[1]) },
    storage: { host: stHost[0], port: Number(stHost[1]),
      rules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{p=**} { allow read, write: if firestore.exists(/databases/(default)/documents/users/$(request.auth.uid)); } } }" },
  });
  try {
    await probe.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'users/probe'), { active: true }));
    await uploadBytes(ref(probe.authenticatedContext('probe').storage(), 'probe/p.txt'), new Uint8Array([1]));
    return true;
  } catch {
    return false;
  } finally {
    await probe.cleanup();
  }
}

const crossService = await probeCrossService();
const needsProfile = noEmulator || (!crossService && 'This Storage emulator cannot evaluate firestore.get()/exists() in rules (it denies them), so role-based allow cases cannot be checked here. Verify on the deployed development project (docs/PRODUCTION_READINESS.md).');

const PROFILES = {
  admin: { role: 'admin' }, manager: { role: 'manager' }, cashier: { role: 'cashier' }, worker: { role: 'worker' },
  auditor: { role: 'auditor' }, shareholder: { role: 'shareholder' }, inactiveAdmin: { role: 'admin', active: false },
  pendingAdmin: { role: 'admin', mustChangePassword: true },
};
const PDF = { contentType: 'application/pdf' };
const PNG = { contentType: 'image/png' };
const EXE = { contentType: 'application/octet-stream' };
const bytes = new Uint8Array([1, 2, 3]);

let env;
const as = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();
const put = (uid, path, meta = PDF) => uploadBytes(ref(as(uid), path), bytes, meta);
const read = (uid, path) => getBytes(ref(as(uid), path));
const remove = (uid, path) => deleteObject(ref(as(uid), path));

before(async () => {
  if (noEmulator) return;
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { host: fsHost[0], port: Number(fsHost[1]) },
    storage: { host: stHost[0], port: Number(stHost[1]), rules: readFileSync(new URL('../../firebase/storage.rules', import.meta.url), 'utf8') },
  });
});
after(async () => env?.cleanup());

beforeEach(async () => {
  if (noEmulator) return;
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const [uid, p] of Object.entries(PROFILES)) {
      await setDoc(doc(ctx.firestore(), `users/${uid}`), { uid, active: true, phoneNumber: '+256700000000', permissions: [], ...p });
    }
    const s = ctx.storage();
    for (const path of ['staff/s1/documents/id/front.pdf', 'finance_uploads/deposits/u1/slip.pdf', 'payroll_uploads/losses/u1/note.pdf',
      'expenses/e1/receipts/r.pdf', 'business/policies/handbook.pdf']) {
      await uploadBytes(ref(s, path), bytes, PDF);
    }
  });
});

describe('storage rules: independent of the profile', { skip: noEmulator }, () => {
  test('signed-out callers reach nothing', async () => {
    for (const path of ['business/policies/handbook.pdf', 'staff/s1/documents/id/front.pdf', 'finance_uploads/deposits/u1/slip.pdf']) {
      await assertFails(read(null, path));
    }
    await assertFails(put(null, 'business/policies/new.pdf'));
    await assertFails(put(null, 'staff/s1/profile/photo.png', PNG));
  });

  test('unknown paths are denied to everyone, Administrators included', async () => {
    await assertFails(put('admin', 'random/place/file.pdf'));
    await assertFails(read('admin', 'random/place/file.pdf'));
    await assertFails(put('admin', 'users/admin/anything.pdf'));
  });

  test('evidence and sensitive documents are never deleted', async () => {
    for (const path of ['staff/s1/documents/id/front.pdf', 'finance_uploads/deposits/u1/slip.pdf', 'payroll_uploads/losses/u1/note.pdf',
      'expenses/e1/receipts/r.pdf', 'business/policies/handbook.pdf']) {
      await assertFails(remove('admin', path), path);
    }
  });
});

describe('storage rules: role-based (needs cross-service lookups)', { skip: needsProfile }, () => {
  test('inactive accounts and pending password changes reach nothing', async () => {
    for (const uid of ['inactiveAdmin', 'pendingAdmin']) {
      await assertFails(read(uid, 'business/policies/handbook.pdf'));
      await assertFails(put(uid, 'business/policies/new.pdf'));
    }
  });

  test('sensitive staff documents: Administrators only', async () => {
    await assertSucceeds(read('admin', 'staff/s1/documents/id/front.pdf'));
    for (const uid of ['manager', 'cashier', 'worker', 'auditor', 'shareholder']) {
      await assertFails(read(uid, 'staff/s1/documents/id/front.pdf'));
      await assertFails(put(uid, 'staff/s1/documents/id/back.pdf'));
    }
  });

  test('finance and payroll evidence: allowed uploads only; never replaced', async () => {
    await assertSucceeds(put('cashier', 'finance_uploads/deposits/u2/slip.pdf'));
    await assertFails(put('cashier', 'finance_uploads/payroll/u2/x.pdf'), 'unknown kind');
    await assertFails(put('worker', 'finance_uploads/deposits/u3/slip.pdf'));
    await assertFails(put('manager', 'finance_uploads/deposits/u1/slip.pdf'), 'replacing evidence');
    await assertFails(put('manager', 'finance_uploads/expenses/u4/x.bin', EXE), 'wrong content type');
    await assertFails(read('cashier', 'payroll_uploads/losses/u1/note.pdf'));
    await assertFails(read('worker', 'payroll_uploads/losses/u1/note.pdf'));
    await assertSucceeds(read('auditor', 'payroll_uploads/losses/u1/note.pdf'));
    await assertFails(put('cashier', 'payroll_uploads/losses/u2/note.pdf'));
  });

  test('receipts, business documents and staff photos follow their roles', async () => {
    await assertFails(read('worker', 'expenses/e1/receipts/r.pdf'));
    await assertFails(read('cashier', 'expenses/e1/receipts/r.pdf'));
    await assertSucceeds(read('shareholder', 'business/policies/handbook.pdf'));
    await assertFails(put('manager', 'business/policies/new.pdf'), 'business documents: Administrators only');
    await assertSucceeds(put('manager', 'staff/s1/profile/photo.png', PNG));
    await assertFails(put('worker', 'staff/s1/profile/photo.png', PNG), 'workers cannot change staff photos');
    await assertFails(put('manager', 'staff/s1/profile/photo.pdf'), 'photos must be images');
  });
});
