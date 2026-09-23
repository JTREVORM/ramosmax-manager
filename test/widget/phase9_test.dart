import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:ramosmax_auto_manager/app.dart';
import 'package:ramosmax_auto_manager/features/after_hours/application/after_hours_providers.dart';
import 'package:ramosmax_auto_manager/features/billing/application/billing_providers.dart';
import 'package:ramosmax_auto_manager/features/dashboard/presentation/dashboard_shell.dart';
import 'package:ramosmax_auto_manager/features/expenses/application/expenses_providers.dart';
import 'package:ramosmax_auto_manager/features/finance/application/finance_providers.dart';
import 'package:ramosmax_auto_manager/features/inventory/application/inventory_providers.dart';
import 'package:ramosmax_auto_manager/features/jobs/application/jobs_providers.dart';
import 'package:ramosmax_auto_manager/features/notifications/application/notifications_providers.dart';
import 'package:ramosmax_auto_manager/features/operations/application/operations_providers.dart';
import 'package:ramosmax_auto_manager/features/payroll/application/workforce_providers.dart';
import 'package:ramosmax_auto_manager/features/reports/application/reports_providers.dart';
import 'package:ramosmax_auto_manager/features/shareholders/application/shareholders_providers.dart';
import 'package:ramosmax_auto_manager/models/business_report.dart';

