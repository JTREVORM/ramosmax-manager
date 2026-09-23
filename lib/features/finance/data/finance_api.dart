import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../models/finance.dart';

/// Result of a posting: the ledger entry the server created.
class PostingOutcome {
  const PostingOutcome({required this.transactionId, required this.transactionNumber, this.number, this.difference, this.duplicate = false});
  final String transactionId;
  final String transactionNumber;

  /// The deposit or reconciliation number, where there is one.
  final String? number;

  /// Reconciliation difference (actual − system).
  final Money? difference;
  final bool duplicate;

  static PostingOutcome fromJson(Map<String, dynamic> d) => PostingOutcome(
        transactionId: d['transactionId'] as String? ?? '',
        transactionNumber: d['transactionNumber'] as String? ?? '',
        number: (d['depositNumber'] ?? d['reconciliationNumber']) as String?,
        difference: d['differenceUgx'] == null ? null : Money((d['differenceUgx'] as num).toInt()),
        duplicate: d['duplicate'] == true,
      );
}

/// Finance commands — Cloud Functions in functions/src/finance.js. The app
/// sends what the person asked for; balances, numbers and ledger entries are
/// the server's. Every money movement carries a [requestId] so a retry after a
/// lost response is applied once.
abstract class FinanceApi {
  Future<Result<void>> ensureDefaultAccounts();
  Future<Result<String>> createAccount({
    required String name,
    required AccountType type,
    String? provider,
    String? accountNumber,
    String? notes,
    Money? openingBalance,
  });
  Future<Result<void>> updateAccount(String accountId, {String? name, String? provider, String? accountNumber, String? notes, bool? active, String? reason});
  Future<Result<PostingOutcome>> recordOpeningBalance(String accountId, Money amount, {String? reason});
  Future<Result<PostingOutcome>> transfer({
    required String fromAccountId,
    required String toAccountId,
    required Money amount,
    required String reason,
    required String requestId,
    DateTime? date,
    String? reference,
    String? description,
  });
  Future<Result<PostingOutcome>> deposit({
    required String sourceAccountId,
    required String bankAccountId,
    required Money amount,
    required String bankReference,
    required String requestId,
    DateTime? date,
    String? description,
    String? attachmentPath,
  });
  Future<Result<PostingOutcome>> reconcile({
    required String accountId,
    required Money actualBalance,
    required String requestId,
    DateTime? date,
    String? notes,
    String? attachmentPath,
  });
  Future<Result<PostingOutcome>> adjust({
    required String accountId,
    required bool increase,
    required Money amount,
    required String reason,
    required String requestId,
    String? reconciliationId,
  });
  Future<Result<PostingOutcome>> reverse(String transactionId, {required String reason});
}

class CallableFinanceApi implements FinanceApi {
  CallableFinanceApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<PostingOutcome>> _post(String name, Map<String, Object?> data) async =>
      (await callFunction(_functions, name, data)).when(success: (d) => Success(PostingOutcome.fromJson(d)), failure: Failure.new);

  @override
  Future<Result<void>> ensureDefaultAccounts() async =>
      (await callFunction(_functions, 'ensureDefaultFinancialAccounts', {})).when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<String>> createAccount({
    required String name,
    required AccountType type,
    String? provider,
    String? accountNumber,
    String? notes,
    Money? openingBalance,
  }) async =>
      (await callFunction(_functions, 'createFinancialAccount', {
        'name': name,
        'type': type.key,
        'provider': ?provider,
        'accountNumber': ?accountNumber,
        'notes': ?notes,
        'openingBalanceUgx': ?openingBalance?.ugx,
      }))
          .when(success: (d) => Success(d['accountId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> updateAccount(String accountId,
          {String? name, String? provider, String? accountNumber, String? notes, bool? active, String? reason}) async =>
      (await callFunction(_functions, 'updateFinancialAccount', {
        'accountId': accountId,
        'name': ?name,
        'provider': ?provider,
        'accountNumber': ?accountNumber,
        'notes': ?notes,
        'active': ?active,
        'reason': ?reason,
      }))
          .when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<PostingOutcome>> recordOpeningBalance(String accountId, Money amount, {String? reason}) =>
      _post('recordOpeningBalance', {'accountId': accountId, 'amountUgx': amount.ugx, 'reason': ?reason});

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
  }) =>
      _post('transferFunds', {
        'fromAccountId': fromAccountId,
        'toAccountId': toAccountId,
        'amountUgx': amount.ugx,
        'reason': reason,
        'requestId': requestId,
        'transferDate': ?date?.millisecondsSinceEpoch,
        'reference': ?reference,
        'description': ?description,
      });

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
  }) =>
      _post('recordBankDeposit', {
        'sourceAccountId': sourceAccountId,
        'bankAccountId': bankAccountId,
        'amountUgx': amount.ugx,
        'bankReference': bankReference,
        'requestId': requestId,
        'depositDate': ?date?.millisecondsSinceEpoch,
        'description': ?description,
        'attachmentPath': ?attachmentPath,
      });

  @override
  Future<Result<PostingOutcome>> reconcile({
    required String accountId,
    required Money actualBalance,
    required String requestId,
    DateTime? date,
    String? notes,
    String? attachmentPath,
  }) =>
      _post('reconcileAccount', {
        'accountId': accountId,
        'actualBalanceUgx': actualBalance.ugx,
        'requestId': requestId,
        'reconciliationDate': ?date?.millisecondsSinceEpoch,
        'notes': ?notes,
        'attachmentPath': ?attachmentPath,
      });

  @override
  Future<Result<PostingOutcome>> adjust({
    required String accountId,
    required bool increase,
    required Money amount,
    required String reason,
    required String requestId,
    String? reconciliationId,
  }) =>
      _post('recordAccountAdjustment', {
        'accountId': accountId,
        'direction': increase ? 'in' : 'out',
        'amountUgx': amount.ugx,
        'reason': reason,
        'requestId': requestId,
        'reconciliationId': ?reconciliationId,
      });

  @override
  Future<Result<PostingOutcome>> reverse(String transactionId, {required String reason}) =>
      _post('reverseFinancialTransaction', {'transactionId': transactionId, 'reason': reason});
}
