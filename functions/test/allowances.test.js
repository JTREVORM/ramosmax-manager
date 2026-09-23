// Daily allowances: eligibility, the UGX 5,000 default and configurable
// amounts, the late policy (full / deduct / reject), approval, payment through
// the Phase 5 ledger, duplicate payments, insufficient funds and reversal
// (Phase 6) - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as allowances from '../src/allowances.js';
import * as attendance from '../src/attendance.js';
import * as finance from '../src/finance.js';
import * as payroll from '../src/payroll.js';
import * as workforce from '../src/workforce.js';
import { eat, emulatorDb, financeHelpers, rejects, resetAndSeed, workforceHelpers } from './helpers.js';

const db = emulatorDb('allowance-tests');
const { deps, doc, all } = workforceHelpers(db);
const { balance, txns, assertLedgerConsistent } = financeHelpers(db);
const audits = async (action) => all('audit_logs', { action });

beforeEach(() => resetAndSeed(db));

const MON = 21;
const NOW = eat(MON, 18);
let seq = 0;
const rid = () => `allow-${Date.now()}-${seq++}`;

const profile = (staffUid, extra = {}) => payroll.setSalaryProfile(deps, 'admin', {
  staffUid, basicSalaryUgx: 300000, effectiveFrom: eat(1, 12, 0, 1), ...extra,
}, eat(MON, 6));

/** Approved attendance for [uid] at [hour]:[minute] on the Monday. */
async function present(uid, hour = 8, minute = 0) {
  const r = await attendance.recordAttendance(deps, uid, {}, eat(MON, hour, minute));
  await attendance.verifyAttendance(deps, uid === 'mgr' ? 'admin' : 'mgr', { attendanceIds: [r.attendanceId], action: 'approve' }, NOW);
  return r.attendanceId;
}
const calculate = (actor = 'mgr', extra = {}) => allowances.calculateAllowances(deps, actor, { date: eat(MON, 12), ...extra }, NOW);
const decide = (actor, ids, decision, extra = {}) => allowances.reviewAllowance(deps, actor, { allowanceIds: [].concat(ids), decision, ...extra }, NOW);
const payAll = (actor, ids, extra = {}) => allowances.payAllowances(deps, actor, {
  allowanceIds: [].concat(ids), accountId: 'cash_at_hand', requestId: rid(), ...extra,
}, NOW);
const fund = (amountUgx = 100000) => finance.recordOpeningBalance(deps, 'admin', { accountId: 'cash_at_hand', amountUgx });

