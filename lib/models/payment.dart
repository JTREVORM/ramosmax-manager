import '../core/money/money.dart';
import 'firestore_converters.dart';

/// How a customer paid, and the (Phase 5) financial account it lands in.
/// Mirrors PAYMENT_METHODS in functions/src/billing.js.
enum PaymentMethod {
  cash('cash', 'Cash', 'cash_at_hand', needsReference: false),
  mtnMerchant('mtn_merchant', 'MTN Merchant', 'mtn_merchant'),
  airtelMerchant('airtel_merchant', 'Airtel Merchant', 'airtel_merchant'),
  bank('bank', 'Bank', 'bank');

  const PaymentMethod(this.key, this.label, this.accountKey, {this.needsReference = true});
  final String key;
  final String label;
  final String accountKey;

  /// Mobile money and bank payments need the transaction reference.
  final bool needsReference;

  static PaymentMethod parse(Object? v) => values.firstWhere((m) => m.key == v, orElse: () => cash);
}

/// `payments/{id}`: money received against an invoice. Never edited or
/// deleted; a mistake is reversed ([reversed]).
class Payment {
  const Payment({
    required this.paymentId,
    required this.invoiceId,
    required this.amount,
    required this.method,
    required this.reversed,
    this.invoiceNumber,
    this.numberPlate,
    this.customerName,
    this.reference,
    this.receiptId,
    this.receiptNumber,
    this.receivedByName,
    this.receivedAt,
    this.reversalReason,
  });

  final String paymentId;
  final String invoiceId;
  final String? invoiceNumber;
  final String? numberPlate;
  final String? customerName;
  final Money amount;
  final PaymentMethod method;
  final String? reference;
  final String? receiptId;
  final String? receiptNumber;
  final String? receivedByName;
  final DateTime? receivedAt;
  final bool reversed;
  final String? reversalReason;

  static Payment fromFirestore(String id, Map<String, dynamic> d) => Payment(
        paymentId: id,
        invoiceId: d['invoiceId'] as String? ?? '',
        invoiceNumber: d['invoiceNumber'] as String?,
        numberPlate: d['numberPlate'] as String?,
        customerName: d['customerName'] as String?,
        amount: Money((d['amountUgx'] as num?)?.toInt() ?? 0),
        method: PaymentMethod.parse(d['method']),
        reference: d['reference'] as String?,
        receiptId: d['receiptId'] as String?,
        receiptNumber: d['receiptNumber'] as String?,
        receivedByName: d['receivedByName'] as String?,
        receivedAt: FirestoreConverters.toDateTime(d['receivedAt']),
        reversed: d['status'] == 'reversed',
        reversalReason: d['reversalReason'] as String?,
      );
}

class ReceiptLine {
  const ReceiptLine(this.serviceName, this.price);
  final String serviceName;
  final Money price;
}

/// `receipts/{id}`: a full snapshot of one payment, as handed to the
/// customer. Reprinting or sharing it never recalculates anything.
class Receipt {
  const Receipt({
    required this.receiptId,
    required this.receiptNumber,
    required this.businessName,
    required this.invoiceId,
    required this.numberPlate,
    required this.lines,
    required this.subtotal,
    required this.discount,
    required this.total,
    required this.amountPaid,
    required this.totalPaid,
    required this.outstanding,
    required this.method,
    required this.reversed,
    this.invoiceNumber,
    this.jobNumber,
    this.vehicleSummary,
    this.customerName,
    this.discountLabel,
    this.reference,
    this.cashierName,
    this.issuedAt,
    this.loyaltyPointsEarned = 0,
    this.loyaltyPointsBalance,
  });

  final String receiptId;
  final String receiptNumber;
  final String businessName;
  final String invoiceId;
  final String? invoiceNumber;
  final String? jobNumber;
  final String numberPlate;
  final String? vehicleSummary;
  final String? customerName;
  final List<ReceiptLine> lines;
  final Money subtotal;
  final Money discount;
  final String? discountLabel;
  final Money total;
  final Money amountPaid;
  final Money totalPaid;
  final Money outstanding;
  final PaymentMethod method;
  final String? reference;
  final String? cashierName;
  final DateTime? issuedAt;
  final bool reversed;
  final int loyaltyPointsEarned;
  final int? loyaltyPointsBalance;

  static Receipt fromFirestore(String id, Map<String, dynamic> d) {
    Money m(String f) => Money((d[f] as num?)?.toInt() ?? 0);
    return Receipt(
      receiptId: id,
      receiptNumber: d['receiptNumber'] as String? ?? '',
      businessName: d['businessName'] as String? ?? 'RamosMAX Automotive Care (U) Ltd',
      invoiceId: d['invoiceId'] as String? ?? '',
      invoiceNumber: d['invoiceNumber'] as String?,
      jobNumber: d['jobNumber'] as String?,
      numberPlate: d['numberPlate'] as String? ?? '',
      vehicleSummary: d['vehicleSummary'] as String?,
      customerName: d['customerName'] as String?,
      lines: [
        for (final l in (d['items'] as List? ?? const []))
          if (l is Map) ReceiptLine(l['serviceName'] as String? ?? '', Money((l['priceUgx'] as num?)?.toInt() ?? 0)),
      ],
      subtotal: m('subtotalUgx'),
      discount: m('discountUgx'),
      discountLabel: d['discountLabel'] as String?,
      total: m('totalUgx'),
      amountPaid: m('amountPaidUgx'),
      totalPaid: m('totalPaidUgx'),
      outstanding: m('outstandingUgx'),
      method: PaymentMethod.parse(d['method']),
      reference: d['reference'] as String?,
      cashierName: d['cashierName'] as String?,
      issuedAt: FirestoreConverters.toDateTime(d['issuedAt']),
      reversed: d['status'] == 'reversed',
      loyaltyPointsEarned: (d['loyaltyPointsEarned'] as num?)?.toInt() ?? 0,
      loyaltyPointsBalance: (d['loyaltyPointsBalance'] as num?)?.toInt(),
    );
  }
}
