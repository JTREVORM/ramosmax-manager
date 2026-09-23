// Firestore security-rule tests against the emulator, using the real
// firebase/firestore.rules file. Run with `npm test`.
//
// These prove the enforcement holds for a MODIFIED client talking to
// Firestore directly - not merely that the app hides buttons.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where,
} from 'firebase/firestore';

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '').split(':');
if (!host) throw new Error('Run through `npm test` so the Firestore emulator is started.');

let env;
const H = 3600_000;
const phone = (n) => `+2567720001${String(n).padStart(2, '0')}`;
const PROFILES = {
  admin: { role: 'admin' },
  manager: { role: 'manager' },
  cashier: { role: 'cashier' },
  worker: { role: 'worker', deniedPermissions: ['attendance.mark'] },
  auditor: { role: 'auditor' },
  shareholder: { role: 'shareholder' },
  inactiveAdmin: { role: 'admin', active: false },
  pendingAdmin: { role: 'admin', mustChangePassword: true },
  expiredAdmin: { role: 'admin', accessExpiresAt: Timestamp.fromMillis(Date.now() - H) },
  deniedManager: { role: 'manager', deniedPermissions: ['users.view'] },
  tempWorker: { role: 'worker', temporaryPermissions: {
    'users.view': { startsAt: Timestamp.fromMillis(Date.now() - H), expiresAt: Timestamp.fromMillis(Date.now() + H), grantId: 'g1' },
  } },
  expiredTempWorker: { role: 'worker', temporaryPermissions: {
    'users.view': { startsAt: Timestamp.fromMillis(Date.now() - 2 * H), expiresAt: Timestamp.fromMillis(Date.now() - H), grantId: 'g2' },
  } },
  scheduledTempWorker: { role: 'worker', temporaryPermissions: {
    'users.view': { startsAt: Timestamp.fromMillis(Date.now() + H), expiresAt: Timestamp.fromMillis(Date.now() + 2 * H), grantId: 'g3' },
  } },
  legacyTempWorker: { role: 'worker', temporaryPermissions: { 'users.view': Timestamp.fromMillis(Date.now() + H) } },
  legacyExpiredWorker: { role: 'worker', temporaryPermissions: { 'users.view': Timestamp.fromMillis(Date.now() - 1) } },
};
const UIDS = Object.keys(PROFILES);

/** Firestore client acting as [uid] (signed in with phone number + password). */
function as(uid, token = {}) {
  return env.authenticatedContext(uid, { firebase: { sign_in_provider: 'custom' }, ...token }).firestore();
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-ramosmax-rules',
    firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [i, uid] of UIDS.entries()) {
      await setDoc(doc(db, 'users', uid), {
        uid, active: true, phoneNumber: phone(i), fullName: uid, permissions: [], deniedPermissions: [],
        temporaryPermissions: {}, phoneVerified: false, staffId: uid === 'worker' ? 'RMX-STF-0001' : null,
        ...PROFILES[uid],
      });
    }
    await setDoc(doc(db, 'users/worker/temporary_grants/g1'), { permission: 'payments.record', status: 'active' });
    await setDoc(doc(db, 'staff/RMX-STF-0001'), { staffId: 'RMX-STF-0001', linkedUid: 'worker' });
    await setDoc(doc(db, 'staff/RMX-STF-0002'), { staffId: 'RMX-STF-0002', linkedUid: 'cashier' });
    await setDoc(doc(db, 'audit_logs/a1'), { userId: 'admin', userRole: 'admin', action: 'user.created', module: 'users', recordId: 'worker' });
    await setDoc(doc(db, 'counters/staff'), { next: 2 });
  });
});

const listUsers = (uid) => getDocs(collection(as(uid), 'users'));

describe('reading user records', () => {
  test('unauthenticated users cannot read protected user records', async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'users/admin')));
    await assertFails(getDocs(collection(anon, 'users')));
  });

  test('a signed-in phone without a profile reads nothing', async () => {
    await assertFails(getDoc(doc(as('stranger'), 'users/worker')));
    await assertFails(getDocs(collection(as('stranger'), 'users')));
  });

  test('admin, manager and auditor can list users; cashier, worker and shareholder cannot', async () => {
    for (const uid of ['admin', 'manager', 'auditor']) await assertSucceeds(listUsers(uid));
    for (const uid of ['cashier', 'worker', 'shareholder']) await assertFails(listUsers(uid));
  });

  test('everyone can read their own profile (even when deactivated) but not other people\'s', async () => {
    for (const uid of ['worker', 'cashier', 'inactiveAdmin']) await assertSucceeds(getDoc(doc(as(uid), 'users', uid)));
    await assertFails(getDoc(doc(as('worker'), 'users/admin')));
  });

  test('deactivated and expired accounts cannot access protected data', async () => {
    for (const uid of ['inactiveAdmin', 'expiredAdmin']) {
      await assertFails(listUsers(uid));
      await assertFails(getDoc(doc(as(uid), 'audit_logs/a1')));
      await assertFails(getDoc(doc(as(uid), 'staff/RMX-STF-0002')));
      await assertFails(getDoc(doc(as(uid), 'settings/general')));
    }
  });

  test('an explicit denial overrides the role', async () => {
    await assertFails(listUsers('deniedManager'));
  });

  test('temporary permissions work only inside their window (both formats)', async () => {
    await assertSucceeds(listUsers('tempWorker'));
    await assertSucceeds(listUsers('legacyTempWorker'));
    await assertFails(listUsers('expiredTempWorker'));
    await assertFails(listUsers('scheduledTempWorker'));
    await assertFails(listUsers('legacyExpiredWorker'));
  });
});

describe('writing access-control data', () => {
  test('no client - admin included - may create, delete or re-role users directly', async () => {
    for (const uid of ['admin', 'manager', 'worker']) {
      const db = as(uid);
      await assertFails(setDoc(doc(db, 'users/newbie'), { role: 'worker', active: true, phoneNumber: '+256700000000' }));
      await assertFails(updateDoc(doc(db, 'users/cashier'), { role: 'admin' }));
      await assertFails(updateDoc(doc(db, 'users/cashier'), { active: false }));
      await assertFails(updateDoc(doc(db, 'users/cashier'), { permissions: ['payroll.view'] }));
      await assertFails(deleteDoc(doc(db, 'users/cashier')));
    }
  });

  test('self-escalation is impossible: role, permissions, temporary access, status, staff link', async () => {
    const db = as('worker');
    const me = doc(db, 'users/worker');
    await assertFails(updateDoc(me, { role: 'admin' }));
    await assertFails(updateDoc(me, { permissions: ['users.view'] }));
    await assertFails(updateDoc(me, { deniedPermissions: [] }));
    await assertFails(updateDoc(me, { 'temporaryPermissions.users.view': { startsAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + H) } }));
    await assertFails(updateDoc(me, { staffId: 'RMX-STF-0002' }));
    await assertFails(updateDoc(me, { fullName: 'New Name' }));
    await assertFails(updateDoc(doc(as('inactiveAdmin'), 'users/inactiveAdmin'), { active: true }));
    await assertFails(updateDoc(doc(as('manager'), 'users/manager'), { role: 'admin', lastLoginAt: serverTimestamp() }));
  });

  test('session bookkeeping on one\'s own profile is allowed', async () => {
    await assertSucceeds(updateDoc(doc(as('worker'), 'users/worker'), {
      lastLoginAt: serverTimestamp(), updatedAt: serverTimestamp(), fcmTokens: ['t1'],
    }));
    await assertFails(updateDoc(doc(as('worker'), 'users/cashier'), { lastLoginAt: serverTimestamp() }));
  });

  test('credential state cannot be written by any client', async () => {
    await assertFails(updateDoc(doc(as('pendingAdmin'), 'users/pendingAdmin'), { mustChangePassword: false }));
    await assertFails(updateDoc(doc(as('worker'), 'users/worker'), { passwordSet: false }));
    await assertFails(updateDoc(doc(as('admin'), 'users/worker'), { mustChangePassword: true }));
    await assertFails(updateDoc(doc(as('worker'), 'users/worker'), { password: 'Secret!123a' }));
    await assertFails(updateDoc(doc(as('worker'), 'users/worker'), { phoneVerified: true }));
  });

  test('a pending temporary-password change blocks all data access except one\'s own profile', async () => {
    await assertSucceeds(getDoc(doc(as('pendingAdmin'), 'users/pendingAdmin')));
    await assertSucceeds(updateDoc(doc(as('pendingAdmin'), 'users/pendingAdmin'), { lastLoginAt: serverTimestamp() }));
    await assertFails(listUsers('pendingAdmin'));
    await assertFails(getDoc(doc(as('pendingAdmin'), 'audit_logs/a1')));
    await assertFails(getDoc(doc(as('pendingAdmin'), 'settings/general')));
    await assertFails(addDoc(collection(as('pendingAdmin'), 'audit_logs'),
      { userId: 'pendingAdmin', userRole: 'admin', action: 'x.y', module: 'auth', timestamp: serverTimestamp() }));
  });

  test('sign-in throttling data is server-only', async () => {
    await assertFails(getDoc(doc(as('admin'), 'login_throttle/abc')));
    await assertFails(setDoc(doc(as('worker'), 'login_throttle/abc'), { failures: 0 }));
  });
});

