// Salary profiles (effective-dated history) and payroll: calculation, review
// and approval, payment through the Phase 5 ledger, duplicate payment
// prevention, locking, corrections, reversal and worker isolation of totals
// (Phase 6) - against the Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as allowances from '../src/allowances.js';
import * as attendance from '../src/attendance.js';
import * as finance from '../src/finance.js';
import * as losses from '../src/losses.js';
import * as payroll from '../src/payroll.js';
import * as workforce from '../src/workforce.js';
import { eat, emulatorDb, financeHelpers, rejects, resetAndSeed, workforceHelpers } from './helpers.js';

const db = emulatorDb('payroll-tests');
const { deps, doc, all } = workforceHelpers(db);
const { balance, txns, assertLedgerConsistent } = financeHelpers(db);
const audits = async (action) => all('audit_logs', { action });

beforeEach(() => resetAndSeed(db));

const NOW = eat(15, 12, 0, 12); // 15 December 2026
let seq = 0;
const rid = () => `pay-${Date.now()}-${seq++}`;
const JAN1 = eat(1, 12, 0, 1);

const salary = (staffUid, basicSalaryUgx, extra = {}, now = NOW) =>
  payroll.setSalaryProfile(deps, 'admin', { staffUid, basicSalaryUgx, effectiveFrom: JAN1, ...extra }, now);
const create = (month = 9, actor = 'mgr', extra = {}) => payroll.createPayroll(deps, actor, { frequency: 'monthly', year: 2026, month, ...extra }, NOW);
const prepare = (payrollId, actor = 'mgr', extra = {}) => payroll.preparePayroll(deps, actor, { payrollId, ...extra }, NOW);
const act = (payrollId, action, actor, extra = {}) => payroll.updatePayrollStatus(deps, actor, { payrollId, action, ...extra }, NOW);
const payIt = (payrollId, actor = 'admin', extra = {}) => payroll.payPayroll(deps, actor, { payrollId, accountId: 'cash_at_hand', requestId: rid(), ...extra }, NOW);
const fund = (amountUgx) => finance.recordOpeningBalance(deps, 'admin', { accountId: 'cash_at_hand', amountUgx });
const items = async (payrollId) => (await all('payroll_items', { payrollId })).filter((i) => i.current)
  .reduce((m, i) => ({ ...m, [i.staffUid]: i }), {});

/** An approved allowance for [uid] on September [day] (created with September clocks). */
async function allowanceFor(uid, day) {
  const r = await attendance.recordAttendance(deps, uid, {}, eat(day, 8));
  await attendance.verifyAttendance(deps, 'admin', { attendanceIds: [r.attendanceId], action: 'approve' }, eat(day, 18));
  const c = await allowances.calculateAllowances(deps, 'admin', { date: eat(day, 12), attendanceIds: [r.attendanceId] }, eat(day, 18));
  await allowances.reviewAllowance(deps, 'admin', { allowanceIds: [c.allowances[0].allowanceId], decision: 'full' }, eat(day, 18));
  return c.allowances[0].allowanceId;
}

/** An approved authorised deduction from [uid]. */
async function deduction(uid, totalAmountUgx, extra = {}) {
  const d = await losses.createSalaryDeduction(deps, 'admin', {
    staffUid: uid, type: 'authorized_deduction', totalAmountUgx, reason: 'Uniform replacement, signed agreement',
    reference: 'AGR-2026-014', startDate: eat(1, 12, 0, 9), requestId: rid(), ...extra,
  }, NOW);
  await losses.decideSalaryDeduction(deps, 'admin', { deductionId: d.deductionId, decision: 'approve' }, NOW);
  return d.deductionId;
}

/** The brief's example: basic 600,000 + allowances 100,000 = 700,000; deductions 50,000; net 650,000. */
async function example() {
  await salary('wkr', 600000, { allowanceAmountUgx: 50000 });
  await salary('wkr2', 400000);
  const allowanceIds = [await allowanceFor('wkr', 21), await allowanceFor('wkr', 22)];
  const deductionId = await deduction('wkr', 50000);
  const { payrollId, payrollNumber } = await create();
  await prepare(payrollId);
  return { payrollId, payrollNumber, allowanceIds, deductionId };
}

