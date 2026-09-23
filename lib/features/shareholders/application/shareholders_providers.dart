import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../models/shareholding.dart';
import '../data/shareholders_api.dart';
import '../data/shareholders_repository.dart';

final shareholdersRepositoryProvider = Provider<ShareholdersRepository>((ref) => ShareholdersRepository(ref.watch(firestoreProvider)));

final shareholdersApiProvider = Provider<ShareholdersApi>((ref) => CallableShareholdersApi(ref.watch(firebaseFunctionsProvider)));

final shareRegisterProvider = StreamProvider<ShareRegister>((ref) => ref.watch(shareholdersRepositoryProvider).watchRegister());

final shareClassesProvider = StreamProvider<List<ShareClass>>((ref) => ref.watch(shareholdersRepositoryProvider).watchClasses());

final sharePolicyProvider = StreamProvider<SharePolicy>((ref) => ref.watch(shareholdersRepositoryProvider).watchSharePolicy());

final dividendPolicyProvider = StreamProvider<DividendPolicy>((ref) => ref.watch(shareholdersRepositoryProvider).watchDividendPolicy());

final activeShareholdersProvider =
    StreamProvider<List<Shareholder>>((ref) => ref.watch(shareholdersRepositoryProvider).watchActiveShareholders());

final shareholderProvider =
    StreamProvider.family<Shareholder?, String>((ref, id) => ref.watch(shareholdersRepositoryProvider).watchShareholder(id));

final holdingsProvider =
    StreamProvider.family<List<Shareholding>, String>((ref, id) => ref.watch(shareholdersRepositoryProvider).watchHoldings(id));

final shareTransactionsProvider = StreamProvider.family<List<ShareTransaction>, ({ShareTransactionStatus? status, ShareTransactionType? type})>(
    (ref, f) => ref.watch(shareholdersRepositoryProvider).watchShareTransactions(status: f.status, type: f.type));

final shareholderTransactionsProvider = StreamProvider.family<List<ShareTransaction>, String>(
    (ref, id) => ref.watch(shareholdersRepositoryProvider).watchShareholderTransactions(id));

final shareTransactionProvider =
    StreamProvider.family<ShareTransaction?, String>((ref, id) => ref.watch(shareholdersRepositoryProvider).watchShareTransaction(id));

final contributionsProvider = StreamProvider<List<ShareContribution>>((ref) => ref.watch(shareholdersRepositoryProvider).watchContributions());

final shareholderContributionsProvider = StreamProvider.family<List<ShareContribution>, String>(
    (ref, id) => ref.watch(shareholdersRepositoryProvider).watchShareholderContributions(id));

final issueContributionsProvider = StreamProvider.family<List<ShareContribution>, String>(
    (ref, id) => ref.watch(shareholdersRepositoryProvider).watchIssueContributions(id));

final dividendsProvider = StreamProvider<List<Dividend>>((ref) => ref.watch(shareholdersRepositoryProvider).watchDividends());

final dividendProvider = StreamProvider.family<Dividend?, String>((ref, id) => ref.watch(shareholdersRepositoryProvider).watchDividend(id));

final allocationsProvider =
    StreamProvider.family<List<DividendAllocation>, String>((ref, id) => ref.watch(shareholdersRepositoryProvider).watchAllocations(id));

final shareholderAllocationsProvider = StreamProvider.family<List<DividendAllocation>, String>(
    (ref, id) => ref.watch(shareholdersRepositoryProvider).watchShareholderAllocations(id));

/// The signed-in shareholder's own records (server-side, never a direct query).
final myShareholdingProvider = FutureProvider.autoDispose<MyShareholding>((ref) async {
  final r = await ref.watch(shareholdersApiProvider).myShareholding();
  return r.when(success: (v) => v, failure: (f) => throw f);
});

final shareholderActionsProvider = Provider<ShareholderActions>(ShareholderActions.new);

/// Phase 7 commands. Online-only: shareholder changes, share issues,
/// transfers, adjustments, contributions and every dividend step are never
/// queued offline.
class ShareholderActions {
  ShareholderActions(this._ref);
  final Ref _ref;

  ShareholdersApi get _api => _ref.read(shareholdersApiProvider);

  Future<Result<T>> _run<T>(String event, String outcome, Future<Result<T>> Function() action) =>
      runOnline(_ref, action, event: event, params: {'outcome': outcome});

  // shareholders
  Future<Result<String>> createShareholder(ShareholderDraft draft, {required String requestId}) =>
      _run(AnalyticsEvents.shareholderAction, 'created', () => _api.createShareholder(draft, requestId: requestId));
  Future<Result<void>> updateShareholder(String id, Map<String, Object?> changes, {String? reason}) =>
      _run(AnalyticsEvents.shareholderAction, 'updated', () => _api.updateShareholder(id, changes, reason: reason));
  Future<Result<void>> setStatus(String id, ShareholderStatus status, {required String reason}) =>
      _run(AnalyticsEvents.shareholderAction, 'status_${status.key}', () => _api.setStatus(id, status, reason: reason));
  Future<Result<void>> linkAccount(String id, String? uid, {String? reason}) =>
      _run(AnalyticsEvents.shareholderAction, uid == null ? 'unlinked' : 'linked', () => _api.linkAccount(id, uid, reason: reason));
  Future<Result<void>> createShareClass({required String code, required String name, required Money valuePerShare, String? description}) =>
      _run(AnalyticsEvents.shareAction, 'class_created',
          () => _api.createShareClass(code: code, name: name, valuePerShare: valuePerShare, description: description));
  Future<Result<void>> updateShareClass(String classId, {String? name, Money? valuePerShare, bool? active, String? reason}) =>
      _run(AnalyticsEvents.shareAction, 'class_updated',
          () => _api.updateShareClass(classId, name: name, valuePerShare: valuePerShare, active: active, reason: reason));
  Future<Result<void>> updatePolicy(String policy, Map<String, bool> changes, {required String reason}) =>
      _run(AnalyticsEvents.shareAction, '${policy}_policy', () => _api.updatePolicy(policy, changes, reason: reason));

