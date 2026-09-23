// ===========================================================================
// RamosMAX salary profiles and payroll (Phase 6)
// ===========================================================================
//
// Salary: `salary_profiles/{staffUid}` is the latest version, for display.
// Every change is a NEW `salary_history` version with an effective date;
// versions are never edited. Payroll uses the version in force on the last
// day of its period and copies the figures onto each payroll item, so a later
// salary change never alters an earlier payroll.
//
// Payroll:
//
//   draft ──prepare──► prepared ──submit──► pending_review ──review──► (reviewed) ──approve──► approved ──pay──► paid ──lock──► locked
//                        ▲   │                   │                                          │               │
//                        │   └─ earnings ±       └──return (reason)──► prepared             │               │
//                        └───────── correct (payroll.adjust, reason) ◄──────────────────────┘               │
//   approved ◄──── reverse payment (payroll.adjust, reason; not once locked) ────────────────────────────────┘
//   draft / prepared / pending_review / approved ──cancel (reason)──► cancelled
//
// Per employee (payroll_items), all computed here:
//   gross = basic salary + approved allowances not yet paid + other earnings
//   deductions = authorised salary deductions + approved loss recoveries + other approved deductions
//                (each from an approved `salary_deductions` record, never more than its remaining
//                 balance, and together never more than maxDeductionPercentOfGross of gross)
//   net = gross − deductions   (never negative)
// Preparing again writes a new version of the items; the old ones are kept,
// marked superseded. Balances (allowances paid, recoveries, loss outstanding)
// change only when the payroll is PAID, in one transaction with ONE
// `payroll_payment` ledger entry for the whole payroll (finance.js).
// ===========================================================================

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { deny, invalid, optionalText, precondition, requireReason } from './access.js';
import { alreadyExists, audit, freshActor, notFound, requireDocId, stamp, uniqueRef } from './operations.js';
import {
  holdersOf, openLedger, postReversal, readCounter, readRequest, readTransaction, requireAmount, requireBusinessDate,
  requireRequestId, requireText, saveRequest,
} from './finance.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import {
  ALLOWANCES, DAY_MS, DEDUCTIONS, LOSSES, PAYROLL, PAYROLL_ITEMS, SALARY_HISTORY, SALARY_PROFILES, dayKey, dayStart,
  employeeFields, isoWeekday, nameOf, optionalNotes, readEmployee, readPolicy, readVersions, requireInstant,
  requireNotOwn, versionOn,
} from './workforce.js';

export const MAX_SALARY_UGX = 100_000_000;
export const FREQUENCIES = Object.freeze(['monthly', 'weekly']);
export const PAYROLL_STATUSES = Object.freeze(['draft', 'prepared', 'pending_review', 'approved', 'paid', 'locked', 'cancelled']);
const EAT_MS = 3 * 3600_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Legacy Phase 1 names still honoured: payroll.process = prepare.
const PREPARE = ['payroll.prepare', 'payroll.process'];

// ---------------------------------------------------------------------------
// Salary profiles (effective-dated, append-only history)
// ---------------------------------------------------------------------------

const newestFirst = (a, b) => (b.effectiveFrom.toMillis() - a.effectiveFrom.toMillis()) || (b.version - a.version);
const SALARY_FIELDS = ['basicSalaryUgx', 'paymentFrequency', 'allowanceEligible', 'allowanceAmountUgx', 'active'];

