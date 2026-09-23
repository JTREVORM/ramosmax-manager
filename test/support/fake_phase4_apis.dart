import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/billing/data/billing_api.dart';
import 'package:ramosmax_auto_manager/features/jobs/data/jobs_api.dart';
import 'package:ramosmax_auto_manager/models/invoice.dart';
import 'package:ramosmax_auto_manager/models/work_order.dart';

/// Records calls instead of calling Cloud Functions. Server behaviour is
/// tested against the emulator in functions/test/{jobs,billing,loyalty}.test.js.
class _Recorder {
  final List<(String, Map<String, Object?>)> calls = [];
  AppFailure? nextFailure;

  Iterable<String> get names => calls.map((c) => c.$1);

  Result<T> respond<T>(String name, Map<String, Object?> args, T value) {
    calls.add((name, args));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(value);
  }
}

class FakeJobsApi extends _Recorder implements JobsApi {
  @override
  Future<Result<void>> assign(String workerOrderId, String workerId, {String? notes}) async =>
      respond<void>('assign', {'workerOrderId': workerOrderId, 'workerId': workerId}, null);

  @override
  Future<Result<void>> reassign(String workerOrderId, String workerId, {required String reason}) async =>
      respond<void>('reassign', {'workerOrderId': workerOrderId, 'workerId': workerId, 'reason': reason}, null);

  @override
  Future<Result<void>> cancelOrder(String workerOrderId, {required String reason}) async =>
      respond<void>('cancelOrder', {'workerOrderId': workerOrderId, 'reason': reason}, null);

  @override
  Future<Result<void>> updateStatus(String workerOrderId, WorkerAction action, {String? reason, String? completionNotes}) async =>
      respond<void>('updateStatus',
          {'workerOrderId': workerOrderId, 'action': action.key, 'reason': reason, 'completionNotes': completionNotes}, null);
}

class FakeBillingApi extends _Recorder implements BillingApi {
  PaymentOutcome paymentOutcome = const PaymentOutcome(
    paymentId: 'p-new',
    receiptId: 'r-new',
    receiptNumber: 'RMX-RCP-000009',
    outstanding: Money.zero,
    status: PaymentStatus.paid,
  );

  @override
  Future<Result<String>> createInvoice(String intakeId, {String? notes}) async =>
      respond('createInvoice', {'intakeId': intakeId}, 'inv-new');

  @override
  Future<Result<void>> applyDiscount(String invoiceId,
          {required DiscountType type, required int value, required DiscountReason reason, String? description}) async =>
      respond<void>('applyDiscount',
          {'invoiceId': invoiceId, 'type': type.key, 'value': value, 'reason': reason.key, 'description': description}, null);

  @override
  Future<Result<void>> applyLoyaltyReward(String invoiceId, {required Money expected}) async =>
      respond<void>('applyLoyaltyReward', {'invoiceId': invoiceId, 'expected': expected.ugx}, null);

  @override
  Future<Result<PaymentOutcome>> recordPayment(PaymentRequest request) async =>
      respond('recordPayment', request.toJson(), paymentOutcome);

  @override
  Future<Result<void>> reversePayment(String paymentId, {required String reason}) async =>
      respond<void>('reversePayment', {'paymentId': paymentId, 'reason': reason}, null);

  @override
  Future<Result<void>> markCredit(String invoiceId, {required String reason}) async =>
      respond<void>('markCredit', {'invoiceId': invoiceId, 'reason': reason}, null);

  @override
  Future<Result<void>> cancelInvoice(String invoiceId, {required String reason}) async =>
      respond<void>('cancelInvoice', {'invoiceId': invoiceId, 'reason': reason}, null);

  @override
  Future<Result<void>> adjustLoyaltyPoints(String vehicleId, int points, {required String reason}) async =>
      respond<void>('adjustLoyaltyPoints', {'vehicleId': vehicleId, 'points': points, 'reason': reason}, null);

  @override
  Future<Result<void>> reverseLoyaltyTransaction(String transactionId, {required String reason}) async =>
      respond<void>('reverseLoyaltyTransaction', {'transactionId': transactionId, 'reason': reason}, null);
}
