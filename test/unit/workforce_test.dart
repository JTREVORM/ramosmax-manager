import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/core/services/analytics_service.dart';
import 'package:ramosmax_auto_manager/core/services/notification_service.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/features/payroll/data/workforce_api.dart';
import 'package:ramosmax_auto_manager/models/attendance.dart';
import 'package:ramosmax_auto_manager/models/finance.dart';
import 'package:ramosmax_auto_manager/models/payroll.dart';

import '../support/fixtures.dart';

void main() {
  final now = DateTime.utc(2026, 9, 21, 12);

  group('attendance policy', () {
    test('defaults: 08:00, 15-minute grace, Monday–Saturday, UGX 5,000, late → deduct UGX 2,500', () {
      const p = WorkforcePolicy.defaults;
      expect([p.reportingTime, p.gracePeriodMinutes, p.workingDays, p.defaultDailyAllowance, p.lateAllowancePolicy, p.lateDeduction],
          ['08:00', 15, [1, 2, 3, 4, 5, 6], const Money(5000), LatePolicy.deduct, const Money(2500)]);
      expect(WorkforcePolicy.fromFirestore(null).defaultDailyAllowance, const Money(5000));
    });

    test('08:05 and 08:14 are on time, 08:15 is the last on-time minute, 08:20 is late (same rule as the server)', () {
      const p = WorkforcePolicy.defaults;
      expect(p.lateness(8, 5).late, isFalse);
      expect(p.lateness(8, 14).late, isFalse);
      expect(p.lateness(8, 15).late, isFalse);
      expect(p.lateness(8, 16).late, isTrue);
      expect(p.lateness(8, 20), (minutesLate: 20, late: true));
      expect(p.lateness(7, 50).minutesLate, 0);
    });

    test('the policy is configurable, not hard-coded', () {
      final p = WorkforcePolicy.fromFirestore({
        'reportingTime': '09:00', 'gracePeriodMinutes': 5, 'defaultDailyAllowanceUgx': 6000, 'lateAllowancePolicy': 'reject',
        'workingDays': [1, 2, 3, 4, 5],
      });
      expect([p.reportingTime, p.gracePeriodMinutes, p.defaultDailyAllowance, p.lateAllowancePolicy, p.workingDays],
          ['09:00', 5, const Money(6000), LatePolicy.reject, [1, 2, 3, 4, 5]]);
      expect(p.lateness(9, 6).late, isTrue);
      expect(p.lateness(8, 50).late, isFalse);
    });
  });

  group('pay formula (mirror of the server)', () {
    ({Money instalment, Money remaining}) d(int instalment, int remaining) => (instalment: Money(instalment), remaining: Money(remaining));

    test("the brief's example: 600,000 + 100,000 + 0 = 700,000 gross; 50,000 deducted; 650,000 net", () {
      final r = PayCalculator.compute(
          basic: const Money(600000), allowances: const Money(100000), otherEarnings: Money.zero, deductions: [d(50000, 50000)], capPercent: 100);
      expect([r.gross, r.deductions, r.net, r.capped], [const Money(700000), const Money(50000), const Money(650000), false]);
    });

    test('a deduction never takes more than what remains', () {
      final r = PayCalculator.compute(basic: const Money(600000), allowances: Money.zero, otherEarnings: Money.zero, deductions: [d(50000, 20000)], capPercent: 100);
      expect(r.taken, [const Money(20000)]);
    });

    test('deductions never exceed the allowed share of gross, so net pay is never negative', () {
      final r = PayCalculator.compute(
          basic: const Money(100000), allowances: Money.zero, otherEarnings: Money.zero, deductions: [d(90000, 90000), d(50000, 50000)], capPercent: 100);
      expect([r.deductions, r.net, r.capped, r.taken], [const Money(100000), Money.zero, true, [const Money(90000), const Money(10000)]]);
      final tenPercent = PayCalculator.compute(
          basic: const Money(100000), allowances: Money.zero, otherEarnings: Money.zero, deductions: [d(50000, 50000)], capPercent: 10);
      expect([tenPercent.deductions, tenPercent.net], [const Money(10000), const Money(90000)]);
    });
  });

  group('salary versions', () {
    SalaryVersion v(int version, int basic, DateTime from) =>
        SalaryVersion.fromFirestore({'staffUid': 'w', 'staffName': 'W', 'basicSalaryUgx': basic, 'version': version, 'effectiveFrom': Timestamp.fromDate(from)});

    test('January–June 500,000; from July 600,000; payroll picks the version in force', () {
      final history = [v(1, 500000, DateTime.utc(2026, 1, 1)), v(2, 600000, DateTime.utc(2026, 7, 1))];
      expect(SalaryVersion.inForce(history, DateTime.utc(2026, 6, 30))!.basicSalary, const Money(500000));
      expect(SalaryVersion.inForce(history, DateTime.utc(2026, 7, 31))!.basicSalary, const Money(600000));
      expect(SalaryVersion.inForce(history, DateTime.utc(2025, 12, 31)), isNull);
    });

    test('a same-day correction (a later version) wins', () {
      final history = [v(1, 500000, DateTime.utc(2026, 7, 1)), v(2, 550000, DateTime.utc(2026, 7, 1))];
      expect(SalaryVersion.inForce(history, DateTime.utc(2026, 7, 2))!.basicSalary, const Money(550000));
    });

    test('the salary draft sends whole shillings and the effective date', () {
      final json = SalaryDraft(
        staffUid: 'w', basicSalary: const Money(600000), frequency: PaymentFrequency.monthly, allowanceEligible: true,
        effectiveFrom: DateTime.utc(2026, 7, 1), reason: 'Annual review',
      ).toJson();
      expect([json['basicSalaryUgx'], json['paymentFrequency'], json['allowanceAmountUgx'], json['reason']], [600000, 'monthly', null, 'Annual review']);
    });
  });

  group('records from Firestore', () {
    test('attendance record', () {
      final a = AttendanceRecord.fromFirestore('w_2026-09-21', {
        'attendanceNumber': 'RMX-ATT-000001', 'staffUid': 'w', 'staffName': 'Wash One', 'dayKey': '2026-09-21', 'status': 'pending_verification',
        'arrivalStatus': 'late', 'verificationStatus': 'pending', 'source': 'manual', 'minutesLate': 20, 'late': true,
        'clockInAt': Timestamp.fromDate(DateTime.utc(2026, 9, 21, 5, 20)),
      });
      expect([a.status, a.arrivalStatus, a.source, a.minutesLate, a.isPending, a.canClockOut],
          [AttendanceStatus.pendingVerification, ArrivalStatus.late, AttendanceSource.manual, 20, true, true]);
      expect(AttendanceSource.values.map((s) => s.key), ['manual', 'biometric', 'imported']);
    });

    test('allowance: what is paid is the approved amount, else the calculation', () {
      final calc = WorkerAllowance.fromFirestore('a1', {'calculatedAmountUgx': 5000, 'status': 'calculated', 'suggestedDecision': 'deduct', 'suggestedDeductionUgx': 2500});
      expect([calc.amount, calc.status.awaitsDecision, calc.suggestedDecision], [const Money(5000), true, AllowanceDecision.deduct]);
      final approved = WorkerAllowance.fromFirestore('a2', {'calculatedAmountUgx': 5000, 'approvedAmountUgx': 2500, 'deductionUgx': 2500, 'status': 'approved'});
      expect([approved.amount, approved.deduction, approved.status.awaitsDecision], [const Money(2500), const Money(2500), false]);
    });

    test('payroll workflow actions follow the status', () {
      PayrollRun run(String status, {bool reviewed = false, int count = 2}) => PayrollRun.fromFirestore('p', {
            'status': status, 'employeeCount': count, 'totalNetUgx': 1050000, if (reviewed) 'reviewedAt': Timestamp.fromDate(now),
          });
      expect(run('prepared').availableActions, {PayrollAction.submit});
      expect(run('prepared', count: 0).availableActions, isEmpty);
      expect(run('pending_review').availableActions, {PayrollAction.review, PayrollAction.returnForCorrection});
      expect(run('pending_review', reviewed: true).availableActions, {PayrollAction.approve, PayrollAction.returnForCorrection});
      expect([run('approved').canPay, run('paid').canPay, run('paid').canLock, run('locked').canReversePayment, run('locked').canCancel],
          [true, false, true, false, false]);
      expect(run('approved').totals.net, const Money(1050000));
    });

    test('payroll item (payslip) and its deduction lines', () {
      final i = PayrollItem.fromFirestore('i', {
        'staffUid': 'w', 'basicSalaryUgx': 600000, 'allowancesUgx': 100000, 'grossUgx': 700000, 'totalDeductionsUgx': 50000, 'netUgx': 650000,
        'lossRecoveriesUgx': 50000, 'deductions': [{'deductionId': 'd', 'deductionNumber': 'RMX-DED-000001', 'type': 'loss_recovery', 'plannedUgx': 50000, 'amountUgx': 50000, 'lossNumber': 'RMX-LOSS-000001'}],
      });
      expect([i.gross, i.net, i.deductionLines.single.type, i.deductionLines.single.lossNumber],
          [const Money(700000), const Money(650000), DeductionType.lossRecovery, 'RMX-LOSS-000001']);
    });

    test('loss incident: an approved recovery can be scheduled once; finished incidents cannot be cancelled', () {
      LossIncident l(String status, {String? deductionId, int outstanding = 150000}) =>
          LossIncident.fromFirestore('l', {'status': status, 'amountUgx': 300000, 'outstandingUgx': outstanding, 'deductionId': deductionId});
      expect(l('approved').canSchedule, isTrue);
      expect(l('recovery_scheduled', deductionId: 'd').canSchedule, isFalse);
      expect(l('approved', outstanding: 0).canSchedule, isFalse);
      expect(l('reported').canSchedule, isFalse);
      expect([l('recovered').canCancel, l('rejected').canCancel, l('partially_recovered').canCancel], [false, false, true]);
      expect(LossStatus.values.map((s) => s.key), [
        'reported', 'under_review', 'approved', 'rejected', 'recovery_scheduled', 'partially_recovered', 'recovered', 'cancelled',
      ]);
    });
  });

  group('permissions and menus', () {
    Set<Permission> perms(UserRole r) => testUser(role: r).effectivePermissions(now);

    test('workers see only their own pay; they cannot view others, approve, pay or change salaries', () {
      final w = perms(UserRole.worker);
      expect(w, containsAll([Permission.attendanceViewOwn, Permission.allowancesViewOwn, Permission.payrollViewOwn, Permission.attendanceMark]));
      expect(w.intersection({
        Permission.attendanceView, Permission.attendanceApprove, Permission.allowancesView, Permission.allowancesApprove, Permission.allowancesPay,
        Permission.salaryView, Permission.salaryManage, Permission.payrollView, Permission.payrollApprove, Permission.payrollPay, Permission.lossesView,
      }), isEmpty);
    });

    test('cashiers: own attendance and pay only; no salary configuration or approvals by default', () {
      final c = perms(UserRole.cashier);
      expect(c, containsAll([Permission.attendanceMark, Permission.attendanceViewOwn, Permission.payrollViewOwn]));
      expect(c.intersection({Permission.salaryManage, Permission.salaryView, Permission.payrollApprove, Permission.allowancesApprove, Permission.allowancesPay}),
          isEmpty);
    });

    test('managers review and prepare; salary changes, payroll approval/payment and loss decisions stay with Admins', () {
      final m = perms(UserRole.manager);
      expect(m, containsAll([Permission.attendanceApprove, Permission.attendanceCorrect, Permission.allowancesCalculate, Permission.allowancesPay,
        Permission.payrollPrepare, Permission.payrollReview, Permission.salaryView, Permission.lossesReview, Permission.lossesSchedule]));
      expect(m.intersection({Permission.salaryManage, Permission.payrollApprove, Permission.payrollPay, Permission.payrollAdjust, Permission.lossesApprove,
        Permission.lossesAdjust, Permission.deductionsManage}), isEmpty);
    });

    test('auditors read attendance, allowances, salaries, payroll and losses - read-only', () {
      final a = perms(UserRole.auditor);
      expect(a, containsAll([Permission.attendanceView, Permission.allowancesView, Permission.salaryView, Permission.salaryHistoryView,
        Permission.payrollView, Permission.lossesView]));
      expect(a.every((p) => p.isReadOnly), isTrue);
    });

    test('shareholders get no individual pay by default', () {
      expect(perms(UserRole.shareholder).intersection({Permission.payrollView, Permission.salaryView, Permission.payrollViewOwn}), isEmpty);
    });

    test('menus: managers get Payroll and Loss Incidents; cashiers Attendance and Allowances; auditors all read-only', () {
      final m = RoleNavigation.modulesFor(testUser(role: UserRole.manager), now);
      expect(m, containsAll([AppModule.attendance, AppModule.allowances, AppModule.payroll, AppModule.losses]));
      final c = RoleNavigation.modulesFor(testUser(role: UserRole.cashier), now);
      expect(c, containsAll([AppModule.attendance, AppModule.allowances]));
      expect(c, isNot(contains(AppModule.payroll)));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.auditor), now), containsAll([AppModule.payroll, AppModule.losses, AppModule.attendance]));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.admin), now), containsAll([AppModule.payroll, AppModule.losses]));
      for (final mod in [AppModule.attendance, AppModule.allowances, AppModule.payroll, AppModule.losses]) {
        expect(mod.available, isTrue, reason: mod.key);
      }
    });

    test('denying payroll.view removes the Payroll menu unless salary.view is held', () {
      final u = testUser(role: UserRole.manager, denied: {Permission.payrollView, Permission.salaryView});
      expect(RoleNavigation.modulesFor(u, now), isNot(contains(AppModule.payroll)));
    });
  });

  group('finance integration', () {
    test('payroll and allowance payments are outflows, never revenue, and reversed from their own screens', () {
      for (final type in ['payroll_payment', 'allowance_payment']) {
        final t = FinancialTransaction.fromFirestore('t', {'type': type, 'amountUgx': 1050000, 'status': 'posted'});
        expect([t.isRevenue, t.isStaffPay, t.canReverse], [false, true, false], reason: type);
      }
    });

    test('daily staff pay totals net of reversals', () {
      final d = DailyFinanceSummary.fromFirestore('2026-09-30', {
        'payrollPaidUgx': 1050000, 'allowancesPaidUgx': 10000, 'reversals': {'payroll_paymentUgx': 50000},
      });
      expect(d.netStaffPay, const Money(1010000));
      expect(DailyFinanceSummary.combine('x', [d, d]).netStaffPay, const Money(2020000));
    });

    test('the server knows the same transaction types', () {
      final js = File('functions/src/finance.js').readAsStringSync();
      for (final t in TransactionType.values) {
        expect(js.contains("'${t.key}'"), isTrue, reason: t.key);
      }
    });
  });

  group('server parity', () {
    test('Phase 6 notification types match functions/src/user_admin.js', () {
      final js = File('functions/src/user_admin.js').readAsStringSync();
      for (final t in [
        NotificationTypes.attendanceReview, NotificationTypes.attendanceRejected, NotificationTypes.allowanceAwaitingApproval,
        NotificationTypes.allowanceApproved, NotificationTypes.payrollReview, NotificationTypes.payrollApproved, NotificationTypes.payrollPaid,
        NotificationTypes.lossIncidentCreated, NotificationTypes.lossRecoveryScheduled, NotificationTypes.deductionAwaitingApproval,
        NotificationTypes.deductionApplied,
      ]) {
        expect(js.contains("'$t'"), isTrue, reason: t);
      }
    });

    test('statuses match the server', () {
      final allowances = File('functions/src/allowances.js').readAsStringSync();
      for (final s in AllowanceStatus.values) {
        expect(allowances.contains("'${s.key}'"), isTrue, reason: s.key);
      }
      final payroll = File('functions/src/payroll.js').readAsStringSync();
      for (final s in PayrollStatus.values) {
        expect(payroll.contains("'${s.key}'"), isTrue, reason: s.key);
      }
      final attendance = File('functions/src/attendance.js').readAsStringSync();
      for (final s in AttendanceStatus.values) {
        expect(attendance.contains("'${s.key}'"), isTrue, reason: s.key);
      }
    });

    test('analytics carries no pay data: only action keys', () {
      expect(AnalyticsEvents.all, containsAll([AnalyticsEvents.attendanceAction, AnalyticsEvents.allowanceAction, AnalyticsEvents.payrollAction,
        AnalyticsEvents.lossAction]));
      expect(AnalyticsEvents.allowedParams.any((p) => p.contains('salary') || p.contains('amount')), isFalse);
    });
  });
}
