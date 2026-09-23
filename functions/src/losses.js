// ===========================================================================
// RamosMAX loss incidents and salary deductions (Phase 6)
// ===========================================================================
//
// Loss incident:
//   reported ──review──► under_review ──decide (losses.approve)──► approved ──schedule──► recovery_scheduled
//       │                     │                 └─► rejected                                   │ (payroll paid)
//       └─────────────────────┴──decide───────────────────────────────────────────► partially_recovered ──► recovered
//   anything not finished ──cancel (losses.adjust, reason)──► cancelled
//
// An incident NEVER creates a deduction by itself. A recovery exists only
// after an approver decides that the staff member is liable for a stated
// amount (at most the loss), and someone schedules it: that creates ONE
// `salary_deductions` record of type loss_recovery (total = what is still
// outstanding, a per-payroll instalment, a first period). Payroll takes
// min(instalment, remaining) each period and the balances go down only when
// the payroll is PAID (payroll.js), so the recovered total can never exceed
// the approved amount, and nothing is recovered after cancellation.
//
// Salary deductions of other kinds (authorised salary deduction, other
// approved deduction) are created with a reason and source by
// `deductions.manage` and take effect only after `payroll.approve` approves
// them. Salary advances are not part of Phase 6.
// ===========================================================================

import { Timestamp } from 'firebase-admin/firestore';

import { deny, invalid, optionalText, precondition, requireReason } from './access.js';
import { audit, freshActor, notFound, requireDocId, stamp } from './operations.js';
import {
  holdersOf, readCounter, readRequest, requireAmount, requireBusinessDate, requireChoice, requireRequestId, requireText, saveRequest,
} from './finance.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import { DEDUCTIONS, LOSSES, PAYROLL_ITEMS, employeeFields, holds, nameOf, optionalNotes, optionalUpload, readEmployee, requireNotOwn } from './workforce.js';

export const INCIDENT_TYPES = Object.freeze(['damaged_equipment', 'damaged_customer_property', 'stock_loss', 'worker_related_loss', 'other']);
export const INCIDENT_STATUSES = Object.freeze([
  'reported', 'under_review', 'approved', 'rejected', 'recovery_scheduled', 'partially_recovered', 'recovered', 'cancelled',
]);
export const DEDUCTION_TYPES = Object.freeze(['loss_recovery', 'authorized_deduction', 'other']);
export const DEDUCTION_STATUSES = Object.freeze(['pending_approval', 'active', 'completed', 'rejected', 'cancelled']);
export const MAX_LOSS_UGX = 100_000_000;

