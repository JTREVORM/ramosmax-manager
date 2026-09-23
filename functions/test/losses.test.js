// Loss incidents, approved recoveries through payroll and salary deductions:
// no automatic deductions, no over-recovery, no recovery after cancellation,
// only from the staff member linked to the incident (Phase 6) - against the
// Firestore emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as finance from '../src/finance.js';
import * as losses from '../src/losses.js';
import * as payroll from '../src/payroll.js';
import { eat, emulatorDb, rejects, resetAndSeed, workforceHelpers } from './helpers.js';

const db = emulatorDb('loss-tests');
const { deps, doc, all } = workforceHelpers(db);
const audits = async (action) => all('audit_logs', { action });

beforeEach(() => resetAndSeed(db));

const NOW = eat(15, 12, 0, 12); // 15 December 2026
let seq = 0;
const rid = () => `loss-${Date.now()}-${seq++}`;

const report = (actor = 'mgr', extra = {}) => losses.createLossIncident(deps, actor, {
  staffUid: 'wkr', incidentType: 'damaged_customer_property', amountUgx: 300000,
  description: 'Side mirror broken while reversing a customer vehicle', incidentDate: eat(5, 12, 0, 9), requestId: rid(), ...extra,
}, NOW);
const decide = (incidentId, decision, extra = {}, actor = 'admin') =>
  losses.decideLossIncident(deps, actor, { incidentId, decision, reason: 'Investigated: negligence confirmed', ...extra }, NOW);
const schedule = (incidentId, instalmentUgx = 50000, actor = 'mgr') =>
  losses.scheduleLossRecovery(deps, actor, { incidentId, instalmentUgx, startDate: eat(1, 12, 0, 9) }, NOW);

async function staffOnPayroll() {
  await finance.recordOpeningBalance(deps, 'admin', { accountId: 'cash_at_hand', amountUgx: 10_000_000 });
  for (const [uid, basic] of [['wkr', 600000], ['wkr2', 400000]]) {
    await payroll.setSalaryProfile(deps, 'admin', { staffUid: uid, basicSalaryUgx: basic, effectiveFrom: eat(1, 12, 0, 1) }, NOW);
  }
}

/** Creates, prepares and (optionally) pays the monthly payroll for [month]. */
async function runPayroll(month, { pay = true } = {}) {
  const { payrollId } = await payroll.createPayroll(deps, 'mgr', { frequency: 'monthly', year: 2026, month }, NOW);
  await payroll.preparePayroll(deps, 'mgr', { payrollId }, NOW);
  const items = Object.fromEntries((await all('payroll_items', { payrollId })).filter((i) => i.current).map((i) => [i.staffUid, i]));
  if (pay) {
    for (const [action, actor] of [['submit', 'mgr'], ['review', 'mgr'], ['approve', 'admin']]) {
      await payroll.updatePayrollStatus(deps, actor, { payrollId, action }, NOW);
    }
    await payroll.payPayroll(deps, 'admin', { payrollId, accountId: 'cash_at_hand', requestId: rid() }, NOW);
  }
  return { payrollId, items };
}

describe('incidents', () => {
  test('reporting creates an incident (RMX-LOSS) and nothing else: no deduction; reviewers only; audited', async () => {
    const r = await report();
    assert.equal(r.lossNumber, 'RMX-LOSS-000001');
    const inc = await doc(`loss_incidents/${r.incidentId}`);
    assert.deepEqual([inc.status, inc.staffUid, inc.amountUgx, inc.outstandingUgx, inc.visibleToStaff, inc.deductionId],
      ['reported', 'wkr', 300000, 0, false, null]);
    assert.equal((await all('salary_deductions')).length, 0);
    assert.equal((await audits('loss.created')).length, 1);
    for (const who of ['wkr', 'aud', 'sh']) await rejects(report(who), 'permission-denied');
  });

  test('review → approve a recovery of 150,000 of a 300,000 loss; the staff member can now see it', async () => {
    const { incidentId } = await report();
    await losses.reviewLossIncident(deps, 'mgr', { incidentId, notes: 'CCTV checked' }, NOW);
    assert.equal((await doc(`loss_incidents/${incidentId}`)).status, 'under_review');
    await rejects(decide(incidentId, 'approve', { approvedRecoveryUgx: 150000 }, 'mgr'), 'permission-denied');
    await rejects(decide(incidentId, 'approve', { approvedRecoveryUgx: 350000 }), 'invalid-argument', 'over_recovery');
    await decide(incidentId, 'approve', { approvedRecoveryUgx: 150000 });
    const inc = await doc(`loss_incidents/${incidentId}`);
    assert.deepEqual([inc.status, inc.approvedRecoveryUgx, inc.outstandingUgx, inc.approvedBy, inc.visibleToStaff],
      ['approved', 150000, 150000, 'admin', true]);
    assert.equal((await all('salary_deductions')).length, 0, 'approval alone deducts nothing');
    assert.equal((await audits('loss.approved')).length, 1);
  });

  test('rejection needs a reason and ends the matter', async () => {
    const { incidentId } = await report();
    await rejects(losses.decideLossIncident(deps, 'admin', { incidentId, decision: 'reject' }, NOW), 'invalid-argument', 'reason');
    await decide(incidentId, 'reject', { reason: 'Mirror was already cracked at intake' });
    assert.equal((await doc(`loss_incidents/${incidentId}`)).status, 'rejected');
    await rejects(schedule(incidentId), 'failed-precondition', 'invalid_status');
  });

  test('nothing can be recovered when no staff member is linked; nobody decides their own incident', async () => {
    const { incidentId } = await report('mgr', { staffUid: null, incidentType: 'stock_loss', description: 'Wax bottles missing after stock count' });
    await rejects(decide(incidentId, 'approve', { approvedRecoveryUgx: 1000 }), 'invalid-argument', 'no_staff');
    await decide(incidentId, 'approve', { approvedRecoveryUgx: 0, reason: 'Business absorbs the loss' });
    const own = await report('admin', { staffUid: 'mgr' });
    await rejects(losses.reviewLossIncident(deps, 'mgr', { incidentId: own.incidentId }, NOW), 'permission-denied', 'self_action');
  });
});

