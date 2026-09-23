import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../models/after_hours.dart';

/// What a supervisor entered for an after-hours authorisation. The server
/// checks eligibility, the window, the float and the permission list.
class AuthorizationDraft {
  const AuthorizationDraft({
    required this.staffUid,
    required this.startsAt,
    required this.expiresAt,
    required this.reason,
    required this.permissions,
    this.openingFloat = Money.zero,
  });

  final String staffUid;
  final DateTime startsAt;
  final DateTime expiresAt;
  final String reason;
  final List<Permission> permissions;
  final Money openingFloat;

  Map<String, Object?> toJson() => {
        'staffUid': staffUid,
        'startsAt': startsAt.millisecondsSinceEpoch,
        'expiresAt': expiresAt.millisecondsSinceEpoch,
        'reason': reason,
        'permissions': [for (final p in permissions) p.key],
        'openingFloatUgx': openingFloat.ugx,
      };
}

/// What closing a session produced: the expected cash the server froze, and
/// the handover to complete (none when there was no cash).
typedef SessionCloseResult = ({Money expectedCash, String? handoverId, String? handoverNumber});

/// What the manager's count produced.
typedef HandoverReceipt = ({HandoverStatus status, Money difference, String? discrepancyId, String? discrepancyNumber});

enum DiscrepancyOutcome { resolved, waived }

/// Phase 8 commands - Cloud Functions in functions/src/after_hours.js. Every
/// amount, status and permission decision is made there; nothing here is
/// trusted (in particular the expected cash is never sent).
abstract class AfterHoursApi {
  Future<Result<String>> authorize(AuthorizationDraft draft, {required String requestId});
  Future<Result<void>> revoke(String authorizationId, {required String reason});
  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason});

  Future<Result<String>> openSession({required String requestId, String? notes});
  Future<Result<SessionCloseResult>> closeSession(String sessionId, {String? notes});
  Future<Result<void>> cancelSession(String sessionId, {required String reason});

  Future<Result<void>> submitHandover(String handoverId, {required Money declared, required String requestId, String? notes});
  Future<Result<HandoverReceipt>> receiveHandover(String handoverId,
      {required Money actual, required String requestId, String? explanation, String? notes});

  Future<Result<void>> reviewDiscrepancy(String discrepancyId, {required String notes});
  Future<Result<void>> resolveDiscrepancy(
    String discrepancyId, {
    required DiscrepancyOutcome outcome,
    required String resolution,
    required String requestId,
    bool recoverFromWorker = false,
    bool postAdjustment = false,
  });
}

class CallableAfterHoursApi implements AfterHoursApi {
  CallableAfterHoursApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<Map<String, dynamic>>> _call(String name, Map<String, Object?> data) => callFunction(_functions, name, data);

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await _call(name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<String>> authorize(AuthorizationDraft draft, {required String requestId}) async =>
      (await _call('authorizeAfterHours', {...draft.toJson(), 'requestId': requestId}))
          .when(success: (d) => Success(d['authorizationId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> revoke(String authorizationId, {required String reason}) =>
      _done('revokeAfterHours', {'authorizationId': authorizationId, 'reason': reason});

  @override
  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason}) =>
      _done('updateAfterHoursPolicy', {'changes': changes, 'reason': reason});

  @override
  Future<Result<String>> openSession({required String requestId, String? notes}) async =>
      (await _call('openAfterHoursSession', {'requestId': requestId, 'notes': ?notes}))
          .when(success: (d) => Success(d['sessionId'] as String), failure: Failure.new);

  @override
  Future<Result<SessionCloseResult>> closeSession(String sessionId, {String? notes}) async =>
      (await _call('closeAfterHoursSession', {'sessionId': sessionId, 'notes': ?notes})).when(
          success: (d) => Success((
                expectedCash: Money((d['expectedCashUgx'] as num?)?.toInt() ?? 0),
                handoverId: d['handoverId'] as String?,
                handoverNumber: d['handoverNumber'] as String?,
              )),
          failure: Failure.new);

  @override
  Future<Result<void>> cancelSession(String sessionId, {required String reason}) =>
      _done('cancelAfterHoursSession', {'sessionId': sessionId, 'reason': reason});

  @override
  Future<Result<void>> submitHandover(String handoverId, {required Money declared, required String requestId, String? notes}) =>
      _done('submitCashHandover', {'handoverId': handoverId, 'declaredAmountUgx': declared.ugx, 'requestId': requestId, 'notes': ?notes});

  @override
  Future<Result<HandoverReceipt>> receiveHandover(String handoverId,
          {required Money actual, required String requestId, String? explanation, String? notes}) async =>
      (await _call('receiveCashHandover', {
        'handoverId': handoverId,
        'actualAmountUgx': actual.ugx,
        'requestId': requestId,
        'explanation': ?explanation,
        'notes': ?notes,
      }))
          .when(
              success: (d) => Success((
                    status: HandoverStatus.parse(d['status']),
                    difference: Money((d['differenceUgx'] as num?)?.toInt() ?? 0),
                    discrepancyId: d['discrepancyId'] as String?,
                    discrepancyNumber: d['discrepancyNumber'] as String?,
                  )),
              failure: Failure.new);

  @override
  Future<Result<void>> reviewDiscrepancy(String discrepancyId, {required String notes}) =>
      _done('reviewCashDiscrepancy', {'discrepancyId': discrepancyId, 'notes': notes});

  @override
  Future<Result<void>> resolveDiscrepancy(
    String discrepancyId, {
    required DiscrepancyOutcome outcome,
    required String resolution,
    required String requestId,
    bool recoverFromWorker = false,
    bool postAdjustment = false,
  }) =>
      _done('resolveCashDiscrepancy', {
        'discrepancyId': discrepancyId,
        'outcome': outcome.name,
        'resolution': resolution,
        'requestId': requestId,
        'recoverFromWorker': recoverFromWorker,
        'postAdjustment': postAdjustment,
      });
}
