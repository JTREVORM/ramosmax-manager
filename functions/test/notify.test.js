// Notifications (Phase 9): the notifier itself (dedupe, preferences, inactive
// recipients, token clean-up, delivery records, failure isolation) and the
// Phase 9 business events - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as ah from '../src/after_hours.js';
import * as attendance from '../src/attendance.js';
import * as expenses from '../src/expenses.js';
import * as finance from '../src/finance.js';
import * as jobs from '../src/jobs.js';
import { CRITICAL_TYPES, DEDUPE_WINDOW_MS, NOTIFICATION_CATEGORIES, categoryOf, makeNotifier } from '../src/notify.js';
import * as admin from '../src/user_admin.js';
import { NotificationType } from '../src/user_admin.js';
import { eat, emulatorDb, helpers, rejects, resetAndSeed, rid } from './helpers.js';

const db = emulatorDb('notify-tests');
const { doc, audits, world, ordersOf } = helpers(db);
const all = async (collection, filter = {}) => (await db.collection(collection).get()).docs.map((d) => d.data())
  .filter((x) => Object.entries(filter).every(([k, v]) => x[k] === v));

/** A fake FCM: records every multicast; per-token outcomes can be scripted. */
function fakeMessaging({ failTokens = {}, throws = null } = {}) {
  const calls = [];
  return {
    calls,
    async sendEachForMulticast(message) {
      calls.push(message);
      if (throws) throw Object.assign(new Error('fcm down'), { code: throws });
      const responses = message.tokens.map((t) => (failTokens[t] ? { success: false, error: { code: failTokens[t] } } : { success: true }));
      return { responses, successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length };
    },
  };
}

const sent = [];
const recording = { db, notify: async (uid, type, recordId) => { sent.push({ uid, type, recordId }); } };
const types = (uid) => sent.filter((s) => s.uid === uid).map((s) => s.type);

beforeEach(async () => {
  await resetAndSeed(db);
  sent.length = 0;
  await db.doc('users/wkr').update({ fcmTokens: ['tok-a', 'tok-b'] });
});

