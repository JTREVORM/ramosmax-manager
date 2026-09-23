// ===========================================================================
// RamosMAX jobs - service intakes and worker orders (Phase 4).
// ===========================================================================
// A service intake IS the job (`RMX-JOB-000001`). Each selected service gets
// one worker order (`RMX-JOB-000001/1`), which a manager assigns to a worker
// and the worker moves through a controlled status flow:
//
//   pending ──assign──► assigned ──accept──► accepted ──start──► in_progress
//                          ▲                                   │   ▲
//                          └────────── reassign (reason) ──────┤ pause│resume (reason on pause)
//                                                              ▼   │
//                                                          completed / paused
//   any unfinished order ──cancel (reason)──► cancelled
//
// The intake keeps a compact summary of its orders (`orders`, `workerIds`),
// updated in the same transaction as every order change. That summary drives
// the job's own status: `completed` once every order is completed or
// cancelled and at least one was completed. Only a completed job can be
// invoiced (billing.js).
//
// Workers act only on orders assigned to them; managers assign, reassign and
// cancel. Nothing here trusts the client beyond the requested action.
// ===========================================================================

import { Timestamp } from 'firebase-admin/firestore';

import { invalid, precondition, deny, optionalText, requireReason, isAccountLive, effectivePermissions } from './access.js';
import {
  INTAKES, audit, freshActor, nextNumber, notFound, requireDocId, requireServiceIds, readSelectedServices, stamp,
} from './operations.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import { afterHoursTags, countOnSession, readAfterHoursContext } from './after_hours.js';

export const ORDERS = 'worker_orders';
const VEHICLES = 'vehicles';
const USERS = 'users';

export const ORDER_STATUSES = Object.freeze(['pending', 'assigned', 'accepted', 'in_progress', 'paused', 'completed', 'cancelled']);
const ACTIVE_WORK = new Set(['in_progress', 'paused']);
const REASSIGNABLE = new Set(['assigned', 'accepted', 'in_progress', 'paused']);
const REMOVABLE = new Set(['pending', 'assigned', 'accepted']);

/** Worker actions: allowed from-states, target state, timestamp field. */
export const WORKER_ACTIONS = Object.freeze({
  accept: { from: ['assigned'], to: 'accepted', at: 'acceptedAt', event: 'work_order.accepted' },
  start: { from: ['accepted'], to: 'in_progress', at: 'startedAt', event: 'work_order.started' },
  pause: { from: ['in_progress'], to: 'paused', at: 'pausedAt', reason: true, event: 'work_order.paused' },
  resume: { from: ['paused'], to: 'in_progress', at: 'resumedAt', event: 'work_order.resumed' },
  complete: { from: ['in_progress'], to: 'completed', at: 'completedAt', event: 'work_order.completed' },
});

/**
 * The job status implied by its orders: `completed` when every order is
 * completed or cancelled and at least one was completed; otherwise `open`.
 */
export function jobStatusFor(orders) {
  const live = orders.filter((o) => o.status !== 'cancelled');
  if (live.length > 0 && live.every((o) => o.status === 'completed')) return 'completed';
  return 'open';
}

function summary(order) {
  return {
    workerOrderId: order.workerOrderId,
    orderNumber: order.orderNumber,
    serviceId: order.serviceId,
    serviceName: order.serviceName,
    workerId: order.workerId ?? null,
    workerName: order.workerName ?? null,
    status: order.status,
  };
}

function withSummary(intake, order) {
  const orders = (intake.orders ?? []).map((o) => (o.workerOrderId === order.workerOrderId ? summary(order) : o));
  if (!orders.some((o) => o.workerOrderId === order.workerOrderId)) orders.push(summary(order));
  return orders;
}

function intakeUpdate(intake, orders, actorUid) {
  const update = {
    orders,
    workerIds: [...new Set(orders.map((o) => o.workerId).filter(Boolean))],
    updatedAt: stamp(),
    updatedBy: actorUid,
  };
  if (intake.status !== 'cancelled' && intake.status !== 'draft') {
    const status = jobStatusFor(orders);
    update.status = status;
    update.completedAt = status === 'completed' ? (intake.completedAt ?? stamp()) : null;
  }
  return update;
}