async function readIncident(tx, db, id) {
  const ref = db.collection(LOSSES).doc(requireDocId(id, 'loss incident'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That loss incident could not be found.');
  return { ref, inc: snap.data() };
}

async function readDeduction(tx, db, id) {
  const ref = db.collection(DEDUCTIONS).doc(requireDocId(id, 'deduction'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That deduction could not be found.');
  return { ref, ded: snap.data() };
}

/** A deduction must not be cancelled while an unpaid payroll plans to take it. */
async function requireNotPlanned(tx, db, deductionId) {
  const items = await tx.get(db.collection(PAYROLL_ITEMS).where('current', '==', true).where('paymentStatus', '==', 'unpaid'));
  const hit = items.docs.find((d) => (d.get('deductions') ?? []).some((l) => l.deductionId === deductionId && l.amountUgx > 0));
  if (hit) throw precondition(`Payroll ${hit.get('payrollNumber')} includes this deduction. Correct or cancel that payroll first.`, 'deduction_in_payroll');
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/**
 * Reads (inside [tx]) what a new loss incident needs and returns the function
 * that writes it with its audit entry. Shared by createLossIncident and, in
 * Phase 8, by after-hours cash discrepancies referred for recovery - an
 * incident is only ever REPORTED this way; recovery still needs the Phase 6
 * review, decision and schedule.
 */
export async function prepareLossIncident(tx, db, actor, {
  staffUid = null, type, amount, description, date, attachmentPath = null, notes = null, requestId = null, source = null,
}) {
  const employee = staffUid == null ? null : await readEmployee(tx, db, staffUid, { requireActive: false });
  const numbers = await readCounter(tx, db, 'loss_incidents', 'RMX-LOSS-', 6);
  return () => {
    const number = numbers.next();
    numbers.commit();
    const ref = db.collection(LOSSES).doc();
    tx.set(ref, {
      incidentId: ref.id,
      lossNumber: number,
      ...(employee ? employeeFields(employee) : { staffUid: null, staffId: null, staffName: null, staffRole: null }),
      incidentType: type,
      incidentDate: date,
      amountUgx: amount,
      description,
      attachmentPath,
      notes,
      status: 'reported',
      // A worker sees an incident about them once it has been decided.
      visibleToStaff: false,
      reportedBy: actor.uid, reportedByName: nameOf(actor),
      reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNotes: null,
      approvedBy: null, approvedByName: null, approvedAt: null,
      approvedRecoveryUgx: 0, recoveryReason: null, rejectionReason: null,
      recoveredUgx: 0, outstandingUgx: 0, deductionId: null, deductionNumber: null,
      cancelledBy: null, cancelledAt: null, cancelReason: null, cancelledOutstandingUgx: 0,
      ...(source ? { sourceType: source.type, sourceId: source.id, sourceNumber: source.number } : {}),
      requestId,
      createdAt: stamp(), updatedAt: stamp(), updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'losses', 'loss.created', ref.id, {
      newValue: { lossNumber: number, incidentType: type, amountUgx: amount, staffUid: employee?.uid ?? null, source: source?.number ?? null },
    });
    return { incidentId: ref.id, lossNumber: number };
  };
}

export async function createLossIncident(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const type = requireChoice(data.incidentType, INCIDENT_TYPES, 'Choose the type of loss.', 'incident_type');
  const amount = requireAmount(data.amountUgx, { field: 'loss amount', max: MAX_LOSS_UGX });
  const description = requireText(data.description, 'Description', 1000);
  const date = requireBusinessDate(data.incidentDate, now, { field: 'incident date' });
  const attachmentPath = optionalUpload(data.attachmentPath, 'losses');
  const notes = optionalNotes(data.notes);
  const requestId = requireRequestId(data.requestId);

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'losses.create');
    const request = await readRequest(tx, db, requestId, actor.uid, 'loss_incident');
    if (request.earlier) return request.earlier;
    const write = await prepareLossIncident(tx, db, actor, {
      staffUid: data.staffUid, type, amount, description, date, attachmentPath, notes, requestId,
    });
    const result = write();
    saveRequest(tx, request.ref, 'loss_incident', actor.uid, result);
    return result;
  });
  if (!out.duplicate) {
    for (const uid of await holdersOf(db, ['losses.review', 'losses.approve'], now)) {
      if (uid !== callerUid && uid !== data.staffUid) await notifySafely(deps, uid, NotificationType.lossIncidentCreated, out.incidentId);
    }
  }
  return out;
}

/** Opens the investigation (losses.review); notes are kept. */
export async function reviewLossIncident(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const notes = optionalNotes(data.notes, 'Review notes');
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'losses.review');
    const { ref, inc } = await readIncident(tx, db, data.incidentId);
    requireNotOwn(actor, inc.staffUid, 'You cannot review an incident about yourself.');
    if (inc.status !== 'reported') throw precondition('Only a newly reported incident can be put under review.', 'invalid_status');
    tx.update(ref, {
      status: 'under_review', reviewedBy: actor.uid, reviewedByName: nameOf(actor), reviewedAt: Timestamp.fromMillis(now), reviewNotes: notes,
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'losses', 'loss.reviewed', ref.id, { previousValue: { status: inc.status }, newValue: { status: 'under_review' }, reason: notes });
    return { incidentId: ref.id, status: 'under_review' };
  });
}

/**
 * The decision (losses.approve): approve with the amount the staff member
 * must repay (0 = the business absorbs it; never more than the loss), or
 * reject. Always with a reason.
 */
export async function decideLossIncident(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const decision = requireChoice(data.decision, ['approve', 'reject'], 'Choose approve or reject.', 'decision');
  const reason = requireReason(data.reason);
  const recovery = decision === 'approve' ? requireAmount(data.approvedRecoveryUgx ?? 0, { field: 'recovery amount', min: 0, max: MAX_LOSS_UGX }) : 0;

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'losses.approve');
    const { ref, inc } = await readIncident(tx, db, data.incidentId);
    requireNotOwn(actor, inc.staffUid, 'You cannot decide an incident about yourself.');
    if (inc.status !== 'reported' && inc.status !== 'under_review') throw precondition(`This incident is already ${inc.status.replace('_', ' ')}.`, 'invalid_status');
    if (recovery > inc.amountUgx) throw invalid('The recovery cannot be more than the loss.', 'over_recovery');
    if (recovery > 0 && !inc.staffUid) throw invalid('No staff member is linked to this incident, so nothing can be recovered.', 'no_staff');
    const at = Timestamp.fromMillis(now);
    const update = decision === 'approve'
      ? { status: 'approved', approvedBy: actor.uid, approvedByName: nameOf(actor), approvedAt: at, approvedRecoveryUgx: recovery, recoveryReason: reason, outstandingUgx: recovery }
      : { status: 'rejected', rejectionReason: reason, approvedBy: actor.uid, approvedByName: nameOf(actor), approvedAt: at };
    tx.update(ref, { ...update, visibleToStaff: inc.staffUid != null, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'losses', decision === 'approve' ? 'loss.approved' : 'loss.rejected', ref.id, {
      previousValue: { status: inc.status }, newValue: { status: update.status, amountUgx: inc.amountUgx, approvedRecoveryUgx: recovery }, reason,
    });
    return { incidentId: ref.id, status: update.status, staffUid: inc.staffUid };
  });
  return { incidentId: out.incidentId, status: out.status };
}