async function toApproved(payrollId) {
  await act(payrollId, 'submit', 'mgr');
  await act(payrollId, 'review', 'mgr');
  await act(payrollId, 'approve', 'admin');
}

describe('salary profiles and history', () => {
  test('a salary profile is created with version 1 history; audited', async () => {
    const r = await salary('wkr', 500000);
    assert.equal(r.version, 1);
    const p = await doc('salary_profiles/wkr');
    assert.deepEqual([p.basicSalaryUgx, p.paymentFrequency, p.active, p.allowanceEligible, p.currentHistoryId], [500000, 'monthly', true, true, 'wkr_v1']);
    const h = await doc('salary_history/wkr_v1');
    assert.deepEqual([h.basicSalaryUgx, h.version, h.previousValue], [500000, 1, null]);
    assert.equal((await audits('salary.created')).length, 1);
  });

  test('a change is a new effective-dated version; the old one is kept; a reason is required; no backdating', async () => {
    await salary('wkr', 500000);
    await rejects(salary('wkr', 600000, { effectiveFrom: eat(1, 12, 0, 7) }), 'invalid-argument', 'reason');
    await salary('wkr', 600000, { effectiveFrom: eat(1, 12, 0, 7), reason: 'Annual review' });
    assert.equal((await doc('salary_history/wkr_v1')).basicSalaryUgx, 500000);
    const v2 = await doc('salary_history/wkr_v2');
    assert.deepEqual([v2.basicSalaryUgx, v2.previousValue.basicSalaryUgx, v2.reason], [600000, 500000, 'Annual review']);
    assert.equal((await doc('salary_profiles/wkr')).basicSalaryUgx, 600000);
    await rejects(salary('wkr', 650000, { effectiveFrom: eat(1, 12, 0, 3), reason: 'Backdate' }), 'failed-precondition', 'backdated');
    await rejects(salary('wkr', 600000, { effectiveFrom: eat(1, 12, 0, 7), reason: 'Same again' }), 'failed-precondition', 'no_changes');
    assert.equal((await audits('salary.changed')).length, 1);
  });

  test('the version in force is chosen by date: January–June 500,000, from July 600,000', async () => {
    await salary('wkr', 500000);
    await salary('wkr', 600000, { effectiveFrom: eat(1, 12, 0, 7), reason: 'Annual review' });
    const versions = await all('salary_history');
    assert.equal(workforce.versionOn(versions, 'wkr', eat(30, 12, 0, 6)).basicSalaryUgx, 500000);
    assert.equal(workforce.versionOn(versions, 'wkr', eat(1, 12, 0, 7)).basicSalaryUgx, 600000);
    assert.equal(workforce.versionOn(versions, 'wkr', eat(31, 12, 0, 12) - 366 * 24 * 3600_000), null);
  });

  test('deactivation and reactivation are versions too', async () => {
    await salary('wkr', 500000);
    await salary('wkr', 500000, { active: false, effectiveFrom: eat(1, 12, 0, 10), reason: 'Left the business' });
    assert.equal((await audits('salary.deactivated')).length, 1);
    assert.equal((await doc('salary_profiles/wkr')).active, false);
  });

  test('only salary.manage; nobody sets their own salary; tampered values are refused', async () => {
    for (const who of ['mgr', 'cash', 'wkr', 'aud']) {
      await rejects(payroll.setSalaryProfile(deps, who, { staffUid: 'wkr2', basicSalaryUgx: 9_000_000 }, NOW), 'permission-denied');
    }
    await rejects(payroll.setSalaryProfile(deps, 'admin', { staffUid: 'admin', basicSalaryUgx: 9000000 }, NOW), 'permission-denied', 'self_action');
    await rejects(payroll.setSalaryProfile(deps, 'admin', { staffUid: 'wkr', basicSalaryUgx: -5 }, NOW), 'invalid-argument', 'amount');
    await rejects(payroll.setSalaryProfile(deps, 'admin', { staffUid: 'wkr', basicSalaryUgx: 1.5 }, NOW), 'invalid-argument', 'amount');
    await rejects(payroll.setSalaryProfile(deps, 'admin', { staffUid: 'wkr', basicSalaryUgx: '500000' }, NOW), 'invalid-argument', 'amount');
    await rejects(payroll.setSalaryProfile(deps, 'admin', { staffUid: 'wkr', basicSalaryUgx: 1, paymentFrequency: 'daily' }, NOW), 'invalid-argument', 'frequency');
  });
});