describe('recovery through payroll', () => {
  test('150,000 at 50,000 a month: 150,000 → 100,000 → 50,000 → 0, then nothing more (no over-recovery)', async () => {
    await staffOnPayroll();
    const { incidentId } = await report();
    await decide(incidentId, 'approve', { approvedRecoveryUgx: 150000 });
    await rejects(schedule(incidentId, 200000), 'invalid-argument', 'instalment');
    const s = await schedule(incidentId);
    assert.equal(s.deductionNumber, 'RMX-DED-000001');
    const d0 = await doc(`salary_deductions/${s.deductionId}`);
    assert.deepEqual([d0.type, d0.totalAmountUgx, d0.instalmentUgx, d0.remainingUgx, d0.lossIncidentId, d0.staffUid],
      ['loss_recovery', 150000, 50000, 150000, incidentId, 'wkr']);
    assert.equal((await doc(`loss_incidents/${incidentId}`)).status, 'recovery_scheduled');
    await rejects(schedule(incidentId), 'failed-precondition', 'invalid_status');

    const outstanding = [];
    for (const month of [9, 10, 11]) {
      const { items } = await runPayroll(month);
      assert.deepEqual([items.wkr.lossRecoveriesUgx, items.wkr.netUgx], [50000, 550000], `month ${month}`);
      assert.equal(items.wkr.deductions[0].lossIncidentId, incidentId);
      assert.equal(items.wkr2.totalDeductionsUgx, 0, 'only the linked staff member pays');
      const inc = await doc(`loss_incidents/${incidentId}`);
      outstanding.push([inc.outstandingUgx, inc.status]);
    }
    assert.deepEqual(outstanding, [[100000, 'partially_recovered'], [50000, 'partially_recovered'], [0, 'recovered']]);
    const d = await doc(`salary_deductions/${s.deductionId}`);
    assert.deepEqual([d.status, d.recoveredUgx, d.remainingUgx, d.applications.length], ['completed', 150000, 0, 3]);
    const inc = await doc(`loss_incidents/${incidentId}`);
    assert.equal(inc.recoveredUgx, 150000);
    const { items } = await runPayroll(12, { pay: false });
    assert.deepEqual([items.wkr.totalDeductionsUgx, items.wkr.netUgx], [0, 600000]);
    await rejects(schedule(incidentId), 'failed-precondition', 'invalid_status');
    assert.equal((await audits('loss.recovered')).length, 3);
  });

  test('a small last instalment takes only what is left', async () => {
    await staffOnPayroll();
    const { incidentId } = await report();
    await decide(incidentId, 'approve', { approvedRecoveryUgx: 70000 });
    await schedule(incidentId, 50000);
    await runPayroll(9);
    const { items } = await runPayroll(10);
    assert.equal(items.wkr.lossRecoveriesUgx, 20000);
    assert.equal((await doc(`loss_incidents/${incidentId}`)).status, 'recovered');
  });

  test('cancellation: refused while a payroll plans the recovery; afterwards nothing more is recovered and what was is kept', async () => {
    await staffOnPayroll();
    const { incidentId } = await report();
    await decide(incidentId, 'approve', { approvedRecoveryUgx: 150000 });
    await schedule(incidentId);
    await runPayroll(9);
    const oct = await runPayroll(10, { pay: false });
    await rejects(losses.cancelLossIncident(deps, 'admin', { incidentId, reason: 'Customer withdrew the claim' }, NOW), 'failed-precondition', 'deduction_in_payroll');
    await payroll.cancelPayroll(deps, 'admin', { payrollId: oct.payrollId, reason: 'Recalculate after the claim was withdrawn' }, NOW);
    await rejects(losses.cancelLossIncident(deps, 'mgr', { incidentId, reason: 'Customer withdrew the claim' }, NOW), 'permission-denied');
    await losses.cancelLossIncident(deps, 'admin', { incidentId, reason: 'Customer withdrew the claim' }, NOW);
    const inc = await doc(`loss_incidents/${incidentId}`);
    assert.deepEqual([inc.status, inc.recoveredUgx, inc.cancelledOutstandingUgx, inc.outstandingUgx], ['cancelled', 50000, 100000, 0]);
    assert.equal((await doc(`salary_deductions/${inc.deductionId}`)).status, 'cancelled');
    const { items } = await runPayroll(10, { pay: false });
    assert.equal(items.wkr.totalDeductionsUgx, 0);
    await rejects(schedule(incidentId), 'failed-precondition', 'invalid_status');
    assert.equal((await audits('loss.cancelled')).length, 1);
  });

  test('a payment reversal gives the recovery back to the incident', async () => {
    await staffOnPayroll();
    const { incidentId } = await report();
    await decide(incidentId, 'approve', { approvedRecoveryUgx: 150000 });
    await schedule(incidentId);
    const { payrollId } = await runPayroll(9);
    assert.equal((await doc(`loss_incidents/${incidentId}`)).outstandingUgx, 100000);
    await payroll.reversePayrollPayment(deps, 'admin', { payrollId, reason: 'Paid from the wrong account' }, NOW);
    const inc = await doc(`loss_incidents/${incidentId}`);
    assert.deepEqual([inc.outstandingUgx, inc.recoveredUgx, inc.status], [150000, 0, 'recovery_scheduled']);
  });
});

