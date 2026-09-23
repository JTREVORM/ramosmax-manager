// Shared set-up for the Phase 4 emulator tests (jobs, billing, loyalty).
// Not a test file itself: `npm run test:emulated` runs only test/*.test.js.
import assert from 'node:assert/strict';

import { getApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import * as billing from '../src/billing.js';
import * as jobs from '../src/jobs.js';
import * as ops from '../src/operations.js';

export const PROJECT = 'demo-ramosmax';

export function emulatorDb(appName) {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run through `npm test` so the Firebase emulators are started.');
  initializeApp({ projectId: PROJECT }, appName);
  return getFirestore(getApp(appName));
}

/** Staff used by the tests: uid → role (+ extra fields). */
export const STAFF = [
  ['admin', 'admin'], ['mgr', 'manager'], ['cash', 'cashier'], ['wkr', 'worker'], ['wkr2', 'worker'],
  ['aud', 'auditor'], ['sh', 'shareholder'],
  ['cashDisc', 'cashier', { permissions: ['discounts.apply'] }],
  ['wkrOff', 'worker', { active: false }],
  // Phase 5
  ['mgrOff', 'manager', { active: false }],
  ['mgrPending', 'manager', { mustChangePassword: true }],
  ['wkrInv', 'worker', { permissions: ['inventory.view', 'inventory.stock.out', 'inventory.purchase.create'] }],
];

export async function resetAndSeed(db) {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const [uid, role, extra] of STAFF) {
    await db.doc(`users/${uid}`).set({ uid, role, active: true, phoneNumber: '+256700000000', fullName: uid,
      permissions: [], deniedPermissions: [], temporaryPermissions: {}, ...extra });
  }
}

export async function rejects(promise, code, reason) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (reason) assert.equal(e.details?.reason, reason, e.message);
    return true;
  });
}

export function helpers(db) {
  const deps = { db };
  const doc = async (path) => (await db.doc(path).get()).data();
  const audits = async (action) => (await db.collection('audit_logs').where('action', '==', action).get()).docs.map((d) => d.data());
  const ordersOf = async (intakeId) => (await db.collection('worker_orders').where('serviceIntakeId', '==', intakeId).get())
    .docs.map((d) => d.data()).sort((a, b) => a.orderNumber.localeCompare(b.orderNumber, 'en', { numeric: true }));

  let plate = 100;
  /** A vehicle plus services: wash (15,000, loyalty), interior (20,000, loyalty), tyre (10,000, no loyalty). */
  async function world() {
    const { customerId } = await ops.createCustomer(deps, 'mgr', { fullName: 'John Doe' });
    const { vehicleId } = await ops.createVehicle(deps, 'mgr', { numberPlate: `UBA ${plate++}A`, model: 'Harrier', colour: 'Black', customerId });
    // Service names are unique: reuse the catalogue within a test.
    const mk = async (name, category, priceUgx, qualifiesForLoyalty) => {
      const existing = await db.collection('services').where('name', '==', name).limit(1).get();
      if (!existing.empty) return existing.docs[0].id;
      return (await ops.createService(deps, 'admin', {
        name, category, priceUgx, estimatedDurationMinutes: 30, qualifiesForLoyalty,
      })).serviceId;
    };
    return {
      customerId,
      vehicleId,
      wash: await mk('Full Wash', 'washing', 15000, true),
      interior: await mk('Interior Cleaning', 'interior', 20000, true),
      tyre: await mk('Tyre Shine', 'exterior', 10000, false),
    };
  }

  async function newVehicle(customerId) {
    return (await ops.createVehicle(deps, 'mgr', { numberPlate: `UBA ${plate++}A`, model: 'Premio', colour: 'White', customerId })).vehicleId;
  }

  /** Runs every order of a job through assign → accept → start → complete. */
  async function completeJob(intakeId, workerUid = 'wkr') {
    for (const o of await ordersOf(intakeId)) {
      if (o.status === 'cancelled' || o.status === 'completed') continue;
      if (o.status === 'pending') await jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: workerUid });
      const who = (await doc(`worker_orders/${o.workerOrderId}`)).workerId;
      for (const action of ['accept', 'start', 'complete']) {
        const s = (await doc(`worker_orders/${o.workerOrderId}`)).status;
        if (WORKFLOW[action].includes(s)) await jobs.updateWorkerOrderStatus(deps, who, { workerOrderId: o.workerOrderId, action });
      }
    }
  }

  /** A completed, invoiced job for [vehicleId]. */
  async function invoicedJob(vehicleId, serviceIds, actor = 'cash') {
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds });
    await completeJob(intakeId);
    const inv = await billing.createInvoice(deps, actor, { intakeId });
    return { intakeId, ...inv };
  }

  let request = 0;
  const pay = (actor, invoiceId, amountUgx, extra = {}) => billing.recordPayment(deps, actor, {
    invoiceId, amountUgx, method: 'cash', requestId: `req-${Date.now()}-${request++}`, ...extra,
  });

  return { deps, doc, audits, ordersOf, world, newVehicle, completeJob, invoicedJob, pay };
}

const WORKFLOW = { accept: ['assigned'], start: ['accepted'], complete: ['in_progress'] };

// ---------------------------------------------------------------------------
// Phase 5: finance, expenses, inventory
// ---------------------------------------------------------------------------

let requestSeq = 0;
/** A fresh idempotency key. */
export const rid = () => `r5-${Date.now()}-${requestSeq++}`;

export function financeHelpers(db) {
  const account = async (id) => (await db.doc(`financial_accounts/${id}`).get()).data();
  const balance = async (id) => (await account(id))?.balanceUgx ?? 0;
  const txns = async (filter = {}) => (await db.collection('financial_transactions').get()).docs.map((d) => d.data())
    .filter((t) => Object.entries(filter).every(([k, v]) => t[k] === v));
  const today = async () => {
    const snaps = await db.collection('finance_daily_summaries').get();
    return snaps.docs[0]?.data() ?? {};
  };

  /** Every account balance equals the sum of its ledger entries (the reconciliation guarantee). */
  async function assertLedgerConsistent() {
    const sums = new Map();
    for (const t of await txns()) for (const e of t.entries) sums.set(e.accountId, (sums.get(e.accountId) ?? 0) + e.deltaUgx);
    const accounts = (await db.collection('financial_accounts').get()).docs.map((d) => d.data());
    for (const a of accounts) {
      assert.equal(a.balanceUgx, sums.get(a.accountId) ?? 0, `${a.accountId}: balance ${a.balanceUgx} ≠ ledger ${sums.get(a.accountId)}`);
      assert.ok(a.balanceUgx >= 0);
      if (a.type === 'cash') assert.ok(a.awaitingBankingUgx >= 0 && a.awaitingBankingUgx <= a.balanceUgx);
    }
  }
  return { account, balance, txns, today, assertLedgerConsistent };
}

// ---------------------------------------------------------------------------
// Phase 6: attendance, allowances, payroll, losses
// ---------------------------------------------------------------------------

/** Epoch millis of an EAT wall-clock time in September 2026 (day 21 is a Monday). */
export const eat = (day, hour, minute = 0, month = 9, year = 2026) => Date.UTC(year, month - 1, day, hour - 3, minute);

export function workforceHelpers(db) {
  const deps = { db };
  const doc = async (path) => (await db.doc(path).get()).data();
  const all = async (collection, filter = {}) => (await db.collection(collection).get()).docs.map((d) => d.data())
    .filter((x) => Object.entries(filter).every(([k, v]) => x[k] === v));
  return { deps, doc, all };
}
