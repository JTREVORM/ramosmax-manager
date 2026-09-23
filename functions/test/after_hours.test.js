// After-hours authorisation, sessions, tagged operations, cash custody,
// handovers, discrepancies and finance integration (Phase 8) - against the
// Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as ah from '../src/after_hours.js';
import * as billing from '../src/billing.js';
import * as finance from '../src/finance.js';
import * as jobs from '../src/jobs.js';
import * as ops from '../src/operations.js';
import * as admin from '../src/user_admin.js';
import { emulatorDb, financeHelpers, helpers, rejects, resetAndSeed } from './helpers.js';

const db = emulatorDb('after-hours-tests');
const { doc, audits, world, invoicedJob, completeJob } = helpers(db);
const { balance, txns, assertLedgerConsistent } = financeHelpers(db);
const sent = [];
const deps = { db, notify: async (uid, type, recordId) => { sent.push({ uid, type, recordId }); } };
const all = async (collection, filter = {}) => (await db.collection(collection).get()).docs.map((d) => d.data())
  .filter((x) => Object.entries(filter).every(([k, v]) => x[k] === v));

const H = 3600_000;
const NOW = Date.now();
let seq = 0;
const rid = () => `ah-${Date.now()}-${seq++}`;

beforeEach(async () => {
  await resetAndSeed(db);
  sent.length = 0;
});

const authorize = (staffUid = 'wkr', actor = 'mgr', extra = {}, now = NOW) => ah.authorizeAfterHours(deps, actor, {
  staffUid, startsAt: now, expiresAt: now + 4 * H, reason: 'Evening washes, manager off site', requestId: rid(), ...extra,
}, now);
const open = (uid = 'wkr', now = NOW, extra = {}) => ah.openAfterHoursSession(deps, uid, { requestId: rid(), ...extra }, now);
const close = (sessionId, actor = 'wkr', now = NOW) => ah.closeAfterHoursSession(deps, actor, { sessionId }, now);
const pay = (actor, invoiceId, amountUgx, method = 'cash', now = NOW, extra = {}) => billing.recordPayment(deps, actor, {
  invoiceId, amountUgx, method, requestId: rid(), ...(method === 'cash' ? {} : { reference: `REF${seq}` }), ...extra,
}, now);
const submit = (handoverId, declaredAmountUgx, actor = 'wkr', extra = {}) =>
  ah.submitCashHandover(deps, actor, { handoverId, declaredAmountUgx, requestId: rid(), ...extra }, NOW);
const receive = (handoverId, actualAmountUgx, actor = 'mgr', extra = {}) =>
  ah.receiveCashHandover(deps, actor, { handoverId, actualAmountUgx, requestId: rid(), ...extra }, NOW);
const session = (id) => doc(`after_hours_sessions/${id}`);
const profile = (uid) => doc(`users/${uid}`);

/** Three invoices of UGX 15,000 (Full Wash), raised during the day by the cashier. */
async function invoices(n = 3) {
  const w = await world();
  const out = [];
  for (let i = 0; i < n; i++) {
    const vehicleId = i === 0 ? w.vehicleId : (await ops.createVehicle(deps, 'mgr', { numberPlate: `UBB ${100 + i}K`, model: 'Premio', colour: 'Blue', customerId: w.customerId })).vehicleId;
    out.push((await invoicedJob(vehicleId, [w.wash])).invoiceId);
  }
  return { ...w, invoiceIds: out };
}

/** Authorised worker with an open session (float UGX 50,000). */
async function working(extra = {}) {
  const a = await authorize('wkr', 'mgr', { openingFloatUgx: 50000, ...extra });
  const s = await open('wkr');
  return { ...a, ...s };
}