describe('temporary grant records, staff and counters', () => {
  test('temporary grant history: own records or users.view; never writable', async () => {
    await assertSucceeds(getDoc(doc(as('worker'), 'users/worker/temporary_grants/g1')));
    await assertSucceeds(getDoc(doc(as('manager'), 'users/worker/temporary_grants/g1')));
    await assertFails(getDoc(doc(as('cashier'), 'users/worker/temporary_grants/g1')));
    await assertFails(setDoc(doc(as('worker'), 'users/worker/temporary_grants/g9'), { permission: 'payroll.view', status: 'active' }));
    await assertFails(updateDoc(doc(as('admin'), 'users/worker/temporary_grants/g1'), { status: 'revoked' }));
  });

  test('staff records: staff.view holders, or the linked person for their own record; never writable', async () => {
    for (const uid of ['admin', 'manager', 'auditor']) await assertSucceeds(getDoc(doc(as(uid), 'staff/RMX-STF-0002')));
    await assertSucceeds(getDoc(doc(as('worker'), 'staff/RMX-STF-0001')));
    await assertFails(getDoc(doc(as('worker'), 'staff/RMX-STF-0002')));
    await assertFails(getDoc(doc(as('shareholder'), 'staff/RMX-STF-0002')));
    await assertFails(getDocs(collection(as('worker'), 'staff')));
    await assertFails(setDoc(doc(as('admin'), 'staff/RMX-STF-0003'), { staffId: 'RMX-STF-0003' }));
    await assertFails(updateDoc(doc(as('admin'), 'staff/RMX-STF-0001'), { linkedUid: 'cashier' }));
  });

  test('counters are server-only', async () => {
    await assertFails(getDoc(doc(as('admin'), 'counters/staff')));
    await assertFails(setDoc(doc(as('admin'), 'counters/staff'), { next: 1 }));
  });
});

describe('audit logs', () => {
  test('admin and auditor read; manager, cashier, worker and shareholder cannot', async () => {
    for (const uid of ['admin', 'auditor']) await assertSucceeds(getDoc(doc(as(uid), 'audit_logs/a1')));
    for (const uid of ['manager', 'cashier', 'worker', 'shareholder']) await assertFails(getDoc(doc(as(uid), 'audit_logs/a1')));
    await assertSucceeds(getDocs(query(collection(as('auditor'), 'audit_logs'), where('recordId', '==', 'worker'))));
  });

  test('append-only for everyone, and entries cannot be forged', async () => {
    await assertFails(updateDoc(doc(as('admin'), 'audit_logs/a1'), { action: 'nothing.happened' }));
    await assertFails(deleteDoc(doc(as('admin'), 'audit_logs/a1')));
    const base = { action: 'session.sign_in', module: 'auth', timestamp: serverTimestamp() };
    await assertSucceeds(addDoc(collection(as('worker'), 'audit_logs'), { ...base, userId: 'worker', userRole: 'worker' }));
    await assertFails(addDoc(collection(as('worker'), 'audit_logs'), { ...base, userId: 'admin', userRole: 'admin' }));
    await assertFails(addDoc(collection(as('worker'), 'audit_logs'), { ...base, userId: 'worker', userRole: 'admin' }));
    await assertFails(addDoc(collection(as('inactiveAdmin'), 'audit_logs'), { ...base, userId: 'inactiveAdmin', userRole: 'admin' }));
  });
});

describe('customers, vehicles, services and service intakes (Phase 3)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'customers/c1'), { customerId: 'c1', fullName: 'John Doe', phoneNumber: '+256772123456', status: 'active' });
      await setDoc(doc(db, 'vehicles/v1'), { vehicleId: 'v1', numberPlate: 'UGB 123A', normalizedNumberPlate: 'UGB123A', customerId: 'c1', customerName: 'John Doe', status: 'active' });
      await setDoc(doc(db, 'services/s1'), { serviceId: 's1', name: 'Full Wash', priceUgx: 15000, isActive: true });
      await setDoc(doc(db, 'service_intakes/i1'), { intakeId: 'i1', vehicleId: 'v1', status: 'open' });
      await setDoc(doc(db, 'unique_keys/plate_UGB123A'), { vehicleId: 'v1' });
    });
  });

  const read = (uid, path) => getDoc(doc(as(uid), path));
  const canRead = {
    'customers/c1': ['admin', 'manager', 'cashier', 'auditor'],
    'vehicles/v1': ['admin', 'manager', 'cashier', 'worker', 'auditor'],
    'services/s1': ['admin', 'manager', 'cashier', 'worker', 'auditor'],
    'service_intakes/i1': ['admin', 'manager', 'cashier', 'auditor'],
  };

  for (const [path, allowed] of Object.entries(canRead)) {
    test(`read ${path.split('/')[0]}: ${allowed.join(', ')} only`, async () => {
      for (const uid of ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder', 'inactiveAdmin', 'pendingAdmin']) {
        if (allowed.includes(uid)) await assertSucceeds(read(uid, path));
        else await assertFails(read(uid, path));
      }
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
    });
  }

  test('plate search query is allowed for vehicles.view holders', async () => {
    const q = (uid) => getDocs(query(collection(as(uid), 'vehicles'), where('normalizedNumberPlate', '>=', 'UGB'), where('normalizedNumberPlate', '<', 'UGB')));
    await assertSucceeds(q('worker'));
    await assertSucceeds(q('cashier'));
    await assertFails(q('shareholder'));
  });

  test('no client - admin included - may write any of them; prices only change server-side', async () => {
    for (const uid of ['admin', 'manager', 'cashier', 'worker']) {
      const db = as(uid);
      await assertFails(setDoc(doc(db, 'customers/c2'), { fullName: 'X' }));
      await assertFails(updateDoc(doc(db, 'customers/c1'), { fullName: 'Changed' }));
      await assertFails(setDoc(doc(db, 'vehicles/v2'), { numberPlate: 'UGB 123A' }));
      await assertFails(updateDoc(doc(db, 'vehicles/v1'), { status: 'inactive' }));
      await assertFails(deleteDoc(doc(db, 'vehicles/v1')));
      await assertFails(updateDoc(doc(db, 'services/s1'), { priceUgx: 1 }));
      await assertFails(setDoc(doc(db, 'services/s2'), { name: 'Free Wash', priceUgx: 0 }));
      await assertFails(setDoc(doc(db, 'service_intakes/i2'), { vehicleId: 'v1', status: 'open' }));
      await assertFails(updateDoc(doc(db, 'service_intakes/i1'), { status: 'cancelled' }));
    }
  });

  test('uniqueness reservations are server-only', async () => {
    await assertFails(getDoc(doc(as('admin'), 'unique_keys/plate_UGB123A')));
    await assertFails(deleteDoc(doc(as('admin'), 'unique_keys/plate_UGB123A')));
    await assertFails(setDoc(doc(as('cashier'), 'unique_keys/plate_UAX456B'), { vehicleId: 'x' }));
  });

  test('a worker granted customers.view (explicitly) can read customers', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/worker'), { permissions: ['customers.view'] }));
    await assertSucceeds(read('worker', 'customers/c1'));
  });
});

