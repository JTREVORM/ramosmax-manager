// Attendance: recording, lateness and the grace period, verification,
// corrections, and the configurable policy (Phase 6) - against the Firestore
// emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as allowances from '../src/allowances.js';
import * as attendance from '../src/attendance.js';
import * as finance from '../src/finance.js';
import * as payroll from '../src/payroll.js';
import * as workforce from '../src/workforce.js';
import { eat, emulatorDb, rejects, resetAndSeed, workforceHelpers } from './helpers.js';

const db = emulatorDb('attendance-tests');
const { deps, doc, all } = workforceHelpers(db);
const audits = async (action) => all('audit_logs', { action });

beforeEach(() => resetAndSeed(db));

const MON = 21; // Monday 21 September 2026
const clockIn = (uid, hour, minute, day = MON) => attendance.recordAttendance(deps, uid, {}, eat(day, hour, minute));
const enter = (actor, staffUid, extra = {}, now = eat(MON, 18)) =>
  attendance.recordAttendance(deps, actor, { staffUid, date: eat(MON, 12), ...extra }, now);
const verify = (actor, ids, action = 'approve', extra = {}, now = eat(MON, 18)) =>
  attendance.verifyAttendance(deps, actor, { attendanceIds: [].concat(ids), action, ...extra }, now);

describe('the lateness rule (pure)', () => {
  const policy = workforce.policyFrom(null);
  const day = eat(MON, 0);
  const at = (h, m) => attendance.lateness(policy, day, eat(MON, h, m));

  test('reporting 08:00 with a 15-minute grace period: 08:05 and 08:14 on time, 08:20 late', () => {
    assert.deepEqual([at(8, 5).late, at(8, 14).late, at(8, 15).late, at(8, 16).late, at(8, 20).late], [false, false, false, true, true]);
    assert.equal(at(8, 20).minutesLate, 20);
    assert.equal(at(7, 45).minutesLate, 0);
  });

  test('beyond the late threshold (120 min by default) is severely late', () => {
    assert.equal(at(10, 0).severelyLate, false);
    assert.equal(at(10, 1).severelyLate, true);
  });
});

