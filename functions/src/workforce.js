// ===========================================================================
// RamosMAX workforce - shared by attendance, allowances, payroll and losses
// (Phase 6).
// ===========================================================================
// * The attendance / allowance / payroll policy (`settings/payroll_policy`),
//   read with defaults and changed only by updatePayrollPolicy (settings.manage).
// * Who an employee is: the `users/{uid}` profile. Every Phase 6 record is
//   keyed by that uid (`staffUid`) and carries the staff ID and name as they
//   were at the time, so a worker's own records are exactly the ones whose
//   `staffUid` is their sign-in uid (firebase/firestore.rules).
// * Which salary version applies on a date: the newest `salary_history`
//   version whose effectiveFrom is on or before that day.
// * Evidence uploads under `payroll_uploads/{kind}/{uploadId}/{file}`.
// ===========================================================================

import { Timestamp } from 'firebase-admin/firestore';

import { deny, invalid, optionalText, precondition, requireReason } from './access.js';
import { audit, freshActor, notFound, stamp } from './operations.js';
import { dayKey, dayStart, requireAmount } from './finance.js';
import { requireObject, requireUid } from './user_admin.js';

export const USERS = 'users';
export const POLICY_DOC = ['settings', 'payroll_policy'];
export const ATTENDANCE = 'attendance';
export const CORRECTIONS = 'attendance_corrections';
export const ALLOWANCES = 'worker_allowances';
export const SALARY_PROFILES = 'salary_profiles';
export const SALARY_HISTORY = 'salary_history';
export const PAYROLL = 'payroll';
export const PAYROLL_ITEMS = 'payroll_items';
export const DEDUCTIONS = 'salary_deductions';
export const LOSSES = 'loss_incidents';

export const DAY_MS = 24 * 3600_000;
const EAT_MS = 3 * 3600_000;

/** Late-arrival allowance policies (the brief's FULL / DEDUCT / REJECT). */
export const LATE_POLICIES = Object.freeze(['full', 'deduct', 'reject']);
export const ROLES_WITH_PAY = Object.freeze(['admin', 'manager', 'cashier', 'worker']);

/**
 * The defaults in force until an Administrator saves `settings/payroll_policy`.
 * The daily allowance (UGX 5,000) lives here and nowhere else.
 */
export const DEFAULT_POLICY = Object.freeze({
  reportingTime: '08:00',
  workingDays: Object.freeze([1, 2, 3, 4, 5, 6]), // ISO weekdays: Monday = 1 … Sunday = 7
  gracePeriodMinutes: 15,
  lateThresholdMinutes: 120,
  requireClockOut: false,
  allowanceOnNonWorkingDays: false,
  defaultDailyAllowanceUgx: 5000,
  allowanceEligibleRoles: Object.freeze(['cashier', 'manager', 'worker']),
  lateAllowancePolicy: 'deduct',
  lateDeductionUgx: 2500,
  maxLateDeductionUgx: 5000,
  allowanceApprovalRequired: true,
  maxDeductionPercentOfGross: 100,
  payrollRequiresAdminApproval: true,
});

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const minutesOf = (hhmm) => {
  const m = TIME.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** ISO weekday (Mon = 1 … Sun = 7) of the EAT day containing [ms]. */
export const isoWeekday = (ms) => ((new Date(ms + EAT_MS).getUTCDay() + 6) % 7) + 1;

/** Stored policy merged over the defaults (unknown keys ignored). */
export function policyFrom(data) {
  const p = { ...DEFAULT_POLICY };
  for (const k of Object.keys(DEFAULT_POLICY)) if (data && data[k] !== undefined && data[k] !== null) p[k] = data[k];
  return p;
}

export async function readPolicy(tx, db) {
  const snap = await tx.get(db.collection(POLICY_DOC[0]).doc(POLICY_DOC[1]));
  return policyFrom(snap.exists ? snap.data() : null);
}

function intIn(v, min, max, message) {
  if (!Number.isInteger(v) || v < min || v > max) throw invalid(message, 'policy');
  return v;
}

/** Validates a full policy (after merging the requested changes). */
export function validatePolicy(p) {
  if (minutesOf(p.reportingTime) == null) throw invalid('Enter the reporting time as HH:MM, e.g. 08:00.', 'policy');
  if (!Array.isArray(p.workingDays) || p.workingDays.length === 0 || p.workingDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw invalid('Choose at least one working day.', 'policy');
  }
  p.workingDays = [...new Set(p.workingDays)].sort();
  intIn(p.gracePeriodMinutes, 0, 240, 'The grace period must be between 0 and 240 minutes.');
  intIn(p.lateThresholdMinutes, 1, 720, 'The late threshold must be between 1 and 720 minutes.');
  if (p.lateThresholdMinutes <= p.gracePeriodMinutes) throw invalid('The late threshold must be longer than the grace period.', 'policy');
  for (const k of ['requireClockOut', 'allowanceOnNonWorkingDays', 'allowanceApprovalRequired', 'payrollRequiresAdminApproval']) {
    if (typeof p[k] !== 'boolean') throw invalid('A policy switch is not valid.', 'policy');
  }
  requireAmount(p.defaultDailyAllowanceUgx, { field: 'default daily allowance', min: 0, max: 1_000_000 });
  if (!Array.isArray(p.allowanceEligibleRoles) || p.allowanceEligibleRoles.some((r) => !ROLES_WITH_PAY.includes(r))) {
    throw invalid('Choose valid roles for allowance eligibility.', 'policy');
  }
  p.allowanceEligibleRoles = [...new Set(p.allowanceEligibleRoles)].sort();
  if (!LATE_POLICIES.includes(p.lateAllowancePolicy)) throw invalid('Choose full, deduct or reject for late arrivals.', 'policy');
  requireAmount(p.lateDeductionUgx, { field: 'late deduction', min: 0, max: 1_000_000 });
  requireAmount(p.maxLateDeductionUgx, { field: 'maximum late deduction', min: 0, max: 1_000_000 });
  if (p.lateDeductionUgx > p.maxLateDeductionUgx) throw invalid('The late deduction cannot exceed the maximum deduction.', 'policy');
  intIn(p.maxDeductionPercentOfGross, 0, 100, 'Payroll deductions are limited to between 0% and 100% of gross pay.');
  return p;
}

/** Admin: changes the policy. Each change is audited with before/after. */
export async function updatePayrollPolicy(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  const changes = requireObject(data.changes ?? {});
  const unknown = Object.keys(changes).filter((k) => !(k in DEFAULT_POLICY));
  if (unknown.length > 0) throw invalid('One of the settings is not recognised.', 'policy');
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'settings.manage');
    const stored = await readPolicy(tx, db);
    // Compare normalised copies (validation sorts the lists).
    const before = validatePolicy({ ...stored, workingDays: [...stored.workingDays], allowanceEligibleRoles: [...stored.allowanceEligibleRoles] });
    const next = validatePolicy(policyFrom({ ...before, ...changes }));
    const changed = Object.keys(DEFAULT_POLICY).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');
    tx.set(db.collection(POLICY_DOC[0]).doc(POLICY_DOC[1]), { ...next, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'payroll', 'payroll_policy.updated', POLICY_DOC[1], {
      previousValue: Object.fromEntries(changed.map((k) => [k, before[k]])),
      newValue: Object.fromEntries(changed.map((k) => [k, next[k]])),
      reason,
    });
    return { changed };
  });
}

