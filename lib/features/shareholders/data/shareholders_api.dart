import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../models/shareholding.dart';

/// What someone entered for a shareholder profile. The server validates it.
class ShareholderDraft {
  const ShareholderDraft({required this.fullName, this.phoneNumber, this.email, this.address, this.idType, this.idNumber, this.notes, this.joinDate});
  final String fullName;
  final String? phoneNumber;
  final String? email;
  final String? address;
  final IdentificationType? idType;
  final String? idNumber;
  final String? notes;
  final DateTime? joinDate;

  Map<String, Object?> toJson() => {
        'fullName': fullName,
        'phoneNumber': phoneNumber,
        'email': email,
        'address': address,
        'idType': idType?.key,
        'idNumber': idNumber,
        'notes': notes,
        'joinDate': ?joinDate?.millisecondsSinceEpoch,
      };
}

/// Money received with a share issue (or later). Totals are never sent: the
/// server works out the commitment from the class's value per share.
class SharePayment {
  const SharePayment({required this.source, this.amount = Money.zero, this.accountId});
  final ContributionSource source;
  final Money amount;
  final String? accountId;

  Map<String, Object?> toJson() => {
        'source': source.key,
        if (source != ContributionSource.none) 'amountUgx': amount.ugx,
        'accountId': ?accountId,
      };
}

/// A dividend declaration draft. Allocations are never sent - the server calculates them.
class DividendDraft {
  const DividendDraft({
    required this.financialPeriod,
    required this.recordDate,
    required this.declarationDate,
    required this.method,
    this.totalDistributable,
    this.perShare,
    this.paymentDate,
    this.classId,
    this.notes,
  });

  final String financialPeriod;
  final DateTime recordDate;
  final DateTime declarationDate;
  final DateTime? paymentDate;
  final DividendMethod method;
  final Money? totalDistributable;
  final Money? perShare;
  final String? classId;
  final String? notes;

  Map<String, Object?> toJson() => {
        'financialPeriod': financialPeriod,
        'recordDate': recordDate.millisecondsSinceEpoch,
        'declarationDate': declarationDate.millisecondsSinceEpoch,
        'paymentDate': ?paymentDate?.millisecondsSinceEpoch,
        'calculationMethod': method.key,
        if (method == DividendMethod.pool) 'totalDistributableUgx': totalDistributable?.ugx,
        if (method == DividendMethod.perShare) 'dividendPerShareUgx': perShare?.ugx,
        'classId': classId,
        'notes': ?notes,
      };
}

enum ShareDecision { approve, reject }

enum DividendAction { declare, returnToDraft, approve }

/// Phase 7 commands - Cloud Functions in functions/src/{shareholders,shares,
/// dividends}.js. Every total, percentage and allocation is decided there.
abstract class ShareholdersApi {
  Future<Result<String>> createShareholder(ShareholderDraft draft, {required String requestId});
  Future<Result<void>> updateShareholder(String shareholderId, Map<String, Object?> changes, {String? reason});
  Future<Result<void>> setStatus(String shareholderId, ShareholderStatus status, {required String reason});
  Future<Result<void>> linkAccount(String shareholderId, String? uid, {String? reason});
  Future<Result<void>> createShareClass({required String code, required String name, required Money valuePerShare, String? description});
  Future<Result<void>> updateShareClass(String classId, {String? name, Money? valuePerShare, bool? active, String? reason});
  Future<Result<void>> updatePolicy(String policy, Map<String, bool> changes, {required String reason});

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
  });
  Future<Result<String>> transferShares({
    required String fromShareholderId,
    required String toShareholderId,
    required String classId,
    required int shares,
    required DateTime effectiveDate,
    required String reason,
    required String requestId,
    String? reference,
  });
  Future<Result<String>> adjustShares({
    required String shareholderId,
    required String classId,
    required int deltaShares,
    required bool adjustCommitment,
    required DateTime effectiveDate,
    required String reason,
    required String requestId,
    String? reference,
  });
  Future<Result<void>> decideShareTransaction(String transactionId, ShareDecision decision, {String? reason});
  Future<Result<void>> reverseShareTransaction(String transactionId, {required String reason, required String requestId});
  Future<Result<void>> recordContribution(String shareTransactionId,
      {required SharePayment payment, required DateTime paymentDate, required String requestId, String? reference, String? reason});
  Future<Result<void>> reverseContribution(String contributionId, {required String reason});
  Future<Result<OwnershipSnapshot>> ownershipAsOf(DateTime date, {String? classId});
  Future<Result<MyShareholding>> myShareholding();

  Future<Result<String>> createDividend(DividendDraft draft, {required String requestId});
  Future<Result<void>> updateDividend(String dividendId, DividendDraft draft, {String? reason});
  Future<Result<void>> calculateDividend(String dividendId);
  Future<Result<void>> dividendAction(String dividendId, DividendAction action, {String? reason});
  Future<Result<void>> payDividend(String dividendId, List<String> allocationIds,
      {required String accountId, required String requestId, required DateTime paymentDate, String? reference});
  Future<Result<void>> reverseDividendPayment(String allocationId, {required String reason});
  Future<Result<void>> cancelDividend(String dividendId, {required String reason});
}