describe('payroll periods', () => {
  test('RMX-PAY numbering; one payroll per period; no future periods; weekly periods start on Monday', async () => {
    const a = await create(9);
    assert.equal(a.payrollNumber, 'RMX-PAY-000001');
    const p = await doc(`payroll/${a.payrollId}`);
    assert.deepEqual([p.status, p.periodKey, p.periodLabel, p.periodStart.toMillis(), p.periodEnd.toMillis()],
      ['draft', '2026-09', 'September 2026', eat(1, 0, 0, 9), eat(1, 0, 0, 10)]);
    await rejects(create(9), 'already-exists', 'duplicate_payroll');
    await rejects(create(1, 'mgr', { year: 2027 }), 'invalid-argument', 'period');
    await rejects(payroll.createPayroll(deps, 'mgr', { frequency: 'weekly', weekStart: eat(22, 12) }, NOW), 'invalid-argument', 'period');
    const w = await payroll.createPayroll(deps, 'mgr', { frequency: 'weekly', weekStart: eat(21, 12) }, NOW);
    assert.equal((await doc(`payroll/${w.payrollId}`)).periodKey, 'W2026-09-21');
    for (const who of ['wkr', 'cash', 'aud']) await rejects(create(10, who), 'permission-denied');
  });

  test('the legacy payroll.process permission still prepares payroll', async () => {
    await db.doc('users/cash').update({ permissions: ['payroll.process'] });
    await create(9, 'cash');
  });
});