describe('recording attendance', () => {
  test('a worker clocks in with the server time; on time within the grace period; numbered and audited', async () => {
    const r = await clockIn('wkr', 8, 14);
    assert.equal(r.attendanceId, `wkr_2026-09-${MON}`);
    assert.equal(r.attendanceNumber, 'RMX-ATT-000001');
    const a = await doc(`attendance/${r.attendanceId}`);
    assert.deepEqual([a.arrivalStatus, a.minutesLate, a.late, a.status, a.verificationStatus, a.source, a.recordedVia, a.workingDay],
      ['on_time', 14, false, 'pending_verification', 'pending', 'manual', 'self', true]);
    assert.equal(a.clockInAt.toMillis(), eat(MON, 8, 14));
    assert.deepEqual([a.reportingTime, a.gracePeriodMinutes], ['08:00', 15]);
    assert.equal(a.staffUid, 'wkr');
    assert.equal((await audits('attendance.recorded')).length, 1);
  });

  test('08:20 is late', async () => {
    const r = await clockIn('wkr', 8, 20);
    assert.deepEqual([r.arrivalStatus, r.minutesLate, r.late], ['late', 20, true]);
  });

  test('a second record for the same person and day is refused', async () => {
    await clockIn('wkr', 8, 0);
    await rejects(clockIn('wkr', 9, 0), 'already-exists', 'duplicate_attendance');
    await rejects(enter('mgr', 'wkr', { clockInAt: eat(MON, 8, 0) }), 'already-exists', 'duplicate_attendance');
  });

  test('a manager enters attendance for others: present with times, absent, excused (with a reason)', async () => {
    const p = await enter('mgr', 'wkr', { clockInAt: eat(MON, 8, 30), clockOutAt: eat(MON, 17, 0) });
    assert.deepEqual([p.arrivalStatus, p.minutesLate], ['late', 30]);
    const a = await doc(`attendance/${p.attendanceId}`);
    assert.deepEqual([a.recordedVia, a.recordedBy, a.clockOutAt.toMillis()], ['manager', 'mgr', eat(MON, 17, 0)]);
    assert.equal((await enter('mgr', 'wkr2', { arrival: 'absent' })).arrivalStatus, 'absent');
    await rejects(enter('mgr', 'cash', { arrival: 'excused' }), 'invalid-argument', 'notes');
    assert.equal((await enter('mgr', 'cash', { arrival: 'excused', notes: 'Hospital visit' })).arrivalStatus, 'excused');
  });

  test('refused: future day, future clock-in, clock-in on another day, times on an absence', async () => {
    await rejects(enter('mgr', 'wkr', { date: eat(MON + 1, 12), clockInAt: eat(MON + 1, 8) }), 'invalid-argument', 'date');
    await rejects(enter('mgr', 'wkr', { clockInAt: eat(MON, 19) }), 'invalid-argument', 'time');
    await rejects(enter('mgr', 'wkr', { clockInAt: eat(MON - 1, 8) }), 'invalid-argument', 'time');
    await rejects(enter('mgr', 'wkr', { arrival: 'absent', clockInAt: eat(MON, 8) }), 'invalid-argument', 'time');
  });

  test('a worker cannot record attendance for someone else, or mark themselves absent', async () => {
    await rejects(enter('wkr', 'wkr2', { clockInAt: eat(MON, 8) }), 'permission-denied');
    await rejects(attendance.recordAttendance(deps, 'wkr', { arrival: 'excused', notes: 'x' }, eat(MON, 9)), 'invalid-argument', 'arrival');
    await rejects(enter('aud', 'wkr', { clockInAt: eat(MON, 8) }), 'permission-denied');
    await rejects(clockIn('wkrOff', 8, 0), 'permission-denied');
  });

  test('clock-out: once, after clock-in; not after verification', async () => {
    const r = await clockIn('wkr', 8, 0);
    await attendance.clockOut(deps, 'wkr', {}, eat(MON, 17, 30));
    assert.equal((await doc(`attendance/${r.attendanceId}`)).clockOutAt.toMillis(), eat(MON, 17, 30));
    await rejects(attendance.clockOut(deps, 'wkr', {}, eat(MON, 17, 45)), 'failed-precondition', 'already_clocked_out');
    const s = await clockIn('wkr2', 8, 0);
    await verify('mgr', s.attendanceId);
    await rejects(attendance.clockOut(deps, 'wkr2', {}, eat(MON, 17)), 'failed-precondition', 'verified');
  });

  test('biometric and imported sources exist in the model but no client can claim them', async () => {
    assert.deepEqual(attendance.SOURCES, ['manual', 'biometric', 'imported']);
    const r = await attendance.recordAttendance(deps, 'wkr', { source: 'biometric' }, eat(MON, 8));
    assert.equal((await doc(`attendance/${r.attendanceId}`)).source, 'manual');
  });
});

describe('verification', () => {
  test('a manager approves: on time → present, late → late; audited', async () => {
    const a = await clockIn('wkr', 8, 5);
    const b = await clockIn('wkr2', 8, 40);
    const r = await verify('mgr', [a.attendanceId, b.attendanceId]);
    assert.equal(r.count, 2);
    const [x, y] = [await doc(`attendance/${a.attendanceId}`), await doc(`attendance/${b.attendanceId}`)];
    assert.deepEqual([x.status, x.verificationStatus, x.verifiedBy], ['present', 'approved', 'mgr']);
    assert.equal(y.status, 'late');
    assert.equal((await audits('attendance.approved')).length, 2);
    await rejects(verify('mgr', a.attendanceId), 'failed-precondition', 'already_verified');
  });

  test('a manager rejects with a reason', async () => {
    const a = await clockIn('wkr', 8, 5);
    await rejects(verify('mgr', a.attendanceId, 'reject'), 'invalid-argument', 'reason');
    await verify('mgr', a.attendanceId, 'reject', { reason: 'Was not on site' });
    const x = await doc(`attendance/${a.attendanceId}`);
    assert.deepEqual([x.status, x.verificationStatus, x.rejectionReason], ['rejected', 'rejected', 'Was not on site']);
    assert.equal((await audits('attendance.rejected')).length, 1);
  });

  test('workers, cashiers and auditors cannot approve; nobody verifies their own attendance', async () => {
    const a = await clockIn('wkr', 8, 5);
    for (const who of ['wkr', 'wkr2', 'cash', 'aud', 'sh']) await rejects(verify(who, a.attendanceId), 'permission-denied');
    const m = await clockIn('mgr', 8, 0);
    await rejects(verify('mgr', m.attendanceId), 'permission-denied', 'self_action');
    await verify('admin', m.attendanceId);
  });

  test('with requireClockOut on, a present day needs a clock-out before approval', async () => {
    await workforce.updatePayrollPolicy(deps, 'admin', { changes: { requireClockOut: true }, reason: 'Full-day attendance' });
    const a = await clockIn('wkr', 8, 0);
    await rejects(verify('mgr', a.attendanceId, 'approve', {}, eat(MON, 12)), 'failed-precondition', 'no_clock_out');
    await attendance.clockOut(deps, 'wkr', {}, eat(MON, 17));
    await verify('mgr', a.attendanceId);
  });
});