describe('authorisation', () => {
  test('an Administrator or Manager authorises a worker: server number, temporary grants only, audited, notified', async () => {
    const r = await authorize('wkr', 'admin');
    assert.equal(r.authorizationNumber, 'RMX-AH-000001');
    const a = await doc(`after_hours_access/${r.authorizationId}`);
    assert.deepEqual([a.staffUid, a.status, a.grantedBy], ['wkr', 'active', 'admin']);
    assert.deepEqual(a.permissions, [...ah.DEFAULT_GRANTS]);
    const p = await profile('wkr');
    for (const perm of ['after_hours.operate', 'after_hours.cash.collect', 'jobs.create', 'invoices.create']) {
      assert.ok(p.temporaryPermissions[perm], perm);
      assert.equal(p.temporaryPermissions[perm].expiresAt.toMillis(), NOW + 4 * H);
    }
    assert.deepEqual(p.permissions, [], 'nothing becomes permanent');
    const grants = (await db.collection('users/wkr/temporary_grants').get()).docs.map((d) => d.data());
    assert.ok(grants.every((g) => g.source === 'after_hours' && g.authorizationId === r.authorizationId));
    assert.equal((await audits('after_hours.authorized')).length, 1);
    assert.ok(sent.some((n) => n.uid === 'wkr' && n.type === 'after_hours_authorized'));
    assert.equal((await authorize('wkr2', 'mgr')).authorizationNumber, 'RMX-AH-000002');
  });

  test('nobody authorises themselves; workers, cashiers and auditors cannot authorise anyone', async () => {
    await rejects(authorize('admin', 'admin'), 'permission-denied', 'self_authorization');
    for (const actor of ['wkr', 'cash', 'aud', 'sh']) await rejects(authorize('wkr2', actor), 'permission-denied');
  });

  test('only eligible, active, junior accounts; no overlap; bounded window and float', async () => {
    await rejects(authorize('cash', 'mgr'), 'failed-precondition', 'not_eligible');
    await rejects(authorize('mgr', 'admin'), 'failed-precondition', 'not_eligible');
    await rejects(authorize('wkrOff', 'mgr'), 'failed-precondition', 'target_inactive');
    await rejects(authorize('wkr', 'mgr', { expiresAt: NOW + 20 * H }), 'invalid-argument', 'window');
    await rejects(authorize('wkr', 'mgr', { openingFloatUgx: 5_000_000 }), 'invalid-argument', 'float');
    await authorize('wkr');
    await rejects(authorize('wkr', 'mgr', { startsAt: NOW + H, expiresAt: NOW + 6 * H }), 'failed-precondition', 'authorization_overlaps');
  });

  test('an authorisation can never include administrative or financial permissions', async () => {
    for (const perm of ['users.edit', 'users.roles.manage', 'users.passwords.reset', 'salary.manage', 'payroll.approve', 'finance.adjust',
      'finance.accounts.manage', 'payments.reverse', 'dividends.pay', 'shareholders.manage', 'shares.issue', 'inventory.manage',
      'services.manage', 'discounts.apply', 'discounts.approve', 'attendance.approve', 'settings.manage', 'audit.view', 'payments.record']) {
      await rejects(authorize('wkr', 'admin', { permissions: ['after_hours.operate', perm] }), 'invalid-argument', 'permission_not_allowed');
    }
    assert.equal((await all('after_hours_access')).length, 0);
  });

  test('after-hours permissions are never permanent and never handed out through the generic temporary grant', async () => {
    await rejects(admin.setUserPermissions(deps, 'admin', { uid: 'wkr', permissions: ['after_hours.cash.collect'] }, NOW), 'failed-precondition', 'authorization_only');
    await rejects(admin.grantTemporaryPermission(deps, 'admin', {
      uid: 'wkr', permission: 'after_hours.operate', startsAt: NOW, expiresAt: NOW + H, reason: 'Shortcut',
    }, NOW), 'failed-precondition', 'authorization_only');
  });

  test('a retried authorisation request creates one authorisation', async () => {
    const requestId = rid();
    const a = await authorize('wkr', 'mgr', { requestId });
    const b = await authorize('wkr', 'mgr', { requestId });
    assert.equal(b.authorizationId, a.authorizationId);
    assert.equal(b.duplicate, true);
    assert.equal((await all('after_hours_access')).length, 1);
  });

  test('expired authorisation stops working on the server (no job needed)', async () => {
    const { invoiceIds } = await invoices(1);
    await authorize('wkr');
    const later = NOW + 5 * H;
    await rejects(open('wkr', later), 'permission-denied');
    const s = await open('wkr', NOW + H);
    await rejects(pay('wkr', invoiceIds[0], 15000, 'cash', later), 'permission-denied');
    // The session can still be closed (and handed over) after expiry.
    await close(s.sessionId, 'wkr', later);
    assert.equal((await session(s.sessionId)).status, 'closed');
  });

  test('revocation removes the temporary permissions at once; open sessions can no longer collect', async () => {
    const { invoiceIds } = await invoices(1);
    const a = await authorize('wkr');
    const s = await open('wkr');
    await rejects(ah.revokeAfterHours(deps, 'mgr', { authorizationId: a.authorizationId }, NOW), 'invalid-argument', 'reason');
    await rejects(ah.revokeAfterHours(deps, 'wkr', { authorizationId: a.authorizationId, reason: 'x y z' }, NOW), 'permission-denied');
    await ah.revokeAfterHours(deps, 'mgr', { authorizationId: a.authorizationId, reason: 'Left the premises' }, NOW);
    const p = await profile('wkr');
    assert.equal(p.temporaryPermissions['after_hours.operate'], undefined);
    assert.equal((await doc(`after_hours_access/${a.authorizationId}`)).status, 'revoked');
    await rejects(pay('wkr', invoiceIds[0], 15000), 'permission-denied');
    await close(s.sessionId);
    await rejects(open('wkr'), 'permission-denied');
    await rejects(ah.revokeAfterHours(deps, 'mgr', { authorizationId: a.authorizationId, reason: 'Again' }, NOW), 'failed-precondition', 'not_active');
    assert.equal((await audits('after_hours.revoked')).length, 1);
  });

  test('an inactive worker cannot operate', async () => {
    await authorize('wkr');
    await db.doc('users/wkr').update({ active: false });
    await rejects(open('wkr'), 'permission-denied');
  });
});