describe('calculation', () => {
  test("the brief's example: 600,000 + 100,000 = 700,000 gross; 50,000 deducted; 650,000 net", async () => {
    const { payrollId } = await example();
    const i = await items(payrollId);
    assert.deepEqual(
      [i.wkr.basicSalaryUgx, i.wkr.allowancesUgx, i.wkr.allowanceDays, i.wkr.otherEarningsUgx, i.wkr.grossUgx, i.wkr.salaryDeductionsUgx,
        i.wkr.lossRecoveriesUgx, i.wkr.totalDeductionsUgx, i.wkr.netUgx],
      [600000, 100000, 2, 0, 700000, 50000, 0, 50000, 650000]);
    assert.deepEqual([i.wkr2.grossUgx, i.wkr2.totalDeductionsUgx, i.wkr2.netUgx], [400000, 0, 400000]);
    assert.match(i.wkr.itemNumber, /^RMX-PAY-000001-00[12]$/);
    const p = await doc(`payroll/${payrollId}`);
    assert.deepEqual([p.status, p.employeeCount, p.totalGrossUgx, p.totalDeductionsUgx, p.totalNetUgx, p.version],
      ['prepared', 2, 1100000, 50000, 1050000, 1]);
    assert.equal((await audits('payroll.prepared')).length, 1);
  });

  test('client-supplied totals, salaries and deductions are ignored', async () => {
    await salary('wkr', 600000);
    const { payrollId } = await create();
    await prepare(payrollId, 'mgr', { totalNetUgx: 1, basicSalaryUgx: 9_999_999, items: [{ staffUid: 'wkr', netUgx: 5_000_000 }] });
    assert.equal((await items(payrollId)).wkr.netUgx, 600000);
    assert.equal((await doc(`payroll/${payrollId}`)).totalNetUgx, 600000);
  });

  test('only active monthly profiles in force at period end are included; a pending deduction is not applied', async () => {
    await salary('wkr', 600000);
    await salary('wkr2', 400000, { paymentFrequency: 'weekly' });
    await salary('cash', 300000, { effectiveFrom: eat(1, 12, 0, 11) }); // starts after September
    await losses.createSalaryDeduction(deps, 'admin', {
      staffUid: 'wkr', type: 'other', totalAmountUgx: 20000, reason: 'Pending approval', reference: 'X-1', startDate: eat(1, 12, 0, 9), requestId: rid(),
    }, NOW);
    const { payrollId } = await create();
    await prepare(payrollId);
    const i = await items(payrollId);
    assert.deepEqual(Object.keys(i), ['wkr']);
    assert.equal(i.wkr.totalDeductionsUgx, 0);
  });

  test('other authorised earnings with a reason; recalculated; removable', async () => {
    const { payrollId } = await example();
    await rejects(payroll.addPayrollEarning(deps, 'admin', { payrollId, staffUid: 'wkr2', description: 'Overtime', amountUgx: 20000 }, NOW), 'invalid-argument', 'reason');
    await rejects(payroll.addPayrollEarning(deps, 'mgr', { payrollId, staffUid: 'wkr2', description: 'Overtime', amountUgx: 20000, reason: 'Sunday shift' }, NOW), 'permission-denied');
    const r = await payroll.addPayrollEarning(deps, 'admin', { payrollId, staffUid: 'wkr2', description: 'Overtime', amountUgx: 20000, reason: 'Sunday shift' }, NOW);
    const i = await items(payrollId);
    assert.deepEqual([i.wkr2.otherEarningsUgx, i.wkr2.grossUgx, i.wkr2.netUgx], [20000, 420000, 420000]);
    assert.equal((await doc(`payroll/${payrollId}`)).totalNetUgx, 1070000);
    await payroll.removePayrollEarning(deps, 'admin', { payrollId, entryId: r.entryId, reason: 'Entered twice' }, NOW);
    assert.equal((await doc(`payroll/${payrollId}`)).totalNetUgx, 1050000);
  });

  test('deductions never exceed the configured share of gross pay, so net pay is never negative', async () => {
    await workforce.updatePayrollPolicy(deps, 'admin', { changes: { maxDeductionPercentOfGross: 10 }, reason: 'Company rule: at most 10%' }, NOW);
    await salary('wkr', 100000);
    await deduction('wkr', 50000);
    await deduction('wkr', 30000);
    const { payrollId } = await create();
    await prepare(payrollId);
    const i = (await items(payrollId)).wkr;
    assert.deepEqual([i.grossUgx, i.totalDeductionsUgx, i.netUgx, i.deductionCapped], [100000, 10000, 90000, true]);
    assert.deepEqual(i.deductions.map((d) => [d.plannedUgx, d.amountUgx]), [[50000, 10000], [30000, 0]]);

    await workforce.updatePayrollPolicy(deps, 'admin', { changes: { maxDeductionPercentOfGross: 100 }, reason: 'Back to the default' }, NOW);
    await deduction('wkr', 90000);
    await prepare(payrollId);
    const j = (await items(payrollId)).wkr;
    assert.deepEqual([j.totalDeductionsUgx, j.netUgx, j.deductionCapped], [100000, 0, true]);
  });
});

describe('review and approval', () => {
  test('prepare → submit → review → admin approval, in order; audited', async () => {
    const { payrollId } = await example();
    await rejects(act(payrollId, 'approve', 'admin'), 'failed-precondition', 'invalid_status');
    await act(payrollId, 'submit', 'mgr');
    await rejects(act(payrollId, 'approve', 'admin'), 'failed-precondition', 'not_reviewed');
    await act(payrollId, 'review', 'mgr', { notes: 'Checked against attendance' });
    await rejects(act(payrollId, 'approve', 'mgr'), 'permission-denied');
    await act(payrollId, 'approve', 'admin');
    const p = await doc(`payroll/${payrollId}`);
    assert.deepEqual([p.status, p.reviewedBy, p.approvedBy], ['approved', 'mgr', 'admin']);
    for (const a of ['payroll.submitted', 'payroll.reviewed', 'payroll.approved']) assert.equal((await audits(a)).length, 1, a);
  });

  test('a manager granted payroll.approve still needs an Administrator while the policy says so', async () => {
    const { payrollId } = await example();
    await db.doc('users/mgr').update({ permissions: ['payroll.approve'] });
    await act(payrollId, 'submit', 'mgr');
    await act(payrollId, 'review', 'mgr');
    await rejects(act(payrollId, 'approve', 'mgr'), 'permission-denied', 'admin_approval_required');
  });

  test('nobody approves (or reviews) a payroll that pays them; workers cannot approve at all', async () => {
    await workforce.updatePayrollPolicy(deps, 'admin', { changes: { payrollRequiresAdminApproval: false }, reason: 'Delegated to managers' }, NOW);
    await salary('mgr', 1000000);
    await salary('wkr', 600000);
    await db.doc('users/mgr').update({ permissions: ['payroll.approve'] });
    const { payrollId } = await create();
    await prepare(payrollId);
    await act(payrollId, 'submit', 'mgr');
    await rejects(act(payrollId, 'review', 'mgr'), 'permission-denied', 'self_action');
    await act(payrollId, 'review', 'admin');
    await rejects(act(payrollId, 'approve', 'mgr'), 'permission-denied', 'self_action');
    await rejects(act(payrollId, 'approve', 'wkr'), 'permission-denied');
  });

  test('returning for correction needs a reason and goes back to prepared', async () => {
    const { payrollId } = await example();
    await act(payrollId, 'submit', 'mgr');
    await rejects(act(payrollId, 'return', 'mgr'), 'invalid-argument', 'reason');
    await act(payrollId, 'return', 'mgr', { reason: 'Missing overtime' });
    assert.equal((await doc(`payroll/${payrollId}`)).status, 'prepared');
  });
});