/** New pending orders for [services] of [intake] (writes deferred to [write]). */
function newOrders(db, intakeRef, intake, services, startIndex) {
  return services.map((s, i) => {
    const ref = db.collection(ORDERS).doc();
    return {
      ref,
      data: {
        workerOrderId: ref.id,
        orderNumber: `${intake.jobNumber}/${startIndex + i + 1}`,
        serviceIntakeId: intakeRef.id,
        jobNumber: intake.jobNumber,
        vehicleId: intake.vehicleId,
        numberPlate: intake.numberPlate,
        vehicleSummary: intake.vehicleSummary ?? null,
        // Workers see the vehicle, not the customer's details.
        customerId: intake.customerId ?? null,
        serviceId: s.serviceId,
        serviceName: s.name,
        category: s.category,
        status: 'pending',
        workerId: null,
        workerName: null,
        assignedBy: null,
        assignedAt: null,
        acceptedAt: null,
        startedAt: null,
        pausedAt: null,
        resumedAt: null,
        completedAt: null,
        cancelledAt: null,
        totalPausedMs: 0,
        notes: intake.notes ?? null,
        completionNotes: null,
        pauseReason: null,
        cancelReason: null,
        assignmentHistory: [],
        createdAt: stamp(),
        updatedAt: stamp(),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Intake (job) creation and changes
// ---------------------------------------------------------------------------

export async function createServiceIntake(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const vehicleId = requireDocId(data.vehicleId, 'vehicle');
  const serviceIds = requireServiceIds(data.serviceIds);
  const notes = optionalText(data.notes, 'Notes', 500);
  const status = data.status === 'draft' ? 'draft' : 'open';

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'jobs.create');
    // Phase 8: a job started in a live after-hours session is marked as such.
    const afterHours = await readAfterHoursContext(tx, db, actor.uid, now);
    const vehicleRef = db.collection(VEHICLES).doc(vehicleId);
    const vehicle = await tx.get(vehicleRef);
    if (!vehicle.exists) throw notFound('That vehicle could not be found.', 'vehicle_missing');
    if (vehicle.get('status') !== 'active') {
      throw precondition(`${vehicle.get('numberPlate')} is inactive. Reactivate it before starting a service.`, 'vehicle_inactive');
    }
    const open = await tx.get(db.collection(INTAKES)
      .where('vehicleId', '==', vehicleId).where('status', 'in', ['open', 'draft']).limit(1));
    if (!open.empty) {
      throw precondition(`${vehicle.get('numberPlate')} already has a service in progress.`, 'open_intake_exists',
        { intakeId: open.docs[0].id });
    }
    const selected = await readSelectedServices(tx, db, serviceIds);
    const jobNumber = await nextNumber(tx, db, 'jobs', 'RMX-JOB-', 6);

    const ref = db.collection(INTAKES).doc();
    const v = vehicle.data();
    const intake = {
      intakeId: ref.id,
      jobNumber: jobNumber.value,
      vehicleId,
      numberPlate: v.numberPlate,
      normalizedNumberPlate: v.normalizedNumberPlate,
      vehicleSummary: [v.make, v.model, v.colour].filter(Boolean).join(' · '),
      customerId: v.customerId ?? null,
      customerName: v.customerName ?? null,
      status,
      selectedServices: selected,
      serviceIds: selected.map((s) => s.serviceId),
      serviceCount: selected.length,
      notes,
      invoiceId: null,
      invoiceNumber: null,
      completedAt: null,
      createdAt: stamp(),
      createdBy: actor.uid,
      createdByName: actor.data.fullName ?? null,
      updatedAt: stamp(),
      updatedBy: actor.uid,
      ...afterHoursTags(afterHours),
    };
    const orders = newOrders(db, ref, intake, selected, 0);
    jobNumber.commit();
    for (const o of orders) tx.set(o.ref, o.data);
    tx.set(ref, { ...intake, orders: orders.map((o) => summary(o.data)), workerIds: [] });
    tx.update(vehicleRef, { lastIntakeAt: stamp() });
    countOnSession(tx, afterHours, 'intakesCreated');
    audit(tx, db, actor, 'jobs', 'service_intake.created', ref.id, {
      newValue: { jobNumber: jobNumber.value, vehicleId, numberPlate: v.numberPlate, serviceIds: intake.serviceIds, status },
    });
    return { intakeId: ref.id, jobNumber: jobNumber.value };
  });
}

export async function updateServiceIntake(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const intakeId = requireDocId(data.intakeId, 'service intake');
  const serviceIds = 'serviceIds' in data ? requireServiceIds(data.serviceIds) : null;
  const cancel = data.status === 'cancelled';
  const open = data.status === 'open';
  if (data.status != null && !cancel && !open) throw invalid('Choose a valid status.', 'status');
  const reason = requireReason(data.reason, { required: cancel });
  if (!serviceIds && !cancel && !open) throw precondition('Nothing has changed.', 'no_changes');

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'jobs.create');
    const ref = db.collection(INTAKES).doc(intakeId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('That service intake could not be found.');
    const before = snap.data();
    if (before.status === 'cancelled') throw precondition('This service intake was cancelled.', 'cancelled');
    if (before.invoiceId) throw precondition('This job has been invoiced. Cancel the invoice first.', 'invoiced');

    const orderSnaps = await tx.get(db.collection(ORDERS).where('serviceIntakeId', '==', intakeId));
    const orders = orderSnaps.docs.map((d) => ({ ref: d.ref, data: d.data() }));
    const liveOrders = orders.filter((o) => o.data.status !== 'cancelled');

    if (cancel) {
      if (liveOrders.some((o) => o.data.status === 'completed' || ACTIVE_WORK.has(o.data.status))) {
        throw precondition('Work on this job has started or finished. Cancel individual services instead, '
          + 'or invoice the completed work.', 'work_started');
      }
      const summaries = [];
      for (const o of orders) {
        if (o.data.status !== 'cancelled') {
          const upd = { status: 'cancelled', cancelledAt: stamp(), cancelReason: reason, updatedAt: stamp() };
          tx.update(o.ref, upd);
          summaries.push(summary({ ...o.data, ...upd }));
        } else {
          summaries.push(summary(o.data));
        }
      }
      tx.update(ref, {
        status: 'cancelled', orders: summaries, cancelledAt: stamp(), cancelledBy: actor.uid, cancelReason: reason,
        updatedAt: stamp(), updatedBy: actor.uid,
      });
      audit(tx, db, actor, 'jobs', 'service_intake.cancelled', intakeId,
        { previousValue: { status: before.status }, newValue: { status: 'cancelled' }, reason });
      return { intakeId, status: 'cancelled' };
    }

    const selected = serviceIds ? await readSelectedServices(tx, db, serviceIds) : null;
    const summaries = orders.map((o) => summary(o.data));
    const changes = [];
    let added = [];
    if (selected) {
      const wanted = new Set(selected.map((s) => s.serviceId));
      const current = new Set(liveOrders.map((o) => o.data.serviceId));
      for (const o of liveOrders) {
        if (wanted.has(o.data.serviceId)) continue;
        if (!REMOVABLE.has(o.data.status)) {
          throw precondition(`"${o.data.serviceName}" is already being worked on and cannot be removed.`, 'order_started');
        }
        changes.push(o);
      }
      added = newOrders(db, ref, before, selected.filter((s) => !current.has(s.serviceId)), orders.length);
    }
    // --- writes ---
    for (const o of changes) {
      const upd = { status: 'cancelled', cancelledAt: stamp(), cancelReason: 'Service removed from the job', updatedAt: stamp() };
      tx.update(o.ref, upd);
      summaries[summaries.findIndex((s) => s.workerOrderId === o.data.workerOrderId)] = summary({ ...o.data, ...upd });
    }
    for (const o of added) {
      tx.set(o.ref, o.data);
      summaries.push(summary(o.data));
    }
    const update = intakeUpdate(before, summaries, actor.uid);
    if (selected) {
      Object.assign(update, { selectedServices: selected, serviceIds: selected.map((s) => s.serviceId), serviceCount: selected.length });
    }
    if (open && before.status === 'draft') update.status = jobStatusFor(summaries);
    tx.update(ref, update);
    audit(tx, db, actor, 'jobs', 'service_intake.updated', intakeId, {
      previousValue: { serviceIds: before.serviceIds, status: before.status },
      newValue: { serviceIds: update.serviceIds ?? before.serviceIds, status: update.status ?? before.status },
      reason,
    });
    return { intakeId, status: update.status ?? before.status };
  });
}

