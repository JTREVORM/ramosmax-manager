import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/invoice.dart';
import '../../../models/loyalty.dart';
import '../../../models/payment.dart';

/// Reads for invoices, payments, receipts and loyalty. Bounded and
/// index-backed (firebase/firestore.indexes.json); offline they come from the
/// cache. Every write goes through [BillingApi].
class BillingRepository {
  BillingRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 100;

  CollectionReference<Map<String, dynamic>> _c(String name) => _db.collection(name);

  List<Invoice> _invoices(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) Invoice.fromFirestore(d.id, d.data())];
  List<Payment> _payments(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) Payment.fromFirestore(d.id, d.data())];

  // --- Invoices ----------------------------------------------------------------

  /// Newest first, optionally one status. Index: invoices (paymentStatus, createdAt desc).
  Stream<List<Invoice>> watchInvoices({PaymentStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.invoices);
    if (status != null) q = q.where('paymentStatus', isEqualTo: status.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_invoices);
  }

  /// Everything still owed (unpaid, partially paid, credit), newest first.
  /// Index: invoices (paymentStatus, createdAt desc).
  Stream<List<Invoice>> watchOutstanding() => _c(FirestoreCollections.invoices)
      .where('paymentStatus', whereIn: [for (final s in PaymentStatus.outstanding) s.key])
      .orderBy('createdAt', descending: true)
      .limit(300)
      .snapshots()
      .map(_invoices);

  Stream<List<Invoice>> watchInvoicesFor({String? vehicleId, String? customerId}) => _c(FirestoreCollections.invoices)
      .where(vehicleId != null ? 'vehicleId' : 'customerId', isEqualTo: vehicleId ?? customerId)
      .orderBy('createdAt', descending: true)
      .limit(30)
      .snapshots()
      .map(_invoices);

  Stream<Invoice?> watchInvoice(String id) => _c(FirestoreCollections.invoices)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? Invoice.fromFirestore(s.id, s.data()!) : null);

  // --- Payments & receipts -----------------------------------------------------

  /// An invoice's payment history. Index: payments (invoiceId, receivedAt).
  Stream<List<Payment>> watchPaymentsOf(String invoiceId) => _c(FirestoreCollections.payments)
      .where('invoiceId', isEqualTo: invoiceId)
      .orderBy('receivedAt')
      .snapshots()
      .map(_payments);

  /// Recent payments, optionally one method, received on or after [since].
  /// Index: payments (method, receivedAt desc).
  Stream<List<Payment>> watchPayments({PaymentMethod? method, DateTime? since}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.payments);
    if (method != null) q = q.where('method', isEqualTo: method.key);
    if (since != null) q = q.where('receivedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(since));
    return q.orderBy('receivedAt', descending: true).limit(listLimit).snapshots().map(_payments);
  }

  Stream<Receipt?> watchReceipt(String id) => _c(FirestoreCollections.receipts)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? Receipt.fromFirestore(s.id, s.data()!) : null);

  Stream<List<Receipt>> watchReceipts() => _c(FirestoreCollections.receipts)
      .orderBy('issuedAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map((s) => [for (final d in s.docs) Receipt.fromFirestore(d.id, d.data())]);

  // --- Loyalty -----------------------------------------------------------------

  Stream<LoyaltyConfig> watchLoyaltyConfig() => _c(FirestoreCollections.settings)
      .doc('loyalty')
      .snapshots()
      .map((s) => LoyaltyConfig.fromMap(s.data()));

  Stream<LoyaltyAccount> watchLoyaltyAccount(String vehicleId) => _c(FirestoreCollections.loyaltyAccounts)
      .doc(vehicleId)
      .snapshots()
      .map((s) => s.exists ? LoyaltyAccount.fromFirestore(s.id, s.data()!) : LoyaltyAccount.none(vehicleId));

  /// Accounts with the most points first (a single-field index).
  Stream<List<LoyaltyAccount>> watchTopAccounts() => _c(FirestoreCollections.loyaltyAccounts)
      .orderBy('pointsBalance', descending: true)
      .limit(50)
      .snapshots()
      .map((s) => [for (final d in s.docs) LoyaltyAccount.fromFirestore(d.id, d.data())]);

  /// Index: loyalty_transactions (vehicleId, createdAt desc).
  Stream<List<LoyaltyTransaction>> watchLedger(String vehicleId) => _c(FirestoreCollections.loyaltyTransactions)
      .where('vehicleId', isEqualTo: vehicleId)
      .orderBy('createdAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map((s) => [for (final d in s.docs) LoyaltyTransaction.fromFirestore(d.id, d.data())]);

  /// Index: loyalty_rewards (vehicleId, status).
  Stream<LoyaltyReward?> watchAvailableReward(String vehicleId) => _c(FirestoreCollections.loyaltyRewards)
      .where('vehicleId', isEqualTo: vehicleId)
      .where('status', isEqualTo: RewardStatus.available.key)
      .limit(1)
      .snapshots()
      .map((s) => s.docs.isEmpty ? null : LoyaltyReward.fromFirestore(s.docs.first.id, s.docs.first.data()));
}
