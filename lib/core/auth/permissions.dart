import 'user_role.dart';

/// The complete RamosMAX permission catalogue.
///
/// Keys use `module.action` and are stored verbatim in Firestore
/// (`users.permissions`, `users.deniedPermissions`,
/// `users.temporaryPermissions`). The role matrix below is mirrored in
/// `firebase/firestore.rules` and in `functions/src/access_catalog.json` (used
/// by the Cloud Functions); `test/unit/permissions_test.dart` fails if the
/// three drift apart.
///
/// Client-side checks drive what the UI shows. They are NOT a security
/// boundary — the rules and the Cloud Functions are.
enum Permission {
  usersView('users.view', 'View users'),
  usersCreate('users.create', 'Create users'),
  usersEdit('users.edit', 'Edit user profiles'),
  usersActivate('users.activate', 'Activate users'),
  usersDeactivate('users.deactivate', 'Deactivate users'),
  usersRolesManage('users.roles.manage', 'Change user roles'),
  usersPermissionsManage('users.permissions.manage', 'Manage user permissions'),
  usersPermissionsTemporary('users.permissions.temporary', 'Grant temporary access'),
  usersPasswordsReset('users.passwords.reset', 'Reset passwords'),

  staffView('staff.view', 'View staff'),
  staffManage('staff.manage', 'Manage staff'),
  staffDocumentsView('staff.documents.view', 'View staff documents'),
  staffSalaryView('staff.salary.view', 'View staff salaries'),

  customersView('customers.view', 'View customers'),
  customersManage('customers.manage', 'Create and edit customers'),
  vehiclesView('vehicles.view', 'View vehicles'),
  vehiclesManage('vehicles.manage', 'Create and edit vehicles'),

  servicesView('services.view', 'View services'),
  servicesManage('services.manage', 'Manage services and prices'),
  jobsView('jobs.view', 'View all jobs'),
  jobsViewOwn('jobs.view.own', 'View own jobs'),
  jobsCreate('jobs.create', 'Start services (service intake)'),
  jobsAssign('jobs.assign', 'Assign and reassign jobs'),
  jobsManage('jobs.manage', 'Create and edit jobs'),
  jobsComplete('jobs.complete', 'Update job status'),

  invoicesView('invoices.view', 'View invoices'),
  invoicesCreate('invoices.create', 'Create invoices'),
  invoicesVoid('invoices.void', 'Void invoices'),
  paymentsView('payments.view', 'View payments'),
  paymentsRecord('payments.record', 'Receive payments and issue receipts'),
  paymentsReverse('payments.reverse', 'Reverse payments'),
  discountsApply('discounts.apply', 'Apply discounts'),
  discountsApprove('discounts.approve', 'Approve discounts'),
  creditView('credit.view', 'View credit'),
  creditManage('credit.manage', 'Record credit'),

  loyaltyView('loyalty.view', 'View loyalty'),
  loyaltyRedeem('loyalty.redeem', 'Redeem loyalty rewards'),
  loyaltyAdjust('loyalty.adjust', 'Manage loyalty'),

  financeView('finance.view', 'View finance (account balances)'),
  financeTransactionsView('finance.transactions.view', 'View financial transactions'),
  financeAccountsManage('finance.accounts.manage', 'Manage financial accounts'),
  financeTransfer('finance.transfer', 'Transfer funds'),
  financeDeposit('finance.deposit', 'Record bank deposits'),
  financeReconcile('finance.reconcile', 'Reconcile accounts'),
  financeAdjust('finance.adjust', 'Adjust balances and reverse transactions'),
  cashHandoverSubmit('cash_handover.submit', 'Submit cash handovers'),
  cashHandoverApprove('cash_handover.approve', 'Approve cash handovers'),

  expensesView('expenses.view', 'View expenses'),
  expensesCreate('expenses.create', 'Create expenses'),
  expensesReview('expenses.review', 'Review expenses'),
  expensesApprove('expenses.approve', 'Approve expenses'),
  expensesPay('expenses.pay', 'Pay expenses and supplier purchases'),
  expensesCancel('expenses.cancel', 'Cancel expenses'),
  expensesAdjust('expenses.adjust', 'Reverse expense and purchase payments'),
  expensesCategoriesManage('expenses.categories.manage', 'Manage expense categories'),
  expensesRecurringManage('expenses.recurring.manage', 'Manage recurring expenses'),