describe('other salary deductions', () => {
  const create = (actor, extra = {}) => losses.createSalaryDeduction(deps, actor, {
    staffUid: 'wkr', type: 'authorized_deduction', totalAmountUgx: 60000, instalmentUgx: 20000,
    reason: 'Phone repaid in instalments', reference: 'AGR-9', startDate: eat(1, 12, 0, 9), requestId: rid(), ...extra,
  }, NOW);

  test('need a reason and a source document, then approval before they apply', async () => {
    await staffOnPayroll();
    await rejects(create('admin', { reference: null }), 'invalid-argument', 'source');
    await rejects(create('admin', { reason: '' }), 'invalid-argument', 'reason');
    await rejects(create('admin', { type: 'salary_advance' }), 'invalid-argument', 'deduction_type');
    await rejects(create('admin', { instalmentUgx: 70000 }), 'invalid-argument', 'instalment');
    for (const who of ['mgr', 'cash', 'wkr', 'aud']) await rejects(create(who), 'permission-denied');
    const d = await create('admin');
    assert.equal((await doc(`salary_deductions/${d.deductionId}`)).status, 'pending_approval');
    const sep = await runPayroll(9, { pay: false });
    assert.equal(sep.items.wkr.totalDeductionsUgx, 0, 'a pending deduction is not applied');
    await payroll.cancelPayroll(deps, 'admin', { payrollId: sep.payrollId, reason: 'Wait for the deduction approval' }, NOW);
    await rejects(losses.decideSalaryDeduction(deps, 'wkr', { deductionId: d.deductionId, decision: 'approve' }, NOW), 'permission-denied');
    await losses.decideSalaryDeduction(deps, 'admin', { deductionId: d.deductionId, decision: 'approve' }, NOW);
    const { items } = await runPayroll(9);
    assert.deepEqual([items.wkr.salaryDeductionsUgx, items.wkr.netUgx], [20000, 580000]);
    assert.equal((await doc(`salary_deductions/${d.deductionId}`)).remainingUgx, 40000);
  });

  test('nobody creates or approves a deduction from their own pay; a duplicate request creates one', async () => {
    await rejects(losses.createSalaryDeduction(deps, 'admin', {
      staffUid: 'admin', type: 'other', totalAmountUgx: 1000, reason: 'Own deduction', reference: 'X', requestId: rid(),
    }, NOW), 'permission-denied', 'self_action');
    const requestId = rid();
    const a = await create('admin', { requestId });
    const b = await create('admin', { requestId });
    assert.equal(b.duplicate, true);
    assert.equal(a.deductionId, b.deductionId);
    assert.equal((await all('salary_deductions')).length, 1);
  });
});
