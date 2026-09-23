import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/shareholders/data/shareholders_api.dart';
import 'package:ramosmax_auto_manager/models/shareholding.dart';

/// Records calls instead of calling Cloud Functions. Server behaviour is
/// tested against the emulator in functions/test/{shares,dividends}.test.js.
class FakeShareholdersApi implements ShareholdersApi {
  final List<(String, Map<String, Object?>)> calls = [];
  AppFailure? nextFailure;
  MyShareholding mine = const MyShareholding(linked: false);
  OwnershipSnapshot snapshot = const OwnershipSnapshot(asOf: '2026-01-31', totalShares: 0, holders: []);

  Result<T> _respond<T>(String name, Map<String, Object?> args, T value) {
    calls.add((name, args));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(value);
  }

  List<String> get names => [for (final (n, _) in calls) n];

  @override
  Future<Result<String>> createShareholder(ShareholderDraft draft, {required String requestId}) async =>
      _respond('createShareholder', {...draft.toJson(), 'requestId': requestId}, 'sh-new');

  @override
  Future<Result<void>> updateShareholder(String shareholderId, Map<String, Object?> changes, {String? reason}) async =>
      _respond<void>('updateShareholder', {'id': shareholderId, ...changes}, null);

  @override
  Future<Result<void>> setStatus(String shareholderId, ShareholderStatus status, {required String reason}) async =>
      _respond<void>('setStatus', {'id': shareholderId, 'status': status.key, 'reason': reason}, null);

  @override
  Future<Result<void>> linkAccount(String shareholderId, String? uid, {String? reason}) async =>
      _respond<void>('linkAccount', {'id': shareholderId, 'uid': uid}, null);

  @override
  Future<Result<void>> createShareClass({required String code, required String name, required Money valuePerShare, String? description}) async =>
      _respond<void>('createShareClass', {'code': code, 'name': name, 'valuePerShareUgx': valuePerShare.ugx}, null);

  @override
  Future<Result<void>> updateShareClass(String classId, {String? name, Money? valuePerShare, bool? active, String? reason}) async =>
      _respond<void>('updateShareClass', {'classId': classId, 'valuePerShareUgx': valuePerShare?.ugx, 'active': active, 'reason': reason}, null);

  @override
  Future<Result<void>> updatePolicy(String policy, Map<String, bool> changes, {required String reason}) async =>
      _respond<void>('updatePolicy', {'policy': policy, ...changes, 'reason': reason}, null);

  @override
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
  }) async =>
      _respond('issueShares', {
        'shareholderId': shareholderId, 'classId': classId, 'shares': shares, 'payment': payment.toJson(), 'requestId': requestId, 'reason': reason,
      }, 'txn-new');

  @override
  Future<Result<String>> transferShares({
    required String fromShareholderId,
    required String toShareholderId,
    required String classId,
    required int shares,
    required DateTime effectiveDate,
    required String reason,
    required String requestId,
    String? reference,
  }) async =>
      _respond('transferShares', {'from': fromShareholderId, 'to': toShareholderId, 'classId': classId, 'shares': shares, 'reason': reason}, 'txn-new');

  @override
  Future<Result<String>> adjustShares({
    required String shareholderId,
    required String classId,
    required int deltaShares,
    required bool adjustCommitment,
    required DateTime effectiveDate,
    required String reason,
    required String requestId,
    String? reference,
  }) async =>
      _respond('adjustShares', {'shareholderId': shareholderId, 'deltaShares': deltaShares, 'reason': reason}, 'txn-new');

  @override
  Future<Result<void>> decideShareTransaction(String transactionId, ShareDecision decision, {String? reason}) async =>
      _respond<void>('decideShareTransaction', {'id': transactionId, 'decision': decision.name, 'reason': reason}, null);

  @override
  Future<Result<void>> reverseShareTransaction(String transactionId, {required String reason, required String requestId}) async =>
      _respond<void>('reverseShareTransaction', {'id': transactionId, 'reason': reason}, null);

  @override
  Future<Result<void>> recordContribution(String shareTransactionId,
          {required SharePayment payment, required DateTime paymentDate, required String requestId, String? reference, String? reason}) async =>
      _respond<void>('recordContribution', {'id': shareTransactionId, ...payment.toJson()}, null);

  @override
  Future<Result<void>> reverseContribution(String contributionId, {required String reason}) async =>
      _respond<void>('reverseContribution', {'id': contributionId, 'reason': reason}, null);

  @override
  Future<Result<OwnershipSnapshot>> ownershipAsOf(DateTime date, {String? classId}) async => _respond('ownershipAsOf', {'date': date}, snapshot);

  @override
  Future<Result<MyShareholding>> myShareholding() async => _respond('myShareholding', {}, mine);

  @override
  Future<Result<String>> createDividend(DividendDraft draft, {required String requestId}) async =>
      _respond('createDividend', draft.toJson(), 'div-new');

  @override
  Future<Result<void>> updateDividend(String dividendId, DividendDraft draft, {String? reason}) async =>
      _respond<void>('updateDividend', {'id': dividendId, ...draft.toJson()}, null);

  @override
  Future<Result<void>> calculateDividend(String dividendId) async => _respond<void>('calculateDividend', {'id': dividendId}, null);

  @override
  Future<Result<void>> dividendAction(String dividendId, DividendAction action, {String? reason}) async =>
      _respond<void>('dividendAction', {'id': dividendId, 'action': action.name, 'reason': reason}, null);

  @override
  Future<Result<void>> payDividend(String dividendId, List<String> allocationIds,
          {required String accountId, required String requestId, required DateTime paymentDate, String? reference}) async =>
      _respond<void>('payDividend', {'id': dividendId, 'allocationIds': allocationIds, 'accountId': accountId}, null);

  @override
  Future<Result<void>> reverseDividendPayment(String allocationId, {required String reason}) async =>
      _respond<void>('reverseDividendPayment', {'id': allocationId, 'reason': reason}, null);

  @override
  Future<Result<void>> cancelDividend(String dividendId, {required String reason}) async =>
      _respond<void>('cancelDividend', {'id': dividendId, 'reason': reason}, null);
}