describe('corrections', () => {
  const correct = (actor, attendanceId, extra) => attendance.correctAttendance(deps, actor, { attendanceId, ...extra }, eat(MON, 19));

  test('an authorised correction keeps the original, the corrected value, the reason and who; the record is re-verified', async () => {
    const a = await clockIn('wkr', 8, 40);
    await verify('mgr', a.attendanceId);
    const r = await correct('mgr', a.attendanceId, { clockInAt: eat(MON, 8, 5), reason: 'Fingerprint queue - arrived 08:05' });
    const c = await doc(`attendance_corrections/${r.correctionId}`);
    assert.deepEqual([c.previousValue.clockInAt, c.newValue.clockInAt], [eat(MON, 8, 40), eat(MON, 8, 5)]);
    assert.deepEqual([c.previousValue.arrivalStatus, c.newValue.arrivalStatus, c.previousValue.status], ['late', 'on_time', 'late']);
    assert.deepEqual([c.reason, c.correctedBy, c.staffUid], ['Fingerprint queue - arrived 08:05', 'mgr', 'wkr']);
    const x = await doc(`attendance/${a.attendanceId}`);
    assert.deepEqual([x.arrivalStatus, x.minutesLate, x.status, x.verificationStatus, x.correctionCount], ['on_time', 5, 'pending_verification', 'pending', 1]);
    const log = await audits('attendance.corrected');
    assert.equal(log.length, 1);
    assert.equal(log[0].previousValue.clockInAt, eat(MON, 8, 40));
  });

  test('refused: no reason, nothing changed, the person themselves, workers and auditors', async () => {
    const a = await clockIn('wkr', 8, 40);
    await rejects(correct('mgr', a.attendanceId, { clockInAt: eat(MON, 8) }), 'invalid-argument', 'reason');
    await rejects(correct('mgr', a.attendanceId, { clockInAt: eat(MON, 8, 40), reason: 'Same time' }), 'failed-precondition', 'no_changes');
    for (const who of ['wkr', 'wkr2', 'aud', 'cash']) await rejects(correct(who, a.attendanceId, { clockInAt: eat(MON, 8), reason: 'Let me in' }), 'permission-denied');
    const m = await clockIn('mgr', 9, 0);
    await rejects(correct('mgr', m.attendanceId, { clockInAt: eat(MON, 8), reason: 'Arrived earlier' }), 'permission-denied', 'self_action');
  });

  test('an unpaid allowance is cancelled by a correction; a paid one blocks it', async () => {
    await payroll.setSalaryProfile(deps, 'admin', { staffUid: 'wkr', basicSalaryUgx: 300000, allowanceEligible: true, effectiveFrom: eat(1, 12, 0, 1) }, eat(MON, 7));
    const a = await clockIn('wkr', 8, 40);
    await verify('mgr', a.attendanceId);
    const calc = await allowances.calculateAllowances(deps, 'mgr', { date: eat(MON, 12) }, eat(MON, 18));
    const allowanceId = calc.allowances[0].allowanceId;
    const r = await correct('mgr', a.attendanceId, { clockInAt: eat(MON, 8, 5), reason: 'Arrived 08:05' });
    assert.equal(r.cancelledAllowanceId, allowanceId);
    assert.equal((await doc(`worker_allowances/${allowanceId}`)).status, 'cancelled');
    assert.equal((await doc(`attendance/${a.attendanceId}`)).allowanceId, null);

    // Recalculate, approve and pay: now the correction must wait for a reversal.
    await verify('mgr', a.attendanceId, 'approve', {}, eat(MON, 19, 30));
    const again = await allowances.calculateAllowances(deps, 'mgr', { date: eat(MON, 12) }, eat(MON, 19, 30));
    assert.equal(again.created, 1);
    const id2 = again.allowances[0].allowanceId;
    await allowances.reviewAllowance(deps, 'mgr', { allowanceIds: [id2], decision: 'full' }, eat(MON, 19, 30));
    await finance.recordOpeningBalance(deps, 'admin', { accountId: 'cash_at_hand', amountUgx: 100000 });
    await allowances.payAllowances(deps, 'mgr', { allowanceIds: [id2], accountId: 'cash_at_hand', requestId: 'req-att-pay-1' }, eat(MON, 19, 45));
    await rejects(correct('mgr', a.attendanceId, { clockInAt: eat(MON, 8), reason: 'Earlier still' }), 'failed-precondition', 'allowance_paid');
  });
});