// ---------------------------------------------------------------------------
// Employees and salary versions
// ---------------------------------------------------------------------------

/** The employee behind [uid] (their users profile). */
export async function readEmployee(tx, db, uidInput, { requireActive = true } = {}) {
  const uid = requireUid(uidInput);
  const snap = await tx.get(db.collection(USERS).doc(uid));
  if (!snap.exists) throw notFound('That staff member could not be found.', 'staff_not_found');
  const u = snap.data();
  if (requireActive && u.active !== true) throw precondition(`${u.fullName ?? 'This staff member'}'s account is not active.`, 'staff_inactive');
  return { uid, staffId: u.staffId ?? null, fullName: u.fullName ?? uid, role: u.role ?? null, active: u.active === true };
}

export const employeeFields = (e) => ({ staffUid: e.uid, staffId: e.staffId, staffName: e.fullName, staffRole: e.role });

/** Versions are ordered by effective date, then by version number. */
const newer = (a, b) => (a.effectiveFrom.toMillis() - b.effectiveFrom.toMillis()) || (a.version - b.version);

/**
 * The salary version for [staffUid] in force on the EAT day containing
 * [dateMs] (null when none has started yet). [versions] are salary_history
 * documents' data.
 */
export function versionOn(versions, staffUid, dateMs) {
  const day = dayStart(dateMs);
  let best = null;
  for (const v of versions) {
    if (v.staffUid !== staffUid || v.effectiveFrom.toMillis() > day) continue;
    if (!best || newer(v, best) > 0) best = v;
  }
  return best;
}

export async function readVersions(tx, db, staffUid) {
  const snap = await tx.get(db.collection(SALARY_HISTORY).where('staffUid', '==', staffUid));
  return snap.docs.map((d) => d.data());
}

// ---------------------------------------------------------------------------
// Small shared rules
// ---------------------------------------------------------------------------

/** The caller holds any of [perms] (legacy names are listed by the caller). */
export const holds = (actor, ...perms) => perms.some((p) => actor.perms.has(p));

/** Refuses to let someone act on their own attendance, allowance, salary or incident. */
export function requireNotOwn(actor, staffUid, message) {
  if (actor.uid === staffUid) throw deny(message, 'self_action');
}

export function requireIdList(input, what, max = 50) {
  const list = Array.isArray(input) ? input : input == null ? [] : [input];
  if (list.length === 0) throw invalid(`Choose at least one ${what}.`, 'ids');
  if (list.length > max) throw invalid(`Choose at most ${max} at a time.`, 'ids');
  for (const id of list) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalid(`Choose a valid ${what}.`, 'id');
  }
  return [...new Set(list)];
}

/** Epoch millis inside the allowed range, or throws. */
export function requireInstant(input, field) {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < Date.UTC(2020, 0, 1)) {
    throw invalid(`Choose a valid ${field}.`, 'time');
  }
  return Math.trunc(input);
}

export const UPLOAD_KINDS = Object.freeze(['attendance', 'losses', 'payroll']);

/** `payroll_uploads/{kind}/{uploadId}/{file}` (firebase/storage.rules), uploaded before the call. */
export function optionalUpload(input, kind) {
  if (input == null || input === '') return null;
  const re = new RegExp(`^payroll_uploads/${kind}/[A-Za-z0-9_-]{8,64}/[A-Za-z0-9._-]{1,100}$`);
  if (typeof input !== 'string' || !re.test(input)) throw invalid('The attachment could not be saved.', 'attachment');
  return input;
}

export const optionalNotes = (input, field = 'Notes') => optionalText(input, field, 500);

export const tsDay = (ms) => Timestamp.fromMillis(dayStart(ms));
export { dayKey, dayStart };

export const nameOf = (a) => a.data.fullName ?? null;
