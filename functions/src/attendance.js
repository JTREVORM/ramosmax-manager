// ===========================================================================
// RamosMAX attendance (Phase 6)
// ===========================================================================
//
//   recorded (pending_verification) ──approve──► present | late | absent | excused
//                  │                                        │
//                  └──reject (reason)──► rejected           │
//   any ──correct (attendance.correct, reason)──► pending_verification (re-verify)
//
// One record per staff member per EAT business day: the document ID is
// `{staffUid}_{yyyy-mm-dd}`, so a duplicate is impossible, not merely checked.
// Lateness is computed here from `settings/payroll_policy` (reporting time +
// grace period) and the policy used is copied onto the record, so a later
// policy change never rewrites history. Nothing is deleted or edited in place
// without a trace: a correction stores the original and corrected values in
// `attendance_corrections` and sends the record back for verification.
//
// Sources: `manual` (the app) today. `biometric` and `imported` are part of
// the data model for a future device integration, which will call
// ingestAttendance() from trusted server code; no client can claim them.
// ===========================================================================

import { Timestamp } from 'firebase-admin/firestore';

import { invalid, precondition, requireReason } from './access.js';
import { alreadyExists, audit, freshActor, notFound, requireDocId, stamp } from './operations.js';
import { holdersOf, readCounter } from './finance.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import {
  ALLOWANCES, ATTENDANCE, CORRECTIONS, DAY_MS, PAYROLL_ITEMS, dayKey, dayStart, employeeFields, isoWeekday, minutesOf,
  nameOf, optionalNotes, optionalUpload, readEmployee, readPolicy, requireIdList, requireInstant, requireNotOwn,
} from './workforce.js';

export const ARRIVALS = Object.freeze(['on_time', 'late', 'absent', 'excused']);
export const STATUSES = Object.freeze(['pending_verification', 'present', 'late', 'absent', 'excused', 'rejected']);
export const SOURCES = Object.freeze(['manual', 'biometric', 'imported']);

/** How far back a manager may enter attendance. */
export const MAX_BACKDATE_DAYS = 62;

const VERIFIED_STATUS = { on_time: 'present', late: 'late', absent: 'absent', excused: 'excused' };

export const attendanceId = (staffUid, ms) => `${staffUid}_${dayKey(ms)}`;

/**
 * Arrival facts for a clock-in at [clockInMs] on the day starting [dayMs],
 * under [policy]. Pure: the unit of "late" is whole minutes after the
 * reporting time, and up to the grace period counts as on time.
 */
export function lateness(policy, dayMs, clockInMs) {
  const expected = dayMs + minutesOf(policy.reportingTime) * 60_000;
  const minutesLate = Math.max(0, Math.floor((clockInMs - expected) / 60_000));
  const late = minutesLate > policy.gracePeriodMinutes;
  return { expectedMs: expected, minutesLate, late, severelyLate: late && minutesLate > policy.lateThresholdMinutes };
}

function readInput(data, now, self) {
  const arrival = data.arrival ?? 'present';
  if (!['present', 'absent', 'excused'].includes(arrival)) throw invalid('Choose present, absent or excused.', 'arrival');
  if (self && arrival !== 'present') throw invalid('Ask a manager to record an absence.', 'arrival');
  const today = dayStart(now);
  const day = self || data.date == null ? today : dayStart(requireInstant(data.date, 'date'));
  if (day > today) throw invalid('Attendance cannot be recorded for a future day.', 'date');
  if (day < today - MAX_BACKDATE_DAYS * DAY_MS) throw invalid(`Attendance can be entered for the last ${MAX_BACKDATE_DAYS} days only.`, 'date');
  let clockIn = null;
  let clockOut = null;
  if (arrival === 'present') {
    // Clocking in yourself uses the server's clock, never the phone's.
    clockIn = self ? now : requireInstant(data.clockInAt, 'clock-in time');
    if (clockIn < day || clockIn >= day + DAY_MS) throw invalid('The clock-in time must be on the attendance day.', 'time');
    if (clockIn > now) throw invalid('The clock-in time cannot be in the future.', 'time');
    if (!self && data.clockOutAt != null) {
      clockOut = requireInstant(data.clockOutAt, 'clock-out time');
      if (clockOut <= clockIn) throw invalid('The clock-out time must be after the clock-in time.', 'time');
      if (clockOut > now) throw invalid('The clock-out time cannot be in the future.', 'time');
    }
  } else if (data.clockInAt != null || data.clockOutAt != null) {
    throw invalid('An absence has no clock-in or clock-out time.', 'time');
  }
  const notes = optionalNotes(data.notes);
  if (arrival === 'excused' && !notes) throw invalid('Say why the absence is excused.', 'notes');
  return { arrival, day, clockIn, clockOut, notes, attachmentPath: optionalUpload(data.attachmentPath, 'attendance') };
}