describe('worker orders, billing and loyalty (Phase 4)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'worker_orders/mine'), { workerOrderId: 'mine', workerId: 'worker', status: 'assigned', numberPlate: 'UGB 123A' });
      await setDoc(doc(db, 'worker_orders/theirs'), { workerOrderId: 'theirs', workerId: 'someoneElse', status: 'assigned' });
      await setDoc(doc(db, 'invoices/inv1'), { invoiceId: 'inv1', totalUgx: 15000, paidUgx: 0, outstandingUgx: 15000, paymentStatus: 'unpaid' });
      await setDoc(doc(db, 'discounts/d1'), { discountId: 'd1', invoiceId: 'inv1', discountAmount: 1000 });
      await setDoc(doc(db, 'payments/p1'), { paymentId: 'p1', invoiceId: 'inv1', amountUgx: 5000, status: 'completed' });
      await setDoc(doc(db, 'receipts/r1'), { receiptId: 'r1', paymentId: 'p1', receiptNumber: 'RMX-RCP-000001' });
      await setDoc(doc(db, 'loyalty_accounts/v1'), { vehicleId: 'v1', pointsBalance: 40 });
      await setDoc(doc(db, 'loyalty_transactions/t1'), { vehicleId: 'v1', type: 'earned', points: 40 });
      await setDoc(doc(db, 'loyalty_rewards/rw1'), { vehicleId: 'v1', status: 'available' });
      await setDoc(doc(db, 'loyalty_events/e1'), { vehicleId: 'v1', type: 'reward_unlocked' });
      await setDoc(doc(db, 'settings/loyalty'), { pointsPerQualifyingService: 20 });
    });
  });

  const read = (uid, path) => getDoc(doc(as(uid), path));
  const ALL = ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder', 'inactiveAdmin', 'pendingAdmin', 'expiredAdmin'];
  const STAFF_READERS = ['admin', 'manager', 'cashier', 'auditor'];
  const canRead = {
    'worker_orders/theirs': STAFF_READERS,
    'worker_orders/mine': [...STAFF_READERS, 'worker'],
    'invoices/inv1': STAFF_READERS,
    'discounts/d1': STAFF_READERS,
    'payments/p1': STAFF_READERS,
    'receipts/r1': STAFF_READERS,
    'loyalty_accounts/v1': STAFF_READERS,
    'loyalty_transactions/t1': STAFF_READERS,
    'loyalty_rewards/rw1': STAFF_READERS,
    'loyalty_events/e1': STAFF_READERS,
  };

  for (const [path, allowed] of Object.entries(canRead)) {
    test(`read ${path}: ${allowed.join(', ')} only; never unauthenticated`, async () => {
      for (const uid of ALL) {
        if (allowed.includes(uid)) await assertSucceeds(read(uid, path));
        else await assertFails(read(uid, path));
      }
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
    });
  }

  test('a worker lists only their own orders (the query must filter on their uid)', async () => {
    const orders = (uid, ...filters) => getDocs(query(collection(as(uid), 'worker_orders'), ...filters));
    const mine = await assertSucceeds(orders('worker', where('workerId', '==', 'worker')));
    assert.deepEqual(mine.docs.map((d) => d.id), ['mine']);
    await assertFails(orders('worker'));
    await assertFails(orders('worker', where('workerId', '==', 'someoneElse')));
    await assertFails(orders('worker', where('status', '==', 'assigned')));
    await assertSucceeds(orders('manager'));
    await assertFails(orders('shareholder', where('workerId', '==', 'shareholder')));
  });

  test('a worker with jobs.view.own denied sees nothing', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/worker'), { deniedPermissions: ['jobs.view.own'] }));
    await assertFails(read('worker', 'worker_orders/mine'));
  });

  test('no client - admin included - may write orders, invoices, payments, receipts, discounts or loyalty', async () => {
    for (const uid of ['admin', 'manager', 'cashier', 'worker', 'auditor']) {
      const db = as(uid);
      // Status changes by the assigned worker still go through the server.
      await assertFails(updateDoc(doc(db, 'worker_orders/mine'), { status: 'completed' }));
      await assertFails(setDoc(doc(db, 'worker_orders/new'), { workerId: uid, status: 'assigned' }));
      await assertFails(deleteDoc(doc(db, 'worker_orders/theirs')));
      // Totals, balances and numbers.
      await assertFails(updateDoc(doc(db, 'invoices/inv1'), { outstandingUgx: 0, paymentStatus: 'paid' }));
      await assertFails(setDoc(doc(db, 'invoices/inv2'), { invoiceNumber: 'RMX-INV-000099', totalUgx: 1 }));
      await assertFails(deleteDoc(doc(db, 'invoices/inv1')));
      await assertFails(setDoc(doc(db, 'discounts/d2'), { invoiceId: 'inv1', discountAmount: 15000 }));
      await assertFails(setDoc(doc(db, 'payments/p2'), { invoiceId: 'inv1', amountUgx: 15000 }));
      await assertFails(updateDoc(doc(db, 'payments/p1'), { status: 'reversed' }));
      await assertFails(deleteDoc(doc(db, 'payments/p1')));
      await assertFails(setDoc(doc(db, 'receipts/r2'), { receiptNumber: 'RMX-RCP-000002' }));
      await assertFails(deleteDoc(doc(db, 'receipts/r1')));
      // Points and rewards.
      await assertFails(updateDoc(doc(db, 'loyalty_accounts/v1'), { pointsBalance: 9999 }));
      await assertFails(setDoc(doc(db, 'loyalty_accounts/v2'), { pointsBalance: 200 }));
      await assertFails(addDoc(collection(db, 'loyalty_transactions'), { vehicleId: 'v1', type: 'earned', points: 200 }));
      await assertFails(deleteDoc(doc(db, 'loyalty_transactions/t1')));
      await assertFails(updateDoc(doc(db, 'loyalty_rewards/rw1'), { status: 'redeemed' }));
      await assertFails(setDoc(doc(db, 'loyalty_rewards/rw2'), { vehicleId: 'v1', status: 'available' }));
      await assertFails(setDoc(doc(db, 'loyalty_events/e2'), { type: 'reward_unlocked' }));
      await assertFails(setDoc(doc(db, 'settings/loyalty'), { rewardThreshold: 1 }));
      await assertFails(setDoc(doc(db, 'counters/invoices'), { next: 1 }));
    }
  });

  test('unauthenticated clients can neither read nor write any of it', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const c of ['worker_orders', 'invoices', 'discounts', 'payments', 'receipts', 'loyalty_accounts', 'loyalty_transactions', 'loyalty_rewards', 'loyalty_events']) {
      await assertFails(getDocs(collection(anon, c)));
      await assertFails(setDoc(doc(anon, `${c}/x`), { any: 1 }));
    }
    await assertFails(getDoc(doc(anon, 'settings/loyalty')));
  });

  test('loyalty rules are readable by active staff (for previews), never by disabled accounts', async () => {
    await assertSucceeds(read('cashier', 'settings/loyalty'));
    await assertSucceeds(read('worker', 'settings/loyalty'));
    await assertFails(read('inactiveAdmin', 'settings/loyalty'));
  });
});