export async function setSalaryProfile(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const basic = requireAmount(data.basicSalaryUgx, { field: 'basic salary', min: 0, max: MAX_SALARY_UGX });
  const frequency = FREQUENCIES.includes(data.paymentFrequency ?? 'monthly') ? (data.paymentFrequency ?? 'monthly') : null;
  if (!frequency) throw invalid('Choose monthly or weekly.', 'frequency');
  const allowanceAmount = data.allowanceAmountUgx == null ? null : requireAmount(data.allowanceAmountUgx, { field: 'daily allowance', max: 1_000_000 });
  const active = data.active !== false;
  const notes = optionalNotes(data.notes);
  const effective = requireBusinessDate(data.effectiveFrom, now, { field: 'effective date', futureDays: 366 });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'salary.manage');
    const employee = await readEmployee(tx, db, data.staffUid, { requireActive: false });
    requireNotOwn(actor, employee.uid, 'You cannot set your own salary.');
    const policy = await readPolicy(tx, db);
    const versions = (await readVersions(tx, db, employee.uid)).sort(newestFirst);
    const latest = versions[0] ?? null;
    const eligible = typeof data.allowanceEligible === 'boolean' ? data.allowanceEligible
      : latest ? latest.allowanceEligible : policy.allowanceEligibleRoles.includes(employee.role);
    const reason = requireReason(data.reason, { required: latest != null });
    if (latest && effective.toMillis() < latest.effectiveFrom.toMillis()) {
      throw precondition(`A later salary version already takes effect on ${dayKey(latest.effectiveFrom.toMillis())}. Changes cannot be backdated before it.`, 'backdated');
    }
    const next = { basicSalaryUgx: basic, paymentFrequency: frequency, allowanceEligible: eligible, allowanceAmountUgx: allowanceAmount, active };
    if (latest && SALARY_FIELDS.every((k) => (latest[k] ?? null) === (next[k] ?? null)) && (latest.notes ?? null) === notes
        && latest.effectiveFrom.toMillis() === effective.toMillis()) {
      throw precondition('Nothing has changed.', 'no_changes');
    }
    const version = (latest?.version ?? 0) + 1;
    const historyId = `${employee.uid}_v${version}`;
    const previous = latest ? Object.fromEntries(SALARY_FIELDS.map((k) => [k, latest[k] ?? null])) : null;
    tx.set(db.collection(SALARY_HISTORY).doc(historyId), {
      historyId,
      ...employeeFields(employee),
      version,
      ...next,
      effectiveFrom: effective,
      notes,
      reason,
      previousValue: previous,
      previousHistoryId: latest?.historyId ?? null,
      createdBy: actor.uid,
      createdByName: nameOf(actor),
      createdAt: stamp(),
    });
    tx.set(db.collection(SALARY_PROFILES).doc(employee.uid), {
      ...employeeFields(employee),
      ...next,
      effectiveFrom: effective,
      currentHistoryId: historyId,
      version,
      notes,
      updatedBy: actor.uid,
      updatedByName: nameOf(actor),
      updatedAt: stamp(),
      ...(latest ? {} : { createdBy: actor.uid, createdAt: stamp() }),
    }, { merge: true });
    const action = !latest ? 'salary.created'
      : latest.active && !active ? 'salary.deactivated'
        : !latest.active && active ? 'salary.activated' : 'salary.changed';
    audit(tx, db, actor, 'payroll', action, employee.uid, {
      previousValue: previous, newValue: { ...next, effectiveFrom: dayKey(effective.toMillis()), version }, reason,
    });
    return { staffUid: employee.uid, historyId, version };
  });
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** {frequency, periodKey, label, startMs, endMs (exclusive), lastDayMs} for the request. Pure. */
export function periodFor(data, now) {
  const frequency = data.frequency ?? 'monthly';
  if (!FREQUENCIES.includes(frequency)) throw invalid('Choose monthly or weekly.', 'frequency');
  let start;
  let end;
  let key;
  let label;
  if (frequency === 'monthly') {
    const y = data.year;
    const m = data.month;
    if (!Number.isInteger(y) || y < 2020 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) throw invalid('Choose a valid month.', 'period');
    start = Date.UTC(y, m - 1, 1) - EAT_MS;
    end = Date.UTC(y, m, 1) - EAT_MS;
    key = `${y}-${String(m).padStart(2, '0')}`;
    label = `${MONTHS[m - 1]} ${y}`;
  } else {
    start = dayStart(requireInstant(data.weekStart, 'week start'));
    if (isoWeekday(start) !== 1) throw invalid('A weekly payroll starts on a Monday.', 'period');
    end = start + 7 * DAY_MS;
    key = `W${dayKey(start)}`;
    label = `Week of ${dayKey(start)}`;
  }
  if (start > dayStart(now)) throw invalid('A payroll period cannot start in the future.', 'period');
  return { frequency, periodKey: key, label, startMs: start, endMs: end, lastDayMs: end - DAY_MS };
}

export async function createPayroll(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const p = periodFor(data, now);
  const notes = optionalNotes(data.notes);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, ...PREPARE);
    const once = uniqueRef(db, 'payroll', `${p.frequency}_${p.periodKey}`);
    const existing = await tx.get(once);
    if (existing.exists) {
      throw alreadyExists(`There is already a ${p.frequency} payroll for ${p.label} (${existing.get('payrollNumber')}).`, 'duplicate_payroll');
    }
    const numbers = await readCounter(tx, db, 'payroll', 'RMX-PAY-', 6);
    const number = numbers.next();
    numbers.commit();
    const ref = db.collection(PAYROLL).doc();
    tx.set(ref, {
      payrollId: ref.id, payrollNumber: number,
      frequency: p.frequency, periodKey: p.periodKey, periodLabel: p.label,
      periodStart: Timestamp.fromMillis(p.startMs), periodEnd: Timestamp.fromMillis(p.endMs), periodLastDay: Timestamp.fromMillis(p.lastDayMs),
      status: 'draft', version: 0, employeeCount: 0, ...zeroTotals(), earningEntries: [], notes,
      createdBy: actor.uid, createdByName: nameOf(actor), createdAt: stamp(),
      preparedBy: null, preparedByName: null, preparedAt: null, submittedBy: null, submittedAt: null,
      reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNotes: null, returnedReason: null,
      approvedBy: null, approvedByName: null, approvedAt: null,
      paidBy: null, paidByName: null, paidAt: null, paymentDate: null, paymentReference: null, paidFromAccountId: null, paidFromAccountName: null,
      financialTransactionId: null, financialTransactionNumber: null,
      lockedBy: null, lockedAt: null, cancelledBy: null, cancelledAt: null, cancelReason: null,
      correctionCount: 0, lastCorrectionReason: null,
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    tx.set(once, { kind: 'payroll', payrollId: ref.id, payrollNumber: number });
    audit(tx, db, actor, 'payroll', 'payroll.created', ref.id, { newValue: { payrollNumber: number, frequency: p.frequency, periodKey: p.periodKey } });
    return { payrollId: ref.id, payrollNumber: number, periodKey: p.periodKey };
  });
}

// ---------------------------------------------------------------------------
// Calculation (pure) - unit tested in functions/test/payroll.test.js
// ---------------------------------------------------------------------------

const TOTAL_KEYS = ['totalBasicUgx', 'totalAllowancesUgx', 'totalOtherEarningsUgx', 'totalGrossUgx', 'totalSalaryDeductionsUgx',
  'totalLossRecoveriesUgx', 'totalOtherDeductionsUgx', 'totalDeductionsUgx', 'totalNetUgx'];