/**
 * Writes one new attendance record inside [tx] (all reads done by the
 * caller except the ones here). Shared by the app's manual entry and by
 * future trusted imports (biometric devices), which pass their [source].
 */
export async function ingestAttendance(tx, db, { employee, policy, input, source, recordedBy, recordedByName, via, external = null }) {
  if (!SOURCES.includes(source)) throw invalid('Unknown attendance source.', 'source');
  const ref = db.collection(ATTENDANCE).doc(attendanceId(employee.uid, input.day));
  if ((await tx.get(ref)).exists) {
    throw alreadyExists(`${employee.fullName} already has attendance for ${dayKey(input.day)}.`, 'duplicate_attendance');
  }
  const numbers = await readCounter(tx, db, 'attendance', 'RMX-ATT-', 6);
  const number = numbers.next();
  numbers.commit();
  const facts = input.clockIn == null ? null : lateness(policy, input.day, input.clockIn);
  const arrivalStatus = input.arrival === 'present' ? (facts.late ? 'late' : 'on_time') : input.arrival;
  const record = {
    attendanceId: ref.id,
    attendanceNumber: number,
    ...employeeFields(employee),
    date: Timestamp.fromMillis(input.day),
    dayKey: dayKey(input.day),
    workingDay: policy.workingDays.includes(isoWeekday(input.day)),
    clockInAt: input.clockIn == null ? null : Timestamp.fromMillis(input.clockIn),
    clockOutAt: input.clockOut == null ? null : Timestamp.fromMillis(input.clockOut),
    reportingTime: policy.reportingTime,
    gracePeriodMinutes: policy.gracePeriodMinutes,
    lateThresholdMinutes: policy.lateThresholdMinutes,
    expectedReportingAt: Timestamp.fromMillis(input.day + minutesOf(policy.reportingTime) * 60_000),
    minutesLate: facts?.minutesLate ?? 0,
    late: facts?.late ?? false,
    severelyLate: facts?.severelyLate ?? false,
    arrivalStatus,
    status: 'pending_verification',
    verificationStatus: 'pending',
    source,
    recordedVia: via,
    deviceId: external?.deviceId ?? null,
    externalRef: external?.externalRef ?? null,
    notes: input.notes,
    attachmentPath: input.attachmentPath,
    verifiedBy: null, verifiedByName: null, verifiedAt: null, verificationNotes: null, rejectionReason: null,
    allowanceId: null,
    correctionCount: 0,
    lastCorrectionId: null,
    recordedBy,
    recordedByName,
    createdAt: stamp(),
    updatedAt: stamp(),
    updatedBy: recordedBy,
  };
  tx.set(ref, record);
  return record;
}

/**
 * Clock-in (self, `attendance.mark`, server time) or a manual entry for
 * someone else (`attendance.record`: present with times, absent or excused).
 */
