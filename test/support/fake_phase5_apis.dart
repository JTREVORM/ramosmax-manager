import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/expenses/data/expenses_api.dart';
import 'package:ramosmax_auto_manager/features/finance/data/finance_api.dart';
import 'package:ramosmax_auto_manager/features/inventory/data/inventory_api.dart';
import 'package:ramosmax_auto_manager/models/expense.dart';
import 'package:ramosmax_auto_manager/models/finance.dart';
import 'package:ramosmax_auto_manager/models/inventory.dart';

/// Records calls instead of calling Cloud Functions. Server behaviour is
/// tested against the emulator in functions/test/{finance,expenses,inventory}.test.js.
class _Recorder {
  final List<(String, Map<String, Object?>)> calls = [];
  AppFailure? nextFailure;

  Result<T> respond<T>(String name, Map<String, Object?> args, T value) {
    calls.add((name, args));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(value);
  }
}

const _posted = PostingOutcome(transactionId: 't-new', transactionNumber: 'RMX-TXN-000099', difference: Money.zero);

class FakeFinanceApi extends _Recorder implements FinanceApi {
  @override
  Future<Result<void>> ensureDefaultAccounts() async => respond<void>('ensureDefaultAccounts', {}, null);

  @override
  Future<Result<String>> createAccount({
    required String name,
    required AccountType type,
    String? provider,
    String? accountNumber,
    String? notes,
    Money? openingBalance,
  }) async =>
      respond('createAccount', {'name': name, 'type': type.key, 'openingBalance': openingBalance?.ugx}, 'acc-new');

  @override
  Future<Result<void>> updateAccount(String accountId,
          {String? name, String? provider, String? accountNumber, String? notes, bool? active, String? reason}) async =>
      respond<void>('updateAccount', {'accountId': accountId, 'active': active, 'reason': reason}, null);

  @override
  Future<Result<PostingOutcome>> recordOpeningBalance(String accountId, Money amount, {String? reason}) async =>
      respond('recordOpeningBalance', {'accountId': accountId, 'amount': amount.ugx}, _posted);

  @override
  Future<Result<PostingOutcome>> transfer({
    required String fromAccountId,
    required String toAccountId,
    required Money amount,
    required String reason,
    required String requestId,
    DateTime? date,
    String? reference,
    String? description,
  }) async =>
      respond('transfer', {'from': fromAccountId, 'to': toAccountId, 'amount': amount.ugx, 'reason': reason, 'requestId': requestId}, _posted);

  @override
  Future<Result<PostingOutcome>> deposit({
    required String sourceAccountId,
    required String bankAccountId,
    required Money amount,
    required String bankReference,
    required String requestId,
    DateTime? date,
    String? description,
    String? attachmentPath,
  }) async =>
      respond('deposit', {'from': sourceAccountId, 'bank': bankAccountId, 'amount': amount.ugx, 'slip': bankReference, 'requestId': requestId}, _posted);

  @override
  Future<Result<PostingOutcome>> reconcile({
    required String accountId,
    required Money actualBalance,
    required String requestId,
    DateTime? date,
    String? notes,
    String? attachmentPath,
  }) async =>
      respond('reconcile', {'accountId': accountId, 'actual': actualBalance.ugx, 'requestId': requestId}, _posted);

  @override
  Future<Result<PostingOutcome>> adjust({
    required String accountId,
    required bool increase,
    required Money amount,
    required String reason,
    required String requestId,
    String? reconciliationId,
  }) async =>
      respond('adjust', {'accountId': accountId, 'increase': increase, 'amount': amount.ugx, 'reconciliationId': reconciliationId}, _posted);

  @override
  Future<Result<PostingOutcome>> reverse(String transactionId, {required String reason}) async =>
      respond('reverse', {'transactionId': transactionId, 'reason': reason}, _posted);
}

class FakeExpensesApi extends _Recorder implements ExpensesApi {
  @override
  Future<Result<String>> create(ExpenseDraft draft, {required bool submit, required String requestId}) async =>
      respond('create', {...draft.toJson(), 'submit': submit, 'requestId': requestId}, 'e-new');

  @override
  Future<Result<void>> update(String expenseId, ExpenseDraft draft, {String? reason}) async =>
      respond<void>('update', {'expenseId': expenseId, ...draft.toJson()}, null);