// ---------------------------------------------------------------------------
// Assignment (managers)
// ---------------------------------------------------------------------------

/** The user an order is assigned to must be active and able to do jobs. */
async function readAssignableWorker(tx, db, workerId, now) {
  const snap = await tx.get(db.collection(USERS).doc(requireDocId(workerId, 'worker')));
  const data = snap.exists ? snap.data() : null;
  if (!isAccountLive(data, now) || !effectivePermissions(data, now).has('jobs.complete')) {
    throw invalid('Choose an active worker who can carry out jobs.', 'worker');
  }
  return { uid: snap.id, name: data.fullName ?? null };
}

async function readOrderAndIntake(tx, db, workerOrderId) {
  const ref = db.collection(ORDERS).doc(requireDocId(workerOrderId, 'work order'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That work order could not be found.');
  const order = snap.data();
  const intakeRef = db.collection(INTAKES).doc(order.serviceIntakeId);
  const intakeSnap = await tx.get(intakeRef);
  if (!intakeSnap.exists) throw notFound('The job for this work order could not be found.');
  const intake = intakeSnap.data();
  if (intake.status === 'cancelled') throw precondition('This job was cancelled.', 'cancelled');
  if (intake.invoiceId) throw precondition('This job has been invoiced.', 'invoiced');
  return { ref, order, intakeRef, intake };
}

export async function assignWorkerOrder(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const notes = optionalText(data.notes, 'Notes', 500);
  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'jobs.assign');
    const { ref, order, intakeRef, intake } = await readOrderAndIntake(tx, db, data.workerOrderId);
    if (order.status !== 'pending') {
      throw precondition('This work order is already assigned. Use Reassign instead.', 'invalid_transition');
    }
    const worker = await readAssignableWorker(tx, db, data.workerId, now);
    const at = Timestamp.fromMillis(now);
    const upd = {
      status: 'assigned', workerId: worker.uid, workerName: worker.name, assignedBy: actor.uid, assignedAt: at,
      ...(notes ? { notes } : {}),
      assignmentHistory: [{ workerId: worker.uid, workerName: worker.name, assignedBy: actor.uid, assignedAt: at, endedAt: null, reason: null }],
      updatedAt: stamp(),
    };
    tx.update(ref, upd);
    tx.update(intakeRef, intakeUpdate(intake, withSummary(intake, { ...order, ...upd }), actor.uid));
    audit(tx, db, actor, 'jobs', 'work_order.assigned', ref.id, {
      newValue: { orderNumber: order.orderNumber, workerId: worker.uid, serviceName: order.serviceName },
    });
    return { workerOrderId: ref.id, status: 'assigned', workerId: worker.uid };
  });
  await notifySafely(deps, result.workerId, NotificationType.workOrderAssigned, result.workerOrderId);
  return result;
}