/**
 * Schedules the approved recovery through payroll (losses.schedule): one
 * loss_recovery deduction for what is still outstanding.
 */
export async function scheduleLossRecovery(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const instalment = requireAmount(data.instalmentUgx, { field: 'amount per payroll', max: MAX_LOSS_UGX });
  const startsFrom = requireBusinessDate(data.startDate, now, { field: 'first payroll date', futureDays: 400 });
  const reason = requireReason(data.reason, { required: false });

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'losses.schedule');
    const { ref, inc } = await readIncident(tx, db, data.incidentId);
    requireNotOwn(actor, inc.staffUid, 'You cannot schedule a recovery from yourself.');
    if (inc.status !== 'approved' && inc.status !== 'partially_recovered') {
      throw precondition(inc.status === 'recovery_scheduled' ? 'A recovery is already scheduled.' : `A ${inc.status.replace('_', ' ')} incident cannot be scheduled.`, 'invalid_status');
    }
    if (inc.deductionId) {
      const { ded } = await readDeduction(tx, db, inc.deductionId);
      if (ded.status === 'active' || ded.status === 'pending_approval') throw precondition('A recovery is already scheduled.', 'already_scheduled');
    }
    if (!(inc.outstandingUgx > 0)) throw precondition('Nothing is outstanding on this incident.', 'nothing_outstanding');
    if (instalment > inc.outstandingUgx) throw invalid('The amount per payroll cannot be more than what is outstanding.', 'instalment');
    const numbers = await readCounter(tx, db, 'salary_deductions', 'RMX-DED-', 6);
    const number = numbers.next();
    numbers.commit();
    const dRef = db.collection(DEDUCTIONS).doc();
    tx.set(dRef, {
      deductionId: dRef.id, deductionNumber: number,
      staffUid: inc.staffUid, staffId: inc.staffId ?? null, staffName: inc.staffName,
      type: 'loss_recovery',
      reason: inc.recoveryReason, source: { kind: 'loss_incident', id: ref.id, number: inc.lossNumber },
      lossIncidentId: ref.id, lossNumber: inc.lossNumber,
      totalAmountUgx: inc.outstandingUgx, instalmentUgx: instalment, recoveredUgx: 0, remainingUgx: inc.outstandingUgx,
      startsFrom, status: 'active', applications: [],
      approvedBy: inc.approvedBy, approvedByName: inc.approvedByName ?? null, approvedAt: inc.approvedAt,
      scheduleReason: reason, reference: null,
      createdBy: actor.uid, createdByName: nameOf(actor), createdAt: stamp(), updatedAt: stamp(), updatedBy: actor.uid,
      cancelledBy: null, cancelledAt: null, cancelReason: null, rejectionReason: null,
    });
    tx.update(ref, { status: (inc.recoveredUgx ?? 0) > 0 ? 'partially_recovered' : 'recovery_scheduled', deductionId: dRef.id, deductionNumber: number, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'losses', 'loss.recovery_scheduled', ref.id, {
      previousValue: { status: inc.status }, newValue: { deductionNumber: number, totalAmountUgx: inc.outstandingUgx, instalmentUgx: instalment }, reason,
    });
    audit(tx, db, actor, 'payroll', 'deduction.created', dRef.id, {
      newValue: { deductionNumber: number, type: 'loss_recovery', staffUid: inc.staffUid, totalAmountUgx: inc.outstandingUgx, lossNumber: inc.lossNumber },
    });
    return { incidentId: ref.id, deductionId: dRef.id, deductionNumber: number, staffUid: inc.staffUid };
  });
  await notifySafely(deps, out.staffUid, NotificationType.lossRecoveryScheduled, out.deductionId);
  return { incidentId: out.incidentId, deductionId: out.deductionId, deductionNumber: out.deductionNumber };
}

