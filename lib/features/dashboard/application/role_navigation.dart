import 'package:flutter/material.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../models/app_user.dart';

/// Every navigable area of the system. A module is shown to a user only if
/// it is in their role's menu AND they hold at least one of its [requires]
/// permissions — so revoking a permission also removes the menu entry.
///
/// [available] marks modules implemented in the current release; the rest
/// open an honest "not yet available" screen rather than fake content.
enum AppModule {
  dashboard('dashboard', 'Dashboard', Icons.space_dashboard_outlined, {}, available: true),
  newService('new-service', 'New Service', Icons.add_task, {Permission.jobsCreate}, available: true, shortLabel: 'Service'),
  myJobs('my-jobs', 'My Jobs', Icons.assignment_ind_outlined, {Permission.jobsViewOwn}, available: true),
  jobs('jobs', 'Jobs', Icons.local_car_wash_outlined, {Permission.jobsView}, available: true),
  vehicles('vehicles', 'Vehicles', Icons.directions_car_outlined, {Permission.vehiclesView}, available: true),
  customers('customers', 'Customers', Icons.people_outline, {Permission.customersView}, available: true),
  services('services', 'Services', Icons.build_outlined, {Permission.servicesView}, available: true),
  staff('staff', 'Staff', Icons.badge_outlined, {Permission.staffView}),
  invoices('invoices', 'Invoices', Icons.receipt_long_outlined, {Permission.invoicesView}, available: true),
  payments('payments', 'Payments', Icons.payments_outlined, {Permission.paymentsView}, available: true),
  receipts('receipts', 'Receipts', Icons.receipt_outlined, {Permission.paymentsView, Permission.invoicesView}, available: true),
  credit('credit', 'Credit', Icons.credit_score_outlined, {Permission.creditView}, available: true),
  loyalty('loyalty', 'Loyalty', Icons.loyalty_outlined, {Permission.loyaltyView}, available: true),
  finance('finance', 'Finance', Icons.account_balance_outlined, {Permission.financeView}, available: true),
  financialSummary('financial-summary', 'Financial Summary', Icons.account_balance_outlined, {Permission.financeView}, available: true),
  businessPerformance('performance', 'Business Performance', Icons.insights_outlined, {Permission.reportsOperationalView}),
  transactions('transactions', 'Transactions', Icons.swap_horiz, {Permission.financeTransactionsView}, available: true),
  reconciliation('reconciliation', 'Reconciliation', Icons.fact_check_outlined, {Permission.financeReconcile, Permission.financeView},
      available: true),
  // Superseded in the menus by [afterHours] (Phase 8), whose Handovers tab
  // holds the cash handovers.
  cashHandover('cash-handover', 'Cash Handover', Icons.handshake_outlined, {Permission.cashHandoverSubmit, Permission.cashHandoverApprove}),
  // Phase 8. After-Hours: authorisations, sessions, handovers, discrepancies
  // and reports for supervisors. My After-Hours: a worker's own authorisation,
  // session, expected cash and handovers.
  afterHours('after-hours', 'After-Hours', Icons.nightlight_outlined,
      {Permission.afterHoursView, Permission.afterHoursApprove, Permission.cashHandoverApprove, Permission.afterHoursDiscrepancyReview},
      available: true),
  myAfterHours('my-after-hours', 'My After-Hours', Icons.nightlight_outlined, {Permission.afterHoursRequest},
      available: true, shortLabel: 'After-hours'),
  discrepancies('discrepancies', 'Discrepancies', Icons.report_problem_outlined, {Permission.auditView}),
  expenses('expenses', 'Expenses', Icons.request_quote_outlined, {Permission.expensesView}, available: true),
  inventory('inventory', 'Inventory', Icons.inventory_2_outlined, {Permission.inventoryView}, available: true),
  attendance('attendance', 'Attendance', Icons.how_to_reg_outlined, {Permission.attendanceView, Permission.attendanceViewOwn},
      available: true),
  // For staff who only see their own records this is "My pay": allowances,
  // payslips, salary and deductions.
  allowances('allowances', 'Allowances', Icons.savings_outlined, {Permission.allowancesView, Permission.allowancesViewOwn},
      available: true),
  payroll('payroll', 'Payroll', Icons.wallet_outlined, {Permission.payrollView, Permission.salaryView}, available: true),
  losses('losses', 'Loss Incidents', Icons.report_problem_outlined, {Permission.lossesView}, available: true),
  reports('reports', 'Reports', Icons.bar_chart_outlined, {Permission.reportsOperationalView, Permission.reportsFinancialView}),
  // Phase 7. Shareholders: the register (reports level) and, with
  // shareholders.view, profiles. Shares: holdings, the ownership ledger and
  // contributions. Dividends: headers with reports level, allocations and
  // payments with dividends.view. My Shareholding: a shareholder's own records.
  shareholders('shareholders', 'Shareholders', Icons.groups_outlined,
      {Permission.shareholdersView, Permission.shareholdersReportsView, Permission.sharesView}, available: true),
  shares('shares', 'Shares', Icons.donut_small_outlined, {Permission.sharesView}, available: true),
  dividends('dividends', 'Dividends', Icons.pie_chart_outline, {Permission.dividendsView, Permission.shareholdersReportsView},
      available: true),
  myShareholding('my-shares', 'My Shareholding', Icons.pie_chart_outline, {Permission.shareholdersViewOwn},
      available: true, shortLabel: 'Shares'),
  users('users', 'User Management', Icons.manage_accounts_outlined, {Permission.usersView},
      available: true, shortLabel: 'Users'),
  auditLogs('audit', 'Audit Logs', Icons.policy_outlined, {Permission.auditView}),
  settings('settings', 'Settings', Icons.settings_outlined, {Permission.settingsView}),
  myProfile('profile', 'My Profile', Icons.person_outline, {}, available: true);