class CallableShareholdersApi implements ShareholdersApi {
  CallableShareholdersApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<Map<String, dynamic>>> _call(String name, Map<String, Object?> data) => callFunction(_functions, name, data);

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await _call(name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  Future<Result<String>> _id(String name, Map<String, Object?> data, String key) async =>
      (await _call(name, data)).when(success: (d) => Success(d[key] as String), failure: Failure.new);

  @override
  Future<Result<String>> createShareholder(ShareholderDraft draft, {required String requestId}) =>
      _id('createShareholder', {...draft.toJson(), 'requestId': requestId}, 'shareholderId');

  @override
  Future<Result<void>> updateShareholder(String shareholderId, Map<String, Object?> changes, {String? reason}) =>
      _done('updateShareholder', {'shareholderId': shareholderId, ...changes, 'reason': ?reason});

  @override
  Future<Result<void>> setStatus(String shareholderId, ShareholderStatus status, {required String reason}) =>
      _done('setShareholderStatus', {'shareholderId': shareholderId, 'status': status.key, 'reason': reason});

  @override
  Future<Result<void>> linkAccount(String shareholderId, String? uid, {String? reason}) =>
      _done('linkShareholderAccount', {'shareholderId': shareholderId, 'uid': uid, 'reason': ?reason});

  @override
  Future<Result<void>> createShareClass({required String code, required String name, required Money valuePerShare, String? description}) =>
      _done('createShareClass', {'code': code, 'name': name, 'valuePerShareUgx': valuePerShare.ugx, 'description': ?description});

  @override
  Future<Result<void>> updateShareClass(String classId, {String? name, Money? valuePerShare, bool? active, String? reason}) =>
      _done('updateShareClass', {
        'classId': classId,
        'name': ?name,
        'valuePerShareUgx': ?valuePerShare?.ugx,
        'active': ?active,
        'reason': ?reason,
      });

  @override
  Future<Result<void>> updatePolicy(String policy, Map<String, bool> changes, {required String reason}) =>
      _done('updateShareholdingPolicy', {'policy': policy, 'changes': changes, 'reason': reason});

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
  }) =>
      _id('issueShares', {
        'shareholderId': shareholderId,
        'classId': classId,
        'shares': shares,
        'payment': payment.toJson(),
        'effectiveDate': effectiveDate.millisecondsSinceEpoch,
        'requestId': requestId,
        'reference': ?reference,
        'notes': ?notes,
        'reason': ?reason,
      }, 'transactionId');

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
  }) =>
      _id('transferShares', {
        'fromShareholderId': fromShareholderId,
        'toShareholderId': toShareholderId,
        'classId': classId,
        'shares': shares,
        'effectiveDate': effectiveDate.millisecondsSinceEpoch,
        'reason': reason,
        'requestId': requestId,
        'reference': ?reference,
      }, 'transactionId');

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
  }) =>
      _id('adjustShares', {
        'shareholderId': shareholderId,
        'classId': classId,
        'deltaShares': deltaShares,
        'adjustCommitment': adjustCommitment,
        'effectiveDate': effectiveDate.millisecondsSinceEpoch,
        'reason': reason,
        'requestId': requestId,
        'reference': ?reference,
      }, 'transactionId');

  @override
  Future<Result<void>> decideShareTransaction(String transactionId, ShareDecision decision, {String? reason}) =>
      _done('decideShareTransaction', {'transactionId': transactionId, 'decision': decision.name, 'reason': ?reason});

  @override
  Future<Result<void>> reverseShareTransaction(String transactionId, {required String reason, required String requestId}) =>
      _done('reverseShareTransaction', {'transactionId': transactionId, 'reason': reason, 'requestId': requestId});

  @override
  Future<Result<void>> recordContribution(String shareTransactionId,
          {required SharePayment payment, required DateTime paymentDate, required String requestId, String? reference, String? reason}) =>
      _done('recordShareContribution', {
        'shareTransactionId': shareTransactionId,
        ...payment.toJson(),
        'paymentDate': paymentDate.millisecondsSinceEpoch,
        'requestId': requestId,
        'reference': ?reference,
        'reason': ?reason,
      });

  @override
  Future<Result<void>> reverseContribution(String contributionId, {required String reason}) =>
      _done('reverseShareContribution', {'contributionId': contributionId, 'reason': reason});

  @override
  Future<Result<OwnershipSnapshot>> ownershipAsOf(DateTime date, {String? classId}) async =>
      (await _call('getOwnershipAsOf', {'date': date.millisecondsSinceEpoch, 'classId': ?classId}))
          .when(success: (d) => Success(OwnershipSnapshot.fromMap(d)), failure: Failure.new);

  @override
  Future<Result<MyShareholding>> myShareholding() async =>
      (await _call('getMyShareholding', {})).when(success: (d) => Success(MyShareholding.fromMap(d)), failure: Failure.new);

  @override
  Future<Result<String>> createDividend(DividendDraft draft, {required String requestId}) =>
      _id('createDividend', {...draft.toJson(), 'requestId': requestId}, 'dividendId');

  @override
  Future<Result<void>> updateDividend(String dividendId, DividendDraft draft, {String? reason}) =>
      _done('updateDividend', {'dividendId': dividendId, ...draft.toJson(), 'reason': ?reason});

  @override
  Future<Result<void>> calculateDividend(String dividendId) => _done('calculateDividend', {'dividendId': dividendId});

  @override
  Future<Result<void>> dividendAction(String dividendId, DividendAction action, {String? reason}) => _done('updateDividendStatus', {
        'dividendId': dividendId,
        'action': switch (action) { DividendAction.declare => 'declare', DividendAction.returnToDraft => 'return', DividendAction.approve => 'approve' },
        'reason': ?reason,
      });

  @override
  Future<Result<void>> payDividend(String dividendId, List<String> allocationIds,
          {required String accountId, required String requestId, required DateTime paymentDate, String? reference}) =>
      _done('payDividend', {
        'dividendId': dividendId,
        'allocationIds': allocationIds,
        'accountId': accountId,
        'requestId': requestId,
        'paymentDate': paymentDate.millisecondsSinceEpoch,
        'reference': ?reference,
      });

  @override
  Future<Result<void>> reverseDividendPayment(String allocationId, {required String reason}) =>
      _done('reverseDividendPayment', {'allocationId': allocationId, 'reason': reason});

  @override
  Future<Result<void>> cancelDividend(String dividendId, {required String reason}) =>
      _done('cancelDividend', {'dividendId': dividendId, 'reason': reason});
}