describe('eligibility and amounts', () => {
  test('eligible staff with approved attendance get the UGX 5,000 default; numbered, linked and audited', async () => {
    await profile('wkr');
    const attendanceId = await present('wkr');
    const r = await calculate();
    assert.equal(r.created, 1);
    const a = await doc(`worker_allowances/${r.allowances[0].allowanceId}`);
    assert.deepEqual([a.allowanceNumber, a.calculatedAmountUgx, a.status, a.suggestedDecision, a.staffUid, a.attendanceId],
      ['RMX-ALL-000001', 5000, 'calculated', 'full', 'wkr', attendanceId]);
    assert.equal((await doc(`attendance/${attendanceId}`)).allowanceId, a.allowanceId);
    assert.equal((await audits('allowance.calculated')).length, 1);
    // Calculating again creates nothing new.
    const again = await calculate();
    assert.deepEqual([again.created, again.skipped[0].reason], [0, 'already_calculated']);
  });

  test('no allowance without an eligible, active profile or without approved presence', async () => {
    await profile('wkr', { allowanceEligible: false });
    await profile('cash', { active: false });
    await present('wkr');
    await present('wkr2'); // no salary profile at all
    await present('cash');
    await profile('mgr');
    await attendance.recordAttendance(deps, 'mgr', {}, eat(MON, 8)); // not verified
    await attendance.recordAttendance(deps, 'admin', { staffUid: 'cashDisc', date: eat(MON, 12), arrival: 'absent' }, NOW);
    const r = await calculate();
    assert.equal(r.created, 0);
    const why = Object.fromEntries(r.skipped.map((s) => [s.staffName, s.reason]));
    assert.deepEqual(why, { wkr: 'not_eligible', wkr2: 'no_salary_profile', cash: 'no_salary_profile', mgr: 'not_verified', cashDisc: 'not_verified' });
  });

  test('a rejected or absent day earns nothing, and neither does a non-working day by default', async () => {
    await profile('wkr');
    await profile('wkr2');
    const a = await attendance.recordAttendance(deps, 'wkr', {}, eat(MON, 8));
    await attendance.verifyAttendance(deps, 'mgr', { attendanceIds: [a.attendanceId], action: 'reject', reason: 'Not on site' }, NOW);
    const b = await attendance.recordAttendance(deps, 'mgr', { staffUid: 'wkr2', date: eat(MON, 12), arrival: 'absent' }, NOW);
    await attendance.verifyAttendance(deps, 'mgr', { attendanceIds: [b.attendanceId], action: 'approve' }, NOW);
    assert.deepEqual((await calculate()).skipped.map((s) => s.reason).sort(), ['not_present', 'rejected']);
    const sun = await attendance.recordAttendance(deps, 'wkr', {}, eat(27, 8));
    await attendance.verifyAttendance(deps, 'mgr', { attendanceIds: [sun.attendanceId], action: 'approve' }, eat(27, 18));
    const r = await allowances.calculateAllowances(deps, 'mgr', { date: eat(27, 12) }, eat(27, 18));
    assert.equal(r.skipped[0].reason, 'non_working_day');
  });

  test('the amount is configurable: per person, or the policy default', async () => {
    await profile('wkr', { allowanceAmountUgx: 7000 });
    await profile('wkr2');
    await workforce.updatePayrollPolicy(deps, 'admin', { changes: { defaultDailyAllowanceUgx: 6000 }, reason: 'Transport costs rose' });
    await present('wkr');
    await present('wkr2');
    const r = await calculate();
    assert.deepEqual(Object.fromEntries(r.allowances.map((a) => [a.staffUid, a.amountUgx])), { wkr: 7000, wkr2: 6000 });
  });

  test('eligibility defaults from the policy roles when a profile is created', async () => {
    await profile('wkr');
    await profile('aud');
    assert.equal((await doc('salary_profiles/wkr')).allowanceEligible, true);
    assert.equal((await doc('salary_profiles/aud')).allowanceEligible, false);
  });

  test('only allowances.calculate holders calculate', async () => {
    for (const who of ['wkr', 'cash', 'aud', 'sh']) await rejects(calculate(who), 'permission-denied');
  });
});