const zeroTotals = () => Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));

const BUCKET = { authorized_deduction: 'salaryDeductionsUgx', loss_recovery: 'lossRecoveriesUgx', other: 'otherDeductionsUgx' };

/**
 * One employee's pay. [deductions] are the approved, active schedules in
 * order; each takes min(instalment, remaining), and the total is capped at
 * [capPercent]% of gross so net pay is never negative.
 */
export function payFor({ basicUgx, allowances, earnings, deductions, capPercent }) {
  const allowancesUgx = allowances.reduce((s, a) => s + a.approvedAmountUgx, 0);
  const otherEarningsUgx = earnings.reduce((s, e) => s + e.amountUgx, 0);
  const grossUgx = basicUgx + allowancesUgx + otherEarningsUgx;
  const cap = Math.floor((grossUgx * capPercent) / 100);
  let left = cap;
  let capped = false;
  const lines = [];
  const buckets = { salaryDeductionsUgx: 0, lossRecoveriesUgx: 0, otherDeductionsUgx: 0 };
  for (const d of deductions) {
    const planned = Math.min(d.instalmentUgx, d.remainingUgx);
    const amount = Math.max(0, Math.min(planned, left));
    if (amount < planned) capped = true;
    left -= amount;
    lines.push({
      deductionId: d.deductionId, deductionNumber: d.deductionNumber, type: d.type, reason: d.reason ?? null,
      lossIncidentId: d.lossIncidentId ?? null, lossNumber: d.lossNumber ?? null, plannedUgx: planned, amountUgx: amount,
    });
    buckets[BUCKET[d.type]] += amount;
  }
  const totalDeductionsUgx = buckets.salaryDeductionsUgx + buckets.lossRecoveriesUgx + buckets.otherDeductionsUgx;
  return {
    basicSalaryUgx: basicUgx, allowancesUgx, allowanceDays: allowances.length, otherEarningsUgx, grossUgx,
    ...buckets, totalDeductionsUgx, deductionCapped: capped, netUgx: grossUgx - totalDeductionsUgx, deductions: lines,
  };
}

async function readPayroll(tx, db, id) {
  const ref = db.collection(PAYROLL).doc(requireDocId(id, 'payroll'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That payroll could not be found.');
  return { ref, pay: snap.data() };
}

async function currentItems(tx, db, payrollId) {
  return (await tx.get(db.collection(PAYROLL_ITEMS).where('payrollId', '==', payrollId).where('current', '==', true))).docs;
}

/** Deduction schedules that may be taken in this payroll (ordered, oldest first). */
function dueDeductions(all, staffUid, pay) {
  return all
    .filter((d) => d.staffUid === staffUid && d.status === 'active' && d.remainingUgx > 0
      && d.startsFrom.toMillis() <= pay.periodLastDay.toMillis()
      && !(d.applications ?? []).some((a) => a.payrollId === pay.payrollId && !a.reversed))
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0) || a.deductionNumber.localeCompare(b.deductionNumber));
}

/**
 * Reads everything the calculation needs (inside [tx], before any write) and
 * returns a function that writes the new item version and the totals.
 */
