// Jobs and worker orders (Phase 4) - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as jobs from '../src/jobs.js';
import { emulatorDb, helpers, rejects, resetAndSeed } from './helpers.js';

const db = emulatorDb('jobs-tests');
const { deps, doc, audits, ordersOf, world, completeJob } = helpers(db);

beforeEach(() => resetAndSeed(db));

const act = (uid, workerOrderId, action, extra = {}) => jobs.updateWorkerOrderStatus(deps, uid, { workerOrderId, action, ...extra });

describe('job creation', () => {
  test('a job gets RMX-JOB numbers and one pending worker order per service', async () => {
    const w = await world();
    const a = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash, w.interior] });
    assert.equal(a.jobNumber, 'RMX-JOB-000001');
    const orders = await ordersOf(a.intakeId);
    assert.deepEqual(orders.map((o) => [o.orderNumber, o.serviceName, o.status, o.workerId]),
      [['RMX-JOB-000001/1', 'Full Wash', 'pending', null], ['RMX-JOB-000001/2', 'Interior Cleaning', 'pending', null]]);
    const intake = await doc(`service_intakes/${a.intakeId}`);
    assert.equal(intake.orders.length, 2);
    assert.deepEqual(intake.workerIds, []);
    assert.equal(intake.invoiceId, null);

    const v2 = (await world()).vehicleId;
    const b = await jobs.createServiceIntake(deps, 'mgr', { vehicleId: v2, serviceIds: [w.wash] });
    assert.equal(b.jobNumber, 'RMX-JOB-000002');
  });

  test('concurrent job creation never reuses a job number', async () => {
    const w = await world();
    const vehicles = [w.vehicleId];
    for (let i = 0; i < 4; i++) vehicles.push((await world()).vehicleId);
    const results = await Promise.all(vehicles.map((vehicleId) => jobs.createServiceIntake(deps, 'cash', { vehicleId, serviceIds: [w.wash] })));
    const numbers = results.map((r) => r.jobNumber);
    assert.equal(new Set(numbers).size, numbers.length);
  });
});

describe('assignment', () => {
  test('manager assigns per service; worker sees only their own orders; notification sent', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash, w.interior] });
    const [o1, o2] = await ordersOf(intakeId);
    const sent = [];
    const notifyDeps = { ...deps, notify: async (uid, type, id) => sent.push([uid, type, id]) };
    await jobs.assignWorkerOrder(notifyDeps, 'mgr', { workerOrderId: o1.workerOrderId, workerId: 'wkr' });
    await jobs.assignWorkerOrder(notifyDeps, 'mgr', { workerOrderId: o2.workerOrderId, workerId: 'wkr2' });
    assert.deepEqual(sent, [['wkr', 'job_assigned', o1.workerOrderId], ['wkr2', 'job_assigned', o2.workerOrderId]]);
    const a = await doc(`worker_orders/${o1.workerOrderId}`);
    assert.deepEqual([a.status, a.workerId, a.assignedBy, a.assignmentHistory.length], ['assigned', 'wkr', 'mgr', 1]);
    assert.deepEqual((await doc(`service_intakes/${intakeId}`)).workerIds.sort(), ['wkr', 'wkr2']);
    assert.equal((await audits('work_order.assigned')).length, 2);
    // Already assigned → reassign, not assign.
    await rejects(jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o1.workerOrderId, workerId: 'wkr2' }), 'failed-precondition', 'invalid_transition');
  });

  test('only active users who can do jobs may be assigned; only jobs.assign holders may assign', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    const [o] = await ordersOf(intakeId);
    for (const bad of ['wkrOff', 'aud', 'cash', 'ghost']) {
      await rejects(jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: bad }), 'invalid-argument', 'worker');
    }
    for (const uid of ['cash', 'wkr', 'aud', 'sh']) {
      await rejects(jobs.assignWorkerOrder(deps, uid, { workerOrderId: o.workerOrderId, workerId: 'wkr' }), 'permission-denied');
    }
    // A manager can assign to themselves (managers hold jobs.complete).
    await jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'mgr' });
  });

  test('reassignment needs a reason, resets progress and keeps the history', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    const [o] = await ordersOf(intakeId);
    await rejects(jobs.reassignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr2', reason: 'Mistake' }),
      'failed-precondition', 'invalid_transition');
    await jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr' });
    await act('wkr', o.workerOrderId, 'accept');
    await act('wkr', o.workerOrderId, 'start');
    await rejects(jobs.reassignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr2' }), 'invalid-argument', 'reason');
    await rejects(jobs.reassignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr', reason: 'Same' }),
      'failed-precondition', 'same_worker');
    await jobs.reassignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr2', reason: 'Wkr went home sick' });
    const r = await doc(`worker_orders/${o.workerOrderId}`);
    assert.deepEqual([r.status, r.workerId, r.startedAt, r.lastReassignReason], ['assigned', 'wkr2', null, 'Wkr went home sick']);
    assert.equal(r.assignmentHistory.length, 2);
    assert.equal(r.assignmentHistory[0].workerId, 'wkr');
    assert.equal(r.assignmentHistory[0].reason, 'Wkr went home sick');
    assert.ok(r.assignmentHistory[0].endedAt);
    assert.equal(r.assignmentHistory[1].endedAt, null);
    // The previous worker can no longer act on it.
    await rejects(act('wkr', o.workerOrderId, 'accept'), 'permission-denied', 'not_assignee');
    assert.deepEqual((await doc(`service_intakes/${intakeId}`)).workerIds, ['wkr2']);
    const [log] = await audits('work_order.reassigned');
    assert.equal(log.reason, 'Wkr went home sick');
  });
});