  // shares
  Future<Result<String>> issueShares({
    required String shareholderId,
    required String classId,
    required int shares,
    required SharePayment payment,
    required DateTime effectiveDate,
    required String requestId,
    String? reference,
    String? notes,
    String? reason,
  }) =>
      _run(AnalyticsEvents.shareAction, 'issued', () => _api.issueShares(
          shareholderId: shareholderId, classId: classId, shares: shares, payment: payment, effectiveDate: effectiveDate,
          requestId: requestId, reference: reference, notes: notes, reason: reason));
  Future<Result<String>> transferShares({
    required String fromShareholderId,
    required String toShareholderId,
    required String classId,
    required int shares,
    required DateTime effectiveDate,
    required String reason,
    required String requestId,
    String? reference,
  }) =>
      _run(AnalyticsEvents.shareAction, 'transferred', () => _api.transferShares(
          fromShareholderId: fromShareholderId, toShareholderId: toShareholderId, classId: classId, shares: shares,
          effectiveDate: effectiveDate, reason: reason, requestId: requestId, reference: reference));
  Future<Result<String>> adjustShares({
    required String shareholderId,
    required String classId,
    required int deltaShares,
    required bool adjustCommitment,
    required DateTime effectiveDate,
    required String reason,
    required String requestId,
    String? reference,
  }) =>
      _run(AnalyticsEvents.shareAction, 'adjusted', () => _api.adjustShares(
          shareholderId: shareholderId, classId: classId, deltaShares: deltaShares, adjustCommitment: adjustCommitment,
          effectiveDate: effectiveDate, reason: reason, requestId: requestId, reference: reference));
  Future<Result<void>> decideShareTransaction(String id, ShareDecision decision, {String? reason}) =>
      _run(AnalyticsEvents.shareAction, decision.name, () => _api.decideShareTransaction(id, decision, reason: reason));
  Future<Result<void>> reverseShareTransaction(String id, {required String reason, required String requestId}) =>
      _run(AnalyticsEvents.shareAction, 'reversed', () => _api.reverseShareTransaction(id, reason: reason, requestId: requestId));
  Future<Result<void>> recordContribution(String shareTransactionId,
          {required SharePayment payment, required DateTime paymentDate, required String requestId, String? reference, String? reason}) =>
      _run(AnalyticsEvents.shareAction, 'contribution', () => _api.recordContribution(shareTransactionId,
          payment: payment, paymentDate: paymentDate, requestId: requestId, reference: reference, reason: reason));
  Future<Result<void>> reverseContribution(String id, {required String reason}) =>
      _run(AnalyticsEvents.shareAction, 'contribution_reversed', () => _api.reverseContribution(id, reason: reason));
  Future<Result<OwnershipSnapshot>> ownershipAsOf(DateTime date, {String? classId}) =>
      runOnline(_ref, () => _api.ownershipAsOf(date, classId: classId));

  // dividends
  Future<Result<String>> createDividend(DividendDraft draft, {required String requestId}) =>
      _run(AnalyticsEvents.dividendAction, 'created', () => _api.createDividend(draft, requestId: requestId));
  Future<Result<void>> updateDividend(String id, DividendDraft draft, {String? reason}) =>
      _run(AnalyticsEvents.dividendAction, 'updated', () => _api.updateDividend(id, draft, reason: reason));
  Future<Result<void>> calculateDividend(String id) => _run(AnalyticsEvents.dividendAction, 'calculated', () => _api.calculateDividend(id));
  Future<Result<void>> dividendAction(String id, DividendAction action, {String? reason}) =>
      _run(AnalyticsEvents.dividendAction, action.name, () => _api.dividendAction(id, action, reason: reason));
  Future<Result<void>> payDividend(String id, List<String> allocationIds,
          {required String accountId, required String requestId, required DateTime paymentDate, String? reference}) =>
      _run(AnalyticsEvents.dividendAction, 'paid', () => _api.payDividend(id, allocationIds,
          accountId: accountId, requestId: requestId, paymentDate: paymentDate, reference: reference));
  Future<Result<void>> reverseDividendPayment(String allocationId, {required String reason}) =>
      _run(AnalyticsEvents.dividendAction, 'payment_reversed', () => _api.reverseDividendPayment(allocationId, reason: reason));
  Future<Result<void>> cancelDividend(String id, {required String reason}) =>
      _run(AnalyticsEvents.dividendAction, 'cancelled', () => _api.cancelDividend(id, reason: reason));
}