describe('the late policy and approval', () => {
  async function lateAllowance(minute = 40) {
    await profile('wkr');
    await present('wkr', 8, minute);
    return (await calculate()).allowances[0].allowanceId;
  }

  test('late: the policy suggests DEDUCT UGX 2,500; the manager applies it with a reason', async () => {
    const id = await lateAllowance();
    const a = await doc(`worker_allowances/${id}`);
    assert.deepEqual([a.late, a.suggestedDecision, a.suggestedDeductionUgx, a.calculatedAmountUgx], [true, 'deduct', 2500, 5000]);
    await rejects(decide('mgr', id, 'deduct'), 'invalid-argument', 'reason');
    await decide('mgr', id, 'deduct', { reason: 'Late 40 minutes' });
    const x = await doc(`worker_allowances/${id}`);
    assert.deepEqual([x.status, x.decision, x.deductionUgx, x.approvedAmountUgx, x.deductionReason, x.approvedBy],
      ['approved', 'deduct', 2500, 2500, 'Late 40 minutes', 'mgr']);
    assert.equal((await audits('allowance.approved')).length, 1);
  });

  test('being late does not automatically lose the allowance: FULL is allowed', async () => {
    const id = await lateAllowance();
    await decide('mgr', id, 'full');
    assert.equal((await doc(`worker_allowances/${id}`)).approvedAmountUgx, 5000);
  });

  test('REJECT pays nothing; a deduction above the maximum or of the whole amount is refused', async () => {
    const id = await lateAllowance();
    await rejects(decide('mgr', id, 'deduct', { deductionUgx: 6000, reason: 'Very late' }), 'invalid-argument', 'deduction_too_large');
    await rejects(decide('mgr', id, 'deduct', { deductionUgx: 5000, reason: 'Very late' }), 'invalid-argument', 'deduction_range');
    await decide('mgr', id, 'reject', { reason: 'Arrived after lunch' });
    const x = await doc(`worker_allowances/${id}`);
    assert.deepEqual([x.status, x.approvedAmountUgx, x.rejectionReason], ['rejected', 0, 'Arrived after lunch']);
    await rejects(decide('mgr', id, 'full'), 'failed-precondition', 'invalid_status');
  });

  test('a custom deduction within the maximum', async () => {
    const id = await lateAllowance();
    await decide('mgr', id, 'deduct', { deductionUgx: 1000, reason: 'Traffic accident on the road' });
    assert.equal((await doc(`worker_allowances/${id}`)).approvedAmountUgx, 4000);
  });

  test('allowances.adjust alone proposes (pending approval); an approver decides', async () => {
    await db.doc('users/cash').update({ permissions: ['allowances.adjust'] });
    const id = await lateAllowance();
    await decide('cash', id, 'deduct', { reason: 'Late 40 minutes' });
    const p = await doc(`worker_allowances/${id}`);
    assert.deepEqual([p.status, p.proposedDecision, p.proposedDeductionUgx, p.approvedAmountUgx], ['pending_approval', 'deduct', 2500, null]);
    await decide('mgr', id, 'deduct', { reason: 'Agree - late 40 minutes' });
    assert.equal((await doc(`worker_allowances/${id}`)).status, 'approved');
  });

  test('workers cannot approve; nobody decides their own allowance', async () => {
    const id = await lateAllowance();
    for (const who of ['wkr', 'wkr2', 'aud']) await rejects(decide(who, id, 'full'), 'permission-denied');
    await profile('mgr');
    await present('mgr');
    const mine = (await calculate()).allowances.find((a) => a.staffUid === 'mgr').allowanceId;
    await rejects(decide('mgr', mine, 'full'), 'permission-denied', 'self_action');
  });

  test('when approval is not required, on-time allowances are approved at calculation; late ones still wait', async () => {
    await workforce.updatePayrollPolicy(deps, 'admin', { changes: { allowanceApprovalRequired: false }, reason: 'Small team' });
    await profile('wkr');
    await profile('wkr2');
    await present('wkr', 8, 0);
    await present('wkr2', 8, 45);
    const r = await calculate();
    assert.deepEqual(Object.fromEntries(r.allowances.map((a) => [a.staffUid, a.status])), { wkr: 'approved', wkr2: 'calculated' });
  });
});