export async function reassignWorkerOrder(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'jobs.assign');
    const { ref, order, intakeRef, intake } = await readOrderAndIntake(tx, db, data.workerOrderId);
    if (!REASSIGNABLE.has(order.status)) {
      throw precondition(order.status === 'pending' ? 'Assign this work order first.' : 'This work order can no longer be reassigned.',
        'invalid_transition');
    }
    const worker = await readAssignableWorker(tx, db, data.workerId, now);
    if (worker.uid === order.workerId) throw precondition('Choose a different worker.', 'same_worker');
    const at = Timestamp.fromMillis(now);
    // The earlier assignment is closed, never deleted.
    const history = (order.assignmentHistory ?? []).map((h, i, all) => (i === all.length - 1 && !h.endedAt ? { ...h, endedAt: at, reason } : h));
    history.push({ workerId: worker.uid, workerName: worker.name, assignedBy: actor.uid, assignedAt: at, endedAt: null, reason: null });
    const upd = {
      status: 'assigned', workerId: worker.uid, workerName: worker.name, assignedBy: actor.uid, assignedAt: at,
      acceptedAt: null, startedAt: null, pausedAt: null, resumedAt: null, totalPausedMs: 0, pauseReason: null,
      assignmentHistory: history, lastReassignReason: reason, updatedAt: stamp(),
    };
    tx.update(ref, upd);
    tx.update(intakeRef, intakeUpdate(intake, withSummary(intake, { ...order, ...upd }), actor.uid));
    audit(tx, db, actor, 'jobs', 'work_order.reassigned', ref.id, {
      previousValue: { workerId: order.workerId, status: order.status },
      newValue: { workerId: worker.uid, status: 'assigned' },
      reason,
    });
    return { workerOrderId: ref.id, status: 'assigned', workerId: worker.uid };
  });
  await notifySafely(deps, result.workerId, NotificationType.workOrderAssigned, result.workerOrderId);
  return result;
}

