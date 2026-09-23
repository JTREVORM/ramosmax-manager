import '../features/auth/application/session_state.dart';
import '../features/dashboard/application/role_navigation.dart';

/// Route paths and the access guard that decides where a session may be.
abstract final class AppRoutes {
  static const String splash = '/splash';
  static const String login = '/login';
  /// Forced replacement of a temporary password, outside the app shell.
  static const String changePassword = '/change-password';
  static const String accessDenied = '/access-denied';
  static const String home = '/app';

  /// Self-service password change from My Profile.
  static const String profilePassword = '$home/profile/password';

  static String module(AppModule m) => m == AppModule.dashboard ? home : '$home/${m.key}';

  // Vehicles, customers, services and service intake (Phase 3). Nested under
  // their modules so the guard's module check covers every sub-screen.
  static const String vehicles = '$home/vehicles';
  static String newVehicle({String? plate, String? customerId, bool startService = false}) =>
      Uri(path: '$vehicles/new', queryParameters: {
        'plate': ?plate,
        'customerId': ?customerId,
        if (startService) 'next': 'start',
      }).toString();
  static String vehicleDetail(String id) => '$vehicles/$id';
  static String editVehicle(String id) => '$vehicles/$id/edit';
  static String startService(String vehicleId) => '$vehicles/$vehicleId/start';
  static const String newService = '$home/new-service';
  static const String customers = '$home/customers';
  static const String newCustomer = '$customers/new';
  static String customerDetail(String id) => '$customers/$id';
  static String editCustomer(String id) => '$customers/$id/edit';
  static const String services = '$home/services';
  static const String newCatalogService = '$services/new';
  static String catalogService(String id) => '$services/$id';
  static const String jobs = '$home/jobs';
  static String intakeDetail(String id) => '$jobs/$id';

  // Worker orders, billing and loyalty (Phase 4), nested under their modules.
  static const String myJobs = '$home/my-jobs';
  static const String invoices = '$home/invoices';
  static String invoiceDetail(String id) => '$invoices/$id';
  static const String payments = '$home/payments';
  static const String receipts = '$home/receipts';
  static String receiptDetail(String id) => '$receipts/$id';
  static const String credit = '$home/credit';
  static const String loyalty = '$home/loyalty';
  static String vehicleLoyalty(String vehicleId) => '$loyalty/$vehicleId';

  // Finance, expenses and inventory (Phase 5), nested under their modules:
  // the guard's module check (finance.view / expenses.view / inventory.view)
  // covers every sub-screen, and each screen checks the finer permission.
  static const String finance = '$home/finance';
  static const String financeAccounts = '$finance/accounts';
  static String financeAccount(String id) => '$financeAccounts/$id';
  static const String financeTransactions = '$finance/transactions';
  static String financeTransaction(String id) => '$financeTransactions/$id';
  static const String financeTransfers = '$finance/transfers';
  static const String financeBanking = '$finance/banking';
  static const String financeReconciliation = '$finance/reconciliation';
  static const String financeReports = '$finance/reports';
  static const String expenses = '$home/expenses';
  static const String newExpense = '$expenses/new';
  static String expenseDetail(String id) => '$expenses/$id';
  static String editExpense(String id) => '$expenses/$id/edit';
  static const String inventory = '$home/inventory';
  static const String newInventoryItem = '$inventory/items/new';
  static String inventoryItem(String id) => '$inventory/items/$id';
  static String editInventoryItem(String id) => '$inventory/items/$id/edit';
  static String supplierDetail(String id) => '$inventory/suppliers/$id';
  static const String newPurchase = '$inventory/purchases/new';
  static String purchaseDetail(String id) => '$inventory/purchases/$id';

  // Attendance, allowances, salaries, payroll and losses (Phase 6), nested
  // under their modules; each screen checks the finer permission it needs.
  static const String attendance = '$home/attendance';
  static String attendanceDetail(String id) => '$attendance/$id';
  static const String allowances = '$home/allowances';
  static const String payroll = '$home/payroll';
  static String payrollDetail(String id) => '$payroll/run/$id';
  static String salaryDetail(String staffUid) => '$payroll/salary/$staffUid';
  static String deductionDetail(String id) => '$payroll/deduction/$id';
  static const String losses = '$home/losses';
  static String lossDetail(String id) => '$losses/$id';

  // Shareholders, shares and dividends (Phase 7), nested under their modules;
  // each screen checks the finer permission it needs.
  static const String shareholders = '$home/shareholders';
  static const String newShareholder = '$shareholders/new';
  static String shareholderDetail(String id) => '$shareholders/$id';
  static String editShareholder(String id) => '$shareholders/$id/edit';
  static const String shares = '$home/shares';
  static String shareTransaction(String id) => '$shares/txn/$id';
  static const String dividends = '$home/dividends';
  static String dividendDetail(String id) => '$dividends/$id';
  static const String myShareholding = '$home/my-shares';

  // User management (Phase 2). Nested under the `users` module so the guard's
  // module check (users.view) covers every sub-screen; each screen then
  // checks the finer permission it needs, and the Cloud Functions enforce it.
  static const String users = '$home/users';
  static const String newUser = '$users/new';
  static String userDetail(String uid) => '$users/$uid';
  static String editUser(String uid) => '$users/$uid/edit';
  static String userPermissions(String uid) => '$users/$uid/permissions';

  static AppModule? moduleForLocation(String location) {
    final path = Uri.parse(location).path;
    if (path == home) return AppModule.dashboard;
    if (!path.startsWith('$home/')) return null;
    return AppModule.fromKey(path.substring(home.length + 1).split('/').first);
  }
}

/// Pure redirect logic, unit-tested in test/unit/route_guard_test.dart.
///
/// This controls *navigation*. It is a usability layer — the Firestore and
/// Storage rules independently deny data access to anyone the guard would
/// turn away.
abstract final class RouteGuard {
  static String? redirect({
    required SessionState session,
    required String location,
    required DateTime now,
  }) {
    final path = Uri.parse(location).path;

    switch (session) {
      case SessionResolving() || AwaitingConnection() || SessionFailed():
        return path == AppRoutes.splash ? null : AppRoutes.splash;

      case SignedOut():
        return path == AppRoutes.login ? null : AppRoutes.login;

      case AccessDenied():
        return path == AppRoutes.accessDenied ? null : AppRoutes.accessDenied;

      // A temporary password must be replaced before anything else.
      case PasswordChangeRequired():
        return path == AppRoutes.changePassword ? null : AppRoutes.changePassword;

      case Authorized(:final user):
        if (!path.startsWith(AppRoutes.home)) return AppRoutes.home;
        final module = AppRoutes.moduleForLocation(path);
        if (module == null) return AppRoutes.home;
        if (module != AppModule.dashboard && !RoleNavigation.canOpen(user, module, now)) {
          return AppRoutes.home;
        }
        return null;
    }
  }
}
