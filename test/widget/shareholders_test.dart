import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:ramosmax_auto_manager/app.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/billing/application/billing_providers.dart';
import 'package:ramosmax_auto_manager/features/dashboard/presentation/dashboard_shell.dart';
import 'package:ramosmax_auto_manager/features/expenses/application/expenses_providers.dart';
import 'package:ramosmax_auto_manager/features/finance/application/finance_providers.dart';
import 'package:ramosmax_auto_manager/features/inventory/application/inventory_providers.dart';
import 'package:ramosmax_auto_manager/features/jobs/application/jobs_providers.dart';
import 'package:ramosmax_auto_manager/features/operations/application/operations_providers.dart';
import 'package:ramosmax_auto_manager/features/payroll/application/workforce_providers.dart';
import 'package:ramosmax_auto_manager/features/shareholders/application/shareholders_providers.dart';
import 'package:ramosmax_auto_manager/models/shareholding.dart';

import '../support/fake_auth_repository.dart';
import '../support/fake_operations_api.dart';
import '../support/fake_phase4_apis.dart';
import '../support/fake_phase5_apis.dart';
import '../support/fake_phase6_apis.dart';
import '../support/fake_phase7_apis.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeShareholdersApi api;
  late FakeConnectivityService connectivity;
  final now = DateTime.now();

  setUp(() {
    db = FakeFirebaseFirestore();
    api = FakeShareholdersApi();
    connectivity = FakeConnectivityService();
  });

  Future<void> me(String role, {List<String> permissions = const []}) =>
      db.collection('users').doc('me').set(userDocData(role: role, fullName: 'Me $role', permissions: permissions));

  Future<void> shareholder(String id, String name, int shares, double pct, {String status = 'active', String number = 'RMX-SHR-000001'}) =>
      db.collection('shareholders').doc(id).set({
        'shareholderId': id, 'shareholderNumber': number, 'fullName': name, 'status': status, 'totalShares': shares, 'ownershipPercent': pct,
        'committedUgx': shares * 10000, 'paidUgx': shares * 10000, 'outstandingUgx': 0, 'phoneNumber': '+256772100001',
        'searchTokens': [name.toLowerCase().split(' ').first], 'createdAt': Timestamp.fromDate(now),
      });

  Future<void> world() async {
    await shareholder('john', 'John Okello', 100, 50);
    await shareholder('mary', 'Mary Nakato', 50, 25, number: 'RMX-SHR-000002');
    await shareholder('peter', 'Peter Mugisha', 50, 25, number: 'RMX-SHR-000003');
    await db.collection('share_classes').doc('ordinary').set({
      'classId': 'ordinary', 'code': 'ORDINARY', 'name': 'Ordinary shares', 'valuePerShareUgx': 10000, 'active': true, 'issuedShares': 200,
    });
    await db.collection('share_register').doc('current').set({
      'totalShares': 200, 'shareholderCount': 3, 'statusCounts': {'active': 3}, 'totalCommittedUgx': 2000000, 'totalPaidUgx': 2000000,
      'outstandingUgx': 0, 'pendingApprovals': 1, 'holderCount': 3,
      'holders': [
        {'shareholderId': 'john', 'shareholderNumber': 'RMX-SHR-000001', 'shareholderName': 'John Okello', 'shares': 100, 'ownershipPercent': 50},
        {'shareholderId': 'mary', 'shareholderNumber': 'RMX-SHR-000002', 'shareholderName': 'Mary Nakato', 'shares': 50, 'ownershipPercent': 25},
        {'shareholderId': 'peter', 'shareholderNumber': 'RMX-SHR-000003', 'shareholderName': 'Peter Mugisha', 'shares': 50, 'ownershipPercent': 25},
      ],
    });
  }

  Future<void> pendingTransfer() => db.collection('share_transactions').doc('t1').set({
        'transactionId': 't1', 'transactionNumber': 'RMX-SHR-TXN-000004', 'type': 'shares_transferred', 'status': 'pending_approval',
        'classId': 'ordinary', 'classCode': 'ORDINARY', 'shares': 30, 'shareholderIds': ['john', 'mary'], 'requestedBy': 'other',
        'requestedByName': 'Officer', 'reason': 'Private sale', 'effectiveDate': Timestamp.fromDate(now), 'createdAt': Timestamp.fromDate(now),
        'lines': [
          {'shareholderId': 'john', 'shareholderNumber': 'RMX-SHR-000001', 'shareholderName': 'John Okello', 'deltaShares': -30},
          {'shareholderId': 'mary', 'shareholderNumber': 'RMX-SHR-000002', 'shareholderName': 'Mary Nakato', 'deltaShares': 30},
        ],
      });

  Future<void> approvedDividend() async {
    await db.collection('dividends').doc('d1').set({
      'dividendId': 'd1', 'dividendNumber': 'RMX-DIV-000001', 'financialPeriod': 'FY 2026', 'status': 'approved', 'calculationMethod': 'pool',
      'totalDistributableUgx': 2000000, 'dividendPerShareUgx': 10000, 'eligibleShares': 200, 'eligibleShareholderCount': 2, 'allocatedUgx': 2000000,
      'outstandingUgx': 2000000, 'paidUgx': 0, 'allocationCount': 2, 'payableCount': 2, 'calculatedAt': Timestamp.fromDate(now),
      'recordDate': Timestamp.fromDate(now), 'createdAt': Timestamp.fromDate(now),
    });
    for (final (id, name, shares) in [('a1', 'John Okello', 100), ('a2', 'Mary Nakato', 100)]) {
      await db.collection('dividend_allocations').doc(id).set({
        'allocationId': id, 'allocationNumber': 'RMX-DIV-PAY-00000${id.substring(1)}', 'dividendId': 'd1', 'dividendNumber': 'RMX-DIV-000001',
        'shareholderId': id, 'shareholderNumber': 'RMX-SHR-00000${id.substring(1)}', 'shareholderName': name, 'sharesAtRecordDate': shares,
        'ownershipPercentAtRecordDate': 50, 'grossUgx': shares * 10000, 'deductionsUgx': 0, 'netUgx': shares * 10000, 'paymentStatus': 'unpaid',
        'current': true, 'createdAt': Timestamp.fromDate(now),
      });
    }
    await db.collection('financial_accounts').doc('bank_1').set({
      'accountId': 'bank_1', 'name': 'Bank Account 1', 'type': 'bank', 'balanceUgx': 5000000, 'awaitingBankingUgx': 0, 'active': true,
    });
  }

  Future<void> pumpAt(WidgetTester tester, String location) async {
    await tester.binding.setSurfaceSize(const Size(430, 2400));
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
        workforceApiProvider.overrideWithValue(FakeWorkforceApi()),
        shareholdersApiProvider.overrideWithValue(api),
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

  group('shareholder dashboard and register', () {
    testWidgets('admin sees register figures and the server ownership distribution', (tester) async {
      await me('admin');
      await world();
      await pumpAt(tester, '/app/shareholders');
      expect(find.widgetWithText(Tab, 'Dashboard'), findsOneWidget);
      expect(find.widgetWithText(Tab, 'All shareholders'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('register-shareholders'))).data, '3');
      expect(tester.widget<Text>(find.byKey(const Key('register-total-shares'))).data, '200');
      expect(tester.widget<Text>(find.byKey(const Key('register-pending'))).data, '1');
      expect(tester.widget<Text>(find.byKey(const Key('holder-pct-john'))).data, '100 · 50%');
      expect(tester.widget<Text>(find.byKey(const Key('holder-pct-mary'))).data, '50 · 25%');
      await unmount(tester);
    });

    testWidgets('search lists shareholders; opening one shows ownership, contact and actions', (tester) async {
      await me('admin');
      await world();
      await pumpAt(tester, '/app/shareholders');
      await tester.tap(find.text('All shareholders'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('shareholder-john')), findsOneWidget);
      await enter(tester, 'shareholder-search', 'mary');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('shareholder-mary')), findsOneWidget);
      expect(find.byKey(const Key('shareholder-john')), findsNothing);
      await tester.tap(find.byKey(const Key('shareholder-mary')));
      await tester.pumpAndSettle();
      expect(location(tester), '/app/shareholders/mary');
      expect(tester.widget<Text>(find.byKey(const Key('detail-ownership'))).data, '25%');
      expect(find.byKey(const Key('issue-to-shareholder-button')), findsOneWidget);
      expect(find.byKey(const Key('shareholder-status-button')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('adding a shareholder sends the profile only; the number comes from the server', (tester) async {
      await me('admin');
      await pumpAt(tester, '/app/shareholders/new');
      await enter(tester, 'shareholder-name', 'Grace Atim');
      await enter(tester, 'shareholder-phone', '0772 555 111');
      await tapKey(tester, 'save-shareholder');
      expect(api.names, ['createShareholder']);
      final args = api.calls.single.$2;
      expect(args['fullName'], 'Grace Atim');
      expect(args.keys.any((k) => k.contains('Number') && k != 'phoneNumber' && k != 'idNumber'), isFalse);
      expect(location(tester), '/app/shareholders/sh-new');
      await unmount(tester);
    });

    testWidgets('a manager sees register reports but no profiles', (tester) async {
      await me('manager');
      await world();
      await pumpAt(tester, '/app/shareholders');
      expect(find.byKey(const Key('register-total-shares')), findsOneWidget);
      expect(find.text('All shareholders'), findsNothing);
      GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/shareholders/john');
      await tester.pumpAndSettle();
      expect(find.text('Not permitted'), findsOneWidget);
      expect(find.text('John Okello'), findsNothing);
      await unmount(tester);
    });

    for (final role in ['worker', 'cashier', 'shareholder']) {
      testWidgets('$role cannot open the register, shares or dividends', (tester) async {
        await me(role);
        await world();
        for (final path in ['/app/shareholders', '/app/shares', '/app/dividends']) {
          await pumpAt(tester, path);
          expect(location(tester), '/app', reason: '$role $path');
        }
        await unmount(tester);
      });
    }
  });

  group('share transactions', () {
    testWidgets('an approver approves a pending transfer after confirming', (tester) async {
      await me('admin');
      await world();
      await pendingTransfer();
      await pumpAt(tester, '/app/shares/txn/t1');
      expect(find.text('Pending approval'), findsOneWidget);
      await tapKey(tester, 'approve-share-txn');
      await tester.tap(find.text('Approve').last);
      await tester.pumpAndSettle();
      expect(api.names, ['decideShareTransaction']);
      expect(api.calls.single.$2['decision'], 'approve');
      await unmount(tester);
    });

    testWidgets('an auditor reads share transactions but cannot approve or reverse', (tester) async {
      await me('auditor');
      await world();
      await pendingTransfer();
      await pumpAt(tester, '/app/shares/txn/t1');
      expect(find.text('RMX-SHR-TXN-000004'), findsOneWidget);
      expect(find.byKey(const Key('approve-share-txn')), findsNothing);
      expect(find.byKey(const Key('reverse-share-txn')), findsNothing);
      await pumpAt(tester, '/app/shares');
      expect(find.byKey(const Key('new-share-transaction')), findsNothing);
      await unmount(tester);
    });

    testWidgets('issuing shows the server-style commitment preview and sends no totals', (tester) async {
      await me('admin');
      await world();
      await pumpAt(tester, '/app/shareholders/john');
      await tapKey(tester, 'issue-to-shareholder-button');
      await tester.tap(find.byKey(const Key('issue-class')));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('ORDINARY ·').last);
      await tester.pumpAndSettle();
      await enter(tester, 'issue-shares', '100');
      expect(tester.widget<Text>(find.byKey(const Key('issue-commitment'))).data, 'UGX 1,000,000');
      await tester.tap(find.byKey(const Key('payment-source')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(ContributionSource.priorRecord.label).last);
      await tester.pumpAndSettle();
      await enter(tester, 'payment-amount', '1,000,000');
      await enter(tester, 'issue-reason', 'Paid at incorporation, certificate 001');
      await tapKey(tester, 'submit-issue');
      expect(api.names, ['issueShares']);
      final args = api.calls.single.$2;
      expect(args['shares'], 100);
      expect((args['payment']! as Map)['source'], 'prior_record');
      expect(args.containsKey('contributionUgx') || args.containsKey('committedUgx') || args.containsKey('ownershipPercent'), isFalse);
      await unmount(tester);
    });

    testWidgets('offline: a share approval is not sent and a connection is required', (tester) async {
      await me('admin');
      await world();
      await pendingTransfer();
      connectivity.online = false;
      await pumpAt(tester, '/app/shares/txn/t1');
      await tapKey(tester, 'approve-share-txn');
      await tester.tap(find.text('Approve').last);
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      expect(find.textContaining('internet connection'), findsOneWidget);
      await unmount(tester);
    });
  });

  group('dividends', () {
    testWidgets('a payer selects unpaid allocations and pays them from a chosen account', (tester) async {
      await me('admin');
      await world();
      await approvedDividend();
      await pumpAt(tester, '/app/dividends/d1');
      expect(tester.widget<Text>(find.byKey(const Key('dividend-outstanding'))).data, const Money(2000000).format());
      await tapKey(tester, 'select-all-unpaid');
      await tapKey(tester, 'pay-dividend');
      await tester.tap(find.byKey(const Key('pay-from-account')));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Bank Account 1').last);
      await tester.pumpAndSettle();
      await tapKey(tester, 'confirm-pay-from');
      expect(api.names, ['payDividend']);
      expect(api.calls.single.$2['allocationIds'], unorderedEquals(['a1', 'a2']));
      expect(api.calls.single.$2['accountId'], 'bank_1');
      await unmount(tester);
    });

    testWidgets('an auditor sees allocations read-only', (tester) async {
      await me('auditor');
      await world();
      await approvedDividend();
      await pumpAt(tester, '/app/dividends/d1');
      expect(find.byKey(const Key('allocation-a1')), findsOneWidget);
      for (final k in ['select-all-unpaid', 'pay-dividend', 'approve-dividend', 'cancel-dividend', 'select-allocation-a1']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      await unmount(tester);
    });

    testWidgets('a manager sees dividend headers and totals, not individual allocations', (tester) async {
      await me('manager');
      await world();
      await approvedDividend();
      await pumpAt(tester, '/app/dividends/d1');
      expect(find.text('RMX-DIV-000001'), findsOneWidget);
      expect(find.byKey(const Key('allocation-a1')), findsNothing);
      expect(find.byKey(const Key('select-all-unpaid')), findsNothing);
      await unmount(tester);
    });

    testWidgets('creating a draft sends the approved pool only - never allocations', (tester) async {
      await me('admin');
      await pumpAt(tester, '/app/dividends');
      await tapKey(tester, 'new-dividend-button');
      await enter(tester, 'dividend-period', 'FY 2026');
      await enter(tester, 'dividend-pool', '10,000,000');
      await tapKey(tester, 'submit-dividend');
      expect(api.names, ['createDividend']);
      final args = api.calls.single.$2;
      expect([args['totalDistributableUgx'], args['calculationMethod']], [10000000, 'pool']);
      expect(args.keys.any((k) => k.contains('alloc')), isFalse);
      await unmount(tester);
    });
  });

  group('shareholder self-service', () {
    testWidgets('a shareholder sees only their own shareholding, from the server', (tester) async {
      await me('shareholder');
      api.mine = MyShareholding.fromMap({
        'linked': true,
        'shareholder': {'shareholderId': 'mary', 'shareholderNumber': 'RMX-SHR-000002', 'fullName': 'Mary Nakato', 'status': 'active',
          'totalShares': 60, 'ownershipPercent': 30, 'paidUgx': 500000},
        'dividends': [{'allocationNumber': 'RMX-DIV-PAY-000002', 'dividendNumber': 'RMX-DIV-000001', 'financialPeriod': 'FY 2026', 'netUgx': 3000000,
          'paymentStatus': 'paid', 'sharesAtRecordDate': 300}],
      });
      await pumpAt(tester, '/app/my-shares');
      expect(api.names, contains('myShareholding'));
      expect(tester.widget<Text>(find.byKey(const Key('my-ownership'))).data, '30%');
      expect(find.text('RMX-DIV-000001 · FY 2026'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('an unlinked shareholder is told so', (tester) async {
      await me('shareholder');
      await pumpAt(tester, '/app/my-shares');
      expect(find.text('No shareholding linked'), findsOneWidget);
      await unmount(tester);
    });
  });
}