  inventoryView('inventory.view', 'View inventory'),
  inventoryManage('inventory.manage', 'Manage inventory items'),
  inventorySuppliersManage('inventory.suppliers.manage', 'Manage suppliers'),
  inventoryPurchaseCreate('inventory.purchase.create', 'Raise stock purchases'),
  inventoryPurchaseApprove('inventory.purchase.approve', 'Approve stock purchases'),
  inventoryStockIn('inventory.stock.in', 'Receive stock (stock-in)'),
  inventoryStockOut('inventory.stock.out', 'Record stock usage and stock-out'),
  inventoryStockAdjust('inventory.stock.adjust', 'Adjust stock and approve high-value stock-outs'),
  inventoryReportsView('inventory.reports.view', 'View inventory reports'),

  attendanceView('attendance.view', 'View all attendance'),
  attendanceViewOwn('attendance.view.own', 'View own attendance'),
  attendanceMark('attendance.mark', 'Mark attendance'),
  attendanceApprove('attendance.approve', 'Approve attendance'),
  attendanceRecord('attendance.record', "Record other staff's attendance"),
  attendanceReview('attendance.review', 'Review and reject attendance'),
  attendanceCorrect('attendance.correct', 'Correct attendance records'),
  allowancesView('allowances.view', 'View all allowances'),
  allowancesViewOwn('allowances.view.own', 'View own allowances'),
  allowancesApprove('allowances.approve', 'Approve allowances'),
  allowancesCalculate('allowances.calculate', 'Calculate daily allowances'),
  allowancesPay('allowances.pay', 'Pay allowances'),
  allowancesAdjust('allowances.adjust', 'Adjust, cancel and reverse allowances'),

  salaryView('salary.view', 'View salary profiles'),
  salaryManage('salary.manage', 'Set and change salaries'),
  salaryHistoryView('salary.history.view', 'View salary history'),

  payrollView('payroll.view', 'View payroll'),
  payrollViewOwn('payroll.view.own', 'View own pay, payslips and deductions'),
  /// Phase 1 name, honoured by the server as [payrollPrepare].
  payrollProcess('payroll.process', 'Manage payroll (legacy)'),
  payrollApprove('payroll.approve', 'Approve payroll and deductions'),
  payrollPrepare('payroll.prepare', 'Prepare payroll'),
  payrollReview('payroll.review', 'Review payroll'),
  payrollPay('payroll.pay', 'Pay payroll'),
  payrollAdjust('payroll.adjust', 'Correct, cancel and reverse payroll'),
  deductionsManage('deductions.manage', 'Manage salary deductions'),

  lossesView('losses.view', 'View loss incidents'),
  lossesCreate('losses.create', 'Report loss incidents'),
  lossesReview('losses.review', 'Review loss incidents'),
  lossesApprove('losses.approve', 'Decide loss incidents and recoveries'),
  lossesSchedule('losses.schedule', 'Schedule loss recoveries'),
  lossesAdjust('losses.adjust', 'Cancel loss incidents and recoveries'),

  afterHoursRequest('after_hours.request', 'Request after-hours access'),
  afterHoursApprove('after_hours.approve', 'Approve after-hours access'),

  shareholdersView('shareholders.view', 'View shareholders'),
  shareholdersManage('shareholders.manage', 'Manage shareholders'),
  dividendsView('dividends.view', 'View dividends'),
  dividendsDeclare('dividends.declare', 'Declare dividends'),

  reportsOperationalView('reports.operational.view', 'View operational reports'),
  reportsFinancialView('reports.financial.view', 'View financial reports'),
  reportsPayrollView('reports.payroll.view', 'View payroll reports'),

  auditView('audit.view', 'View audit logs'),
  notificationsView('notifications.view', 'Receive notifications'),
  settingsView('settings.view', 'View settings'),
  settingsManage('settings.manage', 'Manage settings');