export async function recordAttendance(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const self = data.staffUid == null || data.staffUid === callerUid;
  const input = readInput(data, now, self);

  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, ...(self ? ['attendance.mark', 'attendance.record'] : ['attendance.record']));
    const employee = await readEmployee(tx, db, self ? callerUid : data.staffUid);
    const policy = await readPolicy(tx, db);
    const record = await ingestAttendance(tx, db, {
      employee, policy, input, source: 'manual', recordedBy: actor.uid, recordedByName: nameOf(actor), via: self ? 'self' : 'manager',
    });
    audit(tx, db, actor, 'attendance', 'attendance.recorded', record.attendanceId, {
      newValue: {
        attendanceNumber: record.attendanceNumber, staffUid: employee.uid, dayKey: record.dayKey, arrivalStatus: record.arrivalStatus,
        minutesLate: record.minutesLate, source: 'manual', via: record.recordedVia,
      },
    });
    return { attendanceId: record.attendanceId, attendanceNumber: record.attendanceNumber, arrivalStatus: record.arrivalStatus, minutesLate: record.minutesLate, late: record.late };
  });
  // A late self clock-in is flagged to reviewers; on-time ones wait in the queue.
  if (self && result.late) {
    for (const uid of await holdersOf(db, ['attendance.approve', 'attendance.review'], now)) {
      if (uid !== callerUid) await notifySafely(deps, uid, NotificationType.attendanceReview, result.attendanceId);
    }
  }
  return result;
}

async function readAttendance(tx, db, id) {
  const ref = db.collection(ATTENDANCE).doc(requireDocId(id, 'attendance record'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That attendance record could not be found.');
  return { ref, rec: snap.data() };
}

/** Clock-out: yourself (today, server time) or, with attendance.record, for someone else at a given time. */
export async function clockOut(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const self = data.attendanceId == null;
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, ...(self ? ['attendance.mark', 'attendance.record'] : ['attendance.record']));
    const { ref, rec } = await readAttendance(tx, db, self ? attendanceId(callerUid, now) : data.attendanceId);
    if (self && rec.staffUid !== callerUid) throw invalid('That attendance record is not yours.', 'not_own');
    if (rec.clockInAt == null) throw precondition('There is no clock-in to clock out from.', 'no_clock_in');
    if (rec.clockOutAt != null) throw precondition('Already clocked out.', 'already_clocked_out');
    if (rec.verificationStatus !== 'pending') throw precondition('This record has been verified. Ask for a correction instead.', 'verified');
    const at = self ? now : requireInstant(data.clockOutAt, 'clock-out time');
    if (at <= rec.clockInAt.toMillis()) throw invalid('The clock-out time must be after the clock-in time.', 'time');
    if (at > now) throw invalid('The clock-out time cannot be in the future.', 'time');
    tx.update(ref, { clockOutAt: Timestamp.fromMillis(at), updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'attendance', 'attendance.clocked_out', ref.id, { newValue: { clockOutAt: at, via: self ? 'self' : 'manager' } });
    return { attendanceId: ref.id };
  });
}

/**
 * Manager verification. approve (`attendance.approve`) or reject
 * (`attendance.review` or `attendance.approve`, with a reason); up to 50
 * records at once. Nobody verifies their own attendance.
 */
