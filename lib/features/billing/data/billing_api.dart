import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../models/invoice.dart';
import '../../../models/payment.dart';

/// What the cashier asked for. The server decides every resulting amount.
class PaymentRequest {
  const PaymentRequest({
    required this.invoiceId,
    required this.amount,
    required this.method,
    required this.requestId,
    this.reference,
    this.notes,
    this.accountId,
  });

  final String invoiceId;
  final Money amount;
  final PaymentMethod method;

  /// Idempotency key: the same attempt retried is recorded once.
  final String requestId;
  final String? reference;
  final String? notes;

  /// Bank payments only: which bank account received it (Phase 5). Null lets
  /// the server use the only active bank account.
  final String? accountId;

  Map<String, Object?> toJson() => {
        'invoiceId': invoiceId,
        'amountUgx': amount.ugx,
        'method': method.key,
        'requestId': requestId,
        'reference': ?reference,
        'notes': ?notes,
        'accountId': ?accountId,
      };
}

class PaymentOutcome {
  const PaymentOutcome({
    required this.paymentId,
    required this.receiptId,
    required this.receiptNumber,
    required this.outstanding,
    required this.status,
    this.pointsEarned = 0,
    this.rewardUnlocked = false,
  });

  final String paymentId;
  final String receiptId;
  final String receiptNumber;
  final Money outstanding;
  final PaymentStatus status;
  final int pointsEarned;
  final bool rewardUnlocked;

  static PaymentOutcome fromJson(Map<String, dynamic> d) => PaymentOutcome(
        paymentId: d['paymentId'] as String? ?? '',
        receiptId: d['receiptId'] as String? ?? '',
        receiptNumber: d['receiptNumber'] as String? ?? '',
        outstanding: Money((d['outstandingUgx'] as num?)?.toInt() ?? 0),
        status: PaymentStatus.parse(d['paymentStatus']),
        pointsEarned: (d['pointsEarned'] as num?)?.toInt() ?? 0,
        rewardUnlocked: d['rewardUnlocked'] == true,
      );
}

/// Invoice, discount, payment, credit and loyalty commands — Cloud Functions
/// in functions/src/billing.js and loyalty.js. The app never writes a
/// total, balance, number, point or reward itself.
abstract class BillingApi {
  Future<Result<String>> createInvoice(String intakeId, {String? notes});
  Future<Result<void>> applyDiscount(String invoiceId,
      {required DiscountType type, required int value, required DiscountReason reason, String? description});

  /// [expected] is the amount shown in the preview; the server refuses
  /// (`preview_stale`) if it would apply anything else.
  Future<Result<void>> applyLoyaltyReward(String invoiceId, {required Money expected});
  Future<Result<PaymentOutcome>> recordPayment(PaymentRequest request);
  Future<Result<void>> reversePayment(String paymentId, {required String reason});
  Future<Result<void>> markCredit(String invoiceId, {required String reason});
  Future<Result<void>> cancelInvoice(String invoiceId, {required String reason});
  Future<Result<void>> adjustLoyaltyPoints(String vehicleId, int points, {required String reason});
  Future<Result<void>> reverseLoyaltyTransaction(String transactionId, {required String reason});
}

class CallableBillingApi implements BillingApi {
  CallableBillingApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await callFunction(_functions, name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<String>> createInvoice(String intakeId, {String? notes}) async =>
      (await callFunction(_functions, 'createInvoice', {'intakeId': intakeId, 'notes': ?notes}))
          .when(success: (d) => Success(d['invoiceId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> applyDiscount(String invoiceId,
          {required DiscountType type, required int value, required DiscountReason reason, String? description}) =>
      _done('applyInvoiceDiscount', {
        'invoiceId': invoiceId,
        'discountType': type.key,
        'discountValue': value,
        'reasonCode': reason.key,
        'description': ?description,
      });

  @override
  Future<Result<void>> applyLoyaltyReward(String invoiceId, {required Money expected}) =>
      _done('applyLoyaltyReward', {'invoiceId': invoiceId, 'expectedDiscountUgx': expected.ugx});

  @override
  Future<Result<PaymentOutcome>> recordPayment(PaymentRequest request) async =>
      (await callFunction(_functions, 'recordPayment', request.toJson()))
          .when(success: (d) => Success(PaymentOutcome.fromJson(d)), failure: Failure.new);

  @override
  Future<Result<void>> reversePayment(String paymentId, {required String reason}) =>
      _done('reversePayment', {'paymentId': paymentId, 'reason': reason});

  @override
  Future<Result<void>> markCredit(String invoiceId, {required String reason}) =>
      _done('markInvoiceCredit', {'invoiceId': invoiceId, 'reason': reason});

  @override
  Future<Result<void>> cancelInvoice(String invoiceId, {required String reason}) =>
      _done('cancelInvoice', {'invoiceId': invoiceId, 'reason': reason});

  @override
  Future<Result<void>> adjustLoyaltyPoints(String vehicleId, int points, {required String reason}) =>
      _done('adjustLoyaltyPoints', {'vehicleId': vehicleId, 'points': points, 'reason': reason});

  @override
  Future<Result<void>> reverseLoyaltyTransaction(String transactionId, {required String reason}) =>
      _done('reverseLoyaltyTransaction', {'transactionId': transactionId, 'reason': reason});
}