  const Permission(this.key, this.label);

  final String key;

  /// Short, human-readable name for permission editors.
  final String label;

  /// True for permissions that only read data. Auditors hold nothing else.
  bool get isReadOnly => key.endsWith('.view') || key.endsWith('.view.own');

  /// Feature area the permission belongs to (for grouping in the UI).
  PermissionGroup get group => PermissionGroup.of(this);

  /// Permissions that only an Admin may grant, deny or hand out temporarily,
  /// whatever other permissions the actor holds. Mirrored by
  /// `adminOnlyPermissions` in `functions/src/access_catalog.json`.
  bool get isAdminOnly =>
      (key.startsWith('users.') && this != Permission.usersView) || this == Permission.settingsManage;

  static Permission? tryParse(String value) {
    for (final p in values) {
      if (p.key == value) return p;
    }
    return null;
  }
}

/// Feature areas used to organise permissions on screen.
enum PermissionGroup {
  users('Users', ['users.']),
  staff('Staff', ['staff.']),
  customers('Customers & vehicles', ['customers.', 'vehicles.']),
  operations('Services & jobs', ['services.', 'jobs.']),
  sales('Invoices, payments & discounts', ['invoices.', 'payments.', 'discounts.', 'credit.']),
  loyalty('Loyalty', ['loyalty.']),
  finance('Finance', ['finance.', 'cash_handover.']),
  expenses('Expenses', ['expenses.']),
  inventory('Inventory', ['inventory.']),
  attendance('Attendance & allowances', ['attendance.', 'allowances.', 'after_hours.']),
  payroll('Salary, payroll & losses', ['salary.', 'payroll.', 'deductions.', 'losses.']),
  shareholders('Shareholders', ['shareholders.', 'dividends.']),
  reports('Reports', ['reports.']),
  system('Audit, notifications & settings', ['audit.', 'notifications.', 'settings.']);

  const PermissionGroup(this.label, this._prefixes);

  final String label;
  final List<String> _prefixes;

  List<Permission> get permissions => [
        for (final p in Permission.values)
          if (of(p) == this) p,
      ];

  static PermissionGroup of(Permission permission) {
    for (final g in values) {
      if (g._prefixes.any(permission.key.startsWith)) return g;
    }
    return system;
  }
}

/// Default permissions granted by each role. Admin receives everything.
abstract final class RolePermissions {
  static Set<Permission> forRole(UserRole role) => switch (role) {
        UserRole.admin => Permission.values.toSet(),
        UserRole.manager => _manager,
        UserRole.cashier => _cashier,
        UserRole.worker => _worker,
        UserRole.shareholder => _shareholder,
        UserRole.auditor => _auditor,
      };