describe('sessions', () => {
  test('a worker opens a session (server number, float recorded); a second open session is refused; a retry is recorded once', async () => {
    await authorize('wkr', 'mgr', { openingFloatUgx: 50000 });
    const requestId = rid();
    const s = await open('wkr', NOW, { requestId });
    assert.equal(s.sessionNumber, 'RMX-AHS-000001');
    assert.equal((await open('wkr', NOW, { requestId })).duplicate, true);
    await rejects(open('wkr'), 'failed-precondition', 'session_already_open');
    const d = await session(s.sessionId);
    assert.deepEqual([d.status, d.staffUid, d.openingFloatUgx, d.expectedCashUgx], ['open', 'wkr', 50000, 50000]);
    const [float] = await all('after_hours_cash', { sessionId: s.sessionId });
    assert.deepEqual([float.kind, float.entryNumber, float.cashDeltaUgx], ['opening_float', 'RMX-AHC-000001', 50000]);
    assert.equal((await audits('after_hours.session_opened')).length, 1);
  });

  test('without an authorisation nobody opens a session', async () => {
    for (const uid of ['wkr', 'wkr2', 'cash', 'mgr']) await rejects(open(uid), 'permission-denied');
  });

  test('a worker cannot close or cancel another worker\'s session; the manager can', async () => {
    const s = await working();
    await rejects(close(s.sessionId, 'wkr2'), 'permission-denied', 'not_owner');
    await rejects(ah.cancelAfterHoursSession(deps, 'wkr2', { sessionId: s.sessionId, reason: 'Not mine' }, NOW), 'permission-denied', 'not_owner');
    await close(s.sessionId, 'mgr');
    assert.equal((await session(s.sessionId)).closedBy, 'mgr');
    await rejects(close(s.sessionId, 'wkr'), 'failed-precondition', 'session_not_open');
  });

  test('closing freezes the expected cash on a handover; a session with no cash just closes; cancel needs an empty session', async () => {
    await authorize('wkr');
    const s = await open('wkr');
    const r = await close(s.sessionId);
    assert.deepEqual([r.expectedCashUgx, r.handoverId], [0, undefined]);
    assert.equal((await session(s.sessionId)).status, 'closed');
    const s2 = await open('wkr');
    await rejects(ah.cancelAfterHoursSession(deps, 'wkr', { sessionId: s2.sessionId }, NOW), 'invalid-argument', 'reason');
    await ah.cancelAfterHoursSession(deps, 'wkr', { sessionId: s2.sessionId, reason: 'Opened by mistake' }, NOW);
    assert.equal((await session(s2.sessionId)).status, 'cancelled');
  });
});