async function calculate(tx, db, ref, pay, actor, now) {
  const policy = await readPolicy(tx, db);
  const last = pay.periodLastDay.toMillis();
  const versions = (await tx.get(db.collection(SALARY_HISTORY).where('effectiveFrom', '<=', pay.periodLastDay))).docs.map((d) => d.data());
  const allowances = (await tx.get(db.collection(ALLOWANCES).where('status', '==', 'approved')
    .where('date', '>=', pay.periodStart).where('date', '<', pay.periodEnd))).docs.map((d) => d.data());
  const deductions = (await tx.get(db.collection(DEDUCTIONS).where('status', '==', 'active'))).docs.map((d) => d.data());
  const incidentIds = [...new Set(deductions.map((d) => d.lossIncidentId).filter(Boolean))];
  const incidents = new Map();
  for (const id of incidentIds) {
    const s = await tx.get(db.collection(LOSSES).doc(id));
    if (s.exists) incidents.set(id, s.data());
  }
  const old = await currentItems(tx, db, pay.payrollId);

  const staff = new Map();
  for (const v of versions) {
    const cur = versionOn(versions, v.staffUid, last);
    if (cur && cur.paymentFrequency === pay.frequency) staff.set(v.staffUid, cur);
  }
  for (const a of allowances) {
    const cur = versionOn(versions, a.staffUid, last) ?? versionOn(versions, a.staffUid, a.date.toMillis());
    if (cur && cur.paymentFrequency === pay.frequency && !staff.has(a.staffUid)) staff.set(a.staffUid, cur);
  }
  const entries = pay.earningEntries ?? [];
  const items = [];
  for (const [uid, v] of staff) {
    const mine = allowances.filter((a) => a.staffUid === uid && a.approvedAmountUgx > 0);
    const basic = v.active ? v.basicSalaryUgx : 0;
    const earnings = entries.filter((e) => e.staffUid === uid);
    if (basic === 0 && mine.length === 0 && earnings.length === 0) continue;
    const due = dueDeductions(deductions, uid, pay).filter((d) => {
      const inc = d.lossIncidentId ? incidents.get(d.lossIncidentId) : null;
      return !d.lossIncidentId || (inc && inc.status !== 'cancelled' && inc.staffUid === uid && inc.outstandingUgx > 0);
    }).map((d) => {
      const inc = d.lossIncidentId ? incidents.get(d.lossIncidentId) : null;
      // Never plan more than the incident still has outstanding.
      return inc ? { ...d, remainingUgx: Math.min(d.remainingUgx, inc.outstandingUgx) } : d;
    });
    const figures = payFor({ basicUgx: basic, allowances: mine, earnings, deductions: due, capPercent: policy.maxDeductionPercentOfGross });
    items.push({ v, uid, mine, earnings, figures });
  }
  items.sort((a, b) => (a.v.staffName ?? '').localeCompare(b.v.staffName ?? ''));
  const version = (pay.version ?? 0) + 1;
  const totals = zeroTotals();
  for (const { figures: f } of items) {
    totals.totalBasicUgx += f.basicSalaryUgx;
    totals.totalAllowancesUgx += f.allowancesUgx;
    totals.totalOtherEarningsUgx += f.otherEarningsUgx;
    totals.totalGrossUgx += f.grossUgx;
    totals.totalSalaryDeductionsUgx += f.salaryDeductionsUgx;
    totals.totalLossRecoveriesUgx += f.lossRecoveriesUgx;
    totals.totalOtherDeductionsUgx += f.otherDeductionsUgx;
    totals.totalDeductionsUgx += f.totalDeductionsUgx;
    totals.totalNetUgx += f.netUgx;
  }

  return function write(extra = {}) {
    for (const d of old) tx.update(d.ref, { current: false, status: 'superseded', updatedAt: stamp() });
    items.forEach(({ v, uid, mine, earnings, figures }, i) => {
      const itemRef = db.collection(PAYROLL_ITEMS).doc(`${pay.payrollId}_v${version}_${uid}`);
      tx.set(itemRef, {
        itemId: itemRef.id,
        itemNumber: `${pay.payrollNumber}-${String(i + 1).padStart(3, '0')}`,
        payrollId: pay.payrollId, payrollNumber: pay.payrollNumber, payrollVersion: version,
        frequency: pay.frequency, periodKey: pay.periodKey, periodLabel: pay.periodLabel,
        periodStart: pay.periodStart, periodEnd: pay.periodEnd,
        staffUid: uid, staffId: v.staffId ?? null, staffName: v.staffName ?? uid, staffRole: v.staffRole ?? null,
        salaryHistoryId: v.historyId, salaryVersion: v.version, salaryActive: v.active === true,
        ...figures,
        allowanceIds: mine.map((a) => a.allowanceId),
        allowanceNumbers: mine.map((a) => a.allowanceNumber),
        otherEarnings: earnings.map((e) => ({ entryId: e.entryId, description: e.description, amountUgx: e.amountUgx, reason: e.reason })),
        status: 'prepared', current: true, visibleToStaff: false, paymentStatus: 'unpaid',
        paidAt: null, financialTransactionId: null, notes: null,
        createdAt: stamp(), updatedAt: stamp(), createdBy: actor.uid,
      });
    });
    tx.update(ref, {
      ...totals, employeeCount: items.length, version, status: 'prepared',
      preparedBy: actor.uid, preparedByName: nameOf(actor), preparedAt: Timestamp.fromMillis(now),
      submittedBy: null, submittedAt: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNotes: null,
      approvedBy: null, approvedByName: null, approvedAt: null,
      ...extra, updatedAt: stamp(), updatedBy: actor.uid,
    });
    return { payrollId: pay.payrollId, version, employeeCount: items.length, ...totals };
  };
}

/** Calculates (or recalculates) a draft or prepared payroll. */
export async function preparePayroll(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason, { required: false });
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, ...PREPARE);
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (pay.status !== 'draft' && pay.status !== 'prepared') {
      throw precondition(pay.status === 'cancelled' ? 'This payroll is cancelled.' : 'This payroll is past preparation. Use a correction instead.', 'invalid_status');
    }
    const write = await calculate(tx, db, ref, pay, actor, now);
    const r = write();
    audit(tx, db, actor, 'payroll', 'payroll.prepared', ref.id, {
      previousValue: { status: pay.status, version: pay.version ?? 0, totalNetUgx: pay.totalNetUgx ?? 0 },
      newValue: { status: 'prepared', version: r.version, employeeCount: r.employeeCount, totalGrossUgx: r.totalGrossUgx, totalDeductionsUgx: r.totalDeductionsUgx, totalNetUgx: r.totalNetUgx },
      reason,
    });
    return r;
  });
}

/**
 * An authorised correction BEFORE payment (payroll.adjust, reason): the
 * payroll is recalculated and goes back through review and approval.
 */
export async function correctPayroll(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.adjust');
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (!['prepared', 'pending_review', 'approved'].includes(pay.status)) {
      throw precondition(pay.status === 'paid' || pay.status === 'locked'
        ? 'This payroll has been paid. Reverse the payment (or adjust the next payroll) instead.'
        : `A ${pay.status} payroll cannot be corrected.`, 'invalid_status');
    }
    const write = await calculate(tx, db, ref, pay, actor, now);
    const r = write({ correctionCount: (pay.correctionCount ?? 0) + 1, lastCorrectionReason: reason });
    audit(tx, db, actor, 'payroll', 'payroll.corrected', ref.id, {
      previousValue: { status: pay.status, version: pay.version, totalNetUgx: pay.totalNetUgx },
      newValue: { status: 'prepared', version: r.version, totalNetUgx: r.totalNetUgx }, reason,
    });
    return r;
  });
}

