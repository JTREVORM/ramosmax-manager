/// Canonical Firestore collection names.
///
/// Every collection the RamosMAX system will use is declared here, so names
/// are never typed as string literals in repositories. Collections without
/// security rules yet are denied by the default-deny block in
/// `firebase/firestore.rules` until the phase that owns them ships.
abstract final class FirestoreCollections {
  // Identity & staff
  static const String users = 'users';

  /// Subcollection `users/{uid}/temporary_grants` — temporary-permission
  /// records (the enforcement copy is the profile's `temporaryPermissions`).
  static const String temporaryGrants = 'temporary_grants';
  static const String staff = 'staff';
  static const String staffDocuments = 'staff_documents';

  // Customers & vehicles
  static const String customers = 'customers';
  static const String vehicles = 'vehicles';

  // Operations
  static const String services = 'services';
  /// The job (Phase 4): vehicle + selected services + worker-order summary.
  static const String serviceIntakes = 'service_intakes';
  static const String serviceJobs = 'service_jobs';
  static const String jobItems = 'job_items';
  static const String workerOrders = 'worker_orders';

  // Sales
  static const String invoices = 'invoices';
  static const String payments = 'payments';
  static const String receipts = 'receipts';
  static const String discounts = 'discounts';

  // Loyalty (per vehicle)
  static const String loyaltyAccounts = 'loyalty_accounts';
  static const String loyaltyTransactions = 'loyalty_transactions';
  static const String loyaltyRewards = 'loyalty_rewards';

  /// Hand-off records for future customer messages (reward unlocked / nearing).
  static const String loyaltyEvents = 'loyalty_events';

  // Finance
  static const String financialAccounts = 'financial_accounts';
  static const String financialTransactions = 'financial_transactions';
  static const String bankAccounts = 'bank_accounts';
  static const String mobileMoneyAccounts = 'mobile_money_accounts';
  static const String cashHandovers = 'cash_handovers';
  static const String reconciliations = 'reconciliations';

  /// Server-maintained daily totals, keyed by EAT business day.
  static const String financeDailySummaries = 'finance_daily_summaries';
  static const String bankDeposits = 'bank_deposits';

  // Expenses
  static const String expenses = 'expenses';
  static const String expenseCategories = 'expense_categories';
  static const String recurringExpenses = 'recurring_expenses';

  // Inventory
  static const String inventory = 'inventory';
  static const String inventoryItems = 'inventory_items';
  static const String suppliers = 'suppliers';
  static const String stockMovements = 'stock_movements';
  static const String inventoryPurchases = 'inventory_purchases';

  // Attendance & payroll (Phase 6)
  static const String attendance = 'attendance';

  /// Original and corrected values of every attendance correction.
  static const String attendanceCorrections = 'attendance_corrections';
  static const String workerAllowances = 'worker_allowances';

  /// The latest salary version per staff member (doc ID = their uid).
  static const String salaryProfiles = 'salary_profiles';

  /// Every salary version, effective-dated and never edited.
  static const String salaryHistory = 'salary_history';
  static const String payroll = 'payroll';
  static const String payrollItems = 'payroll_items';
  static const String salaryDeductions = 'salary_deductions';
  static const String lossIncidents = 'loss_incidents';

  // After-hours
  static const String afterHoursAccess = 'after_hours_access';
  static const String afterHoursSessions = 'after_hours_sessions';

  // Shareholding
  static const String shareholders = 'shareholders';
  static const String shares = 'shares';
  static const String dividends = 'dividends';

  // Platform
  static const String notifications = 'notifications';
  static const String auditLogs = 'audit_logs';
  static const String settings = 'settings';

  /// Server-side sequence allocation (e.g. the next staff ID). Clients have
  /// no access at all.
  static const String counters = 'counters';

  /// Server-only uniqueness reservations (number plates, customer phones,
  /// service names). Clients have no access at all.
  static const String uniqueKeys = 'unique_keys';
}

/// Well-known documents inside [FirestoreCollections.settings].
abstract final class FirestoreDocs {
  /// Attendance, allowance and payroll rules (Phase 6).
  static const String payrollPolicy = 'payroll_policy';
}

/// Field names shared by every document (see docs/FIRESTORE_CONVENTIONS.md).
abstract final class FirestoreFields {
  static const String id = 'id';
  static const String createdAt = 'createdAt';
  static const String updatedAt = 'updatedAt';
  static const String createdBy = 'createdBy';
  static const String updatedBy = 'updatedBy';
  static const String status = 'status';
}
