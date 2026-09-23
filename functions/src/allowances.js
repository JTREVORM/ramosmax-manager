// ===========================================================================
// RamosMAX daily allowances (Phase 6)
// ===========================================================================
//
//   approved attendance ──calculate──► calculated ──decide (allowances.approve)──► approved ──pay──► paid
//                                          │  └─decide (allowances.adjust only)─► pending_approval ─┘
//                                          └──reject (reason)──► rejected
//   calculated / pending_approval / approved ──cancel (reason)──► cancelled (attendance can be recalculated)
//   paid ──reverse payment (allowances.adjust, reason)──► approved
//
// An allowance exists only for APPROVED attendance of an ELIGIBLE staff member
// (their salary profile version on that day: active + allowanceEligible). The
// amount is the profile's own allowance or the policy default (UGX 5,000),
// decided here - never sent by the app. A late arrival does not lose the
// allowance automatically: the manager applies FULL / DEDUCT / REJECT, with a
// reason for anything but FULL, and a deduction is capped by the policy.
//
// Money moves only in payAllowances: one `allowance_payment` ledger entry for
// the batch, the account reduced and every allowance marked paid, atomically.
// Approved allowances that are not paid directly are paid through payroll
// (payroll.js), which marks them paid when the payroll is paid.
// ===========================================================================

import { Timestamp } from 'firebase-admin/firestore';

import { invalid, optionalText, precondition, requireReason } from './access.js';
import { audit, freshActor, notFound, stamp } from './operations.js';
import {
  holdersOf, openLedger, postReversal, readCounter, readRequest, readTransaction, requireAmount, requireBusinessDate,
  requireRequestId, saveRequest,
} from './finance.js';
import { NotificationType, notifySafely, requireObject } from './user_admin.js';
import {
  ALLOWANCES, ATTENDANCE, PAYROLL_ITEMS, SALARY_HISTORY, dayKey, dayStart, holds, nameOf, readPolicy, requireIdList,
  requireInstant, requireNotOwn, versionOn,
} from './workforce.js';

export const STATUSES = Object.freeze(['calculated', 'pending_approval', 'approved', 'rejected', 'paid', 'cancelled']);
export const DECISIONS = Object.freeze(['full', 'deduct', 'reject']);
const OPEN = new Set(['calculated', 'pending_approval', 'approved']);

/**
 * Why [rec] (an attendance record) earns no allowance under [policy] with
 * salary [version], or null when it does. Pure - unit tested.
 */
export function ineligibility(rec, policy, version) {
  if (rec.verificationStatus === 'rejected') return 'rejected';
  if (rec.verificationStatus !== 'approved') return 'not_verified';
  if (rec.status !== 'present' && rec.status !== 'late') return 'not_present';
  if (rec.allowanceId) return 'already_calculated';
  if (!rec.workingDay && !policy.allowanceOnNonWorkingDays) return 'non_working_day';
  if (policy.requireClockOut && !rec.clockOutAt) return 'no_clock_out';
  if (!version || version.active !== true) return 'no_salary_profile';
  if (version.allowanceEligible !== true) return 'not_eligible';
  if (allowanceAmount(version, policy) <= 0) return 'no_allowance_amount';
  return null;
}

export const allowanceAmount = (version, policy) => version.allowanceAmountUgx ?? policy.defaultDailyAllowanceUgx;

/** The decision the policy suggests for a record (the manager decides). */
export function suggestion(rec, policy, amount) {
  if (!rec.late) return { decision: 'full', deductionUgx: 0 };
  if (rec.severelyLate) return { decision: 'reject', deductionUgx: amount };
  const decision = policy.lateAllowancePolicy;
  return { decision, deductionUgx: decision === 'deduct' ? Math.min(policy.lateDeductionUgx, amount) : decision === 'reject' ? amount : 0 };
}

/**
 * Calculates allowances for the approved attendance of one EAT day (all
 * records, or [attendanceIds]). Returns what was created and what was
 * skipped, with the reason.
 */