describe('the configurable policy', () => {
  test('defaults: 08:00, 15-minute grace, Monday–Saturday, UGX 5,000 daily allowance', async () => {
    const p = workforce.policyFrom(null);
    assert.deepEqual([p.reportingTime, p.gracePeriodMinutes, p.workingDays, p.defaultDailyAllowanceUgx, p.lateAllowancePolicy],
      ['08:00', 15, [1, 2, 3, 4, 5, 6], 5000, 'deduct']);
  });

  test('an Administrator changes the reporting time; new records use it, old ones keep theirs; audited', async () => {
    const before = await clockIn('wkr', 8, 50);
    assert.equal(before.late, true);
    await workforce.updatePayrollPolicy(deps, 'admin', { changes: { reportingTime: '09:00', gracePeriodMinutes: 10 }, reason: 'New opening hours' });
    const after = await clockIn('wkr2', 9, 10);
    assert.deepEqual([after.late, after.minutesLate], [false, 10]);
    assert.equal((await doc(`attendance/${before.attendanceId}`)).reportingTime, '08:00');
    const log = (await audits('payroll_policy.updated'))[0];
    assert.deepEqual([log.previousValue.reportingTime, log.newValue.reportingTime], ['08:00', '09:00']);
  });

  test('Sunday is not a working day by default', async () => {
    const r = await clockIn('wkr', 8, 0, 27);
    assert.equal((await doc(`attendance/${r.attendanceId}`)).workingDay, false);
  });

  test('only settings.manage may change it; invalid values are refused', async () => {
    await rejects(workforce.updatePayrollPolicy(deps, 'mgr', { changes: { gracePeriodMinutes: 60 }, reason: 'More time' }), 'permission-denied');
    await rejects(workforce.updatePayrollPolicy(deps, 'admin', { changes: { reportingTime: '25:00' }, reason: 'x x x' }), 'invalid-argument');
    await rejects(workforce.updatePayrollPolicy(deps, 'admin', { changes: { lateDeductionUgx: 9000 }, reason: 'x x x' }), 'invalid-argument');
    await rejects(workforce.updatePayrollPolicy(deps, 'admin', { changes: { maxDeductionPercentOfGross: 150 }, reason: 'x x x' }), 'invalid-argument');
    await rejects(workforce.updatePayrollPolicy(deps, 'admin', { changes: { salary: 1 }, reason: 'x x x' }), 'invalid-argument');
    await rejects(workforce.updatePayrollPolicy(deps, 'admin', { changes: { gracePeriodMinutes: 15 }, reason: 'x x x' }), 'failed-precondition', 'no_changes');
  });
});