export async function cancelWorkerOrder(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'jobs.manage');
    const { ref, order, intakeRef, intake } = await readOrderAndIntake(tx, db, data.workerOrderId);
    if (order.status === 'completed' || order.status === 'cancelled') {
      throw precondition('This work order is already finished.', 'invalid_transition');
    }
    const upd = { status: 'cancelled', cancelledAt: Timestamp.fromMillis(now), cancelledBy: actor.uid, cancelReason: reason, updatedAt: stamp() };
    tx.update(ref, upd);
    tx.update(intakeRef, intakeUpdate(intake, withSummary(intake, { ...order, ...upd }), actor.uid));
    audit(tx, db, actor, 'jobs', 'work_order.cancelled', ref.id,
      { previousValue: { status: order.status }, newValue: { status: 'cancelled' }, reason });
    return { workerOrderId: ref.id, status: 'cancelled' };
  });
}

// ---------------------------------------------------------------------------
// Worker actions (the assigned worker only)
// ---------------------------------------------------------------------------

export async function updateWorkerOrderStatus(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const rule = WORKER_ACTIONS[data.action];
  if (!rule) throw invalid('Choose a valid action.', 'action');
  const reason = requireReason(data.reason, { required: Boolean(rule.reason) });
  const completionNotes = data.action === 'complete' ? optionalText(data.completionNotes, 'Completion notes', 500) : null;

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'jobs.complete');
    const { ref, order, intakeRef, intake } = await readOrderAndIntake(tx, db, data.workerOrderId);
    // Phase 8: work completed in a live after-hours session is marked as such.
    const afterHours = data.action === 'complete' ? await readAfterHoursContext(tx, db, actor.uid, now) : null;
    if (order.workerId !== callerUid) throw deny('Only the worker assigned to this job can update it.', 'not_assignee');
    if (!rule.from.includes(order.status)) {
      throw precondition(`This job is ${order.status.replace('_', ' ')}; it cannot be moved to ${rule.to.replace('_', ' ')}.`,
        'invalid_transition');
    }
    const at = Timestamp.fromMillis(now);
    const upd = { status: rule.to, [rule.at]: at, updatedAt: stamp() };
    if (data.action === 'pause') upd.pauseReason = reason;
    if (data.action === 'resume') {
      const pausedAt = order.pausedAt?.toMillis?.() ?? now;
      upd.totalPausedMs = (order.totalPausedMs ?? 0) + Math.max(0, now - pausedAt);
      upd.pauseReason = null;
    }
    if (data.action === 'complete') {
      upd.completionNotes = completionNotes;
      if (afterHours?.live) Object.assign(upd, afterHoursTags(afterHours));
      countOnSession(tx, afterHours, 'jobsCompleted');
    }
    tx.update(ref, upd);
    tx.update(intakeRef, intakeUpdate(intake, withSummary(intake, { ...order, ...upd }), actor.uid));
    audit(tx, db, actor, 'jobs', rule.event, ref.id, {
      previousValue: { status: order.status }, newValue: { status: rule.to }, reason,
    });
    return { workerOrderId: ref.id, status: rule.to, jobStatus: jobStatusFor(withSummary(intake, { ...order, ...upd })) };
  });
}

/** Worked time: start → completion (or now), minus pauses. */
export function workedMs(order, now = Date.now()) {
  const start = order.startedAt?.toMillis?.();
  if (!start) return 0;
  const end = order.completedAt?.toMillis?.() ?? (order.status === 'paused' ? order.pausedAt?.toMillis?.() : now) ?? now;
  return Math.max(0, end - start - (order.totalPausedMs ?? 0));
}