export async function calculateAllowances(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const day = dayStart(requireInstant(data.date ?? now, 'date'));
  if (day > dayStart(now)) throw invalid('Allowances cannot be calculated for a future day.', 'date');
  const only = data.attendanceIds == null ? null : new Set(requireIdList(data.attendanceIds, 'attendance record', 200));

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'allowances.calculate');
    const policy = await readPolicy(tx, db);
    const records = (await tx.get(db.collection(ATTENDANCE).where('dayKey', '==', dayKey(day)))).docs
      .map((d) => d.data()).filter((r) => !only || only.has(r.attendanceId));
    const versions = (await tx.get(db.collection(SALARY_HISTORY).where('effectiveFrom', '<=', Timestamp.fromMillis(day)))).docs.map((d) => d.data());
    const numbers = await readCounter(tx, db, 'worker_allowances', 'RMX-ALL-', 6);
    const created = [];
    const skipped = [];
    for (const rec of records.sort((a, b) => (a.staffName ?? '').localeCompare(b.staffName ?? ''))) {
      const version = versionOn(versions, rec.staffUid, day);
      const why = ineligibility(rec, policy, version);
      if (why) {
        skipped.push({ attendanceId: rec.attendanceId, staffName: rec.staffName, reason: why });
        continue;
      }
      const amount = allowanceAmount(version, policy);
      const suggested = suggestion(rec, policy, amount);
      const auto = !rec.late && !policy.allowanceApprovalRequired;
      const ref = db.collection(ALLOWANCES).doc();
      const number = numbers.next();
      tx.set(ref, {
        allowanceId: ref.id,
        allowanceNumber: number,
        staffUid: rec.staffUid,
        staffId: rec.staffId ?? null,
        staffName: rec.staffName,
        staffRole: rec.staffRole ?? null,
        attendanceId: rec.attendanceId,
        attendanceNumber: rec.attendanceNumber,
        date: rec.date,
        dayKey: rec.dayKey,
        late: rec.late === true,
        severelyLate: rec.severelyLate === true,
        minutesLate: rec.minutesLate ?? 0,
        salaryHistoryId: version.historyId,
        calculatedAmountUgx: amount,
        suggestedDecision: suggested.decision,
        suggestedDeductionUgx: suggested.deductionUgx,
        decision: auto ? 'full' : null,
        proposedDecision: null, proposedDeductionUgx: null, proposedBy: null, proposedByName: null, proposedAt: null, proposalReason: null,
        deductionUgx: 0,
        deductionReason: null,
        approvedAmountUgx: auto ? amount : null,
        status: auto ? 'approved' : 'calculated',
        autoApproved: auto,
        approvedBy: auto ? actor.uid : null, approvedByName: auto ? nameOf(actor) : null, approvedAt: auto ? Timestamp.fromMillis(now) : null,
        rejectedBy: null, rejectedAt: null, rejectionReason: null,
        paidVia: null, paidBy: null, paidByName: null, paidAt: null, paidFromAccountId: null, paidFromAccountName: null,
        paymentReference: null, financialTransactionId: null, financialTransactionNumber: null,
        payrollId: null, payrollNumber: null,
        cancelledBy: null, cancelledAt: null, cancelReason: null,
        createdBy: actor.uid,
        createdByName: nameOf(actor),
        createdAt: stamp(),
        updatedAt: stamp(),
        updatedBy: actor.uid,
      });
      tx.update(db.collection(ATTENDANCE).doc(rec.attendanceId), { allowanceId: ref.id, updatedAt: stamp(), updatedBy: actor.uid });
      audit(tx, db, actor, 'payroll', 'allowance.calculated', ref.id, {
        newValue: {
          allowanceNumber: number, staffUid: rec.staffUid, dayKey: rec.dayKey, calculatedAmountUgx: amount,
          late: rec.late === true, status: auto ? 'approved' : 'calculated', suggestedDecision: suggested.decision,
        },
      });
      created.push({ allowanceId: ref.id, allowanceNumber: number, staffUid: rec.staffUid, amountUgx: amount, status: auto ? 'approved' : 'calculated' });
    }
    numbers.commit();
    return { created, skipped };
  });
  if (out.created.some((c) => c.status === 'calculated')) {
    for (const uid of await holdersOf(db, ['allowances.approve'], now)) {
      await notifySafely(deps, uid, NotificationType.allowanceAwaitingApproval, dayKey(day));
    }
  }
  for (const uid of new Set(out.created.filter((c) => c.status === 'approved').map((c) => c.staffUid))) {
    await notifySafely(deps, uid, NotificationType.allowanceApproved, dayKey(day));
  }
  return { day: dayKey(day), created: out.created.length, allowances: out.created, skipped: out.skipped };
}