/** Other authorised earnings (bonus, overtime…) on one employee's item, with a reason; recalculates. */
export async function addPayrollEarning(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const description = requireText(data.description, 'Description', 120);
  const amount = requireAmount(data.amountUgx, { field: 'amount', max: MAX_SALARY_UGX });
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.adjust');
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (pay.status !== 'prepared') throw precondition('Earnings can be added while the payroll is prepared (before review).', 'invalid_status');
    const items = await currentItems(tx, db, pay.payrollId);
    const item = items.find((d) => d.get('staffUid') === data.staffUid);
    if (!item) throw invalid('That staff member is not in this payroll.', 'not_in_payroll');
    requireNotOwn(actor, data.staffUid, 'You cannot add earnings to your own pay.');
    const entry = { entryId: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, staffUid: data.staffUid, description, amountUgx: amount, reason, addedBy: actor.uid, addedAt: Timestamp.fromMillis(now) };
    const next = { ...pay, earningEntries: [...(pay.earningEntries ?? []), entry] };
    const write = await calculate(tx, db, ref, next, actor, now);
    const r = write({ earningEntries: next.earningEntries });
    audit(tx, db, actor, 'payroll', 'payroll.earning_added', ref.id, {
      newValue: { staffUid: data.staffUid, description, amountUgx: amount, totalNetUgx: r.totalNetUgx }, reason,
    });
    return { ...r, entryId: entry.entryId };
  });
}

export async function removePayrollEarning(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.adjust');
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (pay.status !== 'prepared') throw precondition('Earnings can be removed while the payroll is prepared (before review).', 'invalid_status');
    const entry = (pay.earningEntries ?? []).find((e) => e.entryId === data.entryId);
    if (!entry) throw notFound('That earning could not be found.');
    const next = { ...pay, earningEntries: pay.earningEntries.filter((e) => e.entryId !== entry.entryId) };
    const write = await calculate(tx, db, ref, next, actor, now);
    const r = write({ earningEntries: next.earningEntries });
    audit(tx, db, actor, 'payroll', 'payroll.earning_removed', ref.id, {
      previousValue: { staffUid: entry.staffUid, description: entry.description, amountUgx: entry.amountUgx }, newValue: { totalNetUgx: r.totalNetUgx }, reason,
    });
    return r;
  });
}

// ---------------------------------------------------------------------------
// Review and approval
// ---------------------------------------------------------------------------

/** Nobody approves or reviews a payroll that pays them - unless they are an Administrator. */
function requireNotPaidBy(actor, items, what) {
  if (actor.data.role === 'admin') return;
  if (items.some((d) => d.get('staffUid') === actor.uid)) throw deny(`You cannot ${what} a payroll that includes your own pay.`, 'self_action');
}