describe('after-hours operations', () => {
  test('a worker starts, completes and invoices a job and collects payment - all through the normal Phase 3/4 flows, tagged', async () => {
    const w = await world();
    const s = await working();
    const { intakeId } = await jobs.createServiceIntake(deps, 'wkr', { vehicleId: w.vehicleId, serviceIds: [w.wash] }, NOW);
    const intake = await doc(`service_intakes/${intakeId}`);
    assert.deepEqual([intake.isAfterHours, intake.afterHoursSessionId, intake.afterHoursWorkerUid], [true, s.sessionId, 'wkr']);
    const [order] = await all('worker_orders', { serviceIntakeId: intakeId });
    await jobs.assignWorkerOrder(deps, 'wkr', { workerOrderId: order.workerOrderId, workerId: 'wkr' }, NOW);
    for (const action of ['accept', 'start', 'complete']) {
      await jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: order.workerOrderId, action }, NOW);
    }
    assert.equal((await doc(`worker_orders/${order.workerOrderId}`)).afterHoursSessionId, s.sessionId);
    const { invoiceId } = await billing.createInvoice(deps, 'wkr', { intakeId }, NOW);
    assert.equal((await doc(`invoices/${invoiceId}`)).isAfterHours, true);
    const p = await pay('wkr', invoiceId, 15000);
    const payment = await doc(`payments/${p.paymentId}`);
    assert.deepEqual([payment.isAfterHours, payment.afterHoursSessionId, payment.afterHoursWorkerUid, payment.status], [true, s.sessionId, 'wkr', 'completed']);
    assert.equal((await doc(`receipts/${p.receiptId}`)).afterHoursSessionId, s.sessionId);
    const [ledger] = await txns({ paymentId: p.paymentId });
    assert.deepEqual([ledger.type, ledger.isRevenue, ledger.afterHoursSessionId], ['customer_payment', true, s.sessionId]);
    const d = await session(s.sessionId);
    assert.deepEqual([d.intakesCreated, d.jobsCompleted, d.invoicesCreated, d.paymentCount, d.cashCollectedUgx, d.expectedCashUgx], [1, 1, 1, 1, 15000, 65000]);
    assert.equal((await audits('after_hours.payment_linked')).length, 1);
    await assertLedgerConsistent();
  });

  test('normal-hours workflows are unchanged: a cashier payment is untagged and not in anyone\'s expected cash', async () => {
    const { invoiceIds } = await invoices(2);
    const s = await working();
    const normal = await pay('cash', invoiceIds[0], 15000);
    assert.equal((await doc(`payments/${normal.paymentId}`)).isAfterHours, false);
    await pay('wkr', invoiceIds[1], 15000);
    const r = await close(s.sessionId);
    assert.equal(r.expectedCashUgx, 50000 + 15000);
    assert.equal(await balance('cash_at_hand'), 30000);
  });

  test('only policy payment methods after hours (bank off by default); no session → no collection', async () => {
    const { invoiceIds } = await invoices(1);
    await rejects(pay('wkr', invoiceIds[0], 15000), 'permission-denied'); // not authorised
    await authorize('wkr');
    await rejects(pay('wkr', invoiceIds[0], 15000), 'permission-denied', 'after_hours_session_required');
    await open('wkr');
    await rejects(pay('wkr', invoiceIds[0], 15000, 'bank'), 'permission-denied', 'method_not_allowed');
    await pay('wkr', invoiceIds[0], 15000, 'mtn_merchant');
    assert.equal(await balance('mtn_merchant'), 15000);
  });

  test('a policy change can allow bank (settings.manage only)', async () => {
    await rejects(ah.updateAfterHoursPolicy(deps, 'mgr', { changes: { allowedPaymentMethods: ['cash', 'bank'] }, reason: 'Board decision' }, NOW), 'permission-denied');
    await ah.updateAfterHoursPolicy(deps, 'admin', { changes: { allowedPaymentMethods: ['cash', 'bank'] }, reason: 'Board decision' }, NOW);
    const { invoiceIds } = await invoices(1);
    await working();
    await rejects(pay('wkr', invoiceIds[0], 15000, 'mtn_merchant'), 'permission-denied', 'method_not_allowed');
    await pay('wkr', invoiceIds[0], 15000, 'bank');
  });

  test('an after-hours worker cannot change prices, discounts, balances, the ledger or reverse payments', async () => {
    const { invoiceIds, wash } = await invoices(1);
    const s = await working();
    const p = await pay('wkr', invoiceIds[0], 15000);
    await rejects(ops.updateService(deps, 'wkr', { serviceId: wash, priceUgx: 1 }, NOW), 'permission-denied');
    await rejects(billing.applyInvoiceDiscount(deps, 'wkr', { invoiceId: invoiceIds[0], discountType: 'percentage', discountValue: 50, reasonCode: 'manager_approval' }, NOW), 'permission-denied');
    await rejects(billing.reversePayment(deps, 'wkr', { paymentId: p.paymentId, reason: 'Oops' }, NOW), 'permission-denied');
    await rejects(finance.recordAccountAdjustment(deps, 'wkr', { accountId: 'cash_at_hand', direction: 'out', amountUgx: 1000, reason: 'Take', requestId: rid() }, NOW), 'permission-denied');
    await rejects(finance.transferFunds(deps, 'wkr', { fromAccountId: 'cash_at_hand', toAccountId: 'bank_1', amountUgx: 100, reason: 'x y z', requestId: rid() }, NOW), 'permission-denied');
    await rejects(finance.reconcileAccount(deps, 'wkr', { accountId: 'cash_at_hand', actualBalanceUgx: 0, requestId: rid() }, NOW), 'permission-denied');
    await rejects(admin.setUserRole(deps, 'wkr', { uid: 'wkr2', role: 'manager', reason: 'Promote colleague' }, NOW), 'permission-denied');
    void s;
  });
});