async function readAllowances(tx, db, ids) {
  const list = [];
  for (const id of ids) {
    const ref = db.collection(ALLOWANCES).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound('That allowance could not be found.');
    list.push({ ref, a: snap.data() });
  }
  return list;
}

/** Throws if any of [ids] is in a live (current) payroll item. */
async function requireNotInPayroll(tx, db, ids) {
  for (let i = 0; i < ids.length; i += 30) {
    const hit = await tx.get(db.collection(PAYROLL_ITEMS).where('current', '==', true)
      .where('allowanceIds', 'array-contains-any', ids.slice(i, i + 30)).limit(1));
    if (!hit.empty) {
      throw precondition(`Payroll ${hit.docs[0].get('payrollNumber')} already includes one of these allowances.`, 'allowance_in_payroll');
    }
  }
}

/**
 * The manager's decision: FULL, DEDUCT (the policy's deduction or a smaller /
 * larger one up to the maximum) or REJECT. With `allowances.approve` it is
 * final; with only `allowances.adjust` it waits as pending_approval.
 */
export async function reviewAllowance(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const ids = requireIdList(data.allowanceIds ?? data.allowanceId, 'allowance');
  const decision = DECISIONS.includes(data.decision) ? data.decision : null;
  if (!decision) throw invalid('Choose full, deduct or reject.', 'decision');
  const reason = requireReason(data.reason, { required: decision !== 'full' });
  const requested = decision === 'deduct' && data.deductionUgx != null ? requireAmount(data.deductionUgx, { field: 'deduction' }) : null;

  const approved = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'allowances.approve', 'allowances.adjust');
    const final = holds(actor, 'allowances.approve');
    const policy = await readPolicy(tx, db);
    const list = await readAllowances(tx, db, ids);
    const at = Timestamp.fromMillis(now);
    const done = [];
    for (const { a } of list) {
      requireNotOwn(actor, a.staffUid, 'You cannot decide your own allowance.');
      if (a.status !== 'calculated' && a.status !== 'pending_approval') {
        throw precondition(`${a.allowanceNumber} is ${a.status.replace('_', ' ')}.`, 'invalid_status');
      }
    }
    for (const { ref, a } of list) {
      const amount = a.calculatedAmountUgx;
      let deduction = 0;
      if (decision === 'deduct') {
        deduction = requested ?? Math.min(policy.lateDeductionUgx, amount);
        if (deduction > policy.maxLateDeductionUgx) {
          throw invalid(`The deduction cannot exceed UGX ${policy.maxLateDeductionUgx.toLocaleString('en-US')}.`, 'deduction_too_large');
        }
        if (deduction <= 0 || deduction >= amount) throw invalid('The deduction must leave part of the allowance. Use reject to pay nothing.', 'deduction_range');
      }
      if (decision === 'reject') deduction = amount;
      if (!final) {
        tx.update(ref, {
          status: 'pending_approval', proposedDecision: decision, proposedDeductionUgx: deduction, proposedBy: actor.uid,
          proposedByName: nameOf(actor), proposedAt: at, proposalReason: reason, updatedAt: stamp(), updatedBy: actor.uid,
        });
        audit(tx, db, actor, 'payroll', 'allowance.adjusted', ref.id, {
          previousValue: { status: a.status }, newValue: { status: 'pending_approval', decision, deductionUgx: deduction }, reason,
        });
        continue;
      }
      const rejected = decision === 'reject';
      tx.update(ref, {
        status: rejected ? 'rejected' : 'approved',
        decision,
        deductionUgx: deduction,
        deductionReason: decision === 'full' ? null : reason,
        approvedAmountUgx: rejected ? 0 : amount - deduction,
        approvedBy: rejected ? null : actor.uid, approvedByName: rejected ? null : nameOf(actor), approvedAt: rejected ? null : at,
        rejectedBy: rejected ? actor.uid : null, rejectedAt: rejected ? at : null, rejectionReason: rejected ? reason : null,
        updatedAt: stamp(), updatedBy: actor.uid,
      });
      audit(tx, db, actor, 'payroll', rejected ? 'allowance.rejected' : 'allowance.approved', ref.id, {
        previousValue: { status: a.status, calculatedAmountUgx: amount },
        newValue: { status: rejected ? 'rejected' : 'approved', decision, deductionUgx: deduction, approvedAmountUgx: rejected ? 0 : amount - deduction },
        reason,
      });
      if (!rejected) done.push([a.staffUid, ref.id]);
    }
    return done;
  });
  for (const [uid, id] of approved) await notifySafely(deps, uid, NotificationType.allowanceApproved, id);
  return { count: ids.length };
}