describe('finance, expenses and inventory (Phase 5)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'financial_accounts/cash_at_hand'), { accountId: 'cash_at_hand', type: 'cash', balanceUgx: 50000, awaitingBankingUgx: 50000 });
      await setDoc(doc(db, 'finance_daily_summaries/2026-09-21'), { day: '2026-09-21', customerPaymentsUgx: 50000 });
      await setDoc(doc(db, 'financial_transactions/t1'), { transactionNumber: 'RMX-TXN-000001', type: 'customer_payment', amountUgx: 50000, status: 'posted' });
      await setDoc(doc(db, 'bank_deposits/d1'), { depositNumber: 'RMX-BNK-000001', amountUgx: 1000, status: 'completed' });
      await setDoc(doc(db, 'reconciliations/r1'), { accountId: 'cash_at_hand', differenceUgx: 0, status: 'balanced' });
      await setDoc(doc(db, 'expenses/e1'), { expenseNumber: 'RMX-EXP-000001', amountUgx: 150000, status: 'approved' });
      await setDoc(doc(db, 'expense_categories/utilities'), { name: 'Utilities', active: true });
      await setDoc(doc(db, 'recurring_expenses/re1'), { name: 'Rent', active: true });
      await setDoc(doc(db, 'inventory_items/i1'), { name: 'Car Shampoo', quantity: 24, stockStatus: 'ok' });
      await setDoc(doc(db, 'suppliers/s1'), { name: 'Kampala Auto Supplies', active: true });
      await setDoc(doc(db, 'stock_movements/m1'), { itemId: 'i1', type: 'stock_in', quantityChange: 24, status: 'posted' });
      await setDoc(doc(db, 'inventory_purchases/p1'), { purchaseNumber: 'RMX-PUR-000001', totalUgx: 150000, status: 'approved' });
      await setDoc(doc(db, 'settings/payment_accounts'), { banks: [{ accountId: 'bank_1', name: 'Bank Account 1' }] });
    });
  });

  const read = (uid, path) => getDoc(doc(as(uid), path));
  const ALL = ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder', 'inactiveAdmin', 'pendingAdmin', 'expiredAdmin'];
  const canRead = {
    // Balances: not cashiers or workers.
    'financial_accounts/cash_at_hand': ['admin', 'manager', 'auditor', 'shareholder'],
    'finance_daily_summaries/2026-09-21': ['admin', 'manager', 'auditor', 'shareholder'],
    // The ledger itself: finance.transactions.view.
    'financial_transactions/t1': ['admin', 'manager', 'auditor'],
    'bank_deposits/d1': ['admin', 'manager', 'auditor'],
    'reconciliations/r1': ['admin', 'manager', 'auditor'],
    'expenses/e1': ['admin', 'manager', 'cashier', 'auditor'],
    'expense_categories/utilities': ['admin', 'manager', 'cashier', 'auditor'],
    'recurring_expenses/re1': ['admin', 'manager', 'cashier', 'auditor'],
    'inventory_items/i1': ['admin', 'manager', 'auditor'],
    'suppliers/s1': ['admin', 'manager', 'auditor'],
    'stock_movements/m1': ['admin', 'manager', 'auditor'],
    'inventory_purchases/p1': ['admin', 'manager', 'auditor'],
    // The cashier's bank list (no balances) is ordinary reference data.
    'settings/payment_accounts': ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder'],
  };

  for (const [path, allowed] of Object.entries(canRead)) {
    test(`read ${path}: ${allowed.join(', ')} only; never unauthenticated`, async () => {
      for (const uid of ALL) {
        if (allowed.includes(uid)) await assertSucceeds(read(uid, path));
        else await assertFails(read(uid, path));
      }
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
    });
  }

  test('no client - admin included - may write balances, ledger, expense status, stock or movements', async () => {
    for (const uid of ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder']) {
      const db = as(uid);
      await assertFails(updateDoc(doc(db, 'financial_accounts/cash_at_hand'), { balanceUgx: 99_999_999 }));
      await assertFails(updateDoc(doc(db, 'financial_accounts/cash_at_hand'), { awaitingBankingUgx: 0 }));
      await assertFails(setDoc(doc(db, 'financial_accounts/mine'), { type: 'bank', balanceUgx: 1_000_000 }));
      await assertFails(deleteDoc(doc(db, 'financial_accounts/cash_at_hand')));
      await assertFails(setDoc(doc(db, 'finance_daily_summaries/2026-09-21'), { customerPaymentsUgx: 1 }));
      await assertFails(addDoc(collection(db, 'financial_transactions'), { type: 'adjustment', amountUgx: 1_000_000 }));
      await assertFails(updateDoc(doc(db, 'financial_transactions/t1'), { status: 'reversed' }));
      await assertFails(deleteDoc(doc(db, 'financial_transactions/t1')));
      await assertFails(setDoc(doc(db, 'bank_deposits/d2'), { amountUgx: 1 }));
      await assertFails(updateDoc(doc(db, 'reconciliations/r1'), { differenceUgx: 0, status: 'adjusted' }));
      await assertFails(updateDoc(doc(db, 'expenses/e1'), { status: 'paid' }));
      await assertFails(setDoc(doc(db, 'expenses/e2'), { amountUgx: 1, status: 'approved' }));
      await assertFails(deleteDoc(doc(db, 'expenses/e1')));
      await assertFails(setDoc(doc(db, 'expense_categories/bribes'), { name: 'Bribes', active: true }));
      await assertFails(updateDoc(doc(db, 'recurring_expenses/re1'), { active: false }));
      await assertFails(updateDoc(doc(db, 'inventory_items/i1'), { quantity: 1000 }));
      await assertFails(deleteDoc(doc(db, 'inventory_items/i1')));
      await assertFails(addDoc(collection(db, 'stock_movements'), { itemId: 'i1', quantityChange: 10 }));
      await assertFails(deleteDoc(doc(db, 'stock_movements/m1')));
      await assertFails(updateDoc(doc(db, 'suppliers/s1'), { name: 'Changed' }));
      await assertFails(updateDoc(doc(db, 'inventory_purchases/p1'), { status: 'received' }));
      await assertFails(setDoc(doc(db, 'settings/payment_accounts'), { banks: [] }));
      await assertFails(setDoc(doc(db, 'counters/financial_transactions'), { next: 1 }));
    }
  });

  test('ledger queries work for finance.transactions.view holders only', async () => {
    const q = (uid) => getDocs(query(collection(as(uid), 'financial_transactions'), where('type', '==', 'customer_payment')));
    await assertSucceeds(q('auditor'));
    await assertSucceeds(q('manager'));
    await assertFails(q('cashier'));
    await assertFails(q('shareholder'));
  });

  test('a denied permission removes finance access even from a manager', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/manager'), { deniedPermissions: ['finance.view', 'inventory.view'] }));
    await assertFails(read('manager', 'financial_accounts/cash_at_hand'));
    await assertFails(read('manager', 'inventory_items/i1'));
    await assertSucceeds(read('manager', 'expenses/e1'));
  });

  test('unauthenticated clients can neither read nor write any of it', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const c of ['financial_accounts', 'finance_daily_summaries', 'financial_transactions', 'bank_deposits', 'reconciliations',
      'expenses', 'expense_categories', 'recurring_expenses', 'inventory_items', 'suppliers', 'stock_movements', 'inventory_purchases']) {
      await assertFails(getDocs(collection(anon, c)));
      await assertFails(setDoc(doc(anon, `${c}/x`), { any: 1 }));
    }
  });
});

