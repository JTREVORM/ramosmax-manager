import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/after_hours/data/after_hours_api.dart';
import 'package:ramosmax_auto_manager/models/after_hours.dart';

/// Records calls instead of calling Cloud Functions. Server behaviour is
/// tested against the emulator in functions/test/after_hours.test.js.
class FakeAfterHoursApi implements AfterHoursApi {
  final List<(String, Map<String, Object?>)> calls = [];
  AppFailure? nextFailure;
  SessionCloseResult closeResult = (expectedCash: const Money(55000), handoverId: 'h-new', handoverNumber: 'RMX-HO-000009');
  HandoverReceipt receipt = (status: HandoverStatus.received, difference: Money.zero, discrepancyId: null, discrepancyNumber: null);

  List<String> get names => [for (final (n, _) in calls) n];

  Result<T> _respond<T>(String name, Map<String, Object?> args, T value) {
    calls.add((name, args));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(value);
  }

  @override
  Future<Result<String>> authorize(AuthorizationDraft draft, {required String requestId}) async =>
      _respond('authorizeAfterHours', {...draft.toJson(), 'requestId': requestId}, 'auth-new');

  @override
  Future<Result<void>> revoke(String authorizationId, {required String reason}) async =>
      _respond<void>('revokeAfterHours', {'authorizationId': authorizationId, 'reason': reason}, null);

  @override
  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason}) async =>
      _respond<void>('updateAfterHoursPolicy', {'changes': changes, 'reason': reason}, null);

  @override
  Future<Result<String>> openSession({required String requestId, String? notes}) async =>
      _respond('openAfterHoursSession', {'requestId': requestId, 'notes': notes}, 's-new');

  @override
  Future<Result<SessionCloseResult>> closeSession(String sessionId, {String? notes}) async =>
      _respond('closeAfterHoursSession', {'sessionId': sessionId, 'notes': notes}, closeResult);

  @override
  Future<Result<void>> cancelSession(String sessionId, {required String reason}) async =>
      _respond<void>('cancelAfterHoursSession', {'sessionId': sessionId, 'reason': reason}, null);

  @override
  Future<Result<void>> submitHandover(String handoverId, {required Money declared, required String requestId, String? notes}) async =>
      _respond<void>('submitCashHandover', {'handoverId': handoverId, 'declaredAmountUgx': declared.ugx, 'requestId': requestId, 'notes': notes}, null);

  @override
  Future<Result<HandoverReceipt>> receiveHandover(String handoverId,
          {required Money actual, required String requestId, String? explanation, String? notes}) async =>
      _respond('receiveCashHandover',
          {'handoverId': handoverId, 'actualAmountUgx': actual.ugx, 'requestId': requestId, 'explanation': explanation, 'notes': notes}, receipt);

  @override
  Future<Result<void>> reviewDiscrepancy(String discrepancyId, {required String notes}) async =>
      _respond<void>('reviewCashDiscrepancy', {'discrepancyId': discrepancyId, 'notes': notes}, null);

  @override
  Future<Result<void>> resolveDiscrepancy(
    String discrepancyId, {
    required DiscrepancyOutcome outcome,
    required String resolution,
    required String requestId,
    bool recoverFromWorker = false,
    bool postAdjustment = false,
  }) async =>
      _respond<void>('resolveCashDiscrepancy', {
        'discrepancyId': discrepancyId,
        'outcome': outcome.name,
        'resolution': resolution,
        'requestId': requestId,
        'recoverFromWorker': recoverFromWorker,
        'postAdjustment': postAdjustment,
      }, null);
}