describe('cash held by the worker', () => {
  test('expected = float + cash payments; mobile money is not cash held; reversals while open reduce it', async () => {
    const { invoiceIds } = await invoices(3);
    const s = await working();
    const a = await pay('wkr', invoiceIds[0], 15000);
    await pay('wkr', invoiceIds[1], 15000);
    await pay('wkr', invoiceIds[2], 15000, 'airtel_merchant');
    let d = await session(s.sessionId);
    assert.deepEqual([d.expectedCashUgx, d.cashCollectedUgx, d.nonCashCollectedUgx, d.paymentCount], [80000, 30000, 15000, 3]);
    await billing.reversePayment(deps, 'admin', { paymentId: a.paymentId, reason: 'Customer refunded in cash' }, NOW);
    d = await session(s.sessionId);
    assert.deepEqual([d.expectedCashUgx, d.cashReversedUgx], [65000, 15000]);
    const entries = await all('after_hours_cash', { sessionId: s.sessionId });
    assert.equal(entries.reduce((t, e) => t + e.cashDeltaUgx, 0), 65000);
    const r = await close(s.sessionId);
    assert.equal(r.expectedCashUgx, 65000, 'recalculated from the payments themselves');
  });

  test('the expected amount cannot be supplied or edited by anyone; a reversal after closing does not change it', async () => {
    const { invoiceIds } = await invoices(1);
    const s = await working();
    const p = await pay('wkr', invoiceIds[0], 15000);
    const r = await ah.closeAfterHoursSession(deps, 'wkr', { sessionId: s.sessionId, expectedCashUgx: 1 }, NOW);
    assert.equal(r.expectedCashUgx, 65000);
    await billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Refund after the shift' }, NOW);
    const h = await doc(`cash_handovers/${r.handoverId}`);
    assert.equal(h.expectedCashUgx, 65000);
    assert.equal((await session(s.sessionId)).postCloseReversalsUgx, 15000);
    const rev = (await all('after_hours_cash', { kind: 'payment_reversal' }))[0];
    assert.deepEqual([rev.afterSessionClosed, rev.cashDeltaUgx], [true, 0]);
    await submit(r.handoverId, 1, 'wkr', { expectedCashUgx: 1 });
    assert.equal((await doc(`cash_handovers/${r.handoverId}`)).expectedCashUgx, 65000);
  });

  test('pure helpers: expectedFromPayments and compareCash', () => {
    const e = ah.expectedFromPayments(50000, [
      { method: 'cash', amountUgx: 20000, status: 'completed' }, { method: 'cash', amountUgx: 5000, status: 'reversed' },
      { method: 'mtn_merchant', amountUgx: 9000, status: 'completed' },
    ]);
    assert.deepEqual([e.expectedCashUgx, e.reversedCashUgx, e.nonCashUgx], [70000, 5000, 9000]);
    assert.deepEqual(ah.compareCash(200000, 200000), { differenceUgx: 0, kind: 'balanced' });
    assert.deepEqual(ah.compareCash(200000, 195000), { differenceUgx: -5000, kind: 'shortage' });
    assert.deepEqual(ah.compareCash(200000, 205000), { differenceUgx: 5000, kind: 'excess' });
  });
});