/** Cancels an unfinished incident (losses.adjust); its schedule stops. What was recovered stays recorded. */
export async function cancelLossIncident(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'losses.adjust');
    const { ref, inc } = await readIncident(tx, db, data.incidentId);
    if (['rejected', 'recovered', 'cancelled'].includes(inc.status)) throw precondition(`This incident is already ${inc.status}.`, 'invalid_status');
    let dRef = null;
    if (inc.deductionId) {
      const d = await readDeduction(tx, db, inc.deductionId);
      if (d.ded.status === 'active' || d.ded.status === 'pending_approval') {
        await requireNotPlanned(tx, db, inc.deductionId);
        dRef = d.ref;
      }
    }
    if (dRef) tx.update(dRef, { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: stamp(), cancelReason: reason, updatedAt: stamp(), updatedBy: actor.uid });
    tx.update(ref, {
      status: 'cancelled', cancelledBy: actor.uid, cancelledAt: stamp(), cancelReason: reason,
      cancelledOutstandingUgx: inc.outstandingUgx ?? 0, outstandingUgx: 0, updatedAt: stamp(), updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'losses', 'loss.cancelled', ref.id, {
      previousValue: { status: inc.status, outstandingUgx: inc.outstandingUgx ?? 0 }, newValue: { status: 'cancelled', recoveredUgx: inc.recoveredUgx ?? 0 }, reason,
    });
    return { incidentId: ref.id, status: 'cancelled' };
  });
}

// ---------------------------------------------------------------------------
// Other salary deductions
// ---------------------------------------------------------------------------

export async function createSalaryDeduction(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const type = requireChoice(data.type, ['authorized_deduction', 'other'], 'Choose an authorised salary deduction or another approved deduction.', 'deduction_type');
  const total = requireAmount(data.totalAmountUgx, { field: 'total amount', max: MAX_LOSS_UGX });
  const instalment = data.instalmentUgx == null ? total : requireAmount(data.instalmentUgx, { field: 'amount per payroll', max: MAX_LOSS_UGX });
  if (instalment > total) throw invalid('The amount per payroll cannot be more than the total.', 'instalment');
  const reason = requireReason(data.reason);
  const reference = optionalText(data.reference, 'Reference / source document', 80);
  if (!reference) throw invalid('Enter the source of this deduction (e.g. the signed agreement).', 'source');
  const startsFrom = requireBusinessDate(data.startDate, now, { field: 'first payroll date', futureDays: 400 });
  const requestId = requireRequestId(data.requestId);

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'deductions.manage');
    const request = await readRequest(tx, db, requestId, actor.uid, 'salary_deduction');
    if (request.earlier) return request.earlier;
    const employee = await readEmployee(tx, db, data.staffUid, { requireActive: false });
    requireNotOwn(actor, employee.uid, 'You cannot create a deduction from your own pay.');
    const numbers = await readCounter(tx, db, 'salary_deductions', 'RMX-DED-', 6);
    const number = numbers.next();
    numbers.commit();
    const ref = db.collection(DEDUCTIONS).doc();
    tx.set(ref, {
      deductionId: ref.id, deductionNumber: number,
      staffUid: employee.uid, staffId: employee.staffId, staffName: employee.fullName,
      type, reason, reference, source: { kind: 'manual', id: null, number: reference },
      lossIncidentId: null, lossNumber: null,
      totalAmountUgx: total, instalmentUgx: instalment, recoveredUgx: 0, remainingUgx: total,
      startsFrom, status: 'pending_approval', applications: [],
      approvedBy: null, approvedByName: null, approvedAt: null, rejectionReason: null, scheduleReason: null,
      createdBy: actor.uid, createdByName: nameOf(actor), createdAt: stamp(), updatedAt: stamp(), updatedBy: actor.uid,
      cancelledBy: null, cancelledAt: null, cancelReason: null, requestId,
    });
    audit(tx, db, actor, 'payroll', 'deduction.created', ref.id, {
      newValue: { deductionNumber: number, type, staffUid: employee.uid, totalAmountUgx: total, instalmentUgx: instalment }, reason,
    });
    const result = { deductionId: ref.id, deductionNumber: number, status: 'pending_approval' };
    saveRequest(tx, request.ref, 'salary_deduction', actor.uid, result);
    return result;
  });
  if (!out.duplicate) {
    for (const uid of await holdersOf(db, ['payroll.approve'], now)) {
      if (uid !== callerUid && uid !== data.staffUid) await notifySafely(deps, uid, NotificationType.deductionAwaitingApproval, out.deductionId);
    }
  }
  return out;
}