describe('payment', () => {
  test('pays the total net from one account with ONE payroll_payment entry; allowances and deductions applied; payslips visible', async () => {
    await fund(2000000);
    const { payrollId, allowanceIds, deductionId } = await example();
    await rejects(allowances.payAllowances(deps, 'admin', { allowanceIds, accountId: 'cash_at_hand', requestId: rid() }, NOW), 'failed-precondition', 'allowance_in_payroll');
    await toApproved(payrollId);
    const r = await payIt(payrollId);
    assert.equal(r.totalNetUgx, 1050000);
    assert.equal(await balance('cash_at_hand'), 950000);
    const [t] = await txns({ type: 'payroll_payment' });
    assert.deepEqual([t.amountUgx, t.payrollId, t.isRevenue, t.sourceAccountId, t.employeeCount], [1050000, payrollId, false, 'cash_at_hand', 2]);
    const p = await doc(`payroll/${payrollId}`);
    assert.deepEqual([p.status, p.financialTransactionId, p.paidFromAccountId], ['paid', t.transactionId, 'cash_at_hand']);
    const i = await items(payrollId);
    assert.deepEqual([i.wkr.paymentStatus, i.wkr.visibleToStaff, i.wkr2.visibleToStaff], ['paid', true, true]);
    for (const id of allowanceIds) {
      const a = await doc(`worker_allowances/${id}`);
      assert.deepEqual([a.status, a.paidVia, a.payrollId], ['paid', 'payroll', payrollId]);
    }
    const d = await doc(`salary_deductions/${deductionId}`);
    assert.deepEqual([d.status, d.recoveredUgx, d.remainingUgx, d.applications.length], ['completed', 50000, 0, 1]);
    assert.equal((await doc('finance_daily_summaries/2026-12-15')).payrollPaidUgx, 1050000);
    await assertLedgerConsistent();
  });

  test('duplicate payment: a retried request pays once; a second payment is refused', async () => {
    await fund(2000000);
    const { payrollId } = await example();
    await toApproved(payrollId);
    const requestId = rid();
    await payIt(payrollId, 'admin', { requestId });
    assert.equal((await payIt(payrollId, 'admin', { requestId })).duplicate, true);
    await rejects(payIt(payrollId), 'failed-precondition', 'already_paid');
    assert.equal((await txns({ type: 'payroll_payment' })).length, 1);
    assert.equal(await balance('cash_at_hand'), 950000);
  });

  test('insufficient funds: nothing is paid; unapproved payrolls and unauthorised people cannot pay', async () => {
    await fund(100000);
    const { payrollId } = await example();
    await rejects(payIt(payrollId), 'failed-precondition', 'not_approved');
    await toApproved(payrollId);
    for (const who of ['mgr', 'cash', 'wkr', 'aud']) await rejects(payIt(payrollId, who), 'permission-denied');
    await rejects(payIt(payrollId), 'failed-precondition', 'insufficient_funds');
    assert.equal((await doc(`payroll/${payrollId}`)).status, 'approved');
    assert.equal(await balance('cash_at_hand'), 100000);
  });

  test('locked payrolls cannot be reversed, corrected or cancelled', async () => {
    await fund(2000000);
    const { payrollId } = await example();
    await toApproved(payrollId);
    await payIt(payrollId);
    await payroll.lockPayroll(deps, 'admin', { payrollId }, NOW);
    assert.equal((await doc(`payroll/${payrollId}`)).status, 'locked');
    await rejects(payroll.reversePayrollPayment(deps, 'admin', { payrollId, reason: 'Oops' }, NOW), 'failed-precondition', 'locked');
    await rejects(payroll.correctPayroll(deps, 'admin', { payrollId, reason: 'Oops' }, NOW), 'failed-precondition', 'invalid_status');
    await rejects(payroll.cancelPayroll(deps, 'admin', { payrollId, reason: 'Oops' }, NOW), 'failed-precondition', 'invalid_status');
    await rejects(prepare(payrollId), 'failed-precondition', 'invalid_status');
  });

  test('reversal after payment returns the money and undoes allowances and deductions; Finance cannot reverse it directly', async () => {
    await fund(2000000);
    const { payrollId, allowanceIds, deductionId } = await example();
    await toApproved(payrollId);
    const r = await payIt(payrollId);
    await rejects(finance.reverseFinancialTransaction(deps, 'admin', { transactionId: r.transactionId, reason: 'x x x' }), 'failed-precondition', 'use_pay_reversal');
    await rejects(payroll.reversePayrollPayment(deps, 'mgr', { payrollId, reason: 'Wrong account' }, NOW), 'permission-denied');
    await payroll.reversePayrollPayment(deps, 'admin', { payrollId, reason: 'Paid from the wrong account' }, NOW);
    assert.equal(await balance('cash_at_hand'), 2000000);
    assert.equal((await doc(`payroll/${payrollId}`)).status, 'approved');
    assert.equal((await doc(`worker_allowances/${allowanceIds[0]}`)).status, 'approved');
    const d = await doc(`salary_deductions/${deductionId}`);
    assert.deepEqual([d.status, d.remainingUgx, d.applications[0].reversed], ['active', 50000, true]);
    await payIt(payrollId);
    assert.equal(await balance('cash_at_hand'), 950000);
    await assertLedgerConsistent();
  });

  test('a corrected payroll keeps its old version as history and must be approved again', async () => {
    const { payrollId } = await example();
    await toApproved(payrollId);
    await rejects(payroll.correctPayroll(deps, 'admin', { payrollId }, NOW), 'invalid-argument', 'reason');
    await salary('wkr2', 450000, { effectiveFrom: eat(1, 12, 0, 9), reason: 'Promotion backdated to September' });
    const r = await payroll.correctPayroll(deps, 'admin', { payrollId, reason: 'Promotion missed' }, NOW);
    assert.equal(r.version, 2);
    const p = await doc(`payroll/${payrollId}`);
    assert.deepEqual([p.status, p.approvedBy, p.correctionCount, p.totalNetUgx], ['prepared', null, 1, 1100000]);
    const old = (await all('payroll_items', { payrollId })).filter((i) => !i.current);
    assert.deepEqual(old.map((i) => i.status), ['superseded', 'superseded']);
    assert.equal((await audits('payroll.corrected')).length, 1);
  });

  test('a salary change never alters a paid payroll', async () => {
    await fund(5000000);
    await salary('wkr', 500000);
    const { payrollId } = await create(6);
    await prepare(payrollId);
    await toApproved(payrollId);
    await payIt(payrollId);
    await salary('wkr', 600000, { effectiveFrom: eat(1, 12, 0, 7), reason: 'Annual review' });
    assert.equal((await items(payrollId)).wkr.basicSalaryUgx, 500000);
    const july = await create(7);
    await prepare(july.payrollId);
    assert.equal((await items(july.payrollId)).wkr.basicSalaryUgx, 600000);
  });

  test('a cancelled payroll frees its period', async () => {
    const { payrollId } = await example();
    await payroll.cancelPayroll(deps, 'admin', { payrollId, reason: 'Started too early' }, NOW);
    assert.equal((await doc(`payroll/${payrollId}`)).status, 'cancelled');
    assert.equal(Object.keys(await items(payrollId)).length, 0);
    const again = await create(9);
    assert.notEqual(again.payrollId, payrollId);
  });
});
