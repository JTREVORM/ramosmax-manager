import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:ramosmax_auto_manager/app.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/features/billing/application/billing_providers.dart';
import 'package:ramosmax_auto_manager/features/dashboard/presentation/dashboard_shell.dart';
import 'package:ramosmax_auto_manager/features/jobs/application/jobs_providers.dart';
import 'package:ramosmax_auto_manager/features/operations/application/operations_providers.dart';

import '../support/fake_auth_repository.dart';
import '../support/fake_operations_api.dart';
import '../support/fake_phase4_apis.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeJobsApi jobsApi;
  late FakeBillingApi billingApi;
  late FakeConnectivityService connectivity;
  final t0 = DateTime.utc(2026, 9, 21, 8);

  setUp(() {
    db = FakeFirebaseFirestore();
    jobsApi = FakeJobsApi();
    billingApi = FakeBillingApi();
    connectivity = FakeConnectivityService();
  });

  Future<void> me(String role, {List<String> permissions = const []}) =>
      db.collection('users').doc('me').set(userDocData(role: role, fullName: 'Me $role', permissions: permissions));

  Future<void> order(String id, {String workerId = 'me', String status = 'assigned', String intakeId = 'i1', String service = 'Full Wash'}) =>
      db.collection('worker_orders').doc(id).set({
        'workerOrderId': id, 'orderNumber': 'RMX-JOB-000001/${id.hashCode % 9 + 1}', 'serviceIntakeId': intakeId,
        'jobNumber': 'RMX-JOB-000001', 'vehicleId': 'v1', 'numberPlate': 'UGB 123A', 'vehicleSummary': 'Toyota · Harrier',
        'serviceName': service, 'status': status, 'workerId': workerId, 'workerName': workerId == 'me' ? 'Me worker' : 'Other',
        'createdAt': Timestamp.fromDate(t0), 'assignmentHistory': [],
      });

  Future<void> invoice({int subtotal = 35000, int paid = 0, String status = 'unpaid', int daysAgo = 0}) =>
      db.collection('invoices').doc('inv1').set({
        'invoiceNumber': 'RMX-INV-000001', 'serviceIntakeId': 'i1', 'jobNumber': 'RMX-JOB-000001', 'vehicleId': 'v1',
        'numberPlate': 'UGB 123A', 'customerName': 'John Doe',
        'items': [
          {'serviceName': 'Full Wash', 'priceUgx': 15000},
          {'serviceName': 'Interior Cleaning', 'priceUgx': 20000},
        ],
        'subtotalUgx': subtotal, 'discountUgx': 0, 'totalUgx': subtotal, 'paidUgx': paid, 'outstandingUgx': subtotal - paid,
        'paymentStatus': status, 'discount': null,
        'issuedAt': Timestamp.fromDate(DateTime.now().subtract(Duration(days: daysAgo))),
        'createdAt': Timestamp.fromDate(DateTime.now().subtract(Duration(days: daysAgo))),
      });

  Future<void> pumpAt(WidgetTester tester, String location) async {
    await tester.binding.setSurfaceSize(const Size(430, 1600));
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...testOverrides(
          auth: FakeAuthRepository(initialUser: MockUser(uid: 'me', phoneNumber: testPhone)),
          db: db,
          connectivity: connectivity,
        ),
        operationsApiProvider.overrideWithValue(FakeOperationsApi()),
        jobsApiProvider.overrideWithValue(jobsApi),
        billingApiProvider.overrideWithValue(billingApi),
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
    if (f.evaluate().isEmpty) {
      await tester.scrollUntilVisible(f, 300,
          scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first);
    }
    final element = tester.element(f);
    if (Scrollable.maybeOf(element) != null) {
      await Scrollable.ensureVisible(element, alignment: 0.5);
      await tester.pumpAndSettle();
    }
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  group('worker', () {
    testWidgets('My Jobs shows only my orders; accept is one tap; pause needs a reason', (tester) async {
      await me('worker');
      await order('o1');
      await order('o2', status: 'in_progress', service: 'Interior Cleaning');
      await order('o3', workerId: 'someone-else', service: 'Waxing');
      await pumpAt(tester, '/app/my-jobs');
      expect(find.byKey(const Key('work-order-o1')), findsOneWidget);
      expect(find.byKey(const Key('work-order-o2')), findsOneWidget);
      expect(find.byKey(const Key('work-order-o3')), findsNothing);
      expect(find.text('Waxing'), findsNothing);

      await tapKey(tester, 'order-accept-o1');
      expect(jobsApi.calls.single.$2, {'workerOrderId': 'o1', 'action': 'accept', 'reason': null, 'completionNotes': null});

      await tapKey(tester, 'order-pause-o2');
      await tester.tap(find.byKey(const Key('confirm-button')));
      await tester.pumpAndSettle();
      expect(jobsApi.calls, hasLength(1), reason: 'pause without a reason is not sent');
      await tester.enterText(find.byKey(const Key('reason-field')), 'Waiting for water');
      await tester.tap(find.byKey(const Key('confirm-button')));
      await tester.pumpAndSettle();
      expect(jobsApi.calls.last.$2['reason'], 'Waiting for water');
      await unmount(tester);
    });

    testWidgets('completing asks for confirmation first', (tester) async {
      await me('worker');
      await order('o2', status: 'in_progress');
      await pumpAt(tester, '/app/my-jobs');
      await tapKey(tester, 'order-complete-o2');
      expect(jobsApi.calls, isEmpty);
      expect(find.textContaining('cannot be undone'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('reason-field')), 'Tyres dressed too');
      await tester.tap(find.byKey(const Key('confirm-button')));
      await tester.pumpAndSettle();
      expect(jobsApi.calls.single.$2, {'workerOrderId': 'o2', 'action': 'complete', 'reason': null, 'completionNotes': 'Tyres dressed too'});
      await unmount(tester);
    });

    testWidgets('workers cannot open billing screens', (tester) async {
      await me('worker');
      for (final path in ['/app/invoices', '/app/payments', '/app/credit', '/app/loyalty', '/app/jobs']) {
        await pumpAt(tester, path);
        expect(location(tester), '/app', reason: path);
      }
      await unmount(tester);
    });

    testWidgets('offline: actions are not sent', (tester) async {
      await me('worker');
      await order('o1');
      connectivity.online = false;
      await pumpAt(tester, '/app/my-jobs');
      await tapKey(tester, 'order-accept-o1');
      expect(jobsApi.calls, isEmpty);
      expect(find.textContaining('internet connection'), findsOneWidget);
      await unmount(tester);
    });
  });

  group('manager and cashier', () {
    Future<void> job({String status = 'open', String? invoiceId}) => db.collection('service_intakes').doc('i1').set({
          'jobNumber': 'RMX-JOB-000001', 'vehicleId': 'v1', 'numberPlate': 'UGB 123A', 'status': status,
          'selectedServices': [{'serviceId': 's1', 'name': 'Full Wash', 'category': 'washing', 'priceUgx': 15000}],
          'orders': [{'workerOrderId': 'o1', 'orderNumber': 'RMX-JOB-000001/1', 'serviceName': 'Full Wash', 'status': 'pending'}],
          'invoiceId': invoiceId, 'invoiceNumber': invoiceId == null ? null : 'RMX-INV-000001',
          'createdAt': Timestamp.fromDate(t0),
        });

    testWidgets('jobs: search by job number; manager assigns a pending order to a worker', (tester) async {
      await me('manager');
      await db.collection('users').doc('w1').set(userDocData(role: 'worker', fullName: 'Wendy Washer'));
      await job();
      await order('o1', workerId: '', status: 'pending');
      await pumpAt(tester, '/app/jobs');
      await tester.enterText(find.byKey(const Key('job-search-field')), 'JOB-000001');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('intake-tile-i1')), findsOneWidget);
      await tester.enterText(find.byKey(const Key('job-search-field')), 'UAX');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('intake-tile-i1')), findsNothing);
      await tester.enterText(find.byKey(const Key('job-search-field')), '');
      await tester.pumpAndSettle();
      await tapKey(tester, 'intake-tile-i1');
      await tapKey(tester, 'assign-o1');
      await tester.tap(find.byKey(const Key('pick-worker-w1')));
      await tester.pumpAndSettle();
      expect(jobsApi.calls.single.$1, 'assign');
      expect(jobsApi.calls.single.$2, {'workerOrderId': 'o1', 'workerId': 'w1'});
      await unmount(tester);
    });

    testWidgets('a completed job is invoiced in one tap and opens the invoice', (tester) async {
      await me('cashier');
      await job(status: 'completed');
      await order('o1', workerId: 'w1', status: 'completed');
      await pumpAt(tester, '/app/jobs/i1');
      expect(find.byKey(const Key('assign-o1')), findsNothing, reason: 'cashiers do not assign');
      await tapKey(tester, 'create-invoice-button');
      expect(billingApi.names, ['createInvoice']);
      expect(location(tester), '/app/invoices/inv-new');
      await unmount(tester);
    });

    testWidgets('invoice: totals shown; partial payment recorded; overpayment blocked; receipt opened', (tester) async {
      await me('cashier');
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      expect(tester.widget<Text>(find.byKey(const Key('invoice-total'))).data, 'UGX 35,000');
      expect(find.byKey(const Key('discount-button')), findsNothing, reason: 'cashiers discount only when granted');
      await tapKey(tester, 'pay-button');
      expect(tester.widget<TextField>(find.byKey(const Key('payment-amount-field'))).controller!.text, '35,000');
      await tester.enterText(find.byKey(const Key('payment-amount-field')), '40000');
      await tester.pumpAndSettle();
      expect(find.textContaining('Give change instead'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('record-payment-button'))).onPressed, isNull);
      await tester.enterText(find.byKey(const Key('payment-amount-field')), '10000');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('method-mtn_merchant')));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byKey(const Key('record-payment-button'))).onPressed, isNull,
          reason: 'mobile money needs a reference');
      await tester.enterText(find.byKey(const Key('payment-reference-field')), 'MP240921.1');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('record-payment-button')));
      await tester.pumpAndSettle();
      final args = billingApi.calls.single.$2;
      expect([args['amountUgx'], args['method'], args['reference']], [10000, 'mtn_merchant', 'MP240921.1']);
      expect(args['requestId'], isA<String>());
      expect(location(tester), '/app/receipts/r-new');
      await unmount(tester);
    });

    testWidgets('a rejected payment keeps the same request id when retried', (tester) async {
      await me('cashier');
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      await tapKey(tester, 'pay-button');
      billingApi.nextFailure = const AppFailure(FailureKind.network, 'Timed out', retryable: true);
      await tester.tap(find.byKey(const Key('record-payment-button')));
      await tester.pumpAndSettle();
      expect(find.text('Timed out'), findsOneWidget);
      await tester.tap(find.byKey(const Key('record-payment-button')));
      await tester.pumpAndSettle();
      expect(billingApi.calls, hasLength(2));
      expect(billingApi.calls[0].$2['requestId'], billingApi.calls[1].$2['requestId']);
      await unmount(tester);
    });

    testWidgets('manager discount: live preview, reason required', (tester) async {
      await me('manager');
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      await tapKey(tester, 'discount-button');
      await tester.enterText(find.byKey(const Key('discount-value-field')), '10');
      await tester.pumpAndSettle();
      expect(tester.widget<Text>(find.byKey(const Key('discount-preview'))).data, '− UGX 3,500');
      expect(tester.widget<FilledButton>(find.byKey(const Key('apply-discount-button'))).onPressed, isNull, reason: 'no reason yet');
      await tester.tap(find.byKey(const Key('discount-reason-field')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Promotional offer').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('apply-discount-button')));
      await tester.pumpAndSettle();
      expect(billingApi.calls.single.$2, {'invoiceId': 'inv1', 'type': 'percentage', 'value': 10, 'reason': 'promotional', 'description': null});
      await unmount(tester);
    });

    testWidgets('a cashier granted discounts cannot exceed 25% without a manager', (tester) async {
      await me('cashier', permissions: ['discounts.apply']);
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      await tapKey(tester, 'discount-button');
      await tester.enterText(find.byKey(const Key('discount-value-field')), '30');
      await tester.pumpAndSettle();
      expect(find.textContaining('need a manager'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('apply-discount-button'))).onPressed, isNull);
      await unmount(tester);
    });

    testWidgets('loyalty reward: offered with an exact preview, applied only after confirming', (tester) async {
      await me('cashier');
      await invoice();
      await db.collection('loyalty_accounts').doc('v1').set({'vehicleId': 'v1', 'numberPlate': 'UGB 123A', 'pointsBalance': 210});
      await db.collection('loyalty_rewards').doc('rw1').set({'vehicleId': 'v1', 'status': 'available', 'discountPercent': 25, 'pointsCost': 200});
      await pumpAt(tester, '/app/invoices/inv1');
      expect(find.byKey(const Key('loyalty-offer')), findsOneWidget);
      await tapKey(tester, 'apply-reward-button');
      expect(tester.widget<Text>(find.byKey(const Key('reward-preview'))).data, '− UGX 8,750');
      expect(find.text('Uses 200 points: 210 → 10.'), findsOneWidget);
      expect(billingApi.calls, isEmpty);
      await tester.tap(find.byKey(const Key('confirm-reward-button')));
      await tester.pumpAndSettle();
      expect(billingApi.calls.single.$1, 'applyLoyaltyReward');
      expect(billingApi.calls.single.$2, {'invoiceId': 'inv1', 'expected': 8750});
      await unmount(tester);
    });

    testWidgets('receipt: branded snapshot with share action', (tester) async {
      await me('cashier');
      await db.collection('receipts').doc('r1').set({
        'receiptNumber': 'RMX-RCP-000001', 'businessName': 'RamosMAX Automotive Care (U) Ltd', 'invoiceId': 'inv1',
        'numberPlate': 'UGB 123A', 'items': [{'serviceName': 'Full Wash', 'priceUgx': 15000}],
        'subtotalUgx': 15000, 'discountUgx': 0, 'totalUgx': 15000, 'amountPaidUgx': 5000, 'totalPaidUgx': 5000,
        'outstandingUgx': 10000, 'method': 'cash', 'status': 'issued', 'issuedAt': Timestamp.fromDate(t0),
      });
      await pumpAt(tester, '/app/receipts/r1');
      expect(find.text('RMX-RCP-000001'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('receipt-balance'))).data, 'UGX 10,000');
      expect(find.byKey(const Key('share-receipt-button')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('credit: totals by age; filters narrow the list', (tester) async {
      await me('manager');
      await invoice(paid: 5000, status: 'credit', daysAgo: 12);
      await db.collection('invoices').doc('inv2').set({
        'invoiceNumber': 'RMX-INV-000002', 'serviceIntakeId': 'i2', 'vehicleId': 'v2', 'numberPlate': 'UAX 456B',
        'subtotalUgx': 15000, 'discountUgx': 0, 'totalUgx': 15000, 'paidUgx': 0, 'outstandingUgx': 15000, 'paymentStatus': 'unpaid',
        'issuedAt': Timestamp.fromDate(DateTime.now()), 'createdAt': Timestamp.fromDate(DateTime.now()),
      });
      await pumpAt(tester, '/app/credit');
      expect(tester.widget<Text>(find.byKey(const Key('credit-total'))).data, 'UGX 45,000');
      expect(find.byKey(const Key('invoice-tile-inv1')), findsOneWidget);
      expect(find.byKey(const Key('invoice-tile-inv2')), findsOneWidget);
      await tapKey(tester, 'credit-age-today');
      expect(find.byKey(const Key('invoice-tile-inv1')), findsNothing);
      expect(find.byKey(const Key('invoice-tile-inv2')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('auditor: reads invoices but gets no action buttons', (tester) async {
      await me('auditor');
      await invoice();
      await pumpAt(tester, '/app/invoices/inv1');
      expect(find.byKey(const Key('invoice-detail')), findsOneWidget);
      for (final k in ['pay-button', 'discount-button', 'credit-button', 'cancel-invoice-button']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      await unmount(tester);
    });

    testWidgets('dashboard shows live figures for the cashier', (tester) async {
      await me('cashier');
      await invoice(paid: 5000, status: 'partially_paid');
      await pumpAt(tester, '/app');
      expect(find.byKey(const Key('stat-outstanding')), findsOneWidget);
      expect(find.text('UGX 30,000'), findsOneWidget);
      await unmount(tester);
    });
  });
}