/** submit (payroll.prepare) · review / return (payroll.review) · approve (payroll.approve). */
export async function updatePayrollStatus(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const action = ['submit', 'review', 'return', 'approve'].includes(data.action) ? data.action : null;
  if (!action) throw invalid('Choose a valid action.', 'action');
  const reason = requireReason(data.reason, { required: action === 'return' });
  const notes = optionalNotes(data.notes);
  const perms = { submit: PREPARE, review: ['payroll.review'], return: ['payroll.review', 'payroll.approve'], approve: ['payroll.approve'] }[action];

  const result = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, ...perms);
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    const items = await currentItems(tx, db, pay.payrollId);
    const at = Timestamp.fromMillis(now);
    let update;
    if (action === 'submit') {
      if (pay.status !== 'prepared') throw precondition('Only a prepared payroll can be submitted for review.', 'invalid_status');
      if (items.length === 0) throw precondition('This payroll has nobody to pay.', 'empty_payroll');
      update = { status: 'pending_review', submittedBy: actor.uid, submittedAt: at, returnedReason: null };
    } else if (action === 'review') {
      if (pay.status !== 'pending_review') throw precondition('Only a payroll waiting for review can be reviewed.', 'invalid_status');
      if (pay.reviewedAt) throw precondition('This payroll has already been reviewed.', 'already_reviewed');
      requireNotPaidBy(actor, items, 'review');
      update = { reviewedBy: actor.uid, reviewedByName: nameOf(actor), reviewedAt: at, reviewNotes: notes };
    } else if (action === 'return') {
      if (pay.status !== 'pending_review') throw precondition('Only a payroll waiting for review can be returned.', 'invalid_status');
      update = { status: 'prepared', returnedReason: reason, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNotes: null };
    } else {
      if (pay.status === 'approved') throw precondition('This payroll is already approved.', 'already_approved');
      if (pay.status !== 'pending_review') throw precondition('Only a payroll waiting for approval can be approved.', 'invalid_status');
      if (!pay.reviewedAt) throw precondition('Review the payroll before approving it.', 'not_reviewed');
      const policy = await readPolicy(tx, db);
      if (policy.payrollRequiresAdminApproval && actor.data.role !== 'admin') {
        throw deny('Payroll must be approved by an Administrator.', 'admin_approval_required');
      }
      requireNotPaidBy(actor, items, 'approve');
      update = { status: 'approved', approvedBy: actor.uid, approvedByName: nameOf(actor), approvedAt: at };
    }
    tx.update(ref, { ...update, updatedAt: stamp(), updatedBy: actor.uid });
    if (update.status) for (const d of items) tx.update(d.ref, { status: update.status, updatedAt: stamp() });
    audit(tx, db, actor, 'payroll', `payroll.${{ submit: 'submitted', review: 'reviewed', return: 'returned', approve: 'approved' }[action]}`, ref.id, {
      previousValue: { status: pay.status }, newValue: { status: update.status ?? pay.status, totalNetUgx: pay.totalNetUgx }, reason: reason ?? notes,
    });
    return { payrollId: ref.id, status: update.status ?? pay.status };
  });
  const notify = { submit: ['payroll.review'], review: ['payroll.approve'], approve: ['payroll.pay'] }[action];
  if (notify) {
    const type = action === 'approve' ? NotificationType.payrollApproved : NotificationType.payrollReview;
    for (const uid of await holdersOf(db, notify, now)) if (uid !== callerUid) await notifySafely(deps, uid, type, result.payrollId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Payment, reversal, lock, cancel
// ---------------------------------------------------------------------------

/** Loss incident status after its recovered / outstanding amounts change. */
export function incidentStatus(inc, { scheduled }) {
  if (inc.status === 'cancelled') return 'cancelled';
  if ((inc.approvedRecoveryUgx ?? 0) > 0 && inc.outstandingUgx === 0) return 'recovered';
  if ((inc.recoveredUgx ?? 0) > 0) return 'partially_recovered';
  return scheduled ? 'recovery_scheduled' : 'approved';
}

/**
 * Pays an approved payroll from one account: ONE `payroll_payment` ledger
 * entry for the total net pay; every item paid and visible to its employee;
 * included allowances marked paid; recoveries applied to their schedules and
 * loss incidents. Everything is re-validated here, so nothing can be paid
 * twice or recovered beyond what was approved.
 */
export async function payPayroll(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const requestId = requireRequestId(data.requestId);
  const reference = optionalText(data.reference, 'Payment reference', 60);
  const at = requireBusinessDate(data.paymentDate, now, { field: 'payment date' });

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.pay');
    const request = await readRequest(tx, db, requestId, actor.uid, 'payroll_payment');
    if (request.earlier) return { result: request.earlier, notify: [] };
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (pay.status === 'paid' || pay.status === 'locked') throw precondition('This payroll has already been paid.', 'already_paid');
    if (pay.status !== 'approved') throw precondition('Only an approved payroll can be paid.', 'not_approved');
    const items = await currentItems(tx, db, pay.payrollId);
    if (items.length === 0) throw precondition('This payroll has nobody to pay.', 'empty_payroll');

    // Everything the payment touches, read and re-checked.
    const allowances = new Map();
    const deductions = new Map();
    const incidents = new Map();
    for (const d of items) {
      for (const id of d.get('allowanceIds') ?? []) {
        const s = await tx.get(db.collection(ALLOWANCES).doc(id));
        if (!s.exists || s.get('status') !== 'approved') {
          throw precondition(`Allowance ${s.get('allowanceNumber') ?? id} is no longer approved and unpaid. Correct the payroll first.`, 'stale_payroll');
        }
        allowances.set(id, s);
      }
      for (const line of d.get('deductions') ?? []) {
        if (line.amountUgx <= 0) continue;
        if (!deductions.has(line.deductionId)) deductions.set(line.deductionId, { snap: await tx.get(db.collection(DEDUCTIONS).doc(line.deductionId)), take: 0 });
        const entry = deductions.get(line.deductionId);
        entry.take += line.amountUgx;
        if (line.lossIncidentId && !incidents.has(line.lossIncidentId)) {
          incidents.set(line.lossIncidentId, { snap: await tx.get(db.collection(LOSSES).doc(line.lossIncidentId)), take: 0 });
        }
        if (line.lossIncidentId) incidents.get(line.lossIncidentId).take += line.amountUgx;
      }
    }
    for (const [id, { snap, take }] of deductions) {
      const x = snap.exists ? snap.data() : null;
      if (!x || x.status !== 'active' || x.remainingUgx < take || (x.applications ?? []).some((a) => a.payrollId === pay.payrollId && !a.reversed)) {
        throw precondition(`Deduction ${x?.deductionNumber ?? id} has changed since the payroll was prepared. Correct the payroll first.`, 'stale_payroll');
      }
    }
    for (const [id, { snap, take }] of incidents) {
      const x = snap.exists ? snap.data() : null;
      if (!x || x.status === 'cancelled' || x.outstandingUgx < take) {
        throw precondition(`Loss ${x?.lossNumber ?? id} cannot be recovered as planned (cancelled or over-recovered). Correct the payroll first.`, 'stale_payroll');
      }
    }

    const total = pay.totalNetUgx;
    const accountId = typeof data.accountId === 'string' ? data.accountId : null;
    let posting = { transactionId: null, transactionNumber: null };
    let accountName = null;
    let balanceUgx = null;
    if (total > 0) {
      if (!accountId) throw invalid('Choose the account to pay from.', 'account');
      const ledger = await openLedger(tx, db, [accountId], now);
      accountName = ledger.requireActive(accountId, actor.uid).name;
      posting = ledger.post({
        type: 'payroll_payment', amountUgx: total, fromId: accountId, actor, at,
        fields: {
          payrollId: pay.payrollId, payrollNumber: pay.payrollNumber, periodKey: pay.periodKey, employeeCount: items.length,
          reference, requestId, approvedBy: pay.approvedBy,
          description: `Payroll ${pay.payrollNumber} (${pay.periodLabel}): ${items.length} staff`,
        },
      });
      ledger.commit(actor.uid);
      balanceUgx = ledger.balance(accountId);
    }

    const paidAt = at;
    for (const d of items) {
      tx.update(d.ref, {
        status: 'paid', paymentStatus: 'paid', visibleToStaff: true, paidAt,
        financialTransactionId: posting.transactionId, updatedAt: stamp(),
      });
    }
    for (const [, s] of allowances) {
      tx.update(s.ref, {
        status: 'paid', paidVia: 'payroll', payrollId: pay.payrollId, payrollNumber: pay.payrollNumber,
        paidBy: actor.uid, paidByName: nameOf(actor), paidAt, paidFromAccountId: accountId, paidFromAccountName: accountName,
        financialTransactionId: posting.transactionId, financialTransactionNumber: posting.transactionNumber,
        updatedAt: stamp(), updatedBy: actor.uid,
      });
    }
    for (const [, { snap, take }] of deductions) {
      const x = snap.data();
      const remaining = x.remainingUgx - take;
      tx.update(snap.ref, {
        recoveredUgx: (x.recoveredUgx ?? 0) + take, remainingUgx: remaining, status: remaining === 0 ? 'completed' : 'active',
        applications: FieldValue.arrayUnion({
          payrollId: pay.payrollId, payrollNumber: pay.payrollNumber, periodKey: pay.periodKey, amountUgx: take,
          appliedAt: Timestamp.fromMillis(now), reversed: false,
        }),
        updatedAt: stamp(), updatedBy: actor.uid,
      });
      audit(tx, db, actor, 'payroll', 'deduction.applied', snap.ref.id, {
        previousValue: { remainingUgx: x.remainingUgx }, newValue: { amountUgx: take, remainingUgx: remaining, payrollNumber: pay.payrollNumber },
      });
    }
    for (const [, { snap, take }] of incidents) {
      const x = snap.data();
      const next = { ...x, recoveredUgx: (x.recoveredUgx ?? 0) + take, outstandingUgx: x.outstandingUgx - take };
      const status = incidentStatus(next, { scheduled: true });
      tx.update(snap.ref, { recoveredUgx: next.recoveredUgx, outstandingUgx: next.outstandingUgx, status, updatedAt: stamp(), updatedBy: actor.uid });
      audit(tx, db, actor, 'losses', 'loss.recovered', snap.ref.id, {
        previousValue: { status: x.status, outstandingUgx: x.outstandingUgx },
        newValue: { status, amountUgx: take, outstandingUgx: next.outstandingUgx, payrollNumber: pay.payrollNumber },
      });
    }
    tx.update(ref, {
      status: 'paid', paidBy: actor.uid, paidByName: nameOf(actor), paidAt: Timestamp.fromMillis(now), paymentDate: at,
      paymentReference: reference, paidFromAccountId: accountId, paidFromAccountName: accountName,
      financialTransactionId: posting.transactionId, financialTransactionNumber: posting.transactionNumber,
      paymentReversedAt: null, paymentReversalReason: null,
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'payroll', 'payroll.paid', ref.id, {
      previousValue: { status: 'approved' },
      newValue: { status: 'paid', totalNetUgx: total, accountId, transactionNumber: posting.transactionNumber, employeeCount: items.length },
    });
    const result = { payrollId: ref.id, ...posting, totalNetUgx: total, balanceUgx };
    saveRequest(tx, request.ref, 'payroll_payment', actor.uid, result);
    return {
      result,
      notify: items.map((d) => [d.get('staffUid'), d.id, (d.get('totalDeductionsUgx') ?? 0) > 0]),
    };
  });
  for (const [uid, itemId, deducted] of out.notify) {
    await notifySafely(deps, uid, NotificationType.payrollPaid, itemId);
    if (deducted) await notifySafely(deps, uid, NotificationType.deductionApplied, itemId);
  }
  return out.result;
}

/**
 * After payment, before locking: the payment is reversed in the ledger and
 * everything it applied (allowances paid, recoveries) is undone. The payroll
 * goes back to approved, to be corrected or paid again.
 */
export async function reversePayrollPayment(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.adjust');
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (pay.status === 'locked') throw precondition('A locked payroll cannot be reversed. Adjust the next payroll instead.', 'locked');
    if (pay.status !== 'paid') throw precondition('Only a paid payroll can be reversed.', 'not_paid');
    const items = await currentItems(tx, db, pay.payrollId);
    const original = pay.financialTransactionId ? await readTransaction(tx, db, pay.financialTransactionId) : null;
    const allowances = [];
    const deductions = new Map();
    const incidents = new Map();
    for (const d of items) {
      for (const id of d.get('allowanceIds') ?? []) {
        const s = await tx.get(db.collection(ALLOWANCES).doc(id));
        if (s.exists && s.get('status') === 'paid' && s.get('payrollId') === pay.payrollId) allowances.push(s);
      }
      for (const line of d.get('deductions') ?? []) {
        if (line.amountUgx <= 0) continue;
        if (!deductions.has(line.deductionId)) deductions.set(line.deductionId, await tx.get(db.collection(DEDUCTIONS).doc(line.deductionId)));
        if (line.lossIncidentId && !incidents.has(line.lossIncidentId)) {
          incidents.set(line.lossIncidentId, { snap: await tx.get(db.collection(LOSSES).doc(line.lossIncidentId)), give: 0 });
        }
      }
    }
    const scheduled = new Map();
    const giveBack = new Map();
    for (const [id, snap] of deductions) {
      if (!snap.exists) continue;
      const apps = snap.get('applications') ?? [];
      const app = apps.find((a) => a.payrollId === pay.payrollId && !a.reversed);
      if (!app) continue;
      giveBack.set(id, { snap, app, apps });
      const inc = snap.get('lossIncidentId');
      if (inc && incidents.has(inc)) incidents.get(inc).give += app.amountUgx;
    }
    let reversal = { transactionId: null, transactionNumber: null };
    if (original) {
      const ledger = await openLedger(tx, db, [original.data.sourceAccountId], now);
      reversal = postReversal(tx, ledger, original, actor, reason, { payrollId: pay.payrollId, payrollNumber: pay.payrollNumber });
      ledger.commit(actor.uid);
    }
    for (const [, { snap, app, apps }] of giveBack) {
      const x = snap.data();
      tx.update(snap.ref, {
        recoveredUgx: x.recoveredUgx - app.amountUgx, remainingUgx: x.remainingUgx + app.amountUgx,
        status: x.status === 'completed' ? 'active' : x.status,
        applications: apps.map((a) => (a === app ? { ...a, reversed: true, reversedAt: Timestamp.fromMillis(now), reversalReason: reason } : a)),
        updatedAt: stamp(), updatedBy: actor.uid,
      });
      scheduled.set(x.lossIncidentId, x.status !== 'cancelled');
      audit(tx, db, actor, 'payroll', 'deduction.reversed', snap.ref.id, {
        previousValue: { remainingUgx: x.remainingUgx }, newValue: { remainingUgx: x.remainingUgx + app.amountUgx, payrollNumber: pay.payrollNumber }, reason,
      });
    }
    for (const [, { snap, give }] of incidents) {
      if (!snap.exists || give === 0) continue;
      const x = snap.data();
      const next = { ...x, recoveredUgx: x.recoveredUgx - give, outstandingUgx: x.outstandingUgx + give };
      const status = incidentStatus(next, { scheduled: scheduled.get(snap.id) ?? Boolean(x.deductionId) });
      tx.update(snap.ref, { recoveredUgx: next.recoveredUgx, outstandingUgx: next.outstandingUgx, status, updatedAt: stamp(), updatedBy: actor.uid });
      audit(tx, db, actor, 'losses', 'loss.recovery_reversed', snap.ref.id, {
        previousValue: { status: x.status, outstandingUgx: x.outstandingUgx }, newValue: { status, outstandingUgx: next.outstandingUgx }, reason,
      });
    }
    for (const s of allowances) {
      tx.update(s.ref, {
        status: 'approved', paidVia: null, payrollId: null, payrollNumber: null, paidBy: null, paidByName: null, paidAt: null,
        paidFromAccountId: null, paidFromAccountName: null, financialTransactionId: null, financialTransactionNumber: null,
        paymentReversedAt: stamp(), paymentReversalReason: reason, updatedAt: stamp(), updatedBy: actor.uid,
      });
    }
    for (const d of items) tx.update(d.ref, { status: 'approved', paymentStatus: 'unpaid', paidAt: null, paymentReversedAt: stamp(), updatedAt: stamp() });
    tx.update(ref, {
      status: 'approved', paidBy: null, paidByName: null, paidAt: null, paymentDate: null, paidFromAccountId: null, paidFromAccountName: null,
      financialTransactionId: null, financialTransactionNumber: null,
      paymentReversedAt: stamp(), paymentReversalReason: reason, paymentReversalTransactionId: reversal.transactionId,
      updatedAt: stamp(), updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'payroll', 'payroll.payment_reversed', ref.id, {
      previousValue: { status: 'paid', transactionNumber: pay.financialTransactionNumber },
      newValue: { status: 'approved', reversalTransactionNumber: reversal.transactionNumber, totalNetUgx: pay.totalNetUgx }, reason,
    });
    return { payrollId: ref.id, ...reversal };
  });
}