describe('worker status flow', () => {
  async function assigned() {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash, w.interior] });
    const orders = await ordersOf(intakeId);
    for (const o of orders) await jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o.workerOrderId, workerId: 'wkr' });
    return { intakeId, w, o1: orders[0].workerOrderId, o2: orders[1].workerOrderId };
  }

  test('accept → start → pause (reason) → resume → complete, with timestamps and paused time', async () => {
    const { o1 } = await assigned();
    const t0 = Date.parse('2026-09-21T08:00:00Z');
    await jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: o1, action: 'accept' }, t0);
    await jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: o1, action: 'start' }, t0 + 60_000);
    await rejects(act('wkr', o1, 'pause'), 'invalid-argument', 'reason');
    await jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: o1, action: 'pause', reason: 'Waiting for water' }, t0 + 10 * 60_000);
    assert.equal((await doc(`worker_orders/${o1}`)).pauseReason, 'Waiting for water');
    await jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: o1, action: 'resume' }, t0 + 15 * 60_000);
    await jobs.updateWorkerOrderStatus(deps, 'wkr', { workerOrderId: o1, action: 'complete', completionNotes: 'Done well' }, t0 + 30 * 60_000);
    const o = await doc(`worker_orders/${o1}`);
    assert.equal(o.status, 'completed');
    assert.equal(o.totalPausedMs, 5 * 60_000);
    assert.equal(o.completionNotes, 'Done well');
    assert.equal(jobs.workedMs(o), 24 * 60_000);
    for (const e of ['accepted', 'started', 'paused', 'resumed', 'completed']) {
      assert.equal((await audits(`work_order.${e}`)).length, 1, e);
    }
  });

  test('illegal transitions are refused', async () => {
    const { o1 } = await assigned();
    await rejects(act('wkr', o1, 'start'), 'failed-precondition', 'invalid_transition');
    await rejects(act('wkr', o1, 'complete'), 'failed-precondition', 'invalid_transition');
    await rejects(act('wkr', o1, 'resume'), 'failed-precondition', 'invalid_transition');
    await rejects(act('wkr', o1, 'teleport'), 'invalid-argument', 'action');
    await act('wkr', o1, 'accept');
    await rejects(act('wkr', o1, 'accept'), 'failed-precondition', 'invalid_transition');
    await act('wkr', o1, 'start');
    await act('wkr', o1, 'complete');
    await rejects(act('wkr', o1, 'pause', { reason: 'late' }), 'failed-precondition', 'invalid_transition');
    await rejects(jobs.cancelWorkerOrder(deps, 'mgr', { workerOrderId: o1, reason: 'late' }), 'failed-precondition', 'invalid_transition');
  });

  test('only the assigned worker acts; auditors, cashiers and other workers cannot', async () => {
    const { o1 } = await assigned();
    await rejects(act('wkr2', o1, 'accept'), 'permission-denied', 'not_assignee');
    for (const uid of ['cash', 'aud', 'sh']) await rejects(act(uid, o1, 'accept'), 'permission-denied');
    await rejects(act('wkrOff', o1, 'accept'), 'permission-denied');
  });

  test('a multi-service job completes only when every service is completed or cancelled', async () => {
    const { intakeId, o1, o2 } = await assigned();
    for (const a of ['accept', 'start', 'complete']) await act('wkr', o1, a);
    let intake = await doc(`service_intakes/${intakeId}`);
    assert.equal(intake.status, 'open');
    assert.deepEqual(intake.orders.map((o) => o.status), ['completed', 'assigned']);
    await rejects(jobs.cancelWorkerOrder(deps, 'mgr', { workerOrderId: o2 }), 'invalid-argument', 'reason');
    await rejects(jobs.cancelWorkerOrder(deps, 'cash', { workerOrderId: o2, reason: 'Mistake' }), 'permission-denied');
    await jobs.cancelWorkerOrder(deps, 'mgr', { workerOrderId: o2, reason: 'Customer in a hurry' });
    intake = await doc(`service_intakes/${intakeId}`);
    assert.equal(intake.status, 'completed');
    assert.ok(intake.completedAt);
  });

  test('a job whose services are all cancelled is not completed', async () => {
    assert.equal(jobs.jobStatusFor([{ status: 'cancelled' }]), 'open');
    assert.equal(jobs.jobStatusFor([{ status: 'completed' }, { status: 'cancelled' }]), 'completed');
    assert.equal(jobs.jobStatusFor([{ status: 'completed' }, { status: 'paused' }]), 'open');
    assert.equal(jobs.jobStatusFor([]), 'open');
  });

  test('concurrent actions on the same order: exactly one wins', async () => {
    const { o1 } = await assigned();
    const results = await Promise.allSettled([act('wkr', o1, 'accept'), act('wkr', o1, 'accept'), act('wkr', o1, 'accept')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await audits('work_order.accepted')).length, 1);
  });
});