/** approve / reject a pending deduction (payroll.approve). */
export async function decideSalaryDeduction(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const decision = requireChoice(data.decision, ['approve', 'reject'], 'Choose approve or reject.', 'decision');
  const reason = requireReason(data.reason, { required: decision === 'reject' });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.approve');
    const { ref, ded } = await readDeduction(tx, db, data.deductionId);
    requireNotOwn(actor, ded.staffUid, 'You cannot approve a deduction from your own pay.');
    if (ded.status !== 'pending_approval') throw precondition(`This deduction is ${ded.status.replace('_', ' ')}.`, 'invalid_status');
    const at = Timestamp.fromMillis(now);
    const update = decision === 'approve'
      ? { status: 'active', approvedBy: actor.uid, approvedByName: nameOf(actor), approvedAt: at }
      : { status: 'rejected', rejectionReason: reason };
    tx.update(ref, { ...update, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'payroll', decision === 'approve' ? 'deduction.approved' : 'deduction.rejected', ref.id, {
      previousValue: { status: ded.status }, newValue: { status: update.status, totalAmountUgx: ded.totalAmountUgx }, reason,
    });
    return { deductionId: ref.id, status: update.status };
  });
}

/**
 * Stops a deduction. A loss recovery (losses.adjust) goes back to its incident,
 * which can be rescheduled; others need deductions.manage.
 */
export async function cancelSalaryDeduction(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'deductions.manage', 'losses.adjust');
    const { ref, ded } = await readDeduction(tx, db, data.deductionId);
    if (!holds(actor, ded.type === 'loss_recovery' ? 'losses.adjust' : 'deductions.manage')) {
      throw deny('You do not have permission to cancel this kind of deduction.');
    }
    if (ded.status !== 'active' && ded.status !== 'pending_approval') throw precondition(`This deduction is ${ded.status.replace('_', ' ')}.`, 'invalid_status');
    const incident = ded.lossIncidentId ? await readIncident(tx, db, ded.lossIncidentId) : null;
    await requireNotPlanned(tx, db, ref.id);
    tx.update(ref, { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: stamp(), cancelReason: reason, updatedAt: stamp(), updatedBy: actor.uid });
    if (incident && incident.inc.status !== 'cancelled') {
      tx.update(incident.ref, {
        status: (incident.inc.recoveredUgx ?? 0) > 0 ? 'partially_recovered' : 'approved', deductionId: null, deductionNumber: null,
        updatedAt: stamp(), updatedBy: actor.uid,
      });
    }
    audit(tx, db, actor, 'payroll', 'deduction.cancelled', ref.id, {
      previousValue: { status: ded.status, remainingUgx: ded.remainingUgx }, newValue: { status: 'cancelled', recoveredUgx: ded.recoveredUgx }, reason,
    });
    return { deductionId: ref.id, status: 'cancelled' };
  });
}
