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

import '../support/fake_auth_repository.dart';
import '../support/fake_operations_api.dart';
import '../support/fake_phase4_apis.dart';
import '../support/fake_phase5_apis.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeFinanceApi financeApi;
  late FakeExpensesApi expensesApi;
  late FakeInventoryApi inventoryApi;
  late FakeConnectivityService connectivity;
  final now = DateTime.now();

  setUp(() {
    db = FakeFirebaseFirestore();
    financeApi = FakeFinanceApi();
    expensesApi = FakeExpensesApi();
    inventoryApi = FakeInventoryApi();
    connectivity = FakeConnectivityService();
  });

  Future<void> me(String role, {List<String> permissions = const []}) =>
      db.collection('users').doc('me').set(userDocData(role: role, fullName: 'Me $role', permissions: permissions));

  Future<void> accounts() async {
    Future<void> a(String id, String name, String type, int balance, {int waiting = 0}) => db.collection('financial_accounts').doc(id).set({
          'accountId': id, 'name': name, 'type': type, 'balanceUgx': balance, 'awaitingBankingUgx': waiting, 'active': true,
          'isDefault': true, 'openingBalanceRecorded': true,
        });
    await a('cash_at_hand', 'Cash at Hand', 'cash', 1250000, waiting: 900000);
    await a('mtn_merchant', 'MTN Merchant', 'mobile_money', 850000);
    await a('airtel_merchant', 'Airtel Merchant', 'mobile_money', 420000);
    await a('bank_1', 'Bank Account 1', 'bank', 3500000);
    await db.collection('finance_daily_summaries').doc(EastAfricaTime.businessDayKey(now)).set({
      'day': EastAfricaTime.businessDayKey(now), 'customerPaymentsUgx': 300000, 'expensesPaidUgx': 150000, 'transfersUgx': 400000,
      'reversals': {'customer_paymentUgx': 50000},
    });
  }

  Future<void> txn(String id, {String type = 'account_transfer', String status = 'posted'}) =>
      db.collection('financial_transactions').doc(id).set({
        'transactionNumber': 'RMX-TXN-00000${id.length}', 'type': type, 'amountUgx': 400000, 'status': status,
        'sourceAccountId': 'cash_at_hand', 'sourceAccountName': 'Cash at Hand', 'destinationAccountId': 'bank_1',
        'destinationAccountName': 'Bank Account 1', 'accountIds': ['cash_at_hand', 'bank_1'],
        'entries': [
          {'accountId': 'cash_at_hand', 'accountName': 'Cash at Hand', 'deltaUgx': -400000, 'balanceAfterUgx': 850000},
          {'accountId': 'bank_1', 'accountName': 'Bank Account 1', 'deltaUgx': 400000, 'balanceAfterUgx': 3900000},
        ],
        'createdAt': Timestamp.fromDate(now),
      });

  Future<void> expense(String id, String status, {bool reviewed = false, String createdBy = 'someone'}) =>
      db.collection('expenses').doc(id).set({
        'expenseNumber': 'RMX-EXP-000001', 'categoryId': 'utilities', 'categoryName': 'Utilities', 'description': 'Office electricity',
        'amountUgx': 150000, 'status': status, 'createdBy': createdBy, 'payee': 'UMEME',
        if (reviewed) 'reviewedAt': Timestamp.fromDate(now),
        'createdAt': Timestamp.fromDate(now), 'expenseDate': Timestamp.fromDate(now),
      });

  Future<void> item(String id, {int quantity = 24, String name = 'Car Shampoo'}) => db.collection('inventory_items').doc(id).set({
        'itemId': id, 'sku': 'RMX-CHEM-001', 'name': name, 'category': 'chemicals', 'unit': 'bottle', 'quantity': quantity,
        'minimumStock': 5, 'reorderLevel': 10, 'active': true,
        'stockStatus': quantity == 0 ? 'out_of_stock' : quantity <= 10 ? 'low' : 'ok',
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
        jobsApiProvider.overrideWithValue(FakeJobsApi()),
        billingApiProvider.overrideWithValue(FakeBillingApi()),
        financeApiProvider.overrideWithValue(financeApi),
        expensesApiProvider.overrideWithValue(expensesApi),
        inventoryApiProvider.overrideWithValue(inventoryApi),
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

  Future<void> choose(WidgetTester tester, String dropdownKey, String text) async {
    await tapKey(tester, dropdownKey);
    await tester.tap(find.text(text).last);
    await tester.pumpAndSettle();
  }

  Future<void> enter(WidgetTester tester, String key, String text) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.enterText(f, text);
    await tester.pumpAndSettle();
  }

  bool enabled(WidgetTester tester, String key) => tester.widget<ButtonStyleButton>(find.byKey(Key(key))).onPressed != null;

  group('finance', () {
    testWidgets('dashboard: server balances, total funds, cash awaiting banking and today (transfers are not income)', (tester) async {
      await me('manager');
      await accounts();
      await txn('t1');
      await pumpAt(tester, '/app/finance');
      expect(find.byKey(const Key('balance-cash_at_hand')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('balance-cash_at_hand'))).data, 'UGX 1,250,000');
      expect(tester.widget<Text>(find.byKey(const Key('total-funds'))).data, 'UGX 6,020,000');
      expect(tester.widget<Text>(find.byKey(const Key('awaiting-banking-amount'))).data, 'UGX 900,000');
      expect(tester.widget<Text>(find.byKey(const Key('today-income'))).data, 'UGX 250,000');
      expect(tester.widget<Text>(find.byKey(const Key('today-transfers'))).data, 'UGX 400,000');
      expect(find.byKey(const Key('txn-t1')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('transfer: over-balance is blocked on the phone; a valid one is sent once with a request ID', (tester) async {
      await me('manager');
      await accounts();
      await pumpAt(tester, '/app/finance/transfers');
      await tapKey(tester, 'new-transfer-button');
      await choose(tester, 'transfer-from', 'Cash at Hand · UGX 1,250,000');
      await choose(tester, 'transfer-to', 'Bank Account 1 · UGX 3,500,000');
      await enter(tester, 'transfer-amount', '2,000,000');
      await enter(tester, 'transfer-reason', 'Weekly banking');
      expect(find.textContaining('has only UGX 1,250,000'), findsOneWidget);
      expect(enabled(tester, 'submit-transfer'), isFalse);
      await enter(tester, 'transfer-amount', '400,000');
      expect(enabled(tester, 'submit-transfer'), isTrue);
      await tapKey(tester, 'submit-transfer');
      final (name, args) = financeApi.calls.single;
      expect(name, 'transfer');
      expect([args['from'], args['to'], args['amount'], args['reason']], ['cash_at_hand', 'bank_1', 400000, 'Weekly banking']);
      expect((args['requestId']! as String).length, 24);
      await unmount(tester);
    });

    testWidgets('reconciliation shows the live difference (actual − system) and never adjusts by itself', (tester) async {
      await me('manager');
      await accounts();
      await pumpAt(tester, '/app/finance/accounts/cash_at_hand');
      await tapKey(tester, 'reconcile-button');
      await enter(tester, 'reconcile-actual', '1,249,500');
      expect(tester.widget<Text>(find.byKey(const Key('reconcile-difference'))).data, 'UGX -500');
      await tapKey(tester, 'submit-reconciliation');
      final (name, args) = financeApi.calls.single;
      expect([name, args['accountId'], args['actual']], ['reconcile', 'cash_at_hand', 1249500]);
      expect(financeApi.calls.where((c) => c.$1 == 'adjust'), isEmpty);
      await unmount(tester);
    });

    testWidgets('offline: a transfer is not sent and the person is told a connection is needed', (tester) async {
      await me('manager');
      await accounts();
      connectivity.online = false;
      await pumpAt(tester, '/app/finance/transfers');
      await tapKey(tester, 'new-transfer-button');
      await choose(tester, 'transfer-from', 'Cash at Hand · UGX 1,250,000');
      await choose(tester, 'transfer-to', 'Bank Account 1 · UGX 3,500,000');
      await enter(tester, 'transfer-amount', '1000');
      await enter(tester, 'transfer-reason', 'Weekly banking');
      await tapKey(tester, 'submit-transfer');
      expect(financeApi.calls, isEmpty);
      expect(find.textContaining('internet connection'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('cashiers and workers cannot open Finance; the menu does not offer it', (tester) async {
      for (final role in ['cashier', 'worker']) {
        await me(role);
        await accounts();
        await pumpAt(tester, '/app/finance');
        expect(location(tester), '/app', reason: role);
        await pumpAt(tester, '/app/finance/transactions');
        expect(location(tester), '/app', reason: role);
        expect(find.text('Finance'), findsNothing);
        await unmount(tester);
      }
    });

    testWidgets('auditor: reads the ledger, but has no transfer, reverse or adjust actions', (tester) async {
      await me('auditor');
      await accounts();
      await txn('t1');
      await pumpAt(tester, '/app/finance/transactions');
      expect(find.byKey(const Key('txn-t1')), findsOneWidget);
      await tapKey(tester, 'txn-t1');
      expect(find.text('Account movements'), findsOneWidget);
      expect(find.byKey(const Key('reverse-transaction-button')), findsNothing);
      await pumpAt(tester, '/app/finance/transfers');
      expect(find.byKey(const Key('new-transfer-button')), findsNothing);
      await pumpAt(tester, '/app/finance/banking');
      expect(find.byKey(const Key('new-deposit-button')), findsNothing);
      await unmount(tester);
    });

    testWidgets('admin reverses a transfer only with a reason', (tester) async {
      await me('admin');
      await accounts();
      await txn('t1');
      await pumpAt(tester, '/app/finance/transactions/t1');
      await tapKey(tester, 'reverse-transaction-button');
      await tester.tap(find.byKey(const Key('confirm-button')));
      await tester.pumpAndSettle();
      expect(financeApi.calls, isEmpty);
      await tester.enterText(find.byKey(const Key('reason-field')), 'Posted to the wrong bank');
      await tester.tap(find.byKey(const Key('confirm-button')));
      await tester.pumpAndSettle();
      expect(financeApi.calls.single.$2, {'transactionId': 't1', 'reason': 'Posted to the wrong bank'});
      await unmount(tester);
    });
  });

  group('expenses', () {
    testWidgets('a cashier records an expense for approval (no money moves)', (tester) async {
      await me('cashier');
      await pumpAt(tester, '/app/expenses/new');
      await choose(tester, 'expense-category', 'Utilities');
      await enter(tester, 'expense-description', 'Office electricity');
      await enter(tester, 'expense-amount', '150,000');
      await tapKey(tester, 'submit-expense');
      final (name, args) = expensesApi.calls.single;
      expect(name, 'create');
      expect([args['categoryId'], args['amountUgx'], args['submit']], ['utilities', 150000, true]);
      expect((args['requestId']! as String).length, 24);
      await unmount(tester);
    });

    testWidgets('cashier sees no review, approve or pay actions', (tester) async {
      await me('cashier');
      await expense('e1', 'pending_review', reviewed: true);
      await pumpAt(tester, '/app/expenses/e1');
      expect(find.text('Office electricity'), findsWidgets);
      for (final key in ['expense-action-review', 'expense-action-approve', 'expense-action-reject', 'pay-expense-button']) {
        expect(find.byKey(Key(key)), findsNothing, reason: key);
      }
      await unmount(tester);
    });

    testWidgets('manager: an unreviewed expense is reviewed before it can be approved or paid', (tester) async {
      await me('manager');
      await accounts();
      await expense('e1', 'pending_review');
      await pumpAt(tester, '/app/expenses/e1');
      expect(find.byKey(const Key('expense-action-approve')), findsNothing, reason: 'not reviewed yet');
      expect(find.byKey(const Key('pay-expense-button')), findsNothing);
      await tapKey(tester, 'expense-action-review');
      await tester.tap(find.byKey(const Key('confirm-button')));
      await tester.pumpAndSettle();
      expect(expensesApi.calls.single.$2['action'], 'review');
      await unmount(tester);
    });

    testWidgets('manager pays an approved expense from the account they choose', (tester) async {
      await me('manager');
      await accounts();
      await expense('e2', 'approved', reviewed: true);
      await pumpAt(tester, '/app/expenses/e2');
      await tapKey(tester, 'pay-expense-button');
      await choose(tester, 'pay-from-account', 'Cash at Hand · UGX 1,250,000');
      await tapKey(tester, 'confirm-pay-from');
      final pay = expensesApi.calls.last;
      expect([pay.$1, pay.$2['expenseId'], pay.$2['accountId']], ['pay', 'e2', 'cash_at_hand']);
      await unmount(tester);
    });

    testWidgets('the pending-approval tab lists only submitted expenses', (tester) async {
      await me('manager');
      await expense('e1', 'pending_review');
      await expense('e2', 'draft');
      await pumpAt(tester, '/app/expenses');
      await tester.tap(find.widgetWithText(Tab, 'Pending approval'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('expense-e1')), findsOneWidget);
      expect(find.byKey(const Key('expense-e2')), findsNothing);
      await unmount(tester);
    });
  });

  group('inventory', () {
    testWidgets('usage above the stock on hand is blocked; a valid usage is sent with a request ID', (tester) async {
      await me('manager');
      await item('i1');
      await pumpAt(tester, '/app/inventory/items/i1');
      expect(find.text('24 bottles'), findsOneWidget);
      await tapKey(tester, 'record-usage-button');
      await enter(tester, 'movement-quantity', '30');
      await enter(tester, 'movement-reason', 'Wash bay 1');
      expect(find.textContaining('Only 24 bottles available'), findsOneWidget);
      expect(enabled(tester, 'submit-movement'), isFalse);
      await enter(tester, 'movement-quantity', '2');
      await tapKey(tester, 'submit-movement');
      final (name, args) = inventoryApi.calls.single;
      expect([name, args['itemId'], args['type'], args['quantity'], args['reason']], ['recordMovement', 'i1', 'usage', 2, 'Wash bay 1']);
      await unmount(tester);
    });

    testWidgets('a count adjustment shows the difference and never overwrites the quantity', (tester) async {
      await me('manager');
      await item('i1', quantity: 20);
      await pumpAt(tester, '/app/inventory/items/i1');
      await tapKey(tester, 'adjust-stock-button');
      await enter(tester, 'count-quantity', '18');
      expect(find.text('Difference: -2'), findsOneWidget);
      await enter(tester, 'count-reason', 'Physical count discrepancy');
      await tapKey(tester, 'submit-adjustment');
      expect(inventoryApi.calls.single.$2, {'itemId': 'i1', 'counted': 18, 'reason': 'Physical count discrepancy'});
      await unmount(tester);
    });

    testWidgets('low-stock tab lists low and out-of-stock items only', (tester) async {
      await me('manager');
      await item('ok', quantity: 24, name: 'Plenty');
      await item('low', quantity: 3, name: 'Running low');
      await item('out', quantity: 0, name: 'All gone');
      await pumpAt(tester, '/app/inventory');
      await tester.tap(find.widgetWithText(Tab, 'Low stock'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('item-low')), findsOneWidget);
      expect(find.byKey(const Key('item-out')), findsOneWidget);
      expect(find.byKey(const Key('item-ok')), findsNothing);
      await unmount(tester);
    });

    testWidgets('auditor reads inventory without stock actions; workers cannot open it', (tester) async {
      await me('auditor');
      await item('i1');
      await pumpAt(tester, '/app/inventory/items/i1');
      for (final key in ['record-usage-button', 'record-stock-in-button', 'adjust-stock-button']) {
        expect(find.byKey(Key(key)), findsNothing, reason: key);
      }
      await me('worker');
      await pumpAt(tester, '/app/inventory');
      expect(location(tester), '/app');
      await unmount(tester);
    });
  });

  group('dashboard', () {
    testWidgets('managers see funds, cash awaiting banking and low stock; cashiers see no balances', (tester) async {
      await me('manager');
      await accounts();
      await item('low', quantity: 3);
      await pumpAt(tester, '/app');
      expect(find.byKey(const Key('stat-total-funds')), findsOneWidget);
      expect(find.byKey(const Key('stat-awaiting-banking')), findsOneWidget);
      expect(find.byKey(const Key('stat-low-stock')), findsOneWidget);
      await unmount(tester);

      await me('cashier');
      await pumpAt(tester, '/app');
      expect(find.byKey(const Key('stat-total-funds')), findsNothing);
      expect(find.byKey(const Key('stat-awaiting-banking')), findsNothing);
      expect(find.byKey(const Key('stat-today-payments')), findsOneWidget, reason: 'Phase 4 figure kept');
      await unmount(tester);
    });
  });
}
