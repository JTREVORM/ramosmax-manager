import '../core/money/money.dart';
import 'firestore_converters.dart';

/// Expense lifecycle. Mirrors EXPENSE_STATUSES in functions/src/expenses.js.
enum ExpenseStatus {
  draft('draft', 'Draft'),
  pendingReview('pending_review', 'Pending approval'),
  approved('approved', 'Approved — unpaid'),
  rejected('rejected', 'Rejected'),
  paid('paid', 'Paid'),
  cancelled('cancelled', 'Cancelled');

  const ExpenseStatus(this.key, this.label);
  final String key;
  final String label;

  static ExpenseStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => draft);

  /// Money not yet paid out for it (still a commitment).
  bool get isUnpaid => this == draft || this == pendingReview || this == approved;
}

/// Actions on an expense (`updateExpenseStatus`); paying is separate.
enum ExpenseAction {
  submit('submit', 'Submit for review', 'submitted'),
  review('review', 'Mark reviewed', 'reviewed'),
  approve('approve', 'Approve', 'approved'),
  reject('reject', 'Reject', 'rejected'),
  cancel('cancel', 'Cancel', 'cancelled');

  const ExpenseAction(this.key, this.label, this.done);
  final String key;
  final String label;
  final String done;

  bool get needsReason => this == reject || this == cancel;
}

/// An expense category: built-in (see [defaults], mirrored by
/// `expenseCategories` in functions/src/access_catalog.json) or custom.
class ExpenseCategory {
  const ExpenseCategory({required this.categoryId, required this.name, this.active = true, this.isDefault = false});
  final String categoryId;
  final String name;
  final bool active;
  final bool isDefault;

  static const Map<String, String> defaults = {
    'utilities': 'Utilities',
    'operations': 'Operations',
    'premises': 'Premises',
    'repairs': 'Repairs',
    'financial_charges': 'Financial Charges',
    'marketing': 'Marketing',
    'transport': 'Transport',
    'office': 'Office',
    'licences': 'Licences',
    'miscellaneous': 'Miscellaneous',
  };

  static ExpenseCategory fromFirestore(String id, Map<String, dynamic> d) => ExpenseCategory(
        categoryId: id,
        name: d['name'] as String? ?? defaults[id] ?? id,
        active: d['active'] != false,
        isDefault: defaults.containsKey(id),
      );

  /// Built-in categories overlaid with stored edits, then custom ones by name.
  static List<ExpenseCategory> merge(Iterable<ExpenseCategory> stored) {
    final byId = {for (final c in stored) c.categoryId: c};
    return [
      for (final e in defaults.entries) byId[e.key] ?? ExpenseCategory(categoryId: e.key, name: e.value, isDefault: true),
      ...(byId.values.where((c) => !defaults.containsKey(c.categoryId)).toList()..sort((a, b) => a.name.compareTo(b.name))),
    ];
  }

  static String nameOf(String id, Iterable<ExpenseCategory> all) {
    for (final c in all) {
      if (c.categoryId == id) return c.name;
    }
    return defaults[id] ?? id;
  }
}

/// `expenses/{id}`.
class Expense {
  const Expense({
    required this.expenseId,
    required this.expenseNumber,
    required this.categoryId,
    required this.categoryName,
    required this.description,
    required this.amount,
    required this.status,
    required this.createdBy,
    this.expenseDate,
    this.payee,
    this.paymentAccountId,
    this.reference,
    this.attachmentPath,
    this.notes,
    this.createdByName,
    this.createdAt,
    this.reviewedByName,
    this.reviewedAt,
    this.reviewNotes,
    this.approvedByName,
    this.approvedAt,
    this.rejectionReason,
    this.paidByName,
    this.paidAt,
    this.paidFromAccountName,
    this.financialTransactionId,
    this.financialTransactionNumber,
    this.cancelReason,
    this.recurringExpenseId,
    this.dueDate,
    this.paymentReversalReason,
  });

  final String expenseId;
  final String expenseNumber;
  final String categoryId;
  final String categoryName;
  final String description;
  final Money amount;
  final ExpenseStatus status;
  final String createdBy;
  final DateTime? expenseDate;
  final String? payee;
  final String? paymentAccountId;
  final String? reference;
  final String? attachmentPath;
  final String? notes;
  final String? createdByName;
  final DateTime? createdAt;
  final String? reviewedByName;
  final DateTime? reviewedAt;
  final String? reviewNotes;
  final String? approvedByName;
  final DateTime? approvedAt;
  final String? rejectionReason;
  final String? paidByName;
  final DateTime? paidAt;
  final String? paidFromAccountName;
  final String? financialTransactionId;
  final String? financialTransactionNumber;
  final String? cancelReason;
  final String? recurringExpenseId;
  final DateTime? dueDate;
  final String? paymentReversalReason;

  bool get isReviewed => reviewedAt != null;

  /// Actions the workflow allows now (the server re-checks everything).
  Set<ExpenseAction> get availableActions => switch (status) {
        ExpenseStatus.draft => {ExpenseAction.submit, ExpenseAction.cancel},
        ExpenseStatus.pendingReview => {
            if (!isReviewed) ExpenseAction.review else ExpenseAction.approve,
            ExpenseAction.reject,
            ExpenseAction.cancel,
          },
        ExpenseStatus.approved => {ExpenseAction.cancel},
        _ => const {},
      };

  bool get canEdit => status == ExpenseStatus.draft || (status == ExpenseStatus.pendingReview && !isReviewed);
  bool get canPay => status == ExpenseStatus.approved;

