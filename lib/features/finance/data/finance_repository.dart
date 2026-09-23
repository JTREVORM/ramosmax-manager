import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/finance.dart';

/// Reads for accounts, the ledger, deposits, reconciliations and the daily
/// summaries. Bounded and index-backed (firebase/firestore.indexes.json);
/// offline they come from the cache. Every write goes through [FinanceApi].
class FinanceRepository {
  FinanceRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 100;

  CollectionReference<Map<String, dynamic>> _c(String name) => _db.collection(name);

  List<FinancialTransaction> _txns(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) FinancialTransaction.fromFirestore(d.id, d.data())];

  /// Every account (a small collection), plus defaults not yet created.
  Stream<List<FinancialAccount>> watchAccounts() => _c(FirestoreCollections.financialAccounts)
      .limit(100)
      .snapshots()
      .map((s) => FinancialAccount.withDefaults([for (final d in s.docs) FinancialAccount.fromFirestore(d.id, d.data())]));

  Stream<FinancialAccount?> watchAccount(String id) => _c(FirestoreCollections.financialAccounts).doc(id).snapshots().map((s) {
        if (s.exists) return FinancialAccount.fromFirestore(s.id, s.data()!);
        return DefaultAccounts.all.containsKey(id) ? FinancialAccount.placeholder(id) : null;
      });

  /// Newest first, optionally one type. Index: financial_transactions (type, createdAt desc).
  Stream<List<FinancialTransaction>> watchTransactions({TransactionType? type, int limit = listLimit}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.financialTransactions);
    if (type != null) q = q.where('type', isEqualTo: type.key);
    return q.orderBy('createdAt', descending: true).limit(limit).snapshots().map(_txns);
  }

  /// An account statement. Index: financial_transactions (accountIds contains, createdAt desc).
  Stream<List<FinancialTransaction>> watchAccountTransactions(String accountId) => _c(FirestoreCollections.financialTransactions)
      .where('accountIds', arrayContains: accountId)
      .orderBy('createdAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map(_txns);

  Stream<FinancialTransaction?> watchTransaction(String id) => _c(FirestoreCollections.financialTransactions)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? FinancialTransaction.fromFirestore(s.id, s.data()!) : null);

  Stream<List<BankDeposit>> watchDeposits() => _c(FirestoreCollections.bankDeposits)
      .orderBy('createdAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map((s) => [for (final d in s.docs) BankDeposit.fromFirestore(d.id, d.data())]);

  /// Index: reconciliations (accountId, createdAt desc).
  Stream<List<Reconciliation>> watchReconciliations({String? accountId}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.reconciliations);
    if (accountId != null) q = q.where('accountId', isEqualTo: accountId);
    return q
        .orderBy('createdAt', descending: true)
        .limit(listLimit)
        .snapshots()
        .map((s) => [for (final d in s.docs) Reconciliation.fromFirestore(d.id, d.data())]);
  }

  /// Daily totals from [from] (inclusive) to [to] (exclusive), oldest first.
  Stream<List<DailyFinanceSummary>> watchDailySummaries(DateTime from, DateTime to) => _c(FirestoreCollections.financeDailySummaries)
      .where('dayStart', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
      .where('dayStart', isLessThan: Timestamp.fromDate(to))
      .orderBy('dayStart')
      .limit(400)
      .snapshots()
      .map((s) => [for (final d in s.docs) DailyFinanceSummary.fromFirestore(d.id, d.data())]);

  Stream<DailyFinanceSummary> watchDay(String dayKey) => _c(FirestoreCollections.financeDailySummaries)
      .doc(dayKey)
      .snapshots()
      .map((s) => s.exists ? DailyFinanceSummary.fromFirestore(s.id, s.data()!) : DailyFinanceSummary.empty(dayKey));

  /// Active banks a cashier may pick for a bank payment (no balances).
  Stream<List<PaymentAccountOption>> watchPaymentAccounts() =>
      _c(FirestoreCollections.settings).doc('payment_accounts').snapshots().map((s) => PaymentAccountOption.listFrom(s.data()));
}
