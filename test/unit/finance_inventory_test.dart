import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/billing/data/billing_api.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/features/expenses/data/expenses_api.dart';
import 'package:ramosmax_auto_manager/features/finance/application/finance_providers.dart';
import 'package:ramosmax_auto_manager/features/inventory/application/inventory_providers.dart';
import 'package:ramosmax_auto_manager/models/expense.dart';
import 'package:ramosmax_auto_manager/models/finance.dart';
import 'package:ramosmax_auto_manager/models/inventory.dart';
import 'package:ramosmax_auto_manager/models/payment.dart';
import 'package:ramosmax_auto_manager/routes/app_routes.dart';

import '../support/fixtures.dart';

void main() {
  final now = DateTime.utc(2026, 9, 21, 9);

  group('financial accounts', () {
    FinancialAccount acct(String id, String type, int balance, {bool active = true, int waiting = 0}) =>
        FinancialAccount.fromFirestore(id, {'name': id, 'type': type, 'balanceUgx': balance, 'active': active, 'awaitingBankingUgx': waiting});

    test('parses server fields; unknown values fail safe', () {
      final a = FinancialAccount.fromFirestore('cash_at_hand', {
        'name': 'Cash at Hand', 'type': 'cash', 'balanceUgx': 1250000, 'awaitingBankingUgx': 400000, 'active': true,
        'openingBalanceRecorded': true, 'openingBalanceUgx': 100000, 'lastTransactionAt': Timestamp.fromDate(now),
      });
      expect([a.balance, a.awaitingBanking, a.type, a.isPermanent], [const Money(1250000), const Money(400000), AccountType.cash, true]);
      expect(FinancialAccount.fromFirestore('x', {'active': 'yes'}).active, isFalse);
    });

    test('the four defaults always appear, in a stable order, as placeholders until created', () {
      final list = FinancialAccount.withDefaults([acct('centenary', 'bank', 5), acct('mtn_merchant', 'mobile_money', 850000)]);
      expect(list.map((a) => a.accountId), ['cash_at_hand', 'mtn_merchant', 'airtel_merchant', 'bank_1', 'centenary']);
      expect(list.first.exists, isFalse);
      expect(list.first.balance, Money.zero);
      expect(list[1].exists, isTrue);
    });

    test('total funds = sum of active balances; awaiting banking is part of cash, not extra', () {
      final s = FundsSummary.of([
        acct('cash_at_hand', 'cash', 1250000, waiting: 900000),
        acct('mtn_merchant', 'mobile_money', 850000),
        acct('airtel_merchant', 'mobile_money', 420000),
        acct('bank_1', 'bank', 3500000),
        acct('old', 'bank', 0, active: false),
      ]);
      expect(s.total, const Money(6020000));
      expect(s.awaitingBanking, const Money(900000));
      expect(s.byType[AccountType.mobileMoney], const Money(1270000));
    });
  });

  group('ledger entries and daily summaries', () {
    test('transaction: signed movements per account; only customer payments are revenue; reversible types', () {
      final t = FinancialTransaction.fromFirestore('t1', {
        'transactionNumber': 'RMX-TXN-000007', 'type': 'account_transfer', 'amountUgx': 400000, 'status': 'posted',
        'entries': [
          {'accountId': 'cash_at_hand', 'accountName': 'Cash at Hand', 'deltaUgx': -400000, 'balanceAfterUgx': 600000},
          {'accountId': 'bank_1', 'accountName': 'Bank Account 1', 'deltaUgx': 400000, 'balanceAfterUgx': 400000},
        ],
      });
      expect(t.deltaFor('cash_at_hand'), const Money(-400000));
      expect(t.deltaFor('bank_1'), const Money(400000));
      expect(t.deltaFor('mtn_merchant'), Money.zero);
      expect(t.isRevenue, isFalse);
      expect(t.canReverse, isTrue);
      expect(FinancialTransaction.fromFirestore('p', {'type': 'customer_payment'}).isRevenue, isTrue);
      expect(FinancialTransaction.fromFirestore('p', {'type': 'customer_payment'}).canReverse, isFalse, reason: 'reversed from the invoice');
      expect(FinancialTransaction.fromFirestore('r', {'type': 'reversal', 'reversalOfType': 'bank_deposit'}).label, 'Reversal of bank deposit');
      expect(FinancialTransaction.fromFirestore('x', {'type': 'account_transfer', 'status': 'reversed'}).canReverse, isFalse);
    });

    test('daily summary: net figures subtract same-day reversals; transfers are never income; periods combine', () {
      final d = DailyFinanceSummary.fromFirestore('2026-09-21', {
        'customerPaymentsUgx': 500000, 'expensesPaidUgx': 150000, 'transfersUgx': 100000, 'depositsUgx': 300000,
        'reversals': {'customer_paymentUgx': 20000, 'bank_depositUgx': 50000},
        'expensesByCategory': {'utilities': 150000},
      });
      expect(d.netIncome, const Money(480000));
      expect(d.netExpenses, const Money(150000));
      expect(d.netTransfers, const Money(350000));
      final both = DailyFinanceSummary.combine('week', [d, DailyFinanceSummary.fromFirestore('2026-09-22', {'customerPaymentsUgx': 20000, 'expensesByCategory': {'utilities': 5000, 'office': 1}})]);
      expect(both.netIncome, const Money(500000));
      expect(both.expensesByCategory['utilities'], const Money(155000));
      expect(both.expensesByCategory['office'], const Money(1));
    });

    test('reconciliation difference = actual − system', () {
      expect(Reconciliation.differenceOf(const Money(100500), const Money(100000)), const Money(500));
      expect(Reconciliation.differenceOf(const Money(98000), const Money(100000)), const Money(-2000));
      expect(Reconciliation.differenceOf(const Money(5), const Money(5)), Money.zero);
      final r = Reconciliation.fromFirestore('r', {'status': 'discrepancy', 'differenceUgx': -2000});
      expect([r.status, r.difference], [ReconciliationStatus.discrepancy, const Money(-2000)]);
    });

    test('finance periods are EAT business days / months', () {
      final (from, to) = FinancePeriod.today.bounds(now);
      expect(from, DateTime.utc(2026, 9, 20, 21));
      expect(to, DateTime.utc(2026, 9, 21, 21));
      final (mFrom, mTo) = FinancePeriod.lastMonth.bounds(now);
      expect([mFrom, mTo], [DateTime.utc(2026, 7, 31, 21), DateTime.utc(2026, 8, 31, 21)]);
    });

    test('bank payment choices come from settings/payment_accounts and carry no balances', () {
      final list = PaymentAccountOption.listFrom({
        'banks': [
          {'accountId': 'bank_1', 'name': 'Stanbic', 'accountNumberMasked': '••1234', 'balanceUgx': 999},
          {'name': 'broken'},
        ],
      });
      expect(list.single.label, 'Stanbic ••1234');
      expect(PaymentAccountOption.listFrom(null), isEmpty);
    });

    test('a bank payment names its account only when one was chosen', () {
      const base = PaymentRequest(invoiceId: 'i', amount: Money(5000), method: PaymentMethod.bank, requestId: 'r123456789', reference: 'EFT');
      expect(base.toJson().containsKey('accountId'), isFalse);
      const chosen = PaymentRequest(invoiceId: 'i', amount: Money(5000), method: PaymentMethod.bank, requestId: 'r123456789', reference: 'EFT', accountId: 'b2');
      expect(chosen.toJson()['accountId'], 'b2');
    });
  });

  group('expenses', () {
    Expense e(String status, {bool reviewed = false}) => Expense.fromFirestore('e1', {
          'expenseNumber': 'RMX-EXP-000001', 'categoryId': 'utilities', 'description': 'Power', 'amountUgx': 150000,
          'status': status, 'createdBy': 'u1', if (reviewed) 'reviewedAt': Timestamp.fromDate(now),
        });

    test('workflow actions follow create → review → approve → pay', () {
      expect(e('draft').availableActions, {ExpenseAction.submit, ExpenseAction.cancel});
      expect(e('pending_review').availableActions, {ExpenseAction.review, ExpenseAction.reject, ExpenseAction.cancel});
      expect(e('pending_review', reviewed: true).availableActions, {ExpenseAction.approve, ExpenseAction.reject, ExpenseAction.cancel});
      expect(e('approved').availableActions, {ExpenseAction.cancel});
      expect(e('approved').canPay, isTrue);
      expect(e('pending_review', reviewed: true).canPay, isFalse);
      expect(e('paid').availableActions, isEmpty);
      expect(e('pending_review', reviewed: true).canEdit, isFalse);
      expect(e('draft').canEdit, isTrue);
      expect(ExpenseAction.reject.needsReason && ExpenseAction.cancel.needsReason, isTrue);
    });

    test('categories: built-ins first (with stored edits), then custom ones; category names resolve', () {
      final merged = ExpenseCategory.merge([
        ExpenseCategory.fromFirestore('marketing', {'name': 'Marketing', 'active': false}),
        ExpenseCategory.fromFirestore('security_services', {'name': 'Security Services', 'active': true}),
      ]);
      expect(merged.length, 11);
      expect(merged.first.categoryId, 'utilities');
      expect(merged.firstWhere((c) => c.categoryId == 'marketing').active, isFalse);
      expect(merged.last.name, 'Security Services');
      expect(ExpenseCategory.nameOf('financial_charges', const []), 'Financial Charges');
    });

    test('totals exclude rejected and cancelled expenses from the live total', () {
      final t = ExpenseTotals.of([e('paid'), e('approved'), e('rejected'), e('cancelled')]);
      expect(t.total, const Money(300000));
      expect(t.count, 2);
      expect(t.byStatus[ExpenseStatus.rejected], const Money(150000));
    });

    test('recurring: days until due; drafts serialise only what the person entered', () {
      final r = RecurringExpense.fromFirestore('r1', {'name': 'Rent', 'frequency': 'quarterly', 'active': true,
        'nextDueDate': Timestamp.fromDate(now.add(const Duration(days: 4, hours: 2))), 'expectedAmountUgx': 800000});
      expect(r.frequency, ExpenseFrequency.quarterly);
      expect(r.daysUntilDue(now), 4);
      final json = ExpenseDraft(categoryId: 'utilities', description: 'Power', amount: const Money(150000), expenseDate: now).toJson();
      expect(json['amountUgx'], 150000);
      expect(json.keys, isNot(contains('status')));
      expect(json.keys, isNot(contains('attachmentPath')));
    });
  });

  group('inventory', () {
    test('stock status: OK, LOW at or below the higher of minimum/reorder, OUT_OF_STOCK at zero', () {
      expect(StockStatus.of(11, 5, 10), StockStatus.ok);
      expect(StockStatus.of(10, 5, 10), StockStatus.low);
      expect(StockStatus.of(6, 8, 0), StockStatus.low);
      expect(StockStatus.of(0, 5, 10), StockStatus.outOfStock);
    });

    test('item parsing, units and indicative value', () {
      final i = InventoryItem.fromFirestore('i1', {
        'sku': 'RMX-CHEM-001', 'name': 'Car Shampoo', 'category': 'chemicals', 'unit': 'bottle', 'quantity': 24,
        'minimumStock': 5, 'reorderLevel': 10, 'active': true, 'lastUnitCostUgx': 15000,
      });
      expect([i.stockStatus, i.unit.quantity(24), i.unit.quantity(1), InventoryUnit.kg.quantity(3)], [StockStatus.ok, '24 bottles', '1 bottle', '3 kg']);
      expect(InventoryUnit.box.quantity(2), '2 boxes');
      expect(i.indicativeValue, const Money(360000));
      expect(itemMatches(i, 'chem'), isTrue);
      expect(itemMatches(i, 'shamp'), isTrue);
      expect(itemMatches(i, 'wax'), isFalse);
    });

    test('stock summary counts low/out and leaves uncosted items out of the value', () {
      InventoryItem item(int q, {int? cost, bool active = true}) => InventoryItem.fromFirestore('x$q$cost', {
            'name': 'x', 'quantity': q, 'minimumStock': 2, 'reorderLevel': 5, 'active': active, 'lastUnitCostUgx': ?cost,
          });
      final s = StockSummary.of([item(10, cost: 100), item(3, cost: 50), item(0), item(7), item(9, cost: 1, active: false)]);
      expect([s.activeItems, s.low, s.outOfStock, s.itemsWithoutCost], [4, 1, 1, 1]);
      expect(s.indicativeValue, const Money(1150));
    });

    test('movements: purchase stock-ins and reversals are not reversible from the item screen', () {
      expect(StockMovement.fromFirestore('m', {'type': 'usage', 'quantityChange': -2}).canReverse, isTrue);
      expect(StockMovement.fromFirestore('m', {'type': 'stock_in', 'purchaseId': 'p1'}).canReverse, isFalse);
      expect(StockMovement.fromFirestore('m', {'type': 'reversal'}).canReverse, isFalse);
      expect(StockMovement.fromFirestore('m', {'type': 'usage', 'status': 'reversed'}).canReverse, isFalse);
      expect(StockMovement.fromFirestore('m', {'type': 'stock_out', 'reasonCode': 'expired'}).reasonCode, StockOutReason.expired);
    });

    test('purchase state and totals', () {
      final p = InventoryPurchase.fromFirestore('p', {
        'status': 'approved', 'paymentStatus': 'unpaid', 'totalUgx': 150000,
        'items': [{'itemId': 'i1', 'name': 'Car Shampoo', 'quantity': 10, 'unitCostUgx': 15000}],
      });
      expect([p.canReceive, p.canPay, p.canCancel, p.canApprove], [true, true, true, false]);
      expect(p.lines.single.total, const Money(150000));
      final received = InventoryPurchase.fromFirestore('p', {'status': 'received', 'paymentStatus': 'paid'});
      expect([received.canReceive, received.canPay, received.canCancel], [false, false, false]);
    });
  });

  group('Phase 5 permissions and navigation', () {
    bool can(UserRole r, Permission p) => testUser(role: r).can(p, now);

    test('workers hold no financial or inventory authority; cashiers record expenses but never approve or pay', () {
      for (final p in Permission.values.where((p) => p.group == PermissionGroup.finance || p.group == PermissionGroup.expenses || p.group == PermissionGroup.inventory)) {
        expect(can(UserRole.worker, p), isFalse, reason: p.key);
      }
      expect(can(UserRole.cashier, Permission.expensesCreate), isTrue);
      for (final p in [Permission.financeView, Permission.expensesReview, Permission.expensesApprove, Permission.expensesPay, Permission.financeTransfer]) {
        expect(can(UserRole.cashier, p), isFalse, reason: p.key);
      }
    });

    test('only admins manage accounts, adjust balances or reverse spending by default', () {
      for (final p in [Permission.financeAccountsManage, Permission.financeAdjust, Permission.expensesAdjust]) {
        for (final r in UserRole.values) {
          expect(can(r, p), r == UserRole.admin, reason: '${r.key} ${p.key}');
        }
      }
    });

    test('auditors read finance, the ledger, expenses and inventory - and nothing is writable', () {
      for (final p in [Permission.financeView, Permission.financeTransactionsView, Permission.expensesView, Permission.inventoryView, Permission.inventoryReportsView]) {
        expect(can(UserRole.auditor, p), isTrue, reason: p.key);
      }
      expect(RolePermissions.forRole(UserRole.auditor).every((p) => p.isReadOnly), isTrue);
    });

    test('menus: managers and auditors get Finance and Inventory; cashiers get Expenses but not Finance', () {
      final mgr = RoleNavigation.modulesFor(testUser(role: UserRole.manager), now);
      expect(mgr, containsAll([AppModule.finance, AppModule.expenses, AppModule.inventory]));
      final aud = RoleNavigation.modulesFor(testUser(role: UserRole.auditor), now);
      expect(aud, containsAll([AppModule.finance, AppModule.transactions, AppModule.inventory, AppModule.reconciliation]));
      final cash = RoleNavigation.modulesFor(testUser(role: UserRole.cashier), now);
      expect(cash, contains(AppModule.expenses));
      expect(cash, isNot(contains(AppModule.finance)));
      expect(cash, isNot(contains(AppModule.reconciliation)));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.shareholder), now), contains(AppModule.financialSummary));
      for (final m in [AppModule.finance, AppModule.expenses, AppModule.inventory, AppModule.transactions]) {
        expect(m.available, isTrue, reason: m.key);
      }
    });

    test('Phase 5 sub-routes are guarded by their module', () {
      expect(AppRoutes.moduleForLocation(AppRoutes.financeTransaction('t1')), AppModule.finance);
      expect(AppRoutes.moduleForLocation(AppRoutes.expenseDetail('e1')), AppModule.expenses);
      expect(AppRoutes.moduleForLocation(AppRoutes.purchaseDetail('p1')), AppModule.inventory);
    });
  });

  group('catalogue sync with the Cloud Functions', () {
    final catalog = jsonDecode(File('functions/src/access_catalog.json').readAsStringSync()) as Map<String, dynamic>;
    test('expense categories, inventory categories and units match', () {
      expect((catalog['expenseCategories'] as List).cast<String>(), ExpenseCategory.defaults.keys.toList());
      expect((catalog['inventoryCategories'] as List).cast<String>(), InventoryCategory.values.map((c) => c.key).toList());
      expect((catalog['inventoryUnits'] as List).cast<String>(), InventoryUnit.values.map((u) => u.key).toList());
    });
  });
}