  static Expense fromFirestore(String id, Map<String, dynamic> d) => Expense(
        expenseId: id,
        expenseNumber: d['expenseNumber'] as String? ?? '',
        categoryId: d['categoryId'] as String? ?? '',
        categoryName: d['categoryName'] as String? ?? ExpenseCategory.defaults[d['categoryId']] ?? '',
        description: d['description'] as String? ?? '',
        amount: Money((d['amountUgx'] as num?)?.toInt() ?? 0),
        status: ExpenseStatus.parse(d['status']),
        createdBy: d['createdBy'] as String? ?? '',
        expenseDate: FirestoreConverters.toDateTime(d['expenseDate']),
        payee: d['payee'] as String?,
        paymentAccountId: d['paymentAccountId'] as String?,
        reference: d['reference'] as String?,
        attachmentPath: d['attachmentPath'] as String?,
        notes: d['notes'] as String?,
        createdByName: d['createdByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        reviewedByName: d['reviewedByName'] as String?,
        reviewedAt: FirestoreConverters.toDateTime(d['reviewedAt']),
        reviewNotes: d['reviewNotes'] as String?,
        approvedByName: d['approvedByName'] as String?,
        approvedAt: FirestoreConverters.toDateTime(d['approvedAt']),
        rejectionReason: d['rejectionReason'] as String?,
        paidByName: d['paidByName'] as String?,
        paidAt: FirestoreConverters.toDateTime(d['paidAt']),
        paidFromAccountName: d['paidFromAccountName'] as String?,
        financialTransactionId: d['financialTransactionId'] as String?,
        financialTransactionNumber: d['financialTransactionNumber'] as String?,
        cancelReason: d['cancelReason'] as String?,
        recurringExpenseId: d['recurringExpenseId'] as String?,
        dueDate: FirestoreConverters.toDateTime(d['dueDate']),
        paymentReversalReason: d['paymentReversalReason'] as String?,
      );
}

enum ExpenseFrequency {
  weekly('weekly', 'Weekly'),
  monthly('monthly', 'Monthly'),
  quarterly('quarterly', 'Quarterly'),
  yearly('yearly', 'Yearly');

  const ExpenseFrequency(this.key, this.label);
  final String key;
  final String label;

  static ExpenseFrequency parse(Object? v) => values.firstWhere((f) => f.key == v, orElse: () => monthly);
}

/// `recurring_expenses/{id}`: a reminder and a draft "due item" per cycle
/// (functions/src/expenses.js → sweepRecurringExpenses). Never paid automatically.
class RecurringExpense {
  const RecurringExpense({
    required this.recurringExpenseId,
    required this.name,
    required this.categoryId,
    required this.categoryName,
    required this.expectedAmount,
    required this.frequency,
    required this.active,
    this.nextDueDate,
    this.payee,
    this.paymentAccountId,
    this.reminderDaysBefore = 3,
    this.notes,
    this.lastGeneratedExpenseId,
  });

  final String recurringExpenseId;
  final String name;
  final String categoryId;
  final String categoryName;
  final Money expectedAmount;
  final ExpenseFrequency frequency;
  final bool active;
  final DateTime? nextDueDate;
  final String? payee;
  final String? paymentAccountId;
  final int reminderDaysBefore;
  final String? notes;
  final String? lastGeneratedExpenseId;

  /// Whole days from [now] to the due date (negative when overdue).
  int? daysUntilDue(DateTime now) => nextDueDate == null ? null : (nextDueDate!.difference(now).inHours / 24).floor();

  static RecurringExpense fromFirestore(String id, Map<String, dynamic> d) => RecurringExpense(
        recurringExpenseId: id,
        name: d['name'] as String? ?? '',
        categoryId: d['categoryId'] as String? ?? '',
        categoryName: d['categoryName'] as String? ?? '',
        expectedAmount: Money((d['expectedAmountUgx'] as num?)?.toInt() ?? 0),
        frequency: ExpenseFrequency.parse(d['frequency']),
        active: d['active'] == true,
        nextDueDate: FirestoreConverters.toDateTime(d['nextDueDate']),
        payee: d['payee'] as String?,
        paymentAccountId: d['paymentAccountId'] as String?,
        reminderDaysBefore: (d['reminderDaysBefore'] as num?)?.toInt() ?? 3,
        notes: d['notes'] as String?,
        lastGeneratedExpenseId: d['lastGeneratedExpenseId'] as String?,
      );
}

/// Totals over a list of expenses (the lists are bounded; paid totals over
/// time come from the server's daily summaries).
class ExpenseTotals {
  const ExpenseTotals({required this.total, required this.count, required this.byCategory, required this.byStatus});
  final Money total;
  final int count;
  final Map<String, Money> byCategory;
  final Map<ExpenseStatus, Money> byStatus;

  static ExpenseTotals of(Iterable<Expense> expenses) {
    var total = Money.zero;
    var count = 0;
    final byCategory = <String, Money>{};
    final byStatus = <ExpenseStatus, Money>{};
    for (final e in expenses) {
      if (e.status == ExpenseStatus.cancelled || e.status == ExpenseStatus.rejected) {
        byStatus[e.status] = (byStatus[e.status] ?? Money.zero) + e.amount;
        continue;
      }
      total += e.amount;
      count++;
      byCategory[e.categoryName] = (byCategory[e.categoryName] ?? Money.zero) + e.amount;
      byStatus[e.status] = (byStatus[e.status] ?? Money.zero) + e.amount;
    }
    return ExpenseTotals(total: total, count: count, byCategory: byCategory, byStatus: byStatus);
  }
}
