import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../models/expense.dart';

/// What someone entered for an expense. The server decides the number,
/// status and everything that follows.
class ExpenseDraft {
  const ExpenseDraft({
    required this.categoryId,
    required this.description,
    required this.amount,
    this.expenseDate,
    this.payee,
    this.paymentAccountId,
    this.reference,
    this.notes,
    this.attachmentPath,
  });

  final String categoryId;
  final String description;
  final Money amount;
  final DateTime? expenseDate;
  final String? payee;
  final String? paymentAccountId;
  final String? reference;
  final String? notes;
  final String? attachmentPath;

  Map<String, Object?> toJson() => {
        'categoryId': categoryId,
        'description': description,
        'amountUgx': amount.ugx,
        'expenseDate': ?expenseDate?.millisecondsSinceEpoch,
        'payee': payee,
        'paymentAccountId': paymentAccountId,
        'reference': reference,
        'notes': notes,
        'attachmentPath': ?attachmentPath,
      };
}

class RecurringDraft {
  const RecurringDraft({
    required this.name,
    required this.categoryId,
    required this.expectedAmount,
    required this.frequency,
    required this.nextDueDate,
    this.payee,
    this.paymentAccountId,
    this.reminderDaysBefore = 3,
    this.notes,
  });

  final String name;
  final String categoryId;
  final Money expectedAmount;
  final ExpenseFrequency frequency;
  final DateTime nextDueDate;
  final String? payee;
  final String? paymentAccountId;
  final int reminderDaysBefore;
  final String? notes;

  Map<String, Object?> toJson() => {
        'name': name,
        'categoryId': categoryId,
        'expectedAmountUgx': expectedAmount.ugx,
        'frequency': frequency.key,
        'nextDueDate': nextDueDate.millisecondsSinceEpoch,
        'payee': payee,
        'paymentAccountId': paymentAccountId,
        'reminderDaysBefore': reminderDaysBefore,
        'notes': notes,
      };
}

/// Expense commands — Cloud Functions in functions/src/expenses.js.
abstract class ExpensesApi {
  Future<Result<String>> create(ExpenseDraft draft, {required bool submit, required String requestId});
  Future<Result<void>> update(String expenseId, ExpenseDraft draft, {String? reason});
  Future<Result<void>> act(String expenseId, ExpenseAction action, {String? reason, String? notes});
  Future<Result<void>> pay(String expenseId, {required String accountId, required String requestId, String? reference});
  Future<Result<void>> createCategory(String name);
  Future<Result<void>> updateCategory(String categoryId, {String? name, bool? active, String? reason});
  Future<Result<void>> createRecurring(RecurringDraft draft);
  Future<Result<void>> updateRecurring(String recurringExpenseId, {RecurringDraft? draft, bool? active, String? reason});
}

class CallableExpensesApi implements ExpensesApi {
  CallableExpensesApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await callFunction(_functions, name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<String>> create(ExpenseDraft draft, {required bool submit, required String requestId}) async =>
      (await callFunction(_functions, 'createExpense', {...draft.toJson(), 'submit': submit, 'requestId': requestId}))
          .when(success: (d) => Success(d['expenseId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> update(String expenseId, ExpenseDraft draft, {String? reason}) =>
      _done('updateExpense', {...draft.toJson(), 'expenseId': expenseId, 'reason': ?reason});

  @override
  Future<Result<void>> act(String expenseId, ExpenseAction action, {String? reason, String? notes}) =>
      _done('updateExpenseStatus', {'expenseId': expenseId, 'action': action.key, 'reason': ?reason, 'notes': ?notes});

  @override
  Future<Result<void>> pay(String expenseId, {required String accountId, required String requestId, String? reference}) =>
      _done('payExpense', {'expenseId': expenseId, 'accountId': accountId, 'requestId': requestId, 'reference': ?reference});

  @override
  Future<Result<void>> createCategory(String name) => _done('createExpenseCategory', {'name': name});

  @override
  Future<Result<void>> updateCategory(String categoryId, {String? name, bool? active, String? reason}) =>
      _done('updateExpenseCategory', {'categoryId': categoryId, 'name': ?name, 'active': ?active, 'reason': ?reason});

  @override
  Future<Result<void>> createRecurring(RecurringDraft draft) => _done('createRecurringExpense', draft.toJson());

  @override
  Future<Result<void>> updateRecurring(String recurringExpenseId, {RecurringDraft? draft, bool? active, String? reason}) =>
      _done('updateRecurringExpense', {
        ...?draft?.toJson(),
        'recurringExpenseId': recurringExpenseId,
        'active': ?active,
        'reason': ?reason,
      });
}
