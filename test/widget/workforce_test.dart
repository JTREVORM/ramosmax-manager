import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:ramosmax_auto_manager/app.dart';
import 'package:ramosmax_auto_manager/core/utils/date_time_utils.dart';
import 'package:ramosmax_auto_manager/features/billing/application/billing_providers.dart';
import 'package:ramosmax_auto_manager/features/dashboard/presentation/dashboard_shell.dart';
import 'package:ramosmax_auto_manager/features/expenses/application/expenses_providers.dart';
import 'package:ramosmax_auto_manager/features/finance/application/finance_providers.dart';
import 'package:ramosmax_auto_manager/features/inventory/application/inventory_providers.dart';
import 'package:ramosmax_auto_manager/features/jobs/application/jobs_providers.dart';
import 'package:ramosmax_auto_manager/features/operations/application/operations_providers.dart';
import 'package:ramosmax_auto_manager/features/payroll/application/workforce_providers.dart';

import '../support/fake_auth_repository.dart';
import '../support/fake_operations_api.dart';
import '../support/fake_phase4_apis.dart';
import '../support/fake_phase5_apis.dart';
import '../support/fake_phase6_apis.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeWorkforceApi api;
  late FakeConnectivityService connectivity;
  final now = DateTime.now();
  final today = EastAfricaTime.businessDayKey(now);

  setUp(() {
    db = FakeFirebaseFirestore();
    api = FakeWorkforceApi();
    connectivity = FakeConnectivityService();
  });

  Future<void> me(String role, {List<String> permissions = const []}) =>
      db.collection('users').doc('me').set(userDocData(role: role, fullName: 'Me $role', permissions: permissions));

  Future<void> colleague(String uid, String name, {String role = 'worker'}) =>
      db.collection('users').doc(uid).set(userDocData(role: role, fullName: name, phone: '+2567720001${uid.length}'));

  Future<void> attendance(String staffUid, {String status = 'pending_verification', String arrival = 'on_time', int minutesLate = 0, bool clockedOut = false}) =>
      db.collection('attendance').doc('${staffUid}_$today').set({
        'attendanceNumber': 'RMX-ATT-0000${staffUid.length}', 'staffUid': staffUid, 'staffName': 'Staff $staffUid', 'dayKey': today,
        'date': Timestamp.fromDate(EastAfricaTime.dayBounds(now).$1), 'status': status, 'arrivalStatus': arrival,
        'verificationStatus': status == 'pending_verification' ? 'pending' : 'approved', 'source': 'manual', 'recordedVia': 'self',
        'minutesLate': minutesLate, 'late': arrival == 'late', 'workingDay': true, 'reportingTime': '08:00', 'gracePeriodMinutes': 15,
        'clockInAt': Timestamp.fromDate(now.subtract(const Duration(hours: 2))),
        if (clockedOut) 'clockOutAt': Timestamp.fromDate(now),
      });

  Future<void> allowance(String id, String staffUid, {String status = 'calculated', bool late = false, int? approved}) =>
      db.collection('worker_allowances').doc(id).set({
        'allowanceNumber': 'RMX-ALL-00000${id.length}', 'staffUid': staffUid, 'staffName': 'Staff $staffUid', 'dayKey': today,
        'date': Timestamp.fromDate(now), 'calculatedAmountUgx': 5000, 'status': status, 'late': late, 'minutesLate': late ? 40 : 0,
        'suggestedDecision': late ? 'deduct' : 'full', 'suggestedDeductionUgx': late ? 2500 : 0, 'approvedAmountUgx': ?approved,
      });

  Future<void> cash(int balance) => db.collection('financial_accounts').doc('cash_at_hand').set({
        'accountId': 'cash_at_hand', 'name': 'Cash at Hand', 'type': 'cash', 'balanceUgx': balance, 'awaitingBankingUgx': 0, 'active': true,
      });

  Future<void> payrollRun(String status, {bool reviewed = false}) => db.collection('payroll').doc('p1').set({
        'payrollNumber': 'RMX-PAY-000001', 'periodKey': '2026-09', 'periodLabel': 'September 2026', 'frequency': 'monthly', 'status': status,
        'version': 1, 'employeeCount': 2, 'totalBasicUgx': 1000000, 'totalAllowancesUgx': 100000, 'totalGrossUgx': 1100000,
        'totalSalaryDeductionsUgx': 50000, 'totalDeductionsUgx': 50000, 'totalNetUgx': 1050000,
        'periodStart': Timestamp.fromDate(DateTime.utc(2026, 8, 31, 21)),
        if (reviewed) 'reviewedAt': Timestamp.fromDate(now),
      });

  Future<void> payslip(String id, String staffUid, int net, {bool visible = true, String payrollId = 'p1'}) =>
      db.collection('payroll_items').doc(id).set({
        'itemNumber': 'RMX-PAY-000001-00${id.length}', 'payrollId': payrollId, 'payrollNumber': 'RMX-PAY-000001', 'periodLabel': 'September 2026',
        'staffUid': staffUid, 'staffName': 'Staff $staffUid', 'basicSalaryUgx': 600000, 'allowancesUgx': 100000, 'allowanceDays': 20,
        'grossUgx': 700000, 'totalDeductionsUgx': 700000 - net, 'salaryDeductionsUgx': 700000 - net, 'netUgx': net, 'current': true,
        'visibleToStaff': visible, 'paymentStatus': visible ? 'paid' : 'unpaid', 'status': visible ? 'paid' : 'approved',
        'periodStart': Timestamp.fromDate(DateTime.utc(2026, 8, 31, 21)),
      });

  Future<void> pumpAt(WidgetTester tester, String location) async {
    await tester.binding.setSurfaceSize(const Size(430, 1800));
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...testOverrides(
          auth: FakeAuthRepository(initialUser: MockUser(uid: 'me', phoneNumber: testPhone)),
          db: db,
          connectivity: connectivity,
        ),
        operationsApiProvider.overrideWithValue(FakeOperationsApi()),
        jobsApiProvider.overrideWithValue(FakeJobsApi()),
        billingApiProvider.overrideWithValue(FakeBillingApi()),
        financeApiProvider.overrideWithValue(FakeFinanceApi()),
        expensesApiProvider.overrideWithValue(FakeExpensesApi()),
        inventoryApiProvider.overrideWithValue(FakeInventoryApi()),
        workforceApiProvider.overrideWithValue(api),
      ],
      child: const RamosMaxApp(),
    ));
    await tester.pumpAndSettle();
    GoRouter.of(tester.element(find.byType(DashboardShell))).go(location);
    await tester.pumpAndSettle();
  }

  String location(WidgetTester tester) =>
      GoRouter.of(tester.element(find.byType(DashboardShell))).routerDelegate.currentConfiguration.uri.toString();

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.binding.setSurfaceSize(null);
  }

  Future<void> tapKey(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    expect(f, findsOneWidget, reason: key);
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  Future<void> tapText(WidgetTester tester, String text) async {
    final f = find.text(text).first;
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  Future<void> enter(WidgetTester tester, String key, String text) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.enterText(f, text);
    await tester.pumpAndSettle();
  }

  bool enabled(WidgetTester tester, String key) => tester.widget<ButtonStyleButton>(find.byKey(Key(key))).onPressed != null;
  String textOf(WidgetTester tester, String key) => tester.widget<Text>(find.byKey(Key(key))).data!;

  group('attendance', () {
    testWidgets('a worker clocks in from the phone; the server decides the time and lateness; no manager tools', (tester) async {
      await me('worker');
      await pumpAt(tester, '/app/attendance');
      expect(find.byKey(const Key('record-attendance-button')), findsNothing);
      expect(find.text('To verify'), findsNothing);
      await tapKey(tester, 'clock-in-button');
      expect(api.calls.single.$1, 'clockIn');
      expect(api.calls.single.$2, isEmpty, reason: 'no time is sent from the phone');
      await unmount(tester);
    });

    testWidgets('after clocking in the worker sees their status and can clock out', (tester) async {
      await me('worker');
      await attendance('me', arrival: 'late', minutesLate: 20);
      await pumpAt(tester, '/app/attendance');
      expect(find.byKey(const Key('clock-in-button')), findsNothing);
      expect(textOf(tester, 'my-today-times'), contains('20 min after 08:00'));
      await tapKey(tester, 'clock-out-button');
      expect(api.calls.single.$1, 'clockOut');
      await unmount(tester);
    });

    testWidgets('offline: clocking in is not sent and the person is told a connection is needed', (tester) async {
      await me('worker');
      connectivity.online = false;
      await pumpAt(tester, '/app/attendance');
      await tapKey(tester, 'clock-in-button');
      expect(api.calls, isEmpty);
      expect(find.textContaining('internet connection'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets("a manager approves others' attendance from the queue but cannot select their own", (tester) async {
      await me('manager');
      await attendance('w1');
      await attendance('me');
      await pumpAt(tester, '/app/attendance');
      await tapText(tester, 'To verify');
      expect(find.byKey(Key('select-attendance-me_$today')), findsNothing);
      await tapKey(tester, 'select-attendance-w1_$today');
      await tapKey(tester, 'approve-selected-attendance');
      final (name, args) = api.calls.single;
      expect([name, args['ids'], args['approve']], ['verifyAttendance', ['w1_$today'], true]);
      await unmount(tester);
    });

    testWidgets('rejecting needs a reason', (tester) async {
      await me('manager');
      await attendance('w1');
      await pumpAt(tester, '/app/attendance/w1_$today');
      await tapKey(tester, 'reject-attendance-button');
      expect(api.calls, isEmpty);
      await tester.enterText(find.byType(TextField).last, 'Not on site');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Reject').last);
      await tester.pumpAndSettle();
      expect(api.calls.single.$2['reason'], 'Not on site');
      await unmount(tester);
    });

    testWidgets('an auditor reads attendance but has no action buttons', (tester) async {
      await me('auditor');
      await attendance('w1');
      await pumpAt(tester, '/app/attendance/w1_$today');
      expect(find.text('RMX-ATT-00002'), findsOneWidget);
      for (final k in ['approve-attendance-button', 'reject-attendance-button', 'correct-attendance-button', 'record-attendance-button']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      await unmount(tester);
    });
  });

  group('allowances', () {
    testWidgets('a late allowance: the policy suggests DEDUCT 2,500; a reason is required; the maximum is enforced', (tester) async {
      await me('manager');
      await allowance('a1', 'w1', late: true);
      await pumpAt(tester, '/app/allowances');
      await tapKey(tester, 'allowance-a1');
      expect(enabled(tester, 'submit-allowance-decision'), isFalse, reason: 'deducting needs a reason');
      await enter(tester, 'allowance-reason', 'Late 40 minutes');
      await enter(tester, 'allowance-deduction', '6,000');
      expect(find.text('At most UGX 5,000'), findsOneWidget);
      expect(enabled(tester, 'submit-allowance-decision'), isFalse);
      await enter(tester, 'allowance-deduction', '2,000');
      expect(textOf(tester, 'allowance-after-deduction'), 'UGX 3,000');
      await tapKey(tester, 'submit-allowance-decision');
      final (name, args) = api.calls.single;
      expect([name, args['ids'], args['decision'], args['deduction'], args['reason']], ['reviewAllowances', ['a1'], 'deduct', 2000, 'Late 40 minutes']);
      await unmount(tester);
    });

    testWidgets('paying approved allowances goes through the account picker, once, with a request ID', (tester) async {
      await me('manager');
      await cash(100000);
      await allowance('a1', 'w1', status: 'approved', approved: 5000);
      await allowance('a2', 'me', status: 'approved', approved: 5000);
      await pumpAt(tester, '/app/allowances');
      await tapText(tester, 'Approved · unpaid');
      expect(find.byKey(const Key('select-allowance-a2')), findsNothing, reason: 'someone else pays your own allowance');
      await tapKey(tester, 'select-allowance-a1');
      await tapKey(tester, 'pay-allowances-button');
      await tapKey(tester, 'pay-from-account');
      await tester.tap(find.text('Cash at Hand · UGX 100,000').last);
      await tester.pumpAndSettle();
      await tapKey(tester, 'confirm-pay-from');
      final (name, args) = api.calls.single;
      expect([name, args['ids'], args['accountId']], ['payAllowances', ['a1'], 'cash_at_hand']);
      expect((args['requestId']! as String).length, 24);
      await unmount(tester);
    });

    testWidgets('a worker sees "My pay": only their own allowances and payslips, never anyone else\'s', (tester) async {
      await me('worker');
      await allowance('a1', 'me', status: 'approved', approved: 5000);
      await allowance('a2', 'w2', status: 'approved', approved: 5000);
      await payrollRun('paid');
      await payslip('mine', 'me', 650000);
      await payslip('other', 'w2', 400000);
      await payslip('draft', 'me', 1, visible: false, payrollId: 'p2');
      await pumpAt(tester, '/app/allowances');
      expect(find.byKey(const Key('allowance-a1')), findsOneWidget);
      expect(find.byKey(const Key('allowance-a2')), findsNothing);
      expect(textOf(tester, 'my-unpaid-allowances'), 'UGX 5,000');
      await tapText(tester, 'Payslips');
      expect(find.byKey(const Key('payslip-mine')), findsOneWidget);
      expect(textOf(tester, 'net-mine'), 'UGX 650,000');
      expect(find.byKey(const Key('payslip-other')), findsNothing);
      expect(find.byKey(const Key('payslip-draft')), findsNothing, reason: 'unpaid payslips stay hidden');
      await unmount(tester);
    });

    testWidgets('calculating shows what was created and what was skipped', (tester) async {
      await me('manager');
      await pumpAt(tester, '/app/allowances');
      await tapText(tester, 'Calculate');
      await tapKey(tester, 'calculate-allowances-button');
      expect(api.calls.single.$1, 'calculateAllowances');
      expect(textOf(tester, 'calculate-summary'), contains('not_eligible'));
      await unmount(tester);
    });
  });

  group('payroll', () {
    testWidgets('an approved payroll shows the server totals and is paid once through the account picker', (tester) async {
      await me('admin');
      await cash(5000000);
      await payrollRun('approved');
      await payslip('i1', 'w1', 650000, visible: false);
      await pumpAt(tester, '/app/payroll/run/p1');
      expect(textOf(tester, 'payroll-gross'), 'UGX 1,100,000');
      expect(textOf(tester, 'payroll-net'), 'UGX 1,050,000');
      expect(find.byKey(const Key('payroll-action-approve')), findsNothing, reason: 'already approved');
      await tapKey(tester, 'pay-payroll-button');
      await tapKey(tester, 'pay-from-account');
      await tester.tap(find.text('Cash at Hand · UGX 5,000,000').last);
      await tester.pumpAndSettle();
      await tapKey(tester, 'confirm-pay-from');
      final (name, args) = api.calls.single;
      expect([name, args['id'], args['accountId']], ['payPayroll', 'p1', 'cash_at_hand']);
      expect((args['requestId']! as String).length, 24);
      await unmount(tester);
    });

    testWidgets('a manager reviews but cannot approve or pay; an auditor has no buttons at all', (tester) async {
      await me('manager');
      await payrollRun('pending_review');
      await pumpAt(tester, '/app/payroll/run/p1');
      expect(find.byKey(const Key('payroll-action-review')), findsOneWidget);
      expect(find.byKey(const Key('payroll-action-return')), findsOneWidget);
      for (final k in ['payroll-action-approve', 'pay-payroll-button', 'correct-payroll-button', 'cancel-payroll-button']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      await unmount(tester);

      await me('auditor');
      await payrollRun('approved');
      await pumpAt(tester, '/app/payroll/run/p1');
      expect(textOf(tester, 'payroll-net'), 'UGX 1,050,000');
      for (final k in ['prepare-payroll-button', 'payroll-action-submit', 'payroll-action-approve', 'pay-payroll-button', 'lock-payroll-button',
        'correct-payroll-button', 'reverse-payroll-button', 'cancel-payroll-button', 'add-earning-button']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      await unmount(tester);
    });

    testWidgets('cashiers and workers cannot open Payroll; the menu does not offer it', (tester) async {
      for (final role in ['cashier', 'worker']) {
        await me(role);
        await payrollRun('approved');
        await pumpAt(tester, '/app/payroll/run/p1');
        expect(location(tester), '/app', reason: role);
        await unmount(tester);
      }
    });

    testWidgets('a salary change needs a reason and is sent as a new effective-dated version', (tester) async {
      await me('admin');
      await db.collection('salary_profiles').doc('w1').set({
        'staffUid': 'w1', 'staffName': 'Wash One', 'basicSalaryUgx': 500000, 'paymentFrequency': 'monthly', 'allowanceEligible': true,
        'active': true, 'version': 1, 'effectiveFrom': Timestamp.fromDate(DateTime.utc(2026, 1, 1)),
      });
      await pumpAt(tester, '/app/payroll/salary/w1');
      expect(textOf(tester, 'salary-basic'), 'UGX 500,000');
      await tapKey(tester, 'change-salary-button');
      await enter(tester, 'salary-basic-field', '600,000');
      expect(enabled(tester, 'submit-salary'), isFalse, reason: 'a change needs a reason');
      await enter(tester, 'salary-reason', 'Annual review');
      await tapKey(tester, 'submit-salary');
      final (name, args) = api.calls.single;
      expect([name, args['staffUid'], args['basicSalaryUgx'], args['reason']], ['setSalary', 'w1', 600000, 'Annual review']);
      expect(args['effectiveFrom'], isA<int>());
      await unmount(tester);
    });
  });

  group('losses', () {
    testWidgets('reporting a loss records an incident only', (tester) async {
      await me('manager');
      await colleague('w1', 'Wash One');
      await pumpAt(tester, '/app/losses');
      await tapKey(tester, 'report-loss-button');
      await enter(tester, 'loss-amount', '300,000');
      await enter(tester, 'loss-description', 'Side mirror broken');
      await tapKey(tester, 'submit-loss');
      expect(api.calls.map((c) => c.$1), ['reportLoss']);
      expect(api.calls.single.$2['amount'], 300000);
      await unmount(tester);
    });

    testWidgets('the recovery can never exceed the loss', (tester) async {
      await me('admin');
      await db.collection('loss_incidents').doc('l1').set({
        'lossNumber': 'RMX-LOSS-000001', 'incidentType': 'damaged_customer_property', 'amountUgx': 300000, 'description': 'Mirror',
        'status': 'under_review', 'staffUid': 'w1', 'staffName': 'Wash One', 'createdAt': Timestamp.fromDate(now),
      });
      await pumpAt(tester, '/app/losses/l1');
      await tapKey(tester, 'decide-loss-button');
      await enter(tester, 'loss-recovery', '350,000');
      await enter(tester, 'loss-reason', 'Negligence confirmed');
      expect(find.textContaining('Cannot exceed the loss'), findsOneWidget);
      expect(enabled(tester, 'submit-loss-decision'), isFalse);
      await enter(tester, 'loss-recovery', '150,000');
      await tapKey(tester, 'submit-loss-decision');
      final (name, args) = api.calls.single;
      expect([name, args['approve'], args['recovery']], ['decideLoss', true, 150000]);
      await unmount(tester);
    });
  });

  group('dashboards and finance', () {
    testWidgets('manager dashboard: attendance to verify, allowances to approve', (tester) async {
      await me('manager');
      await attendance('w1');
      await allowance('a1', 'w1');
      await pumpAt(tester, '/app');
      expect(find.byKey(const Key('stat-attendance-to-verify')), findsOneWidget);
      expect(find.byKey(const Key('stat-allowances-to-decide')), findsOneWidget);
      expect(find.byKey(const Key('stat-attendance-today')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('worker dashboard: own attendance and allowances only', (tester) async {
      await me('worker');
      await pumpAt(tester, '/app');
      expect(find.byKey(const Key('stat-my-attendance')), findsOneWidget);
      expect(find.text('Not clocked in'), findsOneWidget);
      expect(find.byKey(const Key('stat-attendance-to-verify')), findsNothing);
      expect(find.byKey(const Key('stat-payroll-total')), findsNothing);
      expect(find.text('Payroll'), findsNothing);
      await unmount(tester);
    });

    testWidgets('a payroll payment appears in Finance as staff pay and cannot be reversed from there', (tester) async {
      await me('admin');
      await db.collection('financial_transactions').doc('t1').set({
        'transactionNumber': 'RMX-TXN-000009', 'type': 'payroll_payment', 'amountUgx': 1050000, 'status': 'posted', 'payrollNumber': 'RMX-PAY-000001',
        'sourceAccountId': 'cash_at_hand', 'sourceAccountName': 'Cash at Hand', 'accountIds': ['cash_at_hand'],
        'entries': [{'accountId': 'cash_at_hand', 'accountName': 'Cash at Hand', 'deltaUgx': -1050000, 'balanceAfterUgx': 0}],
        'createdAt': Timestamp.fromDate(now),
      });
      await db.collection('finance_daily_summaries').doc(today).set({'day': today, 'payrollPaidUgx': 1050000});
      await pumpAt(tester, '/app/finance/transactions/t1');
      expect(find.text('Payroll payment'), findsWidgets);
      expect(find.byKey(const Key('reverse-transaction-button')), findsNothing);
      await pumpAt(tester, '/app/finance');
      expect(tester.widget<Text>(find.byKey(const Key('today-staff-pay'))).data, 'UGX 1,050,000');
      await unmount(tester);
    });
  });
}
