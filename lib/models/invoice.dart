import '../core/money/money.dart';
import 'firestore_converters.dart';

/// Where an invoice stands. Computed by the server from the amounts
/// (functions/src/billing.js); the app never decides it.
enum PaymentStatus {
  unpaid('unpaid', 'Unpaid'),
  partiallyPaid('partially_paid', 'Partially paid'),
  credit('credit', 'Credit'),
  paid('paid', 'Paid'),
  cancelled('cancelled', 'Cancelled');

  const PaymentStatus(this.key, this.label);
  final String key;
  final String label;

  static PaymentStatus parse(Object? value) => values.firstWhere((s) => s.key == value, orElse: () => unpaid);

  /// Money is still owed on it.
  bool get isOutstanding => this == unpaid || this == partiallyPaid || this == credit;

  static const List<PaymentStatus> outstanding = [unpaid, partiallyPaid, credit];
}

enum DiscountType {
  percentage('percentage', 'Percentage'),
  fixed('fixed', 'Fixed amount');

  const DiscountType(this.key, this.label);
  final String key;
  final String label;

  static DiscountType parse(Object? v) => v == 'fixed' ? fixed : percentage;
}

/// Why a discount was given. [loyaltyReward] is applied only through the
/// loyalty flow, never picked by hand.
enum DiscountReason {
  managerApproval('manager_approval', 'Manager approval'),
  promotional('promotional', 'Promotional offer'),
  serviceIssue('service_issue', 'Service issue / goodwill'),
  other('other', 'Other'),
  loyaltyReward('loyalty_reward', 'Loyalty reward');

  const DiscountReason(this.key, this.label);
  final String key;
  final String label;

  static DiscountReason parse(Object? v) => values.firstWhere((r) => r.key == v, orElse: () => other);

  static const List<DiscountReason> manual = [managerApproval, promotional, serviceIssue, other];
}

/// Discounts larger than this share of the subtotal need `discounts.approve`
/// (mirrors APPROVAL_THRESHOLD_PERCENT in functions/src/billing.js).
const int discountApprovalThresholdPercent = 25;

/// Server-side rounding, reproduced for previews: half-up whole shillings.
Money percentOf(Money amount, int percent) => amount.percentage(percent * 100);

/// Discount amount the server would compute, or null if it would be refused.
Money? previewDiscount(Money subtotal, DiscountType type, int value) {
  if (value <= 0) return null;
  final amount = switch (type) {
    DiscountType.percentage => value > 100 ? null : percentOf(subtotal, value),
    DiscountType.fixed => value > subtotal.ugx ? null : Money(value),
  };
  return amount == null || !amount.isPositive ? null : amount;
}

class InvoiceItem {
  const InvoiceItem({required this.serviceName, required this.price, this.serviceId, this.orderNumber, this.workerName, this.qualifiesForLoyalty = false});

  final String? serviceId;
  final String serviceName;
  final String? orderNumber;
  final String? workerName;
  final Money price;
  final bool qualifiesForLoyalty;

  static InvoiceItem fromMap(Map<String, dynamic> m) => InvoiceItem(
        serviceId: m['serviceId'] as String?,
        serviceName: m['serviceName'] as String? ?? '',
        orderNumber: m['orderNumber'] as String?,
        workerName: m['workerName'] as String?,
        price: Money((m['priceUgx'] as num?)?.toInt() ?? 0),
        qualifiesForLoyalty: m['qualifiesForLoyalty'] == true,
      );
}

class InvoiceDiscount {
  const InvoiceDiscount({
    required this.type,
    required this.value,
    required this.amount,
    required this.reasonCode,
    required this.reason,
    this.description,
    this.approvedBy,
    this.createdBy,
    this.createdByName,
    this.createdAt,
    this.rewardId,
  });

  final DiscountType type;
  final int value;
  final Money amount;
  final DiscountReason reasonCode;
  final String reason;
  final String? description;
  final String? approvedBy;
  final String? createdBy;
  final String? createdByName;
  final DateTime? createdAt;
  final String? rewardId;

  bool get isLoyaltyReward => reasonCode == DiscountReason.loyaltyReward;

  String get label => type == DiscountType.percentage ? '$value% · $reason' : reason;

