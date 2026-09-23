import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../models/expense.dart';
import '../../finance/application/finance_providers.dart' show FinancePeriod;
import '../data/expenses_api.dart';
import '../data/expenses_repository.dart';

final expensesRepositoryProvider = Provider<ExpensesRepository>((ref) => ExpensesRepository(ref.watch(firestoreProvider)));

final expensesApiProvider = Provider<ExpensesApi>((ref) => CallableExpensesApi(ref.watch(firebaseFunctionsProvider)));

final expensesProvider = StreamProvider.family<List<Expense>, ExpenseStatus?>(
    (ref, status) => ref.watch(expensesRepositoryProvider).watchExpenses(status: status));

final expenseProvider = StreamProvider.family<Expense?, String>((ref, id) => ref.watch(expensesRepositoryProvider).watchExpense(id));

final expenseCategoriesProvider =
    StreamProvider<List<ExpenseCategory>>((ref) => ref.watch(expensesRepositoryProvider).watchCategories());

final recurringExpensesProvider =
    StreamProvider<List<RecurringExpense>>((ref) => ref.watch(expensesRepositoryProvider).watchRecurring());

final largeExpenseThresholdProvider = StreamProvider<int>((ref) => ref.watch(expensesRepositoryProvider).watchLargeThreshold());

final periodExpensesProvider = StreamProvider.family<List<Expense>, FinancePeriod>((ref, period) {
  final now = ref.read(clockProvider).value ?? DateTime.now();
  final (from, to) = period.bounds(now);
  return ref.watch(expensesRepositoryProvider).watchExpensesDated(from, to);
});

final largeExpensesProvider = StreamProvider<List<Expense>>((ref) {
  final threshold = ref.watch(largeExpenseThresholdProvider).value ?? 500000;
  return ref.watch(expensesRepositoryProvider).watchLarge(threshold);
});

final expenseActionsProvider = Provider<ExpenseActions>(ExpenseActions.new);

/// Expense commands (online-only). Paying is the only one that moves money.
class ExpenseActions {
  ExpenseActions(this._ref);
  final Ref _ref;

  ExpensesApi get _api => _ref.read(expensesApiProvider);

  Future<Result<T>> _run<T>(String outcome, Future<Result<T>> Function() action) =>
      runOnline(_ref, action, event: AnalyticsEvents.expenseAction, params: {'outcome': outcome});

  Future<Result<String>> create(ExpenseDraft draft, {required bool submit, required String requestId}) =>
      _run('created', () => _api.create(draft, submit: submit, requestId: requestId));

  Future<Result<void>> update(String expenseId, ExpenseDraft draft, {String? reason}) =>
      _run('updated', () => _api.update(expenseId, draft, reason: reason));

  Future<Result<void>> act(String expenseId, ExpenseAction action, {String? reason, String? notes}) =>
      _run(action.key, () => _api.act(expenseId, action, reason: reason, notes: notes));

  Future<Result<void>> pay(String expenseId, {required String accountId, required String requestId, String? reference}) =>
      _run('paid', () => _api.pay(expenseId, accountId: accountId, requestId: requestId, reference: reference));

  Future<Result<void>> createCategory(String name) => _run('category_created', () => _api.createCategory(name));

  Future<Result<void>> updateCategory(String categoryId, {String? name, bool? active, String? reason}) =>
      _run('category_updated', () => _api.updateCategory(categoryId, name: name, active: active, reason: reason));

  Future<Result<void>> createRecurring(RecurringDraft draft) => _run('recurring_created', () => _api.createRecurring(draft));

  Future<Result<void>> updateRecurring(String id, {RecurringDraft? draft, bool? active, String? reason}) =>
      _run('recurring_updated', () => _api.updateRecurring(id, draft: draft, active: active, reason: reason));
}