import '../support/fake_auth_repository.dart';
import '../support/fake_operations_api.dart';
import '../support/fake_phase4_apis.dart';
import '../support/fake_phase5_apis.dart';
import '../support/fake_phase6_apis.dart';
import '../support/fake_phase7_apis.dart';
import '../support/fake_phase8_apis.dart';
import '../support/fake_phase9_apis.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeReportsApi reports;
  late FakeNotificationsApi notificationsApi;
  late FakeConnectivityService connectivity;
  final now = DateTime.now();

  setUp(() {
    db = FakeFirebaseFirestore();
    reports = FakeReportsApi();
    notificationsApi = FakeNotificationsApi();
    connectivity = FakeConnectivityService();
  });

  Future<void> me(String role, {List<String> permissions = const [], List<String> denied = const []}) =>
      db.collection('users').doc('me').set(userDocData(role: role, fullName: 'Me $role', permissions: permissions, denied: denied));

  Future<void> notice(String id, String type, {String? recordId, bool read = false, int minutesAgo = 0, String recipient = 'me'}) =>
      db.collection('notifications').doc(id).set({
        'recipientId': recipient, 'type': type, 'category': 'jobs', 'critical': false, 'recordId': recordId,
        'title': 'Title $id', 'body': 'Open RamosMAX for details.', 'read': read, 'readAt': null,
        'createdAt': Timestamp.fromDate(now.subtract(Duration(minutes: minutesAgo))),
      });

  Future<void> pumpAt(WidgetTester tester, String location) async {
    // A real small Android phone: 360 × 2000 logical pixels at 3x (MediaQuery sees it too).
    tester.view.physicalSize = const Size(1080, 6000);
    tester.view.devicePixelRatio = 3.0;
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...testOverrides(auth: FakeAuthRepository(initialUser: MockUser(uid: 'me', phoneNumber: testPhone)), db: db, connectivity: connectivity),
        operationsApiProvider.overrideWithValue(FakeOperationsApi()),
        jobsApiProvider.overrideWithValue(FakeJobsApi()),
        billingApiProvider.overrideWithValue(FakeBillingApi()),
        financeApiProvider.overrideWithValue(FakeFinanceApi()),
        expensesApiProvider.overrideWithValue(FakeExpensesApi()),
        inventoryApiProvider.overrideWithValue(FakeInventoryApi()),
        workforceApiProvider.overrideWithValue(FakeWorkforceApi()),
        shareholdersApiProvider.overrideWithValue(FakeShareholdersApi()),
        afterHoursApiProvider.overrideWithValue(FakeAfterHoursApi()),
        reportsApiProvider.overrideWithValue(reports),
        notificationsApiProvider.overrideWithValue(notificationsApi),
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
    tester.view.reset();
  }

  Future<void> tapKey(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  String text(WidgetTester tester, String key) => tester.widget<Text>(find.byKey(Key(key))).data!;

  group('reports', () {
    testWidgets('a manager runs a report on a small phone: server figures, formatted UGX, a table and export', (tester) async {
      await me('manager');
      await pumpAt(tester, '/app/reports');
      expect(reports.calls.single.type, ReportType.executive);
      expect(reports.calls.single.period, ReportPeriod.forPreset(ReportPeriodPreset.today, now));
      expect(text(tester, 'fig-revenue-operating_revenue'), 'UGX 1,250,000');
      expect(find.byKey(const Key('table-revenue-by_method')), findsOneWidget);
      expect(find.byKey(const Key('export-report')), findsOneWidget);
      expect(tester.takeException(), isNull);
      // Another period re-asks the server.
      await tapKey(tester, 'report-period-previous month');
      expect(reports.calls.last.period, ReportPeriod.forPreset(ReportPeriodPreset.previousMonth, now));
      await unmount(tester);
    });

    testWidgets('a cashier is offered only the reports the role allows', (tester) async {
      await me('cashier');
      await pumpAt(tester, '/app/reports');
      await tester.tap(find.byKey(const Key('report-type')));
      await tester.pumpAndSettle();
      expect(find.text('Outstanding and credit'), findsWidgets);
      expect(find.text('Expenses'), findsWidgets);
      final menu = find.byType(DropdownMenuItem<ReportType>);
      expect(find.descendant(of: menu, matching: find.text('Revenue')), findsNothing);
      expect(find.descendant(of: menu, matching: find.text('Workforce')), findsNothing);
      await unmount(tester);
    });

    testWidgets('workers cannot open reports; offline a report is not requested', (tester) async {
      await me('worker');
      await pumpAt(tester, '/app/reports');
      expect(location(tester), '/app');
      await unmount(tester);
      await me('manager');
      connectivity.online = false;
      await pumpAt(tester, '/app/reports');
      expect(reports.calls, isEmpty);
      expect(find.textContaining('internet connection'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('Business Performance opens the executive summary for a shareholder', (tester) async {
      await me('shareholder');
      await pumpAt(tester, '/app/performance');
      expect(reports.calls.single.type, ReportType.executive);
      await unmount(tester);
    });
  });

  group('notifications', () {
    testWidgets('the bell shows unread; the inbox lists only my notices; opening one marks it read and navigates', (tester) async {
      await me('worker');
      await notice('n1', 'job_assigned', recordId: 'wo1');
      await notice('n2', 'attendance_rejected', read: true, minutesAgo: 5);
      await notice('other', 'job_assigned', recipient: 'someone-else');
      await pumpAt(tester, '/app');
      expect(text(tester, 'notifications-badge'), '1');
      await tester.tap(find.byKey(const Key('notifications-button')));
      await tester.pumpAndSettle();
      expect(location(tester), '/app/notifications');
      expect(find.byKey(const Key('notification-n1')), findsOneWidget);
      expect(find.byKey(const Key('notification-n2')), findsOneWidget);
      expect(find.byKey(const Key('notification-other')), findsNothing);
      await tester.tap(find.byKey(const Key('notification-n1')));
      await tester.pumpAndSettle();
      expect((await db.doc('notifications/n1').get()).get('read'), isTrue);
      expect(location(tester), '/app/my-jobs');
      await unmount(tester);
    });

    testWidgets('mark all as read', (tester) async {
      await me('manager');
      await notice('a', 'expense_awaiting_approval', recordId: 'e1');
      await notice('b', 'inventory_low_stock', recordId: 'i1');
      await pumpAt(tester, '/app/notifications');
      await tester.tap(find.byKey(const Key('mark-all-read')));
      await tester.pumpAndSettle();
      for (final id in ['a', 'b']) {
        expect((await db.doc('notifications/$id').get()).get('read'), isTrue);
      }
      expect(find.byKey(const Key('mark-all-read')), findsNothing);
      await unmount(tester);
    });

    testWidgets('settings: optional categories can be muted on the server; critical ones are locked on', (tester) async {
      await me('worker');
      await pumpAt(tester, '/app/notifications/settings');
      expect(tester.widget<SwitchListTile>(find.byKey(const Key('pref-access'))).onChanged, isNull);
      expect(tester.widget<SwitchListTile>(find.byKey(const Key('pref-pay'))).onChanged, isNull);
      await tester.tap(find.byKey(const Key('pref-jobs')));
      await tester.pumpAndSettle();
      expect(notificationsApi.calls, [{'jobs': false}]);
      await unmount(tester);
    });
  });

  group('audit logs and settings', () {
    testWidgets('an auditor reads the audit trail and filters by module; a manager cannot open it', (tester) async {
      await me('auditor');
      for (final (id, module, action) in [('l1', 'finance', 'finance.transferred'), ('l2', 'payroll', 'payroll.paid')]) {
        await db.collection('audit_logs').doc(id).set({'userId': 'mgr-uid', 'userRole': 'manager', 'module': module, 'action': action,
          'recordId': 'r-$id', 'reason': 'Month end', 'timestamp': Timestamp.fromDate(now)});
      }
      await pumpAt(tester, '/app/audit');
      expect(find.byKey(const Key('audit-l1')), findsOneWidget);
      expect(find.byKey(const Key('audit-l2')), findsOneWidget);
      await tapKey(tester, 'audit-module-payroll');
      expect(find.byKey(const Key('audit-l1')), findsNothing);
      expect(find.byKey(const Key('audit-l2')), findsOneWidget);
      await unmount(tester);
      await me('manager');
      await pumpAt(tester, '/app/audit');
      expect(location(tester), '/app');
      await unmount(tester);
    });

    testWidgets('settings shows the connected environment and only links the person can open', (tester) async {
      await me('auditor');
      await pumpAt(tester, '/app/settings');
      expect(text(tester, 'settings-environment'), 'Development (test data)');
      expect(find.byKey(const Key('settings-link-settings')), findsOneWidget); // notification settings
      expect(find.byKey(const Key('settings-link-after-hours')), findsOneWidget); // auditor reads After-Hours
      await unmount(tester);
    });
  });
}