describe('attendance, allowances, salary, payroll and losses (Phase 6)', () => {
  // `worker` and `tempWorker` are two different workers.
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const put = (path, data) => setDoc(doc(db, path), data);
      await put('attendance/worker_2026-09-21', { staffUid: 'worker', status: 'pending_verification', verificationStatus: 'pending' });
      await put('attendance/tempWorker_2026-09-21', { staffUid: 'tempWorker', status: 'present' });
      await put('attendance_corrections/c1', { staffUid: 'worker', attendanceId: 'worker_2026-09-21', reason: 'Queue at the gate' });
      await put('worker_allowances/a1', { staffUid: 'worker', status: 'calculated', calculatedAmountUgx: 5000 });
      await put('worker_allowances/a2', { staffUid: 'tempWorker', status: 'approved', approvedAmountUgx: 5000 });
      await put('salary_profiles/worker', { staffUid: 'worker', basicSalaryUgx: 600000 });
      await put('salary_profiles/tempWorker', { staffUid: 'tempWorker', basicSalaryUgx: 450000 });
      await put('salary_history/worker_v1', { staffUid: 'worker', basicSalaryUgx: 600000, version: 1 });
      await put('payroll/p1', { payrollNumber: 'RMX-PAY-000001', status: 'paid', totalNetUgx: 1050000 });
      await put('payroll_items/i1', { payrollId: 'p1', staffUid: 'worker', visibleToStaff: true, netUgx: 650000 });
      await put('payroll_items/i2', { payrollId: 'p2', staffUid: 'worker', visibleToStaff: false, netUgx: 600000 });
      await put('payroll_items/i3', { payrollId: 'p1', staffUid: 'tempWorker', visibleToStaff: true, netUgx: 400000 });
      await put('salary_deductions/d1', { staffUid: 'worker', type: 'loss_recovery', remainingUgx: 100000 });
      await put('salary_deductions/d2', { staffUid: 'tempWorker', type: 'authorized_deduction', remainingUgx: 20000 });
      await put('loss_incidents/l1', { staffUid: 'worker', status: 'approved', visibleToStaff: true, outstandingUgx: 150000 });
      await put('loss_incidents/l2', { staffUid: 'worker', status: 'reported', visibleToStaff: false });
      await put('loss_incidents/l3', { staffUid: 'tempWorker', status: 'approved', visibleToStaff: true });
      await put('settings/payroll_policy', { reportingTime: '08:00', gracePeriodMinutes: 15, defaultDailyAllowanceUgx: 5000 });
    });
  });

  const read = (uid, path) => getDoc(doc(as(uid), path));
  const ALL = ['admin', 'manager', 'cashier', 'worker', 'tempWorker', 'auditor', 'shareholder', 'inactiveAdmin', 'pendingAdmin', 'expiredAdmin'];
  const canRead = {
    'attendance/worker_2026-09-21': ['admin', 'manager', 'auditor', 'worker'],
    'attendance/tempWorker_2026-09-21': ['admin', 'manager', 'auditor', 'tempWorker'],
    'attendance_corrections/c1': ['admin', 'manager', 'auditor', 'worker'],
    'worker_allowances/a1': ['admin', 'manager', 'auditor', 'worker'],
    'worker_allowances/a2': ['admin', 'manager', 'auditor', 'tempWorker'],
    // Salaries: salary.view (manager, auditor), or your own. Never cashiers or shareholders.
    'salary_profiles/worker': ['admin', 'manager', 'auditor', 'worker'],
    'salary_profiles/tempWorker': ['admin', 'manager', 'auditor', 'tempWorker'],
    'salary_history/worker_v1': ['admin', 'auditor', 'worker'],
    // Payroll totals: payroll.view only by default.
    'payroll/p1': ['admin', 'manager', 'auditor'],
    // Payslips: payroll.view, or your own once paid.
    'payroll_items/i1': ['admin', 'manager', 'auditor', 'worker'],
    'payroll_items/i2': ['admin', 'manager', 'auditor'],
    'payroll_items/i3': ['admin', 'manager', 'auditor', 'tempWorker'],
    'salary_deductions/d1': ['admin', 'manager', 'auditor', 'worker'],
    'salary_deductions/d2': ['admin', 'manager', 'auditor', 'tempWorker'],
    'loss_incidents/l1': ['admin', 'manager', 'auditor', 'worker'],
    'loss_incidents/l2': ['admin', 'manager', 'auditor'],
    'settings/payroll_policy': ['admin', 'manager', 'cashier', 'worker', 'tempWorker', 'auditor', 'shareholder'],
  };

  for (const [path, allowed] of Object.entries(canRead)) {
    test(`read ${path}: ${allowed.join(', ')} only; never unauthenticated`, async () => {
      for (const uid of ALL) {
        if (allowed.includes(uid)) await assertSucceeds(read(uid, path));
        else await assertFails(read(uid, path));
      }
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
    });
  }

  test('a worker can only query their own records; another worker\'s salary or payroll cannot be queried', async () => {
    const db = as('worker');
    const mine = (c, ...extra) => getDocs(query(collection(db, c), where('staffUid', '==', 'worker'), ...extra));
    await assertSucceeds(mine('attendance'));
    await assertSucceeds(mine('worker_allowances'));
    await assertSucceeds(mine('salary_profiles'));
    await assertSucceeds(mine('salary_deductions'));
    await assertSucceeds(mine('payroll_items', where('visibleToStaff', '==', true)));
    await assertSucceeds(mine('loss_incidents', where('visibleToStaff', '==', true)));
    await assertFails(mine('payroll_items'));
    await assertFails(mine('loss_incidents'));
    for (const c of ['attendance', 'worker_allowances', 'salary_profiles', 'salary_history', 'payroll_items', 'salary_deductions', 'payroll']) {
      await assertFails(getDocs(collection(db, c)));
      await assertFails(getDocs(query(collection(db, c), where('staffUid', '==', 'tempWorker'))));
    }
  });

  test('no client - admin included - may write attendance approval, allowances, salaries, payroll totals, deductions or recoveries', async () => {
    for (const uid of ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder']) {
      const db = as(uid);
      await assertFails(updateDoc(doc(db, 'attendance/worker_2026-09-21'), { status: 'present', verificationStatus: 'approved' }));
      await assertFails(setDoc(doc(db, `attendance/${uid}_2026-09-22`), { staffUid: uid, status: 'present' }));
      await assertFails(deleteDoc(doc(db, 'attendance/worker_2026-09-21')));
      await assertFails(addDoc(collection(db, 'attendance_corrections'), { staffUid: 'worker', reason: 'forged' }));
      await assertFails(updateDoc(doc(db, 'worker_allowances/a1'), { status: 'approved', approvedAmountUgx: 50000 }));
      await assertFails(addDoc(collection(db, 'worker_allowances'), { staffUid: uid, approvedAmountUgx: 5000, status: 'approved' }));
      await assertFails(updateDoc(doc(db, 'salary_profiles/worker'), { basicSalaryUgx: 9_000_000 }));
      await assertFails(setDoc(doc(db, `salary_profiles/${uid}`), { staffUid: uid, basicSalaryUgx: 9_000_000 }));
      await assertFails(addDoc(collection(db, 'salary_history'), { staffUid: uid, basicSalaryUgx: 9_000_000 }));
      await assertFails(updateDoc(doc(db, 'payroll/p1'), { totalNetUgx: 1, status: 'approved' }));
      await assertFails(updateDoc(doc(db, 'payroll_items/i1'), { netUgx: 5_000_000, totalDeductionsUgx: 0 }));
      await assertFails(deleteDoc(doc(db, 'payroll_items/i1')));
      await assertFails(updateDoc(doc(db, 'salary_deductions/d1'), { remainingUgx: 0, status: 'completed' }));
      await assertFails(updateDoc(doc(db, 'loss_incidents/l1'), { outstandingUgx: 0, status: 'recovered' }));
      await assertFails(setDoc(doc(db, 'settings/payroll_policy'), { defaultDailyAllowanceUgx: 50000 }));
      await assertFails(setDoc(doc(db, 'counters/payroll'), { next: 1 }));
    }
  });

  test('a denied permission removes payroll and salary access even from a manager', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/manager'), { deniedPermissions: ['payroll.view', 'salary.view'] }));
    await assertFails(read('manager', 'payroll/p1'));
    await assertFails(read('manager', 'payroll_items/i1'));
    await assertFails(read('manager', 'salary_profiles/worker'));
    await assertSucceeds(read('manager', 'attendance/worker_2026-09-21'));
  });

  test('reports.payroll.view gives management-level payroll totals, never individual pay', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/shareholder'), { permissions: ['reports.payroll.view'] }));
    await assertSucceeds(read('shareholder', 'payroll/p1'));
    await assertFails(read('shareholder', 'payroll_items/i1'));
    await assertFails(read('shareholder', 'salary_profiles/worker'));
  });

  test('the legacy staff.salary.view permission reads salary profiles (not history)', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/cashier'), { permissions: ['staff.salary.view'] }));
    await assertSucceeds(read('cashier', 'salary_profiles/worker'));
    await assertFails(read('cashier', 'salary_history/worker_v1'));
  });

  test('unauthenticated clients can neither read nor write any of it', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const c of ['attendance', 'attendance_corrections', 'worker_allowances', 'salary_profiles', 'salary_history', 'payroll',
      'payroll_items', 'salary_deductions', 'loss_incidents']) {
      await assertFails(getDocs(collection(anon, c)));
      await assertFails(setDoc(doc(anon, `${c}/x`), { any: 1 }));
    }
    await assertFails(getDoc(doc(anon, 'settings/payroll_policy')));
  });
});