export async function verifyAttendance(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const action = data.action;
  if (action !== 'approve' && action !== 'reject') throw invalid('Choose approve or reject.', 'action');
  const ids = requireIdList(data.attendanceIds ?? data.attendanceId, 'attendance record');
  const reason = requireReason(data.reason, { required: action === 'reject' });
  const notes = optionalNotes(data.notes);

  const rejected = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, ...(action === 'approve' ? ['attendance.approve'] : ['attendance.review', 'attendance.approve']));
    const policy = await readPolicy(tx, db);
    const records = [];
    for (const id of ids) records.push(await readAttendance(tx, db, id));
    const at = Timestamp.fromMillis(now);
    for (const { rec } of records) {
      requireNotOwn(actor, rec.staffUid, 'You cannot verify your own attendance.');
      if (rec.verificationStatus !== 'pending') {
        throw precondition(`${rec.attendanceNumber} has already been ${rec.verificationStatus}.`, 'already_verified');
      }
      if (action === 'approve' && policy.requireClockOut && rec.clockInAt && !rec.clockOutAt) {
        throw precondition(`${rec.attendanceNumber} has no clock-out yet.`, 'no_clock_out');
      }
    }
    for (const { ref, rec } of records) {
      const status = action === 'approve' ? VERIFIED_STATUS[rec.arrivalStatus] : 'rejected';
      tx.update(ref, {
        status,
        verificationStatus: action === 'approve' ? 'approved' : 'rejected',
        verifiedBy: actor.uid, verifiedByName: nameOf(actor), verifiedAt: at, verificationNotes: notes,
        rejectionReason: action === 'reject' ? reason : null,
        updatedAt: stamp(), updatedBy: actor.uid,
      });
      audit(tx, db, actor, 'attendance', action === 'approve' ? 'attendance.approved' : 'attendance.rejected', ref.id, {
        previousValue: { status: rec.status }, newValue: { status, arrivalStatus: rec.arrivalStatus, minutesLate: rec.minutesLate },
        reason: reason ?? notes,
      });
    }
    return action === 'reject' ? records.map(({ rec }) => [rec.staffUid, rec.attendanceId]) : [];
  });
  for (const [uid, id] of rejected) await notifySafely(deps, uid, NotificationType.attendanceRejected, id);
  return { count: ids.length, status: action === 'approve' ? 'approved' : 'rejected' };
}

const CORRECTABLE = ['clockInAt', 'clockOutAt', 'arrival', 'notes'];

/**
 * An authorised correction. The original and corrected values, the reason and
 * who made it are kept in `attendance_corrections`; the record goes back to
 * pending verification. An allowance not yet paid or in a payroll is
 * cancelled (it will be recalculated); a paid one must be reversed first.
 */