export async function lockPayroll(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.approve');
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (pay.status === 'locked') throw precondition('This payroll is already locked.', 'already_locked');
    if (pay.status !== 'paid') throw precondition('Only a paid payroll can be locked.', 'not_paid');
    const items = await currentItems(tx, db, pay.payrollId);
    for (const d of items) tx.update(d.ref, { status: 'locked', updatedAt: stamp() });
    tx.update(ref, { status: 'locked', lockedBy: actor.uid, lockedAt: stamp(), updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'payroll', 'payroll.locked', ref.id, { previousValue: { status: 'paid' }, newValue: { status: 'locked' } });
    return { payrollId: ref.id, status: 'locked' };
  });
}

export async function cancelPayroll(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'payroll.adjust');
    const { ref, pay } = await readPayroll(tx, db, data.payrollId);
    if (!['draft', 'prepared', 'pending_review', 'approved'].includes(pay.status)) {
      throw precondition(pay.status === 'cancelled' ? 'This payroll is already cancelled.' : 'A paid payroll cannot be cancelled. Reverse the payment first.', 'invalid_status');
    }
    const items = await currentItems(tx, db, pay.payrollId);
    for (const d of items) tx.update(d.ref, { current: false, status: 'cancelled', updatedAt: stamp() });
    tx.update(ref, { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: stamp(), cancelReason: reason, updatedAt: stamp(), updatedBy: actor.uid });
    // The period is free again for a new payroll.
    tx.delete(uniqueRef(db, 'payroll', `${pay.frequency}_${pay.periodKey}`));
    audit(tx, db, actor, 'payroll', 'payroll.cancelled', ref.id, { previousValue: { status: pay.status }, newValue: { status: 'cancelled' }, reason });
    return { payrollId: ref.id, status: 'cancelled' };
  });
}