  @override
  Future<Result<void>> act(String expenseId, ExpenseAction action, {String? reason, String? notes}) async =>
      respond<void>('act', {'expenseId': expenseId, 'action': action.key, 'reason': reason, 'notes': notes}, null);

  @override
  Future<Result<void>> pay(String expenseId, {required String accountId, required String requestId, String? reference}) async =>
      respond<void>('pay', {'expenseId': expenseId, 'accountId': accountId, 'requestId': requestId}, null);

  @override
  Future<Result<void>> createCategory(String name) async => respond<void>('createCategory', {'name': name}, null);

  @override
  Future<Result<void>> updateCategory(String categoryId, {String? name, bool? active, String? reason}) async =>
      respond<void>('updateCategory', {'categoryId': categoryId, 'name': name, 'active': active, 'reason': reason}, null);

  @override
  Future<Result<void>> createRecurring(RecurringDraft draft) async => respond<void>('createRecurring', draft.toJson(), null);

  @override
  Future<Result<void>> updateRecurring(String recurringExpenseId, {RecurringDraft? draft, bool? active, String? reason}) async =>
      respond<void>('updateRecurring', {'id': recurringExpenseId, 'active': active, 'reason': reason}, null);
}

class FakeInventoryApi extends _Recorder implements InventoryApi {
  @override
  Future<Result<String>> createItem(ItemDraft draft, {String? sku, int openingQuantity = 0}) async =>
      respond('createItem', {...draft.toJson(), 'sku': sku, 'openingQuantity': openingQuantity}, 'item-new');

  @override
  Future<Result<void>> updateItem(String itemId, ItemDraft draft, {bool? active, String? reason}) async =>
      respond<void>('updateItem', {'itemId': itemId, ...draft.toJson(), 'active': active}, null);

  @override
  Future<Result<void>> recordMovement({
    required String itemId,
    required MovementType type,
    required int quantity,
    required String reason,
    required String requestId,
    StockOutReason? reasonCode,
    String? reference,
    Money? unitCost,
    String? workerId,
  }) async =>
      respond<void>('recordMovement',
          {'itemId': itemId, 'type': type.key, 'quantity': quantity, 'reason': reason, 'reasonCode': reasonCode?.key, 'requestId': requestId}, null);

  @override
  Future<Result<void>> adjust(String itemId, {required int countedQuantity, required String reason, required String requestId}) async =>
      respond<void>('adjust', {'itemId': itemId, 'counted': countedQuantity, 'reason': reason}, null);

  @override
  Future<Result<void>> reverseMovement(String movementId, {required String reason}) async =>
      respond<void>('reverseMovement', {'movementId': movementId, 'reason': reason}, null);

  @override
  Future<Result<void>> createSupplier(SupplierDraft draft) async => respond<void>('createSupplier', draft.toJson(), null);

  @override
  Future<Result<void>> updateSupplier(String supplierId, SupplierDraft draft, {bool? active, String? reason}) async =>
      respond<void>('updateSupplier', {'supplierId': supplierId, ...draft.toJson(), 'active': active}, null);

  @override
  Future<Result<String>> createPurchase({
    required String supplierId,
    required List<PurchaseLine> lines,
    required String requestId,
    DateTime? purchaseDate,
    String? supplierReference,
    String? notes,
  }) async =>
      respond('createPurchase', {
        'supplierId': supplierId,
        'lines': [for (final l in lines) '${l.itemId}:${l.quantity}x${l.unitCost.ugx}'],
      }, 'pur-new');

  @override
  Future<Result<void>> approvePurchase(String purchaseId) async => respond<void>('approvePurchase', {'purchaseId': purchaseId}, null);

  @override
  Future<Result<void>> cancelPurchase(String purchaseId, {required String reason}) async =>
      respond<void>('cancelPurchase', {'purchaseId': purchaseId, 'reason': reason}, null);

  @override
  Future<Result<void>> receivePurchase(String purchaseId, {required String requestId, String? payFromAccountId}) async =>
      respond<void>('receivePurchase', {'purchaseId': purchaseId, 'payFrom': payFromAccountId}, null);

  @override
  Future<Result<void>> payPurchase(String purchaseId, {required String accountId, required String requestId, String? reference}) async =>
      respond<void>('payPurchase', {'purchaseId': purchaseId, 'accountId': accountId}, null);
}