describe('payment', () => {
  async function approved(uids = ['wkr']) {
    for (const u of uids) {
      await profile(u);
      await present(u);
    }
    const ids = (await calculate()).allowances.map((a) => a.allowanceId);
    await decide('mgr', ids, 'full');
    return ids;
  }

  test('paying reduces the chosen account through ONE allowance_payment ledger entry; marked paid; audited', async () => {
    await fund(100000);
    const ids = await approved(['wkr', 'wkr2']);
    const r = await payAll('mgr', ids, { reference: 'Cash envelope' });
    assert.equal(r.totalUgx, 10000);
    assert.equal(await balance('cash_at_hand'), 90000);
    const [t] = await txns({ type: 'allowance_payment' });
    assert.deepEqual([t.amountUgx, t.sourceAccountId, t.isRevenue, t.allowanceIds.length], [10000, 'cash_at_hand', false, 2]);
    for (const id of ids) {
      const a = await doc(`worker_allowances/${id}`);
      assert.deepEqual([a.status, a.paidVia, a.financialTransactionId, a.paidFromAccountId], ['paid', 'direct', t.transactionId, 'cash_at_hand']);
    }
    assert.equal((await doc('finance_daily_summaries/2026-09-21')).allowancesPaidUgx, 10000);
    assert.equal((await audits('allowance.paid')).length, 2);
    await assertLedgerConsistent();
  });

  test('a repeated request pays once; a second payment is refused', async () => {
    await fund(100000);
    const ids = await approved();
    const requestId = rid();
    await payAll('mgr', ids, { requestId });
    const again = await payAll('mgr', ids, { requestId });
    assert.equal(again.duplicate, true);
    await rejects(payAll('mgr', ids), 'failed-precondition', 'already_paid');
    assert.equal((await txns({ type: 'allowance_payment' })).length, 1);
    assert.equal(await balance('cash_at_hand'), 95000);
  });

  test('insufficient funds: nothing moves, nothing is marked paid', async () => {
    await fund(3000);
    const ids = await approved();
    await rejects(payAll('mgr', ids), 'failed-precondition', 'insufficient_funds');
    assert.equal(await balance('cash_at_hand'), 3000);
    assert.equal((await doc(`worker_allowances/${ids[0]}`)).status, 'approved');
  });

  test('only approved allowances are paid; workers and auditors cannot pay; nobody pays themselves', async () => {
    await fund(100000);
    await profile('wkr');
    await present('wkr');
    const [id] = (await calculate()).allowances.map((a) => a.allowanceId);
    await rejects(payAll('mgr', id), 'failed-precondition', 'not_approved');
    await decide('mgr', id, 'full');
    for (const who of ['wkr', 'wkr2', 'aud', 'cash']) await rejects(payAll(who, id), 'permission-denied');
    await db.doc('users/wkr').update({ permissions: ['allowances.pay'] });
    await rejects(payAll('wkr', id), 'permission-denied', 'self_action');
    await rejects(payAll('mgr', id, { accountId: 'no_such_account' }), 'not-found');
  });

  test('reversal returns the money and puts the allowances back to approved; Finance refuses to reverse it directly', async () => {
    await fund(100000);
    const ids = await approved();
    const r = await payAll('mgr', ids);
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: r.transactionId, reason: 'Mistake' }), 'failed-precondition', 'use_pay_reversal');
    await rejects(allowances.reverseAllowancePayment(deps, 'wkr', { transactionId: r.transactionId, reason: 'Mistake' }, NOW), 'permission-denied');
    await allowances.reverseAllowancePayment(deps, 'admin', { transactionId: r.transactionId, reason: 'Paid the wrong day' }, NOW);
    assert.equal(await balance('cash_at_hand'), 100000);
    const a = await doc(`worker_allowances/${ids[0]}`);
    assert.deepEqual([a.status, a.paymentReversalReason, a.financialTransactionId], ['approved', 'Paid the wrong day', null]);
    assert.equal((await doc(`financial_transactions/${r.transactionId}`)).status, 'reversed');
    await rejects(allowances.reverseAllowancePayment(deps, 'admin', { transactionId: r.transactionId, reason: 'Again' }, NOW), 'failed-precondition', 'already_reversed');
    await assertLedgerConsistent();
  });

  test('a cancelled allowance frees the attendance day for recalculation', async () => {
    const ids = await approved();
    await rejects(allowances.cancelAllowance(deps, 'mgr', { allowanceIds: ids }, NOW), 'invalid-argument', 'reason');
    await allowances.cancelAllowance(deps, 'mgr', { allowanceIds: ids, reason: 'Wrong day' }, NOW);
    assert.equal((await doc(`worker_allowances/${ids[0]}`)).status, 'cancelled');
    assert.equal((await calculate()).created, 1);
  });
});
