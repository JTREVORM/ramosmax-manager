import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../models/finance.dart';
import '../data/finance_api.dart';
import '../data/finance_repository.dart';

final financeRepositoryProvider = Provider<FinanceRepository>((ref) => FinanceRepository(ref.watch(firestoreProvider)));

final financeApiProvider = Provider<FinanceApi>((ref) => CallableFinanceApi(ref.watch(firebaseFunctionsProvider)));

final financialAccountsProvider =
    StreamProvider<List<FinancialAccount>>((ref) => ref.watch(financeRepositoryProvider).watchAccounts());

final financialAccountProvider =
    StreamProvider.family<FinancialAccount?, String>((ref, id) => ref.watch(financeRepositoryProvider).watchAccount(id));

final transactionsProvider = StreamProvider.family<List<FinancialTransaction>, TransactionType?>(
    (ref, type) => ref.watch(financeRepositoryProvider).watchTransactions(type: type));

final accountTransactionsProvider = StreamProvider.family<List<FinancialTransaction>, String>(
    (ref, accountId) => ref.watch(financeRepositoryProvider).watchAccountTransactions(accountId));

final transactionProvider =
    StreamProvider.family<FinancialTransaction?, String>((ref, id) => ref.watch(financeRepositoryProvider).watchTransaction(id));

final depositsProvider = StreamProvider<List<BankDeposit>>((ref) => ref.watch(financeRepositoryProvider).watchDeposits());

final reconciliationsProvider = StreamProvider.family<List<Reconciliation>, String?>(
    (ref, accountId) => ref.watch(financeRepositoryProvider).watchReconciliations(accountId: accountId));

final paymentAccountOptionsProvider =
    StreamProvider<List<PaymentAccountOption>>((ref) => ref.watch(financeRepositoryProvider).watchPaymentAccounts());

/// Today's server-maintained totals (EAT business day).
final todayFinanceProvider = StreamProvider<DailyFinanceSummary>((ref) {
  final now = ref.read(clockProvider).value ?? DateTime.now();
  return ref.watch(financeRepositoryProvider).watchDay(EastAfricaTime.businessDayKey(now));
});

/// Report periods, in EAT business days.
enum FinancePeriod {
  today('Today'),
  week('7 days'),
  month('This month'),
  lastMonth('Last month');

  const FinancePeriod(this.label);
  final String label;

  (DateTime, DateTime) bounds(DateTime now) => switch (this) {
        today => EastAfricaTime.dayBounds(now),
        week => (EastAfricaTime.dayBounds(now.subtract(const Duration(days: 6))).$1, EastAfricaTime.dayBounds(now).$2),
        month => EastAfricaTime.monthBounds(now),
        lastMonth => EastAfricaTime.monthBounds(EastAfricaTime.monthBounds(now).$1.subtract(const Duration(hours: 1))),
      };
}

final periodSummariesProvider = StreamProvider.family<List<DailyFinanceSummary>, FinancePeriod>((ref, period) {
  final now = ref.read(clockProvider).value ?? DateTime.now();
  final (from, to) = period.bounds(now);
  return ref.watch(financeRepositoryProvider).watchDailySummaries(from, to);
});

final financeActionsProvider = Provider<FinanceActions>(FinanceActions.new);

/// Finance commands. Online-only: balances change only on the server, in one
/// transaction with the ledger entry. Nothing is queued offline.
class FinanceActions {
  FinanceActions(this._ref);
  final Ref _ref;

  FinanceApi get _api => _ref.read(financeApiProvider);

  Future<Result<T>> _run<T>(String outcome, Future<Result<T>> Function() action) =>
      runOnline(_ref, action, event: AnalyticsEvents.financeAction, params: {'outcome': outcome});

  Future<Result<void>> ensureDefaultAccounts() => _run('accounts_setup', _api.ensureDefaultAccounts);

  Future<Result<String>> createAccount({
    required String name,
    required AccountType type,
    String? provider,
    String? accountNumber,
    String? notes,
    Money? openingBalance,
  }) =>
      _run('account_created', () => _api.createAccount(
          name: name, type: type, provider: provider, accountNumber: accountNumber, notes: notes, openingBalance: openingBalance));

  Future<Result<void>> updateAccount(String accountId,
          {String? name, String? provider, String? accountNumber, String? notes, bool? active, String? reason}) =>
      _run('account_updated', () => _api.updateAccount(accountId,
          name: name, provider: provider, accountNumber: accountNumber, notes: notes, active: active, reason: reason));

  Future<Result<PostingOutcome>> recordOpeningBalance(String accountId, Money amount, {String? reason}) =>
      _run('opening_balance', () => _api.recordOpeningBalance(accountId, amount, reason: reason));

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
      _run('transfer', () => _api.transfer(
          fromAccountId: fromAccountId, toAccountId: toAccountId, amount: amount, reason: reason, requestId: requestId,
          date: date, reference: reference, description: description));

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
      _run('bank_deposit', () => _api.deposit(
          sourceAccountId: sourceAccountId, bankAccountId: bankAccountId, amount: amount, bankReference: bankReference,
          requestId: requestId, date: date, description: description, attachmentPath: attachmentPath));

  Future<Result<PostingOutcome>> reconcile({
    required String accountId,
    required Money actualBalance,
    required String requestId,
    DateTime? date,
    String? notes,
    String? attachmentPath,
  }) =>
      _run('reconciliation', () => _api.reconcile(
          accountId: accountId, actualBalance: actualBalance, requestId: requestId, date: date, notes: notes, attachmentPath: attachmentPath));

  Future<Result<PostingOutcome>> adjust({
    required String accountId,
    required bool increase,
    required Money amount,
    required String reason,
    required String requestId,
    String? reconciliationId,
  }) =>
      _run('adjustment', () => _api.adjust(
          accountId: accountId, increase: increase, amount: amount, reason: reason, requestId: requestId, reconciliationId: reconciliationId));

  Future<Result<PostingOutcome>> reverse(String transactionId, String reason) =>
      _run('reversal', () => _api.reverse(transactionId, reason: reason));
}