describe('shareholders, shares and dividends (Phase 7)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const put = (path, data) => setDoc(doc(db, path), data);
      await put('shareholders/s1', { shareholderNumber: 'RMX-SHR-000001', fullName: 'John Okello', phoneNumber: '+256772100001', linkedUid: 'shareholder', totalShares: 100 });
      await put('shareholders/s2', { shareholderNumber: 'RMX-SHR-000002', fullName: 'Mary Nakato', totalShares: 50 });
      await put('share_classes/ordinary', { code: 'ORDINARY', valuePerShareUgx: 10000, issuedShares: 150 });
      await put('shareholdings/s1_ordinary', { shareholderId: 's1', classId: 'ordinary', shares: 100 });
      await put('share_transactions/t1', { transactionNumber: 'RMX-SHR-TXN-000001', type: 'shares_issued', shareholderIds: ['s1'], status: 'posted' });
      await put('share_contributions/c1', { contributionNumber: 'RMX-SHR-CON-000001', shareholderId: 's1', amountUgx: 1000000, status: 'posted' });
      await put('share_register/current', { totalShares: 150, holders: [{ shareholderId: 's1', shares: 100 }] });
      await put('dividends/d1', { dividendNumber: 'RMX-DIV-000001', status: 'approved', allocatedUgx: 1500000 });
      await put('dividend_allocations/a1', { allocationNumber: 'RMX-DIV-PAY-000001', dividendId: 'd1', shareholderId: 's1', netUgx: 1000000 });
      await put('settings/share_policy', { requireApproval: true, allowUnpaidShares: false, allowPartialPayment: false });
    });
  });

  const read = (uid, path) => getDoc(doc(as(uid), path));
  const ALL = ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder', 'inactiveAdmin', 'pendingAdmin', 'expiredAdmin'];
  const canRead = {
    // Profiles (contact and identification details): shareholders.view only.
    'shareholders/s1': ['admin', 'auditor'],
    'shareholders/s2': ['admin', 'auditor'],
    'share_classes/ordinary': ['admin', 'manager', 'auditor'],
    'shareholdings/s1_ordinary': ['admin', 'auditor'],
    'share_transactions/t1': ['admin', 'auditor'],
    'share_contributions/c1': ['admin', 'auditor'],
    // Register-level totals and distribution: managers see it through shareholders.reports.view.
    'share_register/current': ['admin', 'manager', 'auditor'],
    'dividends/d1': ['admin', 'manager', 'auditor'],
    'dividend_allocations/a1': ['admin', 'auditor'],
    'settings/share_policy': ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder'],
  };

  for (const [path, allowed] of Object.entries(canRead)) {
    test(`read ${path}: ${allowed.join(', ')} only; never unauthenticated`, async () => {
      for (const uid of ALL) {
        if (allowed.includes(uid)) await assertSucceeds(read(uid, path));
        else await assertFails(read(uid, path));
      }
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
    });
  }

  test('a shareholder cannot read or query any shareholder record directly - not even their own (served by getMyShareholding)', async () => {
    const db = as('shareholder');
    await assertFails(getDoc(doc(db, 'shareholders/s1')));
    await assertFails(getDocs(query(collection(db, 'shareholders'), where('linkedUid', '==', 'shareholder'))));
    await assertFails(getDocs(collection(db, 'shareholders')));
    await assertFails(getDocs(query(collection(db, 'share_transactions'), where('shareholderIds', 'array-contains', 's2'))));
    await assertFails(getDocs(query(collection(db, 'dividend_allocations'), where('shareholderId', '==', 's2'))));
    await assertFails(getDocs(collection(db, 'dividend_allocations')));
  });

  test('workers and cashiers see no shareholder data at all', async () => {
    for (const uid of ['worker', 'cashier']) {
      for (const c of ['shareholders', 'share_classes', 'shareholdings', 'share_transactions', 'share_contributions', 'share_register', 'dividends',
        'dividend_allocations']) {
        await assertFails(getDocs(collection(as(uid), c)));
      }
    }
  });

  test('no client - admin included - may write shareholders, ownership, totals, dividends, allocations or payment status', async () => {
    for (const uid of ['admin', 'manager', 'cashier', 'worker', 'auditor', 'shareholder']) {
      const db = as(uid);
      await assertFails(setDoc(doc(db, `shareholders/${uid}-new`), { fullName: 'Forged', totalShares: 1000 }));
      await assertFails(updateDoc(doc(db, 'shareholders/s1'), { ownershipPercent: 99, totalShares: 9999 }));
      await assertFails(deleteDoc(doc(db, 'shareholders/s2')));
      await assertFails(updateDoc(doc(db, 'share_classes/ordinary'), { valuePerShareUgx: 1 }));
      await assertFails(setDoc(doc(db, 'shareholdings/s2_ordinary'), { shareholderId: 's2', shares: 1000000 }));
      await assertFails(addDoc(collection(db, 'share_transactions'), { type: 'shares_issued', shares: 1000, status: 'posted' }));
      await assertFails(updateDoc(doc(db, 'share_transactions/t1'), { status: 'reversed' }));
      await assertFails(deleteDoc(doc(db, 'share_transactions/t1')));
      await assertFails(addDoc(collection(db, 'share_contributions'), { amountUgx: 1, status: 'posted' }));
      await assertFails(updateDoc(doc(db, 'share_register/current'), { totalShares: 1 }));
      await assertFails(updateDoc(doc(db, 'dividends/d1'), { allocatedUgx: 99_000_000, status: 'paid' }));
      await assertFails(addDoc(collection(db, 'dividend_allocations'), { dividendId: 'd1', shareholderId: 's2', netUgx: 50_000_000 }));
      await assertFails(updateDoc(doc(db, 'dividend_allocations/a1'), { paymentStatus: 'paid', netUgx: 1 }));
      await assertFails(deleteDoc(doc(db, 'dividend_allocations/a1')));
      await assertFails(setDoc(doc(db, 'settings/share_policy'), { requireApproval: false }));
      await assertFails(setDoc(doc(db, 'counters/share_transactions'), { next: 1 }));
    }
  });

  test('granted permissions open exactly their level; a denial removes it', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/cashier'), { permissions: ['dividends.pay', 'dividends.view'] }));
    await assertSucceeds(read('cashier', 'dividend_allocations/a1'));
    await assertFails(read('cashier', 'shareholders/s1'));
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/manager'), { deniedPermissions: ['shareholders.reports.view'] }));
    await assertFails(read('manager', 'share_register/current'));
    await assertFails(read('manager', 'dividends/d1'));
  });

  test('unauthenticated clients can neither read nor write any of it', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const c of ['shareholders', 'share_classes', 'shareholdings', 'share_transactions', 'share_contributions', 'share_register', 'dividends',
      'dividend_allocations']) {
      await assertFails(getDocs(collection(anon, c)));
      await assertFails(setDoc(doc(anon, `${c}/x`), { any: 1 }));
    }
  });
});