  static const Set<Permission> _manager = {
    // Managers can look up staff accounts, hand out time-boxed access (e.g.
    // after-hours payment collection) to cashiers and workers, and reset
    // Workers' passwords. They cannot create users, change roles or
    // permanent permissions.
    Permission.usersView, Permission.usersPermissionsTemporary, Permission.usersPasswordsReset,
    Permission.staffView,
    Permission.customersView, Permission.customersManage,
    Permission.vehiclesView, Permission.vehiclesManage,
    Permission.servicesView, Permission.servicesManage,
    Permission.jobsView, Permission.jobsCreate, Permission.jobsAssign, Permission.jobsManage, Permission.jobsComplete,
    Permission.invoicesView, Permission.invoicesCreate, Permission.invoicesVoid,
    Permission.paymentsView, Permission.paymentsRecord,
    Permission.discountsApply, Permission.discountsApprove,
    Permission.creditView, Permission.creditManage,
    Permission.loyaltyView, Permission.loyaltyRedeem, Permission.loyaltyAdjust,
    // Day-to-day finance, expenses and stock. Account set-up, balance
    // adjustments and reversals stay with Admins unless granted.
    Permission.financeView, Permission.financeTransactionsView, Permission.financeTransfer, Permission.financeDeposit,
    Permission.financeReconcile,
    Permission.cashHandoverSubmit, Permission.cashHandoverApprove,
    Permission.expensesView, Permission.expensesCreate, Permission.expensesReview, Permission.expensesApprove,
    Permission.expensesPay, Permission.expensesCancel, Permission.expensesCategoriesManage, Permission.expensesRecurringManage,
    Permission.inventoryView, Permission.inventoryManage, Permission.inventorySuppliersManage,
    Permission.inventoryPurchaseCreate, Permission.inventoryPurchaseApprove,
    Permission.inventoryStockIn, Permission.inventoryStockOut, Permission.inventoryStockAdjust, Permission.inventoryReportsView,
    // Phase 6: attendance, allowances, payroll preparation and review, loss
    // incidents. Salary changes, payroll approval/payment, loss decisions and
    // deductions stay with Admins unless granted.
    Permission.attendanceView, Permission.attendanceViewOwn, Permission.attendanceMark, Permission.attendanceApprove,
    Permission.attendanceRecord, Permission.attendanceReview, Permission.attendanceCorrect,
    Permission.allowancesView, Permission.allowancesViewOwn, Permission.allowancesApprove, Permission.allowancesCalculate,
    Permission.allowancesPay, Permission.allowancesAdjust,
    Permission.salaryView,
    Permission.payrollView, Permission.payrollViewOwn, Permission.payrollPrepare, Permission.payrollReview,
    Permission.lossesView, Permission.lossesCreate, Permission.lossesReview, Permission.lossesSchedule,
    Permission.afterHoursApprove,
    Permission.reportsOperationalView, Permission.reportsFinancialView,
    Permission.notificationsView,
  };

  static const Set<Permission> _cashier = {
    Permission.customersView, Permission.customersManage,
    Permission.vehiclesView, Permission.vehiclesManage,
    Permission.servicesView,
    Permission.jobsView, Permission.jobsCreate,
    Permission.invoicesView, Permission.invoicesCreate,
    Permission.paymentsView, Permission.paymentsRecord,
    // Discounts only when granted (discounts.apply), never by default.
    Permission.creditView, Permission.creditManage,
    Permission.loyaltyView, Permission.loyaltyRedeem,
    // Phase 5: cashiers record expenses for a manager to review; they do not
    // see business-wide balances (no finance.view) or approve/pay anything.
    Permission.expensesView, Permission.expensesCreate,
    Permission.cashHandoverSubmit,
    // Phase 6: their own attendance, allowances and pay only.
    Permission.attendanceViewOwn, Permission.attendanceMark, Permission.allowancesViewOwn, Permission.payrollViewOwn,
    Permission.reportsOperationalView,
    Permission.notificationsView,
  };

  static const Set<Permission> _worker = {
    // Plate look-up and the service catalogue (with prices), read-only.
    // Customer details (phone numbers) stay with customers.view.
    Permission.vehiclesView, Permission.servicesView,
    Permission.jobsViewOwn, Permission.jobsComplete,
    Permission.attendanceViewOwn, Permission.attendanceMark,
    Permission.allowancesViewOwn, Permission.payrollViewOwn,
    Permission.afterHoursRequest,
    Permission.notificationsView,
  };

  static const Set<Permission> _shareholder = {
    Permission.financeView,
    Permission.shareholdersView, Permission.dividendsView,
    Permission.reportsOperationalView, Permission.reportsFinancialView,
    Permission.notificationsView,
  };

  static const Set<Permission> _auditor = {
    Permission.usersView,
    Permission.staffView,
    Permission.customersView, Permission.vehiclesView, Permission.servicesView, Permission.jobsView,
    Permission.invoicesView, Permission.paymentsView, Permission.creditView, Permission.loyaltyView,
    Permission.financeView, Permission.financeTransactionsView, Permission.expensesView,
    Permission.inventoryView, Permission.inventoryReportsView,
    Permission.attendanceView, Permission.allowancesView, Permission.payrollView,
    Permission.salaryView, Permission.salaryHistoryView, Permission.lossesView,
    Permission.shareholdersView, Permission.dividendsView,
    Permission.reportsOperationalView, Permission.reportsFinancialView,
    Permission.reportsPayrollView,
    Permission.auditView, Permission.settingsView,
    Permission.notificationsView,
  };
}