/**
 * Pays approved allowances from one financial account: one
 * `allowance_payment` ledger entry for the batch; every allowance marked paid
 * in the same transaction. A repeated request (same requestId) pays once.
 */
export async function payAllowances(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const ids = requireIdList(data.allowanceIds ?? data.allowanceId, 'allowance', 100);
  const requestId = requireRequestId(data.requestId);
  const reference = optionalText(data.reference, 'Payment reference', 60);
  const at = requireBusinessDate(data.paymentDate, now, { field: 'payment date' });
  const accountId = typeof data.accountId === 'string' ? data.accountId : null;
  if (!accountId) throw invalid('Choose the account to pay from.', 'account');

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'allowances.pay');
    const request = await readRequest(tx, db, requestId, actor.uid, 'allowance_payment');
    if (request.earlier) return request.earlier;
    const list = await readAllowances(tx, db, ids);
    for (const { a } of list) {
      requireNotOwn(actor, a.staffUid, 'Someone else must pay your allowance.');
      if (a.status === 'paid') throw precondition(`${a.allowanceNumber} has already been paid.`, 'already_paid');
      if (a.status !== 'approved') throw precondition(`${a.allowanceNumber} is not approved.`, 'not_approved');
      if (!(a.approvedAmountUgx > 0)) throw precondition(`${a.allowanceNumber} has nothing to pay.`, 'nothing_to_pay');
    }
    await requireNotInPayroll(tx, db, ids);
    const ledger = await openLedger(tx, db, [accountId], now);
    const account = ledger.requireActive(accountId, actor.uid);
    const total = list.reduce((s, { a }) => s + a.approvedAmountUgx, 0);
    const numbers = list.map(({ a }) => a.allowanceNumber);
    const r = ledger.post({
      type: 'allowance_payment', amountUgx: total, fromId: accountId, actor, at,
      fields: {
        allowanceIds: ids, allowanceNumbers: numbers, staffUids: [...new Set(list.map(({ a }) => a.staffUid))],
        reference, requestId, approvedBy: actor.uid,
        description: list.length === 1
          ? `Daily allowance ${numbers[0]} (${list[0].a.staffName}, ${list[0].a.dayKey})`
          : `Daily allowances: ${list.length} (${numbers[0]} … ${numbers.at(-1)})`,
      },
    });
    ledger.commit(actor.uid);
    for (const { ref, a } of list) {
      tx.update(ref, {
        status: 'paid', paidVia: 'direct', paidBy: actor.uid, paidByName: nameOf(actor), paidAt: at,
        paidFromAccountId: accountId, paidFromAccountName: account.name, paymentReference: reference,
        financialTransactionId: r.transactionId, financialTransactionNumber: r.transactionNumber,
        updatedAt: stamp(), updatedBy: actor.uid,
      });
      audit(tx, db, actor, 'payroll', 'allowance.paid', ref.id, {
        previousValue: { status: 'approved' },
        newValue: { status: 'paid', amountUgx: a.approvedAmountUgx, accountId, transactionNumber: r.transactionNumber },
      });
    }
    const result = { ...r, count: list.length, totalUgx: total, balanceUgx: ledger.balance(accountId) };
    saveRequest(tx, request.ref, 'allowance_payment', actor.uid, result);
    return result;
  });
}

