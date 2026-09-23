import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/expense.dart';

/// Reads for expenses, categories and recurring expenses. Bounded and
/// index-backed; offline they come from the cache. Writes go through [ExpensesApi].
class ExpensesRepository {
  ExpensesRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 100;

  CollectionReference<Map<String, dynamic>> _c(String name) => _db.collection(name);

  List<Expense> _list(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) Expense.fromFirestore(d.id, d.data())];

  /// Newest first, optionally one status. Index: expenses (status, createdAt desc).
  Stream<List<Expense>> watchExpenses({ExpenseStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.expenses);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_list);
  }

  /// Expenses dated in [from, to) for reports (single-field index on expenseDate).
  Stream<List<Expense>> watchExpensesDated(DateTime from, DateTime to) => _c(FirestoreCollections.expenses)
      .where('expenseDate', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
      .where('expenseDate', isLessThan: Timestamp.fromDate(to))
      .orderBy('expenseDate', descending: true)
      .limit(500)
      .snapshots()
      .map(_list);

  /// Large expenses: amount at or above [threshold] UGX, largest first.
  Stream<List<Expense>> watchLarge(int thresholdUgx) => _c(FirestoreCollections.expenses)
      .where('amountUgx', isGreaterThanOrEqualTo: thresholdUgx)
      .orderBy('amountUgx', descending: true)
      .limit(50)
      .snapshots()
      .map(_list);

  Stream<Expense?> watchExpense(String id) =>
      _c(FirestoreCollections.expenses).doc(id).snapshots().map((s) => s.exists ? Expense.fromFirestore(s.id, s.data()!) : null);

  Stream<List<ExpenseCategory>> watchCategories() => _c(FirestoreCollections.expenseCategories)
      .limit(200)
      .snapshots()
      .map((s) => ExpenseCategory.merge([for (final d in s.docs) ExpenseCategory.fromFirestore(d.id, d.data())]));

  Stream<List<RecurringExpense>> watchRecurring() => _c(FirestoreCollections.recurringExpenses)
      .orderBy('nextDueDate')
      .limit(listLimit)
      .snapshots()
      .map((s) => [for (final d in s.docs) RecurringExpense.fromFirestore(d.id, d.data())]);

  /// `settings/finance.largeExpenseThresholdUgx` (default UGX 500,000).
  Stream<int> watchLargeThreshold() => _c(FirestoreCollections.settings).doc('finance').snapshots().map((s) {
        final v = s.data()?['largeExpenseThresholdUgx'];
        return v is int && v > 0 ? v : 500000;
      });
}