export async function correctAttendance(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  if (!CORRECTABLE.some((k) => k in data)) throw invalid('Nothing to correct.', 'no_changes');

  let staffUid = null;
  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'attendance.correct');
    const { ref, rec } = await readAttendance(tx, db, data.attendanceId);
    requireNotOwn(actor, rec.staffUid, 'You cannot correct your own attendance.');
    const policy = { reportingTime: rec.reportingTime, gracePeriodMinutes: rec.gracePeriodMinutes, lateThresholdMinutes: rec.lateThresholdMinutes };
    const day = rec.date.toMillis();
    const was = {
      arrival: rec.arrivalStatus === 'on_time' || rec.arrivalStatus === 'late' ? 'present' : rec.arrivalStatus,
      clockIn: rec.clockInAt?.toMillis() ?? null,
      clockOut: rec.clockOutAt?.toMillis() ?? null,
      notes: rec.notes ?? null,
    };
    const arrival = 'arrival' in data ? data.arrival : was.arrival;
    if (!['present', 'absent', 'excused'].includes(arrival)) throw invalid('Choose present, absent or excused.', 'arrival');
    let clockIn = 'clockInAt' in data ? (data.clockInAt == null ? null : requireInstant(data.clockInAt, 'clock-in time')) : was.clockIn;
    let clockOut = 'clockOutAt' in data ? (data.clockOutAt == null ? null : requireInstant(data.clockOutAt, 'clock-out time')) : was.clockOut;
    if (arrival !== 'present') {
      clockIn = null;
      clockOut = null;
    } else {
      if (clockIn == null) throw invalid('A present day needs a clock-in time.', 'time');
      if (clockIn < day || clockIn >= day + DAY_MS) throw invalid('The clock-in time must be on the attendance day.', 'time');
      if (clockIn > now || (clockOut != null && clockOut > now)) throw invalid('Times cannot be in the future.', 'time');
      if (clockOut != null && clockOut <= clockIn) throw invalid('The clock-out time must be after the clock-in time.', 'time');
    }
    const notes = 'notes' in data ? optionalNotes(data.notes) : was.notes;
    if (arrival === 'excused' && !notes) throw invalid('Say why the absence is excused.', 'notes');
    const next = { arrival, clockIn, clockOut, notes };
    const changed = Object.keys(next).filter((k) => next[k] !== was[k]);
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');

    // The allowance that depended on the old facts.
    let allowance = null;
    if (rec.allowanceId) {
      const aRef = db.collection(ALLOWANCES).doc(rec.allowanceId);
      const aSnap = await tx.get(aRef);
      if (aSnap.exists) {
        const a = aSnap.data();
        if (a.status === 'paid') {
          throw precondition(`Its allowance ${a.allowanceNumber} has been paid. Reverse the payment before correcting attendance.`, 'allowance_paid');
        }
        if (['calculated', 'pending_approval', 'approved'].includes(a.status)) {
          const inPayroll = await tx.get(db.collection(PAYROLL_ITEMS).where('current', '==', true).where('allowanceIds', 'array-contains', rec.allowanceId).limit(1));
          if (!inPayroll.empty) {
            throw precondition(`Its allowance ${a.allowanceNumber} is in payroll ${inPayroll.docs[0].get('payrollNumber')}. Correct the payroll first.`, 'allowance_in_payroll');
          }
          allowance = { ref: aRef, data: a };
        }
      }
    }

    const facts = clockIn == null ? null : lateness(policy, day, clockIn);
    const arrivalStatus = arrival === 'present' ? (facts.late ? 'late' : 'on_time') : arrival;
    const corrRef = db.collection(CORRECTIONS).doc();
    const plain = (o) => ({ arrivalStatus: o.arrivalStatus, clockInAt: o.clockIn, clockOutAt: o.clockOut, notes: o.notes, status: o.status });
    const previous = plain({ ...was, arrivalStatus: rec.arrivalStatus, status: rec.status });
    const corrected = plain({ ...next, arrivalStatus, status: 'pending_verification' });
    tx.set(corrRef, {
      correctionId: corrRef.id,
      attendanceId: ref.id,
      attendanceNumber: rec.attendanceNumber,
      staffUid: rec.staffUid,
      staffName: rec.staffName,
      dayKey: rec.dayKey,
      previousValue: previous,
      newValue: corrected,
      changedFields: changed,
      reason,
      cancelledAllowanceId: allowance ? rec.allowanceId : null,
      correctedBy: actor.uid,
      correctedByName: nameOf(actor),
      createdAt: stamp(),
    });
    tx.update(ref, {
      clockInAt: clockIn == null ? null : Timestamp.fromMillis(clockIn),
      clockOutAt: clockOut == null ? null : Timestamp.fromMillis(clockOut),
      minutesLate: facts?.minutesLate ?? 0,
      late: facts?.late ?? false,
      severelyLate: facts?.severelyLate ?? false,
      arrivalStatus,
      notes,
      status: 'pending_verification',
      verificationStatus: 'pending',
      verifiedBy: null, verifiedByName: null, verifiedAt: null, verificationNotes: null, rejectionReason: null,
      allowanceId: allowance ? null : rec.allowanceId,
      correctionCount: (rec.correctionCount ?? 0) + 1,
      lastCorrectionId: corrRef.id,
      updatedAt: stamp(),
      updatedBy: actor.uid,
    });
    if (allowance) {
      tx.update(allowance.ref, {
        status: 'cancelled', cancelledBy: actor.uid, cancelledAt: stamp(),
        cancelReason: `Attendance ${rec.attendanceNumber} corrected: ${reason}`, updatedAt: stamp(), updatedBy: actor.uid,
      });
      audit(tx, db, actor, 'payroll', 'allowance.cancelled', allowance.ref.id, {
        previousValue: { status: allowance.data.status }, newValue: { status: 'cancelled', attendanceId: ref.id }, reason,
      });
    }
    audit(tx, db, actor, 'attendance', 'attendance.corrected', ref.id, { previousValue: previous, newValue: corrected, reason });
    staffUid = rec.staffUid ?? null;
    return { attendanceId: ref.id, correctionId: corrRef.id, cancelledAllowanceId: allowance ? rec.allowanceId : null };
  });
  // Phase 9: the staff member sees that their record changed (never who or why on a lock screen).
  if (staffUid) await notifySafely(deps, staffUid, NotificationType.attendanceCorrected, result.attendanceId);
  return result;
}