describe('the notifier', () => {
  test('writes one generic in-app record and pushes type and record ID only', async () => {
    const fcm = fakeMessaging();
    const r = await makeNotifier(db, fcm)('wkr', NotificationType.workOrderAssigned, 'wo-1');
    assert.equal(r.status, 'recorded');
    const n = await doc(`notifications/${r.notificationId}`);
    assert.deepEqual([n.recipientId, n.type, n.recordId, n.category, n.critical, n.read], ['wkr', 'job_assigned', 'wo-1', 'jobs', false, false]);
    assert.deepEqual([n.push.status, n.push.successCount], ['sent', 2]);
    assert.equal(fcm.calls.length, 1);
    assert.deepEqual(Object.keys(fcm.calls[0].data).sort(), ['notificationId', 'recordId', 'type']);
    assert.doesNotMatch(`${n.title} ${n.body}`, /UGX|\d{3,}/, 'no amounts on a lock screen');
  });

  test('a repeat within the window is dropped (retries never notify twice); a later one is sent', async () => {
    let now = 1_800_000_000_000;
    const fcm = fakeMessaging();
    const notify = makeNotifier(db, fcm, { clock: () => now });
    await notify('wkr', NotificationType.lowStock, 'item-1');
    const again = await notify('wkr', NotificationType.lowStock, 'item-1');
    assert.deepEqual(again, { status: 'skipped', reason: 'duplicate' });
    assert.equal((await all('notifications', { recipientId: 'wkr' })).length, 1);
    assert.equal(fcm.calls.length, 1);
    // Concurrent duplicates: exactly one wins.
    now += DEDUPE_WINDOW_MS;
    const results = await Promise.all([1, 2, 3].map(() => notify('wkr', NotificationType.lowStock, 'item-1')));
    assert.equal(results.filter((x) => x.status === 'recorded').length, 1);
    assert.equal((await all('notifications', { recipientId: 'wkr' })).length, 2);
  });

  test('inactive and unknown recipients are skipped, except the "access turned off" notice', async () => {
    const fcm = fakeMessaging();
    const notify = makeNotifier(db, fcm);
    assert.deepEqual(await notify('wkrOff', NotificationType.workOrderAssigned, 'x'), { status: 'skipped', reason: 'inactive' });
    assert.deepEqual(await notify('ghost', NotificationType.workOrderAssigned, 'x'), { status: 'skipped', reason: 'no_user' });
    assert.equal((await notify('wkrOff', NotificationType.accountDeactivated, 'wkrOff')).status, 'recorded');
    assert.equal((await all('notifications')).length, 1);
  });

  test('a muted category keeps the in-app record but skips push; critical notices always push', async () => {
    await admin.updateNotificationPreferences({ db }, 'wkr', { preferences: { jobs: false } });
    const fcm = fakeMessaging();
    const notify = makeNotifier(db, fcm);
    const a = await notify('wkr', NotificationType.workOrderAssigned, 'wo-1');
    assert.deepEqual(a.push, { status: 'skipped', reason: 'muted' });
    assert.equal((await all('notifications', { type: 'job_assigned' })).length, 1);
    const b = await notify('wkr', NotificationType.deductionApplied, 'item-1');
    assert.equal(b.push.status, 'sent');
    assert.equal(fcm.calls.length, 1);
  });

  test('unregistered tokens are removed; the outcome is recorded; an FCM outage never throws', async () => {
    const fcm = fakeMessaging({ failTokens: { 'tok-a': 'messaging/registration-token-not-registered' } });
    const r = await makeNotifier(db, fcm)('wkr', NotificationType.payrollPaid, 'p-1');
    assert.deepEqual([r.push.status, r.push.successCount, r.push.failureCount, r.push.removedTokens], ['partial', 1, 1, 1]);
    assert.deepEqual((await doc('users/wkr')).fcmTokens, ['tok-b']);
    // A transient error on one token keeps the token.
    const fcm2 = fakeMessaging({ failTokens: { 'tok-b': 'messaging/internal-error' } });
    const r2 = await makeNotifier(db, fcm2)('wkr', NotificationType.payrollPaid, 'p-2');
    assert.equal(r2.push.status, 'failed');
    assert.deepEqual((await doc('users/wkr')).fcmTokens, ['tok-b']);
    const down = await makeNotifier(db, fakeMessaging({ throws: 'messaging/unavailable' }))('wkr', NotificationType.payrollPaid, 'p-3');
    assert.deepEqual(down.push, { status: 'failed', reason: 'messaging/unavailable' });
    const none = await makeNotifier(db, fakeMessaging())('mgr', NotificationType.payrollPaid, 'p-4');
    assert.deepEqual(none.push, { status: 'skipped', reason: 'no_device' });
  });

  test('a failing notifier never fails the business action', async () => {
    const broken = { db, notify: async () => { throw new Error('boom'); } };
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(broken, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    const [o] = await ordersOf(intakeId);
    const r = await jobs.assignWorkerOrder(broken, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr' });
    assert.equal(r.status, 'assigned');
    assert.equal((await doc(`worker_orders/${o.workerOrderId}`)).workerId, 'wkr');
  });

  test('every type has a category; access and personal pay are critical', () => {
    for (const t of Object.values(NotificationType)) assert.notEqual(categoryOf(t), 'other', t);
    for (const t of [...NOTIFICATION_CATEGORIES.access, ...NOTIFICATION_CATEGORIES.pay]) assert.ok(CRITICAL_TYPES.has(t), t);
    assert.ok(!CRITICAL_TYPES.has(NotificationType.lowStock));
  });
});

describe('notification preferences', () => {
  test('own preferences only, mutable categories only, booleans only, audited', async () => {
    const r = await admin.updateNotificationPreferences({ db }, 'mgr', { preferences: { finance: false, workforce: false } });
    assert.deepEqual(r.preferences, { finance: false, workforce: false });
    assert.deepEqual((await doc('users/mgr')).notificationPreferences, { finance: false, workforce: false });
    assert.equal((await audits('notification_preferences.updated')).length, 1);
    await rejects(admin.updateNotificationPreferences({ db }, 'mgr', { preferences: { access: false } }), 'invalid-argument', 'category');
    await rejects(admin.updateNotificationPreferences({ db }, 'mgr', { preferences: { pay: false } }), 'invalid-argument', 'category');
    await rejects(admin.updateNotificationPreferences({ db }, 'mgr', { preferences: { jobs: 'no' } }), 'invalid-argument', 'preferences');
    await rejects(admin.updateNotificationPreferences({ db }, 'mgr', { preferences: {} }), 'invalid-argument', 'preferences');
    await rejects(admin.updateNotificationPreferences({ db }, 'wkrOff', { preferences: { jobs: false } }), 'permission-denied');
  });
});

describe('Phase 9 events', () => {
  test('jobs: reassigned → previous worker; cancelled → the worker; last order done → the job creator', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(recording, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash, w.interior] });
    const [a, b] = await ordersOf(intakeId);
    await jobs.assignWorkerOrder(recording, 'mgr', { workerOrderId: a.workerOrderId, workerId: 'wkr' });
    await jobs.reassignWorkerOrder(recording, 'mgr', { workerOrderId: a.workerOrderId, workerId: 'wkr2', reason: 'Balancing the load' });
    assert.deepEqual(types('wkr'), ['job_assigned', 'job_reassigned']);
    assert.deepEqual(types('wkr2'), ['job_assigned']);
    await jobs.assignWorkerOrder(recording, 'mgr', { workerOrderId: b.workerOrderId, workerId: 'wkr' });
    await jobs.cancelWorkerOrder(recording, 'mgr', { workerOrderId: b.workerOrderId, reason: 'Customer declined' });
    assert.equal(types('wkr').at(-1), 'job_cancelled');
    for (const action of ['accept', 'start']) await jobs.updateWorkerOrderStatus(recording, 'wkr2', { workerOrderId: a.workerOrderId, action });
    assert.deepEqual(types('cash'), []);
    await jobs.updateWorkerOrderStatus(recording, 'wkr2', { workerOrderId: a.workerOrderId, action: 'complete' });
    assert.deepEqual(sent.filter((s) => s.uid === 'cash'), [{ uid: 'cash', type: 'job_ready_to_invoice', recordId: intakeId }]);
  });

  test('expenses: submitted → reviewers (not the author); approved and paid → the author', async () => {
    await finance.recordOpeningBalance(recording, 'admin', { accountId: 'cash_at_hand', amountUgx: 1_000_000 });
    const { expenseId } = await expenses.createExpense(recording, 'cash', {
      categoryId: 'utilities', description: 'Water bill', amountUgx: 50_000, payee: 'NWSC', requestId: rid(), submit: true,
    });
    assert.ok(types('mgr').includes('expense_awaiting_approval'));
    assert.ok(types('admin').includes('expense_awaiting_approval'));
    assert.deepEqual(types('cash'), []);
    await expenses.updateExpenseStatus(recording, 'mgr', { expenseId, action: 'review', notes: 'Checked' });
    await expenses.updateExpenseStatus(recording, 'mgr', { expenseId, action: 'approve' });
    assert.deepEqual(types('cash'), ['expense_decided']);
    await expenses.payExpense(recording, 'admin', { expenseId, accountId: 'cash_at_hand', requestId: rid() });
    assert.deepEqual(types('cash'), ['expense_decided', 'expense_decided']);
  });

  test('reconciliation: a difference → finance.adjust holders; balanced → nobody; retry → once', async () => {
    await finance.recordOpeningBalance(recording, 'admin', { accountId: 'cash_at_hand', amountUgx: 100_000 });
    await finance.reconcileAccount(recording, 'mgr', { accountId: 'cash_at_hand', actualBalanceUgx: 100_000, requestId: rid() });
    assert.deepEqual(sent, []);
    const requestId = rid();
    await finance.reconcileAccount(recording, 'mgr', { accountId: 'cash_at_hand', actualBalanceUgx: 95_000, requestId });
    await finance.reconcileAccount(recording, 'mgr', { accountId: 'cash_at_hand', actualBalanceUgx: 95_000, requestId });
    assert.deepEqual(sent.map((s) => [s.uid, s.type]), [['admin', 'reconciliation_difference']]);
  });

  test('attendance: a correction tells the staff member', async () => {
    const a = await attendance.recordAttendance(recording, 'wkr', {}, eat(21, 8, 40));
    await attendance.correctAttendance(recording, 'mgr', { attendanceId: a.attendanceId, clockInAt: eat(21, 8, 5), reason: 'Queue at the gate' }, eat(21, 19));
    assert.deepEqual(sent.filter((s) => s.uid === 'wkr'), [{ uid: 'wkr', type: 'attendance_corrected', recordId: a.attendanceId }]);
  });

  test('after-hours: an overdue handover is reminded once (worker and receivers), even if the sweep runs twice', async () => {
    const H = 3600_000;
    const now = Date.now();
    const created = now - 3 * H;
    await db.doc('cash_handovers/h1').set({ handoverId: 'h1', handoverNumber: 'RMX-HO-000001', staffUid: 'wkr', status: 'pending', expectedCashUgx: 50_000, createdAt: new Date(created) });
    await db.doc('cash_handovers/h2').set({ handoverId: 'h2', handoverNumber: 'RMX-HO-000002', staffUid: 'wkr2', status: 'pending', expectedCashUgx: 10_000, createdAt: new Date(now - 10 * 60_000) });
    const [r1, r2] = await Promise.all([ah.sweepAfterHours(recording, now), ah.sweepAfterHours(recording, now)]);
    assert.equal(r1.reminded + r2.reminded, 1);
    assert.deepEqual(types('wkr'), ['cash_handover_reminder']);
    assert.deepEqual(types('wkr2'), []);
    assert.ok(types('mgr').includes('cash_handover_reminder'));
    assert.ok((await doc('cash_handovers/h1')).reminderSentAt);
    assert.equal((await ah.sweepAfterHours(recording, now + H)).reminded, 0);
  });
});