  static InvoiceDiscount fromMap(Map<String, dynamic> m) => InvoiceDiscount(
        type: DiscountType.parse(m['discountType']),
        value: (m['discountValue'] as num?)?.toInt() ?? 0,
        amount: Money((m['discountAmount'] as num?)?.toInt() ?? 0),
        reasonCode: DiscountReason.parse(m['reasonCode']),
        reason: m['reason'] as String? ?? '',
        description: m['description'] as String?,
        approvedBy: m['approvedBy'] as String?,
        createdBy: m['createdBy'] as String?,
        createdByName: m['createdByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(m['createdAt']),
        rewardId: m['rewardId'] as String?,
      );
}

/// `invoices/{id}`: the bill for a completed job. Amounts are whole UGX and
/// always consistent (total = subtotal − discount; outstanding = total −
/// paid), because only the server writes them.
class Invoice {
  const Invoice({
    required this.invoiceId,
    required this.invoiceNumber,
    required this.serviceIntakeId,
    required this.vehicleId,
    required this.numberPlate,
    required this.items,
    required this.subtotal,
    required this.discountAmount,
    required this.total,
    required this.paid,
    required this.outstanding,
    required this.paymentStatus,
    this.jobNumber,
    this.vehicleSummary,
    this.customerId,
    this.customerName,
    this.discount,
    this.onCredit = false,
    this.creditReason,
    this.creditMarkedAt,
    this.paymentCount = 0,
    this.lastPaymentAt,
    this.loyaltyPointsEarned = 0,
    this.cancelReason,
    this.issuedAt,
    this.createdByName,
    this.notes,
  });

  final String invoiceId;
  final String invoiceNumber;
  final String serviceIntakeId;
  final String? jobNumber;
  final String vehicleId;
  final String numberPlate;
  final String? vehicleSummary;
  final String? customerId;
  final String? customerName;
  final List<InvoiceItem> items;
  final Money subtotal;
  final Money discountAmount;
  final Money total;
  final Money paid;
  final Money outstanding;
  final PaymentStatus paymentStatus;
  final InvoiceDiscount? discount;
  final bool onCredit;
  final String? creditReason;
  final DateTime? creditMarkedAt;
  final int paymentCount;
  final DateTime? lastPaymentAt;
  final int loyaltyPointsEarned;
  final String? cancelReason;
  final DateTime? issuedAt;
  final String? createdByName;
  final String? notes;

  bool get isCancelled => paymentStatus == PaymentStatus.cancelled;

  /// A discount (manual or loyalty) can still be applied.
  bool get canDiscount => !isCancelled && discount == null && paid.isZero && subtotal.isPositive;

  bool get canPay => !isCancelled && outstanding.isPositive;

  bool get canCancel => !isCancelled && paid.isZero;

  bool get canMarkCredit => canPay && !onCredit;

  /// How long the balance has been owed (from issue), for the credit screen.
  Duration debtAge(DateTime now) => issuedAt == null ? Duration.zero : now.difference(issuedAt!);

  static Invoice fromFirestore(String id, Map<String, dynamic> d) {
    Money m(String f) => Money((d[f] as num?)?.toInt() ?? 0);
    final discount = d['discount'];
    return Invoice(
      invoiceId: id,
      invoiceNumber: d['invoiceNumber'] as String? ?? '',
      serviceIntakeId: d['serviceIntakeId'] as String? ?? '',
      jobNumber: d['jobNumber'] as String?,
      vehicleId: d['vehicleId'] as String? ?? '',
      numberPlate: d['numberPlate'] as String? ?? '',
      vehicleSummary: d['vehicleSummary'] as String?,
      customerId: d['customerId'] as String?,
      customerName: d['customerName'] as String?,
      items: [
        for (final i in (d['items'] as List? ?? const []))
          if (i is Map) InvoiceItem.fromMap(i.map((k, v) => MapEntry(k.toString(), v))),
      ],
      subtotal: m('subtotalUgx'),
      discountAmount: m('discountUgx'),
      total: m('totalUgx'),
      paid: m('paidUgx'),
      outstanding: m('outstandingUgx'),
      paymentStatus: PaymentStatus.parse(d['paymentStatus']),
      discount: discount is Map ? InvoiceDiscount.fromMap(discount.map((k, v) => MapEntry(k.toString(), v))) : null,
      onCredit: d['onCredit'] == true,
      creditReason: d['creditReason'] as String?,
      creditMarkedAt: FirestoreConverters.toDateTime(d['creditMarkedAt']),
      paymentCount: (d['paymentCount'] as num?)?.toInt() ?? 0,
      lastPaymentAt: FirestoreConverters.toDateTime(d['lastPaymentAt']),
      loyaltyPointsEarned: (d['loyaltyPointsEarned'] as num?)?.toInt() ?? 0,
      cancelReason: d['cancelReason'] as String?,
      issuedAt: FirestoreConverters.toDateTime(d['issuedAt']) ?? FirestoreConverters.toDateTime(d['createdAt']),
      createdByName: d['createdByName'] as String?,
      notes: d['notes'] as String?,
    );
  }
}

/// Debt-age buckets for the credit screen.
enum DebtAge {
  today('Today'),
  week('This week'),
  month('This month'),
  older('Older');

  const DebtAge(this.label);
  final String label;

  static DebtAge of(Duration age) => age.inDays < 1
      ? today
      : age.inDays < 7
          ? week
          : age.inDays < 30
              ? month
              : older;
}
