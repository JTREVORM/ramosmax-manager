import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../models/after_hours.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../data/after_hours_api.dart';
import '../data/after_hours_repository.dart';

final afterHoursRepositoryProvider = Provider<AfterHoursRepository>((ref) => AfterHoursRepository(ref.watch(firestoreProvider)));

final afterHoursApiProvider = Provider<AfterHoursApi>((ref) => CallableAfterHoursApi(ref.watch(firebaseFunctionsProvider)));

final afterHoursPolicyProvider = StreamProvider<AfterHoursPolicy>((ref) => ref.watch(afterHoursRepositoryProvider).watchPolicy());

// --- manager views (after_hours.view / after_hours.approve / cash_handover.approve) ---

final authorizationsProvider = StreamProvider.family<List<AfterHoursAuthorization>, AuthorizationStatus?>(
    (ref, status) => ref.watch(afterHoursRepositoryProvider).watchAuthorizations(status: status));

final afterHoursSessionsProvider = StreamProvider.family<List<AfterHoursSession>, SessionStatus?>(
    (ref, status) => ref.watch(afterHoursRepositoryProvider).watchSessions(status: status));

final handoversProvider = StreamProvider.family<List<CashHandover>, HandoverStatus?>(
    (ref, status) => ref.watch(afterHoursRepositoryProvider).watchHandovers(status: status));

final discrepanciesProvider = StreamProvider.family<List<CashDiscrepancy>, DiscrepancyStatus?>(
    (ref, status) => ref.watch(afterHoursRepositoryProvider).watchDiscrepancies(status: status));

// --- single records ---

final afterHoursSessionProvider =
    StreamProvider.family<AfterHoursSession?, String>((ref, id) => ref.watch(afterHoursRepositoryProvider).watchSession(id));

final handoverProvider =
    StreamProvider.family<CashHandover?, String>((ref, id) => ref.watch(afterHoursRepositoryProvider).watchHandover(id));

final discrepancyProvider =
    StreamProvider.family<CashDiscrepancy?, String>((ref, id) => ref.watch(afterHoursRepositoryProvider).watchDiscrepancy(id));

final custodyProvider = StreamProvider.family<List<CustodyEntry>, ({String staffUid, String sessionId})>(
    (ref, k) => ref.watch(afterHoursRepositoryProvider).watchCustody(staffUid: k.staffUid, sessionId: k.sessionId));

// --- the signed-in worker's own records ---

String? _uid(Ref ref) => ref.watch(currentUserProvider)?.uid;

final myAuthorizationsProvider = StreamProvider<List<AfterHoursAuthorization>>((ref) {
  final uid = _uid(ref);
  return uid == null ? Stream.value(const []) : ref.watch(afterHoursRepositoryProvider).watchMyAuthorizations(uid);
});

final mySessionsProvider = StreamProvider<List<AfterHoursSession>>((ref) {
  final uid = _uid(ref);
  return uid == null ? Stream.value(const []) : ref.watch(afterHoursRepositoryProvider).watchMySessions(uid);
});

final myHandoversProvider = StreamProvider<List<CashHandover>>((ref) {
  final uid = _uid(ref);
  return uid == null ? Stream.value(const []) : ref.watch(afterHoursRepositoryProvider).watchMyHandovers(uid);
});

final myDiscrepanciesProvider = StreamProvider<List<CashDiscrepancy>>((ref) {
  final uid = _uid(ref);
  return uid == null ? Stream.value(const []) : ref.watch(afterHoursRepositoryProvider).watchMyDiscrepancies(uid);
});

/// The signed-in user's open session, if any (display; the server decides).
final myOpenSessionProvider = Provider<AfterHoursSession?>((ref) {
  final list = ref.watch(mySessionsProvider).value ?? const <AfterHoursSession>[];
  for (final s in list) {
    if (s.isOpen) return s;
  }
  return null;
});

final afterHoursActionsProvider = Provider<AfterHoursActions>(AfterHoursActions.new);

/// Phase 8 commands. Online-only: authorisations, sessions, handovers and
/// discrepancies move money custody and access, so nothing is queued offline.
class AfterHoursActions {
  AfterHoursActions(this._ref);
  final Ref _ref;

  AfterHoursApi get _api => _ref.read(afterHoursApiProvider);

  Future<Result<T>> _run<T>(String outcome, Future<Result<T>> Function() action) =>
      runOnline(_ref, action, event: AnalyticsEvents.afterHoursAction, params: {'outcome': outcome});

  Future<Result<String>> authorize(AuthorizationDraft draft, {required String requestId}) =>
      _run('authorized', () => _api.authorize(draft, requestId: requestId));
  Future<Result<void>> revoke(String authorizationId, {required String reason}) =>
      _run('revoked', () => _api.revoke(authorizationId, reason: reason));
  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason}) =>
      _run('policy_updated', () => _api.updatePolicy(changes, reason: reason));

  Future<Result<String>> openSession({required String requestId, String? notes}) =>
      _run('session_opened', () => _api.openSession(requestId: requestId, notes: notes));
  Future<Result<SessionCloseResult>> closeSession(String sessionId, {String? notes}) =>
      _run('session_closed', () => _api.closeSession(sessionId, notes: notes));
  Future<Result<void>> cancelSession(String sessionId, {required String reason}) =>
      _run('session_cancelled', () => _api.cancelSession(sessionId, reason: reason));

  Future<Result<void>> submitHandover(String handoverId, {required Money declared, required String requestId, String? notes}) =>
      _run('handover_submitted', () => _api.submitHandover(handoverId, declared: declared, requestId: requestId, notes: notes));
  Future<Result<HandoverReceipt>> receiveHandover(String handoverId,
          {required Money actual, required String requestId, String? explanation, String? notes}) =>
      _run('handover_received',
          () => _api.receiveHandover(handoverId, actual: actual, requestId: requestId, explanation: explanation, notes: notes));

  Future<Result<void>> reviewDiscrepancy(String discrepancyId, {required String notes}) =>
      _run('discrepancy_reviewed', () => _api.reviewDiscrepancy(discrepancyId, notes: notes));
  Future<Result<void>> resolveDiscrepancy(
    String discrepancyId, {
    required DiscrepancyOutcome outcome,
    required String resolution,
    required String requestId,
    bool recoverFromWorker = false,
    bool postAdjustment = false,
  }) =>
      _run('discrepancy_${outcome.name}', () => _api.resolveDiscrepancy(discrepancyId,
          outcome: outcome,
          resolution: resolution,
          requestId: requestId,
          recoverFromWorker: recoverFromWorker,
          postAdjustment: postAdjustment));
}
