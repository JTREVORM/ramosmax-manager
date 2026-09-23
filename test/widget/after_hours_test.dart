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
import 'package:ramosmax_auto_manager/features/operations/application/operations_providers.dart';
import 'package:ramosmax_auto_manager/features/payroll/application/workforce_providers.dart';
import 'package:ramosmax_auto_manager/features/shareholders/application/shareholders_providers.dart';

import '../support/fake_auth_repository.dart';
import '../support/fake_operations_api.dart';
import '../support/fake_phase4_apis.dart';
import '../support/fake_phase5_apis.dart';
import '../support/fake_phase6_apis.dart';
import '../support/fake_phase7_apis.dart';
import '../support/fake_phase8_apis.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeAfterHoursApi api;
  late FakeBillingApi billing;
  late FakeConnectivityService connectivity;
  final now = DateTime.now();
  Timestamp ts(DateTime d) => Timestamp.fromDate(d);
  final start = now.subtract(const Duration(hours: 1));
  final end = now.add(const Duration(hours: 4));

  setUp(() {
    db = FakeFirebaseFirestore();
    api = FakeAfterHoursApi();
    billing = FakeBillingApi();
    connectivity = FakeConnectivityService();
  });

  Future<void> me(String role, {List<String> permissions = const [], Map<String, Object?>? temporary}) async {
    await db.collection('users').doc('me').set({
      ...userDocData(role: role, fullName: 'Me $role', permissions: permissions),
      'temporaryPermissions': ?temporary,
    });
  }

  /// The profile map an authorisation writes (Phase 2 temporary grants).
  Map<String, Object?> grants(List<String> perms, {DateTime? from, DateTime? to}) => {
        for (final p in perms) p: {'startsAt': ts(from ?? start), 'expiresAt': ts(to ?? end), 'grantId': 'g-$p'},
      };

  const workerGrants = ['after_hours.operate', 'after_hours.cash.collect', 'jobs.view', 'jobs.create', 'jobs.assign', 'invoices.view', 'invoices.create'];

  Future<void> authorization({String id = 'a1', String staffUid = 'me', String status = 'active', DateTime? from, DateTime? to, int float = 20000}) =>
      db.collection('after_hours_access').doc(id).set({
        'authorizationId': id, 'authorizationNumber': 'RMX-AH-000001', 'staffUid': staffUid, 'staffName': 'Wendy Worker', 'status': status,
        'startsAt': ts(from ?? start), 'expiresAt': ts(to ?? end), 'permissions': workerGrants, 'openingFloatUgx': float,
        'grantedBy': 'boss', 'grantedByName': 'Mary Manager', 'reason': 'Evening cover', 'createdAt': ts(start),
      });

  Future<void> session({String id = 's1', String staffUid = 'me', String status = 'open', int expected = 55000, int payments = 2, DateTime? authEnds}) =>
      db.collection('after_hours_sessions').doc(id).set({
        'sessionId': id, 'sessionNumber': 'RMX-AHS-000001', 'staffUid': staffUid, 'staffName': 'Wendy Worker', 'status': status,
        'authorizationId': 'a1', 'authorizationNumber': 'RMX-AH-000001', 'authorizationExpiresAt': ts(authEnds ?? end),
        'supervisorName': 'Mary Manager', 'openedAt': ts(start), 'openingFloatUgx': 20000, 'cashCollectedUgx': 35000,
        'nonCashCollectedUgx': 15000, 'cashReversedUgx': 0, 'expectedCashUgx': expected, 'paymentCount': payments,
        'intakesCreated': 2, 'invoicesCreated': 2, 'jobsCompleted': 1, 'createdAt': ts(start),
      });

  Future<void> custody() async {
    for (final (id, kind, method, amount, delta) in [
      ('c1', 'opening_float', 'cash', 20000, 20000),
      ('c2', 'payment', 'cash', 35000, 35000),
      ('c3', 'payment', 'mtn_merchant', 15000, 0),
    ]) {
      await db.collection('after_hours_cash').doc(id).set({
        'entryId': id, 'entryNumber': 'RMX-AHC-00000${id.substring(1)}', 'kind': kind, 'sessionId': 's1', 'staffUid': 'me', 'method': method,
        'amountUgx': amount, 'cashDeltaUgx': delta, 'affectsExpected': delta > 0, 'receiptNumber': kind == 'payment' ? 'RMX-RCP-00000$id' : null,
        'createdAt': ts(start.add(Duration(minutes: int.parse(id.substring(1))))),
      });
    }
  }

  Future<void> handover({String id = 'h1', String staffUid = 'me', String status = 'pending', int expected = 55000, int? actual}) =>
      db.collection('cash_handovers').doc(id).set({
        'handoverId': id, 'handoverNumber': 'RMX-HO-000001', 'sessionId': 's1', 'sessionNumber': 'RMX-AHS-000001', 'staffUid': staffUid,
        'staffName': 'Wendy Worker', 'status': status, 'openingFloatUgx': 20000, 'cashCollectedUgx': 35000, 'cashReversedUgx': 0,
        'nonCashCollectedUgx': 15000, 'paymentCount': 2, 'expectedCashUgx': expected, 'declaredAmountUgx': status == 'pending' ? null : 50000,
        'actualAmountUgx': actual, 'differenceUgx': actual == null ? null : actual - expected, 'createdAt': ts(now),
      });

  Future<void> discrepancy({String staffUid = 'w1', int difference = -5000, String status = 'open'}) =>
      db.collection('cash_discrepancies').doc('d1').set({
        'discrepancyId': 'd1', 'discrepancyNumber': 'RMX-AHD-000001', 'handoverId': 'h1', 'handoverNumber': 'RMX-HO-000001',
        'sessionId': 's1', 'staffUid': staffUid, 'staffName': 'Wendy Worker', 'expectedCashUgx': 55000, 'actualAmountUgx': 55000 + difference,
        'differenceUgx': difference, 'kind': difference < 0 ? 'shortage' : 'excess', 'status': status, 'reason': 'Counted twice',
        'reportedByName': 'Mary Manager', 'createdAt': ts(now),
      });

  Future<void> pumpAt(WidgetTester tester, String location) async {
    await tester.binding.setSurfaceSize(const Size(430, 2400));
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...testOverrides(auth: FakeAuthRepository(initialUser: MockUser(uid: 'me', phoneNumber: testPhone)), db: db, connectivity: connectivity),
        operationsApiProvider.overrideWithValue(FakeOperationsApi()),
        jobsApiProvider.overrideWithValue(FakeJobsApi()),
        billingApiProvider.overrideWithValue(billing),
        financeApiProvider.overrideWithValue(FakeFinanceApi()),
        expensesApiProvider.overrideWithValue(FakeExpensesApi()),
        inventoryApiProvider.overrideWithValue(FakeInventoryApi()),
        workforceApiProvider.overrideWithValue(FakeWorkforceApi()),
        shareholdersApiProvider.overrideWithValue(FakeShareholdersApi()),
        afterHoursApiProvider.overrideWithValue(api),
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

  Future<void> enter(WidgetTester tester, String key, String text) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.enterText(f, text);
    await tester.pumpAndSettle();
  }

  // The FAB sits inside a TabBarView page: ensureVisible would scroll the pages.
  Future<void> tapFab(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('authorize-button')));
    await tester.pumpAndSettle();
  }

  String text(WidgetTester tester, String key) => tester.widget<Text>(find.byKey(Key(key))).data!;

  group('manager dashboard', () {
    testWidgets('overview counts come from server records', (tester) async {
      await me('manager');
      await authorization(staffUid: 'w1');
      await session(staffUid: 'w1');
      await handover(id: 'h1', staffUid: 'w1', status: 'submitted');
      await discrepancy();
      await pumpAt(tester, '/app/after-hours');
      expect(text(tester, 'ah-live-count'), '1');
      expect(text(tester, 'ah-open-sessions'), '1');
      expect(text(tester, 'ah-to-receive'), '1');
      expect(text(tester, 'ah-open-discrepancies'), '1');
      expect(find.byKey(const Key('session-s1')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('authorising sends the worker, window, permissions and float - no totals', (tester) async {
      await me('manager', permissions: ['users.view']);
      await db.collection('users').doc('w1').set(userDocData(role: 'worker', fullName: 'Wendy Worker', phone: '+256772000111'));
      await db.collection('users').doc('c1').set(userDocData(role: 'cashier', fullName: 'Carl Cashier', phone: '+256772000222'));
      await pumpAt(tester, '/app/after-hours');
      await tester.tap(find.byKey(const Key('tab-authorisations')));
      await tester.pumpAndSettle();
      await tapFab(tester);
      await tester.tap(find.byKey(const Key('authorization-staff')));
      await tester.pumpAndSettle();
      // Only people eligible for after-hours work are offered.
      expect(find.textContaining('Carl Cashier'), findsNothing);
      await tester.tap(find.textContaining('Wendy Worker').last);
      await tester.pumpAndSettle();
      await enter(tester, 'authorization-float', '20,000');
      await enter(tester, 'authorization-reason', 'Evening cover');
      await tapKey(tester, 'submit-authorization');
      expect(api.names, ['authorizeAfterHours']);
      final args = api.calls.single.$2;
      expect(args['staffUid'], 'w1');
      expect(args['openingFloatUgx'], 20000);
      expect(args['permissions'], workerGrants);
      expect((args['expiresAt'] as int) - (args['startsAt'] as int), const Duration(hours: 8).inMilliseconds);
      expect(args['requestId'], isA<String>());
      await unmount(tester);
    });

    testWidgets('an authorisation longer than the policy allows is refused before sending', (tester) async {
      await me('manager', permissions: ['users.view']);
      await db.collection('settings').doc('after_hours_policy').set({'maxAuthorizationHours': 4, 'allowedPaymentMethods': ['cash'], 'maxOpeningFloatUgx': 0});
      await db.collection('users').doc('w1').set(userDocData(role: 'worker', fullName: 'Wendy Worker', phone: '+256772000111'));
      await pumpAt(tester, '/app/after-hours');
      await tester.tap(find.byKey(const Key('tab-authorisations')));
      await tester.pumpAndSettle();
      await tapFab(tester);
      await tester.tap(find.byKey(const Key('authorization-staff')));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Wendy Worker').last);
      await tester.pumpAndSettle();
      await enter(tester, 'authorization-reason', 'Evening cover');
      await tapKey(tester, 'submit-authorization');
      expect(find.textContaining('can last at most 4 hours'), findsOneWidget);
      expect(api.calls, isEmpty);
      await unmount(tester);
    });

    testWidgets('revoking asks for a reason', (tester) async {
      await me('manager');
      await authorization(staffUid: 'w1');
      await pumpAt(tester, '/app/after-hours');
      await tester.tap(find.byKey(const Key('tab-authorisations')));
      await tester.pumpAndSettle();
      await tapKey(tester, 'revoke-a1');
      await tester.enterText(find.byType(TextField).last, 'Shift cancelled');
      await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
      await tester.pumpAndSettle();
      expect(api.names, ['revokeAfterHours']);
      expect(api.calls.single.$2, {'authorizationId': 'a1', 'reason': 'Shift cancelled'});
      await unmount(tester);
    });

    testWidgets('an auditor sees the dashboard but cannot authorise, receive or resolve', (tester) async {
      await me('auditor');
      await authorization(staffUid: 'w1');
      await handover(staffUid: 'w1', status: 'submitted');
      await discrepancy();
      await pumpAt(tester, '/app/after-hours');
      await tester.tap(find.byKey(const Key('tab-authorisations')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('authorize-button')), findsNothing);
      expect(find.byKey(const Key('revoke-a1')), findsNothing);
      await pumpAt(tester, '/app/after-hours/handover/h1');
      expect(find.byKey(const Key('receive-handover-button')), findsNothing);
      await pumpAt(tester, '/app/after-hours/discrepancy/d1');
      expect(find.byKey(const Key('resolve-discrepancy-button')), findsNothing);
      await unmount(tester);
    });

    testWidgets('a cashier cannot open the After-Hours dashboard', (tester) async {
      await me('cashier');
      await pumpAt(tester, '/app/after-hours');
      expect(location(tester), '/app');
      await unmount(tester);
    });
  });

  group('receiving a handover', () {
    testWidgets('equal amounts: received, no explanation needed', (tester) async {
      await me('manager');
      await handover(staffUid: 'w1', status: 'submitted');
      await pumpAt(tester, '/app/after-hours/handover/h1');
      expect(text(tester, 'expected-cash'), 'UGX 55,000');
      await tapKey(tester, 'receive-handover-button');
      await enter(tester, 'receive-actual', '55,000');
      expect(text(tester, 'receive-difference'), 'Balanced');
      expect(find.byKey(const Key('receive-explanation')), findsNothing);
      await tapKey(tester, 'submit-receive');
      expect(api.names, ['receiveCashHandover']);
      expect(api.calls.single.$2['actualAmountUgx'], 55000);
      expect(api.calls.single.$2.containsKey('expectedCashUgx'), isFalse);
      await unmount(tester);
    });

    testWidgets('a shortage needs an explanation and is sent as counted', (tester) async {
      await me('manager');
      await handover(staffUid: 'w1', status: 'submitted');
      api.receipt = (status: api.receipt.status, difference: api.receipt.difference, discrepancyId: 'd9', discrepancyNumber: 'RMX-AHD-000009');
      await pumpAt(tester, '/app/after-hours/handover/h1');
      await tapKey(tester, 'receive-handover-button');
      await enter(tester, 'receive-actual', '50,000');
      expect(text(tester, 'receive-difference'), '− UGX 5,000 shortage');
      final submit = tester.widget<FilledButton>(find.byKey(const Key('submit-receive')));
      expect(submit.onPressed, isNull);
      await enter(tester, 'receive-explanation', 'Worker gave change from the float');
      await tapKey(tester, 'submit-receive');
      expect(api.calls.single.$2['actualAmountUgx'], 50000);
      expect(api.calls.single.$2['explanation'], 'Worker gave change from the float');
      await unmount(tester);
    });

    testWidgets('an excess is shown as an excess', (tester) async {
      await me('manager');
      await handover(staffUid: 'w1', status: 'submitted');
      await pumpAt(tester, '/app/after-hours/handover/h1');
      await tapKey(tester, 'receive-handover-button');
      await enter(tester, 'receive-actual', '60,000');
      expect(text(tester, 'receive-difference'), '+ UGX 5,000 excess');
      await unmount(tester);
    });

    testWidgets('nobody receives their own handover', (tester) async {
      await me('manager');
      await handover(staffUid: 'me', status: 'submitted');
      await pumpAt(tester, '/app/after-hours/handover/h1');
      expect(find.byKey(const Key('receive-handover-button')), findsNothing);
      await unmount(tester);
    });

    testWidgets('a recorded difference is displayed from the server and cannot be received again', (tester) async {
      await me('manager');
      await handover(staffUid: 'w1', status: 'discrepancy', actual: 50000);
      await pumpAt(tester, '/app/after-hours/handover/h1');
      expect(text(tester, 'handover-difference'), '− UGX 5,000 shortage');
      expect(find.byKey(const Key('receive-handover-button')), findsNothing);
      await unmount(tester);
    });
  });

  group('discrepancies', () {
    testWidgets('a manager resolves a shortage and may report it as a loss - never a deduction', (tester) async {
      await me('manager');
      await discrepancy();
      await pumpAt(tester, '/app/after-hours/discrepancy/d1');
      expect(text(tester, 'discrepancy-difference'), '− UGX 5,000 shortage');
      await tapKey(tester, 'resolve-discrepancy-button');
      expect(find.byKey(const Key('resolve-recover')), findsOneWidget);
      // Managers have no finance.adjust: no adjustment offered.
      expect(find.byKey(const Key('resolve-adjust')), findsNothing);
      expect(tester.widget<FilledButton>(find.byKey(const Key('submit-resolve'))).onPressed, isNull);
      await enter(tester, 'resolve-resolution', 'Confirmed short; worker agrees');
      await tapKey(tester, 'resolve-recover');
      await tapKey(tester, 'submit-resolve');
      expect(api.names, ['resolveCashDiscrepancy']);
      final args = api.calls.single.$2;
      expect(args['outcome'], 'resolved');
      expect(args['recoverFromWorker'], isTrue);
      expect(args['postAdjustment'], isFalse);
      await unmount(tester);
    });

    testWidgets('an excess cannot be recovered from the worker; an admin may post the adjustment', (tester) async {
      await me('admin');
      await discrepancy(difference: 5000);
      await pumpAt(tester, '/app/after-hours/discrepancy/d1');
      await tapKey(tester, 'resolve-discrepancy-button');
      expect(find.byKey(const Key('resolve-recover')), findsNothing);
      expect(find.byKey(const Key('resolve-adjust')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('review needs notes; nobody decides their own discrepancy', (tester) async {
      await me('manager');
      await discrepancy();
      await pumpAt(tester, '/app/after-hours/discrepancy/d1');
      await tapKey(tester, 'review-discrepancy-button');
      await tester.enterText(find.byType(TextField).last, 'Checking receipts');
      await tester.tap(find.widgetWithText(FilledButton, 'Start review'));
      await tester.pumpAndSettle();
      expect(api.names, ['reviewCashDiscrepancy']);
      expect(api.calls.single.$2, {'discrepancyId': 'd1', 'notes': 'Checking receipts'});
      await discrepancy(staffUid: 'me');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('resolve-discrepancy-button')), findsNothing);
      await unmount(tester);
    });
  });

  group('worker: My After-Hours', () {
    testWidgets('without an authorisation there is nothing to start', (tester) async {
      await me('worker');
      await pumpAt(tester, '/app/my-after-hours');
      expect(find.byKey(const Key('my-ah-none')), findsOneWidget);
      expect(find.byKey(const Key('open-session-button')), findsNothing);
      await unmount(tester);
    });

    testWidgets('an authorised worker starts a session (once per request id)', (tester) async {
      await me('worker', temporary: grants(workerGrants));
      await authorization();
      await pumpAt(tester, '/app/my-after-hours');
      expect(find.byKey(const Key('my-ah-authorization-a1')), findsOneWidget);
      await tapKey(tester, 'open-session-button');
      expect(api.names, ['openAfterHoursSession']);
      expect(api.calls.single.$2['requestId'], isA<String>());
      await unmount(tester);
    });

    testWidgets('an expired authorisation opens nothing and hides the extra menus', (tester) async {
      final past = now.subtract(const Duration(hours: 5));
      final ended = now.subtract(const Duration(minutes: 1));
      await me('worker', temporary: grants(workerGrants, from: past, to: ended));
      await authorization(from: past, to: ended);
      await pumpAt(tester, '/app/my-after-hours');
      expect(find.byKey(const Key('open-session-button')), findsNothing);
      await pumpAt(tester, '/app/invoices');
      expect(location(tester), '/app');
      await unmount(tester);
    });

    testWidgets('the open session shows the server expected cash and custody entries; closing confirms first', (tester) async {
      await me('worker', temporary: grants(workerGrants));
      await authorization();
      await session();
      await custody();
      await pumpAt(tester, '/app/my-after-hours');
      expect(find.byKey(const Key('my-open-session')), findsOneWidget);
      expect(text(tester, 'expected-cash'), 'UGX 55,000');
      expect(find.byKey(const Key('custody-c3')), findsOneWidget);
      expect(find.byKey(const Key('open-session-button')), findsNothing);
      // The expected cash is display-only: there is no field for it.
      expect(find.byType(TextField), findsNothing);
      await tapKey(tester, 'my-close-session');
      await tester.tap(find.widgetWithText(FilledButton, 'Close session').last);
      await tester.pumpAndSettle();
      expect(api.names, ['closeAfterHoursSession']);
      expect(api.calls.single.$2['sessionId'], 's1');
      await unmount(tester);
    });

    testWidgets('after the authorisation ends the worker is told to close and hand over', (tester) async {
      await me('worker');
      await session(authEnds: now.subtract(const Duration(minutes: 1)));
      await pumpAt(tester, '/app/my-after-hours');
      expect(find.textContaining('Your authorisation has ended'), findsOneWidget);
      expect(find.byKey(const Key('my-close-session')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('submitting a handover sends only the declared amount; the expected cash is read-only', (tester) async {
      await me('worker');
      await session(status: 'handover_pending');
      await handover();
      await pumpAt(tester, '/app/my-after-hours');
      await tapKey(tester, 'my-submit-h1');
      expect(text(tester, 'handover-expected'), 'UGX 55,000');
      expect(find.byType(TextField), findsNWidgets(2)); // declared amount + notes only
      await enter(tester, 'handover-declared', '50,000');
      expect(find.byKey(const Key('handover-declared-difference')), findsOneWidget);
      await tapKey(tester, 'submit-handover');
      expect(api.names, ['submitCashHandover']);
      final args = api.calls.single.$2;
      expect(args['declaredAmountUgx'], 50000);
      expect(args.containsKey('expectedCashUgx'), isFalse);
      await unmount(tester);
    });

    testWidgets('offline: starting a session is refused and nothing is queued', (tester) async {
      await me('worker', temporary: grants(workerGrants));
      await authorization();
      connectivity.online = false;
      await pumpAt(tester, '/app/my-after-hours');
      await tapKey(tester, 'open-session-button');
      expect(find.textContaining('internet connection'), findsOneWidget);
      expect(api.calls, isEmpty);
      await unmount(tester);
    });

    testWidgets('a worker cannot reach the supervisors\' dashboard', (tester) async {
      await me('worker', temporary: grants(workerGrants));
      await pumpAt(tester, '/app/after-hours');
      expect(location(tester), '/app');
      await unmount(tester);
    });
  });

  group('collecting a payment after hours', () {
    Future<void> invoice() => db.collection('invoices').doc('inv1').set({
          'invoiceNumber': 'RMX-INV-000001', 'serviceIntakeId': 'i1', 'jobNumber': 'RMX-JOB-000001', 'vehicleId': 'v1',
          'numberPlate': 'UGB 123A', 'customerName': 'John Doe', 'items': [{'serviceName': 'Full Wash', 'priceUgx': 15000}],
          'subtotalUgx': 15000, 'discountUgx': 0, 'totalUgx': 15000, 'paidUgx': 0, 'outstandingUgx': 15000, 'paymentStatus': 'unpaid',
          'issuedAt': ts(now), 'createdAt': ts(now),
        });

    testWidgets('only the policy methods are offered, and the payment is noted as after hours', (tester) async {
      await me('worker', temporary: grants(workerGrants));
      await db.collection('settings').doc('after_hours_policy').set({'allowedPaymentMethods': ['cash', 'mtn_merchant'], 'maxAuthorizationHours': 16});
      await authorization();
      await session();
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      await tapKey(tester, 'pay-button');
      expect(find.byKey(const Key('payment-after-hours-note')), findsOneWidget);
      expect(find.byKey(const Key('method-cash')), findsOneWidget);
      expect(find.byKey(const Key('method-mtn_merchant')), findsOneWidget);
      expect(find.byKey(const Key('method-bank')), findsNothing);
      expect(find.byKey(const Key('method-airtel_merchant')), findsNothing);
      await tapKey(tester, 'record-payment-button');
      expect(billing.names.toList(), ['recordPayment']);
      expect(billing.calls.single.$2['method'], 'cash');
      await unmount(tester);
    });

    testWidgets('without an open session a collect-only worker is told to start one', (tester) async {
      await me('worker', temporary: grants(workerGrants));
      await authorization();
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      await tapKey(tester, 'pay-button');
      expect(find.textContaining('Open your after-hours session'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('record-payment-button'))).onPressed, isNull);
      await unmount(tester);
    });

    testWidgets('a cashier outside any session keeps every method', (tester) async {
      await me('cashier');
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      await tapKey(tester, 'pay-button');
      expect(find.byKey(const Key('method-bank')), findsOneWidget);
      expect(find.byKey(const Key('payment-after-hours-note')), findsNothing);
      await unmount(tester);
    });
  });
}