/** Reverses a direct allowance payment: money back to the account, the allowances back to approved. */
export async function reverseAllowancePayment(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'allowances.adjust');
    const original = await readTransaction(tx, db, data.transactionId);
    const o = original.data;
    if (o.type !== 'allowance_payment') throw invalid('That is not an allowance payment.', 'wrong_type');
    const list = await readAllowances(tx, db, o.allowanceIds ?? []);
    const ledger = await openLedger(tx, db, [o.sourceAccountId], now);
    const r = postReversal(tx, ledger, original, actor, reason, { allowanceIds: o.allowanceIds, allowanceNumbers: o.allowanceNumbers });
    ledger.commit(actor.uid);
    for (const { ref, a } of list) {
      if (a.status !== 'paid' || a.financialTransactionId !== original.ref.id) continue;
      tx.update(ref, {
        status: 'approved', paidVia: null, paidBy: null, paidByName: null, paidAt: null, paidFromAccountId: null, paidFromAccountName: null,
        paymentReference: null, financialTransactionId: null, financialTransactionNumber: null,
        paymentReversedAt: stamp(), paymentReversalReason: reason, paymentReversalTransactionId: r.transactionId,
        updatedAt: stamp(), updatedBy: actor.uid,
      });
      audit(tx, db, actor, 'payroll', 'allowance.payment_reversed', ref.id, {
        previousValue: { status: 'paid', transactionNumber: o.transactionNumber }, newValue: { status: 'approved', reversalTransactionNumber: r.transactionNumber }, reason,
      });
    }
    return r;
  });
}

/** Cancels allowances that are not paid and not in a payroll; the attendance may be recalculated. */
export async function cancelAllowance(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const ids = requireIdList(data.allowanceIds ?? data.allowanceId, 'allowance');
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'allowances.adjust');
    const list = await readAllowances(tx, db, ids);
    for (const { a } of list) {
      requireNotOwn(actor, a.staffUid, 'You cannot cancel your own allowance.');
      if (!OPEN.has(a.status)) throw precondition(`${a.allowanceNumber} is ${a.status.replace('_', ' ')} and cannot be cancelled.`, 'invalid_status');
    }
    await requireNotInPayroll(tx, db, ids);
    const atts = [];
    for (const { a } of list) atts.push(await tx.get(db.collection(ATTENDANCE).doc(a.attendanceId)));
    list.forEach(({ ref, a }, i) => {
      tx.update(ref, { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: stamp(), cancelReason: reason, updatedAt: stamp(), updatedBy: actor.uid });
      if (atts[i].exists && atts[i].get('allowanceId') === ref.id) {
        tx.update(atts[i].ref, { allowanceId: null, updatedAt: stamp(), updatedBy: actor.uid });
      }
      audit(tx, db, actor, 'payroll', 'allowance.cancelled', ref.id, { previousValue: { status: a.status }, newValue: { status: 'cancelled' }, reason });
    });
    return { count: list.length };
  });
}