describe('handover', () => {
  async function closed() {
    const { invoiceIds } = await invoices(1);
    const s = await working({ openingFloatUgx: 185000 });
    await pay('wkr', invoiceIds[0], 15000);
    const r = await close(s.sessionId);
    return { ...s, handoverId: r.handoverId, handoverNumber: r.handoverNumber }; // expected 200,000
  }

  test('pending on close; the worker submits; the manager receives the exact amount: difference 0, reconciled', async () => {
    const c = await closed();
    let h = await doc(`cash_handovers/${c.handoverId}`);
    assert.deepEqual([h.handoverNumber, h.status, h.expectedCashUgx], ['RMX-HO-000001', 'pending', 200000]);
    assert.ok(sent.some((n) => n.type === 'cash_handover_pending' && n.uid === 'mgr'));
    await submit(c.handoverId, 200000, 'wkr', { notes: 'All in the envelope' });
    assert.equal((await doc(`cash_handovers/${c.handoverId}`)).status, 'submitted');
    assert.ok(sent.some((n) => n.type === 'cash_handover_submitted' && n.uid === 'mgr'));
    const r = await receive(c.handoverId, 200000);
    assert.deepEqual([r.status, r.differenceUgx], ['received', 0]);
    h = await doc(`cash_handovers/${c.handoverId}`);
    assert.deepEqual([h.actualAmountUgx, h.differenceUgx, h.receivedBy, h.destinationAccountId], [200000, 0, 'mgr', 'cash_at_hand']);
    assert.equal((await session(c.sessionId)).status, 'reconciled');
    assert.equal((await all('cash_discrepancies')).length, 0);
    for (const a of ['cash_handover.submitted', 'cash_handover.received']) assert.equal((await audits(a)).length, 1, a);
  });

  test('short cash: UGX −5,000 opens a discrepancy that needs an explanation', async () => {
    const c = await closed();
    await submit(c.handoverId, 195000);
    await rejects(receive(c.handoverId, 195000), 'invalid-argument', 'reason');
    const r = await receive(c.handoverId, 195000, 'mgr', { explanation: 'Envelope counted twice, UGX 5,000 short' });
    assert.deepEqual([r.status, r.differenceUgx, r.discrepancyNumber], ['discrepancy', -5000, 'RMX-AHD-000001']);
    const d = await doc(`cash_discrepancies/${r.discrepancyId}`);
    assert.deepEqual([d.status, d.kind, d.expectedCashUgx, d.actualAmountUgx, d.declaredAmountUgx, d.differenceUgx, d.reportedBy],
      ['open', 'shortage', 200000, 195000, 195000, -5000, 'mgr']);
    assert.equal((await session(c.sessionId)).status, 'handover_pending');
    assert.ok(sent.some((n) => n.type === 'cash_discrepancy_detected' && n.uid === 'wkr'));
  });

  test('excess cash: UGX +5,000 is recorded as an excess', async () => {
    const c = await closed();
    const r = await receive(c.handoverId, 205000, 'mgr', { explanation: 'Customer tip left in the float' });
    assert.equal(r.differenceUgx, 5000);
    assert.equal((await doc(`cash_discrepancies/${r.discrepancyId}`)).kind, 'excess');
  });

  test('only a receiver (not the worker) receives; nobody receives their own; the values never change afterwards', async () => {
    const c = await closed();
    await rejects(receive(c.handoverId, 200000, 'wkr'), 'permission-denied');
    await rejects(receive(c.handoverId, 200000, 'cash'), 'permission-denied');
    await rejects(receive(c.handoverId, 200000, 'aud'), 'permission-denied');
    await receive(c.handoverId, 200000, 'admin');
    await rejects(receive(c.handoverId, 1, 'mgr', { explanation: 'Make it match' }), 'failed-precondition', 'already_received');
    const h = await doc(`cash_handovers/${c.handoverId}`);
    assert.deepEqual([h.expectedCashUgx, h.actualAmountUgx], [200000, 200000]);
  });

  test('duplicate submission: a retry is recorded once; a second submission is refused; a worker cannot submit another worker\'s', async () => {
    const c = await closed();
    await rejects(submit(c.handoverId, 1, 'wkr2'), 'permission-denied', 'not_owner');
    const requestId = rid();
    await submit(c.handoverId, 200000, 'wkr', { requestId });
    assert.equal((await submit(c.handoverId, 200000, 'wkr', { requestId })).duplicate, true);
    await rejects(submit(c.handoverId, 150000), 'failed-precondition', 'already_submitted');
    assert.equal((await doc(`cash_handovers/${c.handoverId}`)).declaredAmountUgx, 200000);
    assert.equal((await all('cash_handovers')).length, 1);
    const requestId2 = rid();
    const a = await receive(c.handoverId, 200000, 'mgr', { requestId: requestId2 });
    assert.equal((await receive(c.handoverId, 200000, 'mgr', { requestId: requestId2 })).duplicate, true);
    void a;
  });
});