describe('after-hours operations and cash handovers (Phase 8)', () => {
  // `worker` and `tempWorker` are two different workers.
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const put = (path, data) => setDoc(doc(db, path), data);
      const H = 3600_000;
      const user = (uid, temporaryPermissions) => put(`users/${uid}`, {
        uid, role: 'worker', active: true, phoneNumber: '+256772000199', fullName: uid, permissions: [], deniedPermissions: [], temporaryPermissions,
      });
      await user('ahLive', { 'invoices.view': { startsAt: Timestamp.fromMillis(Date.now() - H), expiresAt: Timestamp.fromMillis(Date.now() + H), grantId: 'g8' } });
      await user('ahExpired', { 'invoices.view': { startsAt: Timestamp.fromMillis(Date.now() - 3 * H), expiresAt: Timestamp.fromMillis(Date.now() - H), grantId: 'g9' } });
      await put('invoices/inv1', { invoiceNumber: 'RMX-INV-000001', totalUgx: 15000 });
      await put('after_hours_access/a1', { authorizationNumber: 'RMX-AH-000001', staffUid: 'worker', status: 'active' });
      await put('after_hours_access/a2', { authorizationNumber: 'RMX-AH-000002', staffUid: 'tempWorker', status: 'active' });
      await put('after_hours_sessions/s1', { sessionNumber: 'RMX-AHS-000001', staffUid: 'worker', status: 'open', expectedCashUgx: 65000 });
      await put('after_hours_sessions/s2', { sessionNumber: 'RMX-AHS-000002', staffUid: 'tempWorker', status: 'open', expectedCashUgx: 30000 });
      await put('after_hours_cash/c1', { entryNumber: 'RMX-AHC-000001', staffUid: 'worker', sessionId: 's1', cashDeltaUgx: 15000 });
      await put('cash_handovers/h1', { handoverNumber: 'RMX-HO-000001', staffUid: 'worker', status: 'pending', expectedCashUgx: 65000 });
      await put('cash_handovers/h2', { handoverNumber: 'RMX-HO-000002', staffUid: 'tempWorker', status: 'submitted', expectedCashUgx: 30000 });
      await put('cash_discrepancies/d1', { discrepancyNumber: 'RMX-AHD-000001', staffUid: 'worker', status: 'open', differenceUgx: -5000 });
      await put('settings/after_hours_policy', { allowedPaymentMethods: ['cash', 'mtn_merchant', 'airtel_merchant'] });
    });
  });

  const read = (uid, path) => getDoc(doc(as(uid), path));
  const ALL = ['admin', 'manager', 'cashier', 'worker', 'tempWorker', 'auditor', 'shareholder', 'inactiveAdmin', 'pendingAdmin', 'expiredAdmin'];
  const canRead = {
    'after_hours_access/a1': ['admin', 'manager', 'auditor', 'worker'],
    'after_hours_access/a2': ['admin', 'manager', 'auditor', 'tempWorker'],
    'after_hours_sessions/s1': ['admin', 'manager', 'auditor', 'worker'],
    'after_hours_sessions/s2': ['admin', 'manager', 'auditor', 'tempWorker'],
    'after_hours_cash/c1': ['admin', 'manager', 'auditor', 'worker'],
    'cash_handovers/h1': ['admin', 'manager', 'auditor', 'worker'],
    'cash_handovers/h2': ['admin', 'manager', 'auditor', 'tempWorker'],
    'cash_discrepancies/d1': ['admin', 'manager', 'auditor', 'worker'],
    'settings/after_hours_policy': ['admin', 'manager', 'cashier', 'worker', 'tempWorker', 'auditor', 'shareholder'],
  };

  for (const [path, allowed] of Object.entries(canRead)) {
    test(`read ${path}: ${allowed.join(', ')} only; never unauthenticated`, async () => {
      for (const uid of ALL) {
        if (allowed.includes(uid)) await assertSucceeds(read(uid, path));
        else await assertFails(read(uid, path));
      }
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
    });
  }

  test('a worker queries only their own after-hours records, never another worker\'s', async () => {
    const db = as('worker');
    for (const c of ['after_hours_access', 'after_hours_sessions', 'after_hours_cash', 'cash_handovers', 'cash_discrepancies']) {
      await assertSucceeds(getDocs(query(collection(db, c), where('staffUid', '==', 'worker'))));
      await assertFails(getDocs(query(collection(db, c), where('staffUid', '==', 'tempWorker'))));
      await assertFails(getDocs(collection(db, c)));
    }
  });

  test('no client - admin included - may write authorisations, sessions, expected cash, handovers or discrepancy resolutions', async () => {
    for (const uid of ['admin', 'manager', 'cashier', 'worker', 'tempWorker', 'auditor', 'shareholder']) {
      const db = as(uid);
      await assertFails(setDoc(doc(db, `after_hours_access/${uid}-self`), { staffUid: uid, status: 'active' }));
      await assertFails(updateDoc(doc(db, 'after_hours_access/a1'), { status: 'active', expiresAt: Timestamp.fromMillis(Date.now() + 99 * 3600_000) }));
      await assertFails(updateDoc(doc(db, 'after_hours_sessions/s1'), { expectedCashUgx: 0 }));
      await assertFails(updateDoc(doc(db, 'after_hours_sessions/s2'), { status: 'reconciled' }));
      await assertFails(addDoc(collection(db, 'after_hours_sessions'), { staffUid: uid, status: 'open' }));
      await assertFails(deleteDoc(doc(db, 'after_hours_sessions/s1')));
      await assertFails(addDoc(collection(db, 'after_hours_cash'), { staffUid: uid, cashDeltaUgx: -65000 }));
      await assertFails(updateDoc(doc(db, 'cash_handovers/h1'), { status: 'received', actualAmountUgx: 65000, differenceUgx: 0 }));
      await assertFails(updateDoc(doc(db, 'cash_handovers/h1'), { expectedCashUgx: 1 }));
      await assertFails(deleteDoc(doc(db, 'cash_handovers/h2')));
      await assertFails(updateDoc(doc(db, 'cash_discrepancies/d1'), { status: 'waived', resolution: 'forged' }));
      await assertFails(deleteDoc(doc(db, 'cash_discrepancies/d1')));
      await assertFails(setDoc(doc(db, 'settings/after_hours_policy'), { allowedPaymentMethods: ['bank'] }));
      await assertFails(setDoc(doc(db, 'counters/cash_handovers'), { next: 1 }));
    }
  });

  test('a worker cannot grant themselves after-hours (or any) permissions on their own profile', async () => {
    const future = Timestamp.fromMillis(Date.now() + 3600_000);
    await assertFails(updateDoc(doc(as('worker'), 'users/worker'), {
      temporaryPermissions: { 'after_hours.operate': { startsAt: Timestamp.now(), expiresAt: future, grantId: 'x' } },
    }));
    await assertFails(updateDoc(doc(as('worker'), 'users/worker'), { permissions: ['after_hours.cash.collect', 'payments.record'] }));
  });

  test('an expired after-hours grant opens nothing; a live one opens exactly its permission', async () => {
    await assertSucceeds(read('ahLive', 'invoices/inv1'));
    await assertFails(read('ahExpired', 'invoices/inv1'));
    await assertFails(read('ahLive', 'financial_accounts/cash_at_hand'));
    await assertFails(read('ahLive', 'cash_handovers/h1'));
  });

  test('a denied permission removes after-hours visibility even from a manager', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'users/manager'), { deniedPermissions: ['after_hours.view', 'after_hours.approve'] }));
    await assertFails(read('manager', 'after_hours_sessions/s1'));
    await assertSucceeds(read('manager', 'cash_handovers/h1')); // still a handover receiver (cash_handover.approve)
    await assertFails(read('manager', 'after_hours_cash/c1'));
  });

  test('unauthenticated clients can neither read nor write any of it', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const c of ['after_hours_access', 'after_hours_sessions', 'after_hours_cash', 'cash_handovers', 'cash_discrepancies']) {
      await assertFails(getDocs(collection(anon, c)));
      await assertFails(setDoc(doc(anon, `${c}/x`), { any: 1 }));
    }
  });
});

