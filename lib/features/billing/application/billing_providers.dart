import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../models/invoice.dart';
import '../../../models/loyalty.dart';
import '../../../models/payment.dart';
import '../data/billing_api.dart';
import '../data/billing_repository.dart';

final billingRepositoryProvider = Provider<BillingRepository>((ref) => BillingRepository(ref.watch(firestoreProvider)));

final billingApiProvider = Provider<BillingApi>((ref) => CallableBillingApi(ref.watch(firebaseFunctionsProvider)));

final invoicesProvider = StreamProvider.family<List<Invoice>, PaymentStatus?>(
    (ref, status) => ref.watch(billingRepositoryProvider).watchInvoices(status: status));

final invoiceProvider =
    StreamProvider.family<Invoice?, String>((ref, id) => ref.watch(billingRepositoryProvider).watchInvoice(id));

final outstandingInvoicesProvider =
    StreamProvider<List<Invoice>>((ref) => ref.watch(billingRepositoryProvider).watchOutstanding());

final vehicleInvoicesProvider = StreamProvider.family<List<Invoice>, String>(
    (ref, vehicleId) => ref.watch(billingRepositoryProvider).watchInvoicesFor(vehicleId: vehicleId));

final invoicePaymentsProvider = StreamProvider.family<List<Payment>, String>(
    (ref, invoiceId) => ref.watch(billingRepositoryProvider).watchPaymentsOf(invoiceId));

/// Payments list filter: period × method.
typedef PaymentFilter = ({PaymentPeriod period, PaymentMethod? method});

enum PaymentPeriod {
  today('Today'),
  week('7 days'),
  month('30 days'),
  all('All');

  const PaymentPeriod(this.label);
  final String label;

  /// Start of the period in East Africa Time business days.
  DateTime? since(DateTime now) => switch (this) {
        today => EastAfricaTime.dayBounds(now).$1,
        week => EastAfricaTime.dayBounds(now.subtract(const Duration(days: 6))).$1,
        month => EastAfricaTime.dayBounds(now.subtract(const Duration(days: 29))).$1,
        all => null,
      };
}

final paymentsProvider = StreamProvider.family<List<Payment>, PaymentFilter>((ref, f) {
  final now = ref.read(clockProvider).value ?? DateTime.now();
  return ref.watch(billingRepositoryProvider).watchPayments(method: f.method, since: f.period.since(now));
});

final receiptProvider =
    StreamProvider.family<Receipt?, String>((ref, id) => ref.watch(billingRepositoryProvider).watchReceipt(id));

final receiptsProvider = StreamProvider<List<Receipt>>((ref) => ref.watch(billingRepositoryProvider).watchReceipts());

final loyaltyConfigProvider =
    StreamProvider<LoyaltyConfig>((ref) => ref.watch(billingRepositoryProvider).watchLoyaltyConfig());

final loyaltyAccountProvider = StreamProvider.family<LoyaltyAccount, String>(
    (ref, vehicleId) => ref.watch(billingRepositoryProvider).watchLoyaltyAccount(vehicleId));

final loyaltyLedgerProvider = StreamProvider.family<List<LoyaltyTransaction>, String>(
    (ref, vehicleId) => ref.watch(billingRepositoryProvider).watchLedger(vehicleId));

final availableRewardProvider = StreamProvider.family<LoyaltyReward?, String>(
    (ref, vehicleId) => ref.watch(billingRepositoryProvider).watchAvailableReward(vehicleId));

final topLoyaltyAccountsProvider =
    StreamProvider<List<LoyaltyAccount>>((ref) => ref.watch(billingRepositoryProvider).watchTopAccounts());

/// Receivables summary for the credit screen and dashboards.
class CreditSummary {
  const CreditSummary({required this.total, required this.count, required this.byAge});
  final Money total;
  final int count;
  final Map<DebtAge, Money> byAge;

  static CreditSummary of(Iterable<Invoice> invoices, DateTime now) {
    final byAge = {for (final a in DebtAge.values) a: Money.zero};
    var total = Money.zero;
    var count = 0;
    for (final i in invoices) {
      if (!i.paymentStatus.isOutstanding) continue;
      total += i.outstanding;
      count++;
      final age = DebtAge.of(i.debtAge(now));
      byAge[age] = byAge[age]! + i.outstanding;
    }
    return CreditSummary(total: total, count: count, byAge: byAge);
  }
}

final billingActionsProvider = Provider<BillingActions>(BillingActions.new);

/// Invoice, payment, credit and loyalty commands. Online-only: amounts,
/// numbers and points are decided by the server in one transaction.
class BillingActions {
  BillingActions(this._ref);
  final Ref _ref;

  BillingApi get _api => _ref.read(billingApiProvider);

  Future<Result<String>> createInvoice(String intakeId) =>
      runOnline(_ref, () => _api.createInvoice(intakeId), event: AnalyticsEvents.invoiceCreated);

  Future<Result<void>> applyDiscount(String invoiceId,
          {required DiscountType type, required int value, required DiscountReason reason, String? description}) =>
      runOnline(_ref, () => _api.applyDiscount(invoiceId, type: type, value: value, reason: reason, description: description),
          event: AnalyticsEvents.discountApplied, params: {'outcome': type.key});

  Future<Result<void>> applyLoyaltyReward(String invoiceId, Money expected) =>
      runOnline(_ref, () => _api.applyLoyaltyReward(invoiceId, expected: expected), event: AnalyticsEvents.loyaltyRewardApplied);

  Future<Result<PaymentOutcome>> recordPayment(PaymentRequest request) =>
      runOnline(_ref, () => _api.recordPayment(request),
          event: AnalyticsEvents.paymentRecorded, params: {'outcome': request.method.key});

  Future<Result<void>> reversePayment(String paymentId, String reason) =>
      runOnline(_ref, () => _api.reversePayment(paymentId, reason: reason), event: AnalyticsEvents.paymentReversed);

  Future<Result<void>> markCredit(String invoiceId, String reason) =>
      runOnline(_ref, () => _api.markCredit(invoiceId, reason: reason), event: AnalyticsEvents.invoiceMarkedCredit);

  Future<Result<void>> cancelInvoice(String invoiceId, String reason) =>
      runOnline(_ref, () => _api.cancelInvoice(invoiceId, reason: reason), event: AnalyticsEvents.invoiceCancelled);

  Future<Result<void>> adjustLoyalty(String vehicleId, int points, String reason) =>
      runOnline(_ref, () => _api.adjustLoyaltyPoints(vehicleId, points, reason: reason), event: AnalyticsEvents.loyaltyAdjusted);

  Future<Result<void>> reverseLoyalty(String transactionId, String reason) =>
      runOnline(_ref, () => _api.reverseLoyaltyTransaction(transactionId, reason: reason),
          event: AnalyticsEvents.loyaltyAdjusted, params: {'outcome': 'reversal'});

  Future<void> logReceiptShared() async {
    try {
      await _ref.read(analyticsProvider).logEvent(AnalyticsEvents.receiptShared);
    } catch (_) {}
  }
}