describe('discrepancies', () => {
  async function shortage() {
    const { invoiceIds } = await invoices(1);
    const s = await working({ openingFloatUgx: 185000 });
    await pay('wkr', invoiceIds[0], 15000);
    const r = await close(s.sessionId);
    const x = await receive(r.handoverId, 195000, 'mgr', { explanation: 'UGX 5,000 short at count' });
    return { sessionId: s.sessionId, handoverId: r.handoverId, discrepancyId: x.discrepancyId };
  }
  const resolve = (discrepancyId, actor = 'mgr', extra = {}) => ah.resolveCashDiscrepancy(deps, actor, {
    discrepancyId, outcome: 'resolved', resolution: 'Worker admits the shortage; refer for recovery', requestId: rid(), ...extra,
  }, NOW);

  test('review and resolution need explanations; the original figures stay; audited; the worker is told', async () => {
    const x = await shortage();
    await rejects(ah.reviewCashDiscrepancy(deps, 'mgr', { discrepancyId: x.discrepancyId }, NOW), 'invalid-argument', 'reason');
    await ah.reviewCashDiscrepancy(deps, 'mgr', { discrepancyId: x.discrepancyId, notes: 'Recounting the envelope' }, NOW);
    await rejects(resolve(x.discrepancyId, 'mgr', { resolution: '' }), 'invalid-argument', 'reason');
    await resolve(x.discrepancyId);
    const d = await doc(`cash_discrepancies/${x.discrepancyId}`);
    assert.deepEqual([d.status, d.expectedCashUgx, d.actualAmountUgx, d.differenceUgx, d.resolvedBy], ['resolved', 200000, 195000, -5000, 'mgr']);
    assert.equal((await doc(`cash_handovers/${x.handoverId}`)).status, 'reconciled');
    assert.equal((await session(x.sessionId)).status, 'reconciled');
    for (const a of ['cash_discrepancy.created', 'cash_discrepancy.reviewed', 'cash_discrepancy.resolved', 'cash_handover.reconciled']) {
      assert.equal((await audits(a)).length, 1, a);
    }
    assert.ok(sent.some((n) => n.type === 'cash_discrepancy_resolved' && n.uid === 'wkr'));
    await rejects(resolve(x.discrepancyId), 'failed-precondition', 'already_resolved');
  });

  test('workers, cashiers and auditors cannot review or resolve; nobody resolves their own', async () => {
    const x = await shortage();
    for (const uid of ['wkr', 'cash', 'aud']) await rejects(resolve(x.discrepancyId, uid), 'permission-denied');
    await db.doc(`cash_discrepancies/${x.discrepancyId}`).update({ staffUid: 'mgr' });
    await rejects(resolve(x.discrepancyId, 'mgr'), 'permission-denied', 'self_action');
  });

  test('recovery goes through a Phase 6 loss incident (reported, no deduction created); waiving never recovers', async () => {
    const x = await shortage();
    await rejects(resolve(x.discrepancyId, 'mgr', { outcome: 'waived', recoverFromWorker: true }), 'invalid-argument', 'outcome');
    const r = await resolve(x.discrepancyId, 'mgr', { recoverFromWorker: true });
    const loss = await doc(`loss_incidents/${r.incidentId}`);
    assert.deepEqual([loss.status, loss.staffUid, loss.amountUgx, loss.incidentType, loss.sourceType], ['reported', 'wkr', 5000, 'worker_related_loss', 'cash_discrepancy']);
    assert.equal((await all('salary_deductions')).length, 0, 'nothing is deducted automatically');
    assert.equal((await doc(`cash_discrepancies/${x.discrepancyId}`)).lossNumber, r.lossNumber);
  });

  test('an excess cannot be recovered from the worker', async () => {
    const { invoiceIds } = await invoices(1);
    const s = await working({ openingFloatUgx: 0 });
    await pay('wkr', invoiceIds[0], 15000);
    const c = await close(s.sessionId);
    const x = await receive(c.handoverId, 20000, 'mgr', { explanation: 'Extra UGX 5,000 in the bag' });
    await rejects(resolve(x.discrepancyId, 'mgr', { recoverFromWorker: true }), 'failed-precondition', 'not_a_shortage');
    await resolve(x.discrepancyId, 'mgr', { outcome: 'waived', resolution: 'Customer tip, kept by the business' });
  });

  test('aligning Cash at Hand posts an existing Phase 5 adjustment, only with finance.adjust', async () => {
    const x = await shortage();
    const before = await balance('cash_at_hand');
    await rejects(resolve(x.discrepancyId, 'mgr', { postAdjustment: true }), 'permission-denied');
    const r = await resolve(x.discrepancyId, 'admin', { postAdjustment: true });
    const t = await doc(`financial_transactions/${r.transactionId}`);
    assert.deepEqual([t.type, t.amountUgx, t.sourceAccountId, t.isRevenue, t.discrepancyId], ['adjustment', 5000, 'cash_at_hand', false, x.discrepancyId]);
    assert.equal(await balance('cash_at_hand'), before - 5000);
    await assertLedgerConsistent();
  });
});