describe('job changes and cancellation', () => {
  test('services can be added or removed only until work starts; removal cancels the order', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash, w.interior] });
    const [o1, o2] = await ordersOf(intakeId);
    await jobs.updateServiceIntake(deps, 'cash', { intakeId, serviceIds: [w.wash, w.tyre] });
    const orders = await ordersOf(intakeId);
    assert.deepEqual(orders.map((o) => [o.serviceName, o.status]),
      [['Full Wash', 'pending'], ['Interior Cleaning', 'cancelled'], ['Tyre Shine', 'pending']]);
    assert.equal(orders[2].orderNumber.endsWith('/3'), true);
    await jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o1.workerOrderId, workerId: 'wkr' });
    for (const a of ['accept', 'start']) await act('wkr', o1.workerOrderId, a);
    await rejects(jobs.updateServiceIntake(deps, 'cash', { intakeId, serviceIds: [w.tyre] }), 'failed-precondition', 'order_started');
    await rejects(jobs.updateServiceIntake(deps, 'cash', { intakeId, status: 'cancelled', reason: 'Left' }), 'failed-precondition', 'work_started');
    assert.ok(o2);
  });

  test('cancelling a job before work starts cancels every order; cancelled jobs cannot be touched', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash, w.interior] });
    const [o1] = await ordersOf(intakeId);
    await jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o1.workerOrderId, workerId: 'wkr' });
    await jobs.updateServiceIntake(deps, 'cash', { intakeId, status: 'cancelled', reason: 'Customer left' });
    assert.deepEqual((await ordersOf(intakeId)).map((o) => o.status), ['cancelled', 'cancelled']);
    await rejects(act('wkr', o1.workerOrderId, 'accept'), 'failed-precondition', 'cancelled');
    await rejects(jobs.assignWorkerOrder(deps, 'mgr', { workerOrderId: o1.workerOrderId, workerId: 'wkr' }), 'failed-precondition', 'cancelled');
  });

  test('completed jobs free the vehicle for a new visit', async () => {
    const w = await world();
    const { intakeId } = await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] });
    await rejects(jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] }), 'failed-precondition', 'open_intake_exists');
    await completeJob(intakeId);
    assert.equal((await doc(`service_intakes/${intakeId}`)).status, 'completed');
    assert.ok((await jobs.createServiceIntake(deps, 'cash', { vehicleId: w.vehicleId, serviceIds: [w.wash] })).intakeId);
  });
});