  const AppModule(this.key, this.label, this.icon, this.requires, {this.available = false, this.shortLabel});

  final String key;
  final String label;
  final IconData icon;
  final Set<Permission> requires;
  final bool available;

  /// Label for the bottom bar; defaults to the first word of [label].
  final String? shortLabel;
  String get barLabel => shortLabel ?? label.split(' ').first;

  static AppModule? fromKey(String? key) {
    for (final m in values) {
      if (m.key == key) return m;
    }
    return null;
  }
}

/// Role-specific menus, in display order.
abstract final class RoleNavigation {
  static const Map<UserRole, List<AppModule>> _menus = {
    UserRole.admin: [
      AppModule.dashboard, AppModule.newService, AppModule.vehicles, AppModule.customers,
      AppModule.services, AppModule.jobs, AppModule.invoices, AppModule.payments, AppModule.receipts,
      AppModule.credit, AppModule.loyalty, AppModule.staff, AppModule.finance, AppModule.expenses,
      AppModule.inventory, AppModule.attendance, AppModule.allowances, AppModule.payroll, AppModule.losses,
      AppModule.shareholders, AppModule.shares, AppModule.dividends, AppModule.afterHours,
      AppModule.reports, AppModule.users, AppModule.settings, AppModule.auditLogs,
    ],
    UserRole.manager: [
      AppModule.dashboard, AppModule.newService, AppModule.vehicles, AppModule.jobs, AppModule.customers,
      AppModule.services, AppModule.invoices,
      AppModule.payments, AppModule.receipts, AppModule.credit, AppModule.loyalty, AppModule.attendance, AppModule.allowances,
      AppModule.payroll, AppModule.losses, AppModule.finance, AppModule.expenses, AppModule.inventory, AppModule.reports, AppModule.afterHours,
      AppModule.shareholders, AppModule.shares, AppModule.dividends,
      AppModule.users,
    ],
    UserRole.cashier: [
      AppModule.dashboard, AppModule.newService, AppModule.vehicles, AppModule.customers,
      AppModule.jobs, AppModule.services, AppModule.invoices, AppModule.payments,
      AppModule.receipts, AppModule.credit, AppModule.loyalty, AppModule.expenses, AppModule.reconciliation,
      AppModule.attendance, AppModule.allowances,
      // Only when granted (e.g. dividends.view + dividends.pay to pay out).
      AppModule.dividends,
    ],
    UserRole.worker: [
      AppModule.dashboard, AppModule.myJobs, AppModule.vehicles, AppModule.services,
      // Phase 8: shown only while an after-hours authorisation's temporary
      // permissions (jobs.create, jobs.view, invoices.view) are in force.
      AppModule.newService, AppModule.jobs, AppModule.invoices, AppModule.receipts,
      AppModule.attendance, AppModule.allowances, AppModule.myAfterHours, AppModule.myProfile,
    ],
    UserRole.shareholder: [
      AppModule.dashboard, AppModule.financialSummary, AppModule.businessPerformance,
      AppModule.reports, AppModule.myShareholding,
    ],
    UserRole.auditor: [
      AppModule.dashboard, AppModule.auditLogs, AppModule.finance, AppModule.transactions, AppModule.expenses, AppModule.inventory,
      AppModule.payroll, AppModule.attendance, AppModule.allowances, AppModule.losses,
      AppModule.reconciliation, AppModule.discrepancies, AppModule.afterHours, AppModule.users,
      AppModule.jobs, AppModule.invoices, AppModule.payments, AppModule.receipts, AppModule.credit,
      AppModule.loyalty, AppModule.vehicles, AppModule.customers, AppModule.services,
      AppModule.shareholders, AppModule.shares, AppModule.dividends,
    ],
  };

  /// Modules [user] may see at [now], respecting denials and expired grants.
  static List<AppModule> modulesFor(AppUser user, DateTime now) {
    final granted = user.effectivePermissions(now);
    if (granted.isEmpty) return const [];
    return [
      for (final m in _menus[user.role]!)
        if (m.requires.isEmpty || m.requires.any(granted.contains)) m,
    ];
  }

  static bool canOpen(AppUser user, AppModule module, DateTime now) =>
      module == AppModule.myProfile || modulesFor(user, now).contains(module);

  /// Bottom bar holds at most this many entries; the rest live under "More".
  static const int maxBarItems = 5;
}