// ===========================================================================
// Phase 9: a modified client against every server-owned collection,
// notifications isolation, forged audit entries, profile field injection.
// ===========================================================================
describe('Phase 9: modified-client hardening', () => {
  const SERVER_OWNED = [
    'staff', 'customers', 'vehicles', 'services', 'service_intakes', 'worker_orders', 'invoices', 'discounts', 'payments', 'receipts',
    'loyalty_accounts', 'loyalty_transactions', 'loyalty_rewards', 'loyalty_events', 'financial_accounts', 'finance_daily_summaries',
    'financial_transactions', 'bank_deposits', 'reconciliations', 'expenses', 'expense_categories', 'recurring_expenses', 'inventory_items',
    'suppliers', 'stock_movements', 'inventory_purchases', 'attendance', 'attendance_corrections', 'worker_allowances', 'salary_profiles',
    'salary_history', 'payroll', 'payroll_items', 'salary_deductions', 'loss_incidents', 'shareholders', 'share_classes', 'shareholdings',
    'share_transactions', 'share_contributions', 'share_register', 'dividends', 'dividend_allocations', 'after_hours_access',
    'after_hours_sessions', 'after_hours_cash', 'cash_handovers', 'cash_discrepancies', 'settings', 'counters', 'unique_keys', 'login_throttle',
  ];

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (const c of SERVER_OWNED) await setDoc(doc(db, `${c}/existing`), { amountUgx: 1000, status: 'posted' });
      await setDoc(doc(db, 'notifications/mine'), { recipientId: 'worker', type: 'job_assigned', title: 'T', body: 'B', read: false, push: { status: 'sent' } });
      await setDoc(doc(db, 'notifications/theirs'), { recipientId: 'cashier', type: 'payroll_paid', title: 'T', body: 'B', read: false });
    });
  });

  test('no role - Administrator included - can create, change or delete any server-owned record', async () => {
    for (const uid of ['admin', 'manager', 'auditor', 'cashier']) {
      const db = as(uid);
      for (const c of SERVER_OWNED) {
        await assertFails(setDoc(doc(db, `${c}/forged`), { amountUgx: 1, status: 'paid' }), `${uid} create ${c}`);
        await assertFails(updateDoc(doc(db, `${c}/existing`), { amountUgx: 999_999_999 }), `${uid} update ${c}`);
        await assertFails(deleteDoc(doc(db, `${c}/existing`)), `${uid} delete ${c}`);
      }
    }
  });

  test('notifications: my own only; I may only mark them read', async () => {
    await assertSucceeds(getDoc(doc(as('worker'), 'notifications/mine')));
    await assertFails(getDoc(doc(as('worker'), 'notifications/theirs')));
    await assertFails(getDocs(collection(as('worker'), 'notifications')), 'a query must filter on recipientId');
    await assertSucceeds(getDocs(query(collection(as('worker'), 'notifications'), where('recipientId', '==', 'worker'))));
    await assertFails(getDocs(query(collection(as('admin'), 'notifications'), where('recipientId', '==', 'worker'))), 'not even an admin reads another inbox');
    await assertSucceeds(updateDoc(doc(as('worker'), 'notifications/mine'), { read: true, readAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as('worker'), 'notifications/mine'), { push: { status: 'failed' } }));
    await assertFails(updateDoc(doc(as('worker'), 'notifications/mine'), { recipientId: 'cashier' }));
    await assertFails(updateDoc(doc(as('worker'), 'notifications/theirs'), { read: true }));
    await assertFails(addDoc(collection(as('worker'), 'notifications'), { recipientId: 'cashier', type: 'x', title: 'Pay me', body: 'now' }));
    await assertFails(deleteDoc(doc(as('worker'), 'notifications/mine')));
  });

  test('audit entries: a client cannot pose as the server or inject fields', async () => {
    const base = { userId: 'worker', userRole: 'worker', action: 'session.sign_in', module: 'auth', timestamp: serverTimestamp() };
    await assertSucceeds(addDoc(collection(as('worker'), 'audit_logs'), { ...base, recordId: null, description: null }));
    await assertFails(addDoc(collection(as('worker'), 'audit_logs'), { ...base, source: 'cloud_function' }));
    await assertFails(addDoc(collection(as('worker'), 'audit_logs'), { ...base, reason: 'Approved by the Administrator' }));
    await assertFails(addDoc(collection(as('worker'), 'audit_logs'), { ...base, targetUserId: 'admin' }));
  });

  test('own profile: session fields only - no preferences, role, permissions or credential flags', async () => {
    const me = doc(as('worker'), 'users/worker');
    await assertSucceeds(updateDoc(me, { fcmTokens: ['token-1'], updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(me, { notificationPreferences: { access: false } }), 'preferences go through the server');
    await assertFails(updateDoc(me, { role: 'admin' }));
    await assertFails(updateDoc(me, { active: true, deniedPermissions: [] }));
    await assertFails(updateDoc(me, { mustChangePassword: false }));
    await assertFails(updateDoc(doc(as('worker'), 'users/cashier'), { fcmTokens: ['stolen'] }), 'another person\'s tokens');
  });

  test('signed-out clients read nothing anywhere', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const c of [...SERVER_OWNED, 'users', 'notifications', 'audit_logs']) await assertFails(getDocs(collection(anon, c)), c);
  });
});