describe('finance integration', () => {
  test('a payment is posted once; the handover adds no revenue and no ledger entry; balances stay consistent', async () => {
    const { invoiceIds } = await invoices(2);
    const s = await working();
    await pay('wkr', invoiceIds[0], 15000);
    await pay('wkr', invoiceIds[1], 15000, 'mtn_merchant');
    const before = await txns();
    const cash = await balance('cash_at_hand');
    assert.equal(cash, 15000);
    const c = await close(s.sessionId);
    await submit(c.handoverId, 65000);
    await receive(c.handoverId, 65000);
    assert.equal((await txns()).length, before.length, 'no new ledger entries');
    assert.equal(await balance('cash_at_hand'), cash);
    assert.equal((await txns({ type: 'customer_payment' })).length, 2);
    await assertLedgerConsistent();
  });

  test('an after-hours payment is still reversed only through reversePayment (the generic finance reversal refuses it)', async () => {
    const { invoiceIds } = await invoices(1);
    await working();
    const p = await pay('wkr', invoiceIds[0], 15000);
    const [t] = await txns({ paymentId: p.paymentId });
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: t.transactionId, reason: 'Generic' }, NOW), 'failed-precondition', 'use_payment_reversal');
    await billing.reversePayment(deps, 'admin', { paymentId: p.paymentId, reason: 'Wrong invoice' }, NOW);
    assert.equal(await balance('cash_at_hand'), 0);
    await assertLedgerConsistent();
  });
});

describe('housekeeping', () => {
  test('the sweep marks expired authorisations and sends one "ending soon" notice', async () => {
    const a = await authorize('wkr', 'mgr', { expiresAt: NOW + 20 * 60_000 });
    let r = await ah.sweepAfterHours(deps, NOW);
    assert.deepEqual(r, { expired: 0, warned: 1, reminded: 0 });
    assert.ok(sent.some((n) => n.type === 'after_hours_expiring' && n.uid === 'wkr'));
    r = await ah.sweepAfterHours(deps, NOW + H);
    assert.deepEqual(r, { expired: 1, warned: 0, reminded: 0 });
    assert.equal((await doc(`after_hours_access/${a.authorizationId}`)).status, 'expired');
    assert.equal((await admin.sweepTemporaryGrants(deps, NOW)).warned, 0, 'no per-permission notices for after-hours grants');
  });
});

void completeJob;
