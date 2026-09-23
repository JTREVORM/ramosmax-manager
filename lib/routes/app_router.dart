import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/providers/core_providers.dart';
import '../features/auth/application/session_controller.dart';
import '../features/auth/presentation/access_denied_screen.dart';
import '../features/auth/presentation/change_password_screen.dart';
import '../features/auth/presentation/login_screen.dart';
import '../features/auth/presentation/splash_screen.dart';
import '../features/billing/presentation/invoice_screens.dart';
import '../features/billing/presentation/loyalty_screens.dart';
import '../features/billing/presentation/payment_screens.dart';
import '../features/dashboard/application/role_navigation.dart';
import '../features/dashboard/presentation/dashboard_home_screen.dart';
import '../features/dashboard/presentation/dashboard_shell.dart';
import '../features/dashboard/presentation/module_screens.dart';
import '../features/expenses/presentation/expense_screens.dart';
import '../features/finance/presentation/finance_screens.dart';
import '../features/inventory/presentation/inventory_screens.dart';
import '../features/jobs/presentation/my_jobs_screen.dart';
import '../features/operations/presentation/customer_screens.dart';
import '../features/operations/presentation/intake_screens.dart';
import '../features/operations/presentation/service_screens.dart';
import '../features/operations/presentation/vehicle_detail_screen.dart';
import '../features/operations/presentation/vehicle_form_screen.dart';
import '../features/operations/presentation/vehicle_search_screen.dart';
import '../features/payroll/presentation/allowance_screens.dart';
import '../features/payroll/presentation/attendance_screens.dart';
import '../features/payroll/presentation/loss_screens.dart';
import '../features/payroll/presentation/payroll_screens.dart';
import '../features/shareholders/presentation/dividend_screens.dart';
import '../features/shareholders/presentation/my_shareholding_screen.dart';
import '../features/shareholders/presentation/share_screens.dart';
import '../features/shareholders/presentation/shareholder_screens.dart';
import '../features/users/presentation/user_detail_screen.dart';
import '../features/users/presentation/user_form_screen.dart';
import '../features/users/presentation/user_permissions_screen.dart';
import '../features/users/presentation/users_screen.dart';
import 'app_routes.dart';

/// Re-runs the router's redirect whenever the session changes.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    ref.listen(sessionProvider, (_, _) => notifyListeners());
  }
}

final appRouterProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh(ref);
  ref.onDispose(refresh.dispose);

  final router = GoRouter(
    initialLocation: AppRoutes.splash,
    refreshListenable: refresh,
    redirect: (context, state) => RouteGuard.redirect(
      session: ref.read(sessionProvider),
      location: state.uri.toString(),
      now: ref.read(clockProvider).value ?? DateTime.now(),
    ),
    routes: [
      GoRoute(path: AppRoutes.splash, builder: (_, _) => const SplashScreen()),
      GoRoute(path: AppRoutes.login, builder: (_, _) => const LoginScreen()),
      GoRoute(
        path: AppRoutes.changePassword,
        builder: (_, _) => const ChangePasswordScreen(forced: true),
      ),
      GoRoute(path: AppRoutes.accessDenied, builder: (_, _) => const AccessDeniedScreen()),
      ShellRoute(
        builder: (context, state, child) =>
            DashboardShell(location: state.uri.toString(), child: child),
        routes: [
          GoRoute(
            path: AppRoutes.home,
            builder: (_, _) => const DashboardHomeScreen(),
            routes: [
              GoRoute(
                path: 'vehicles',
                builder: (_, _) => const VehicleSearchScreen(),
                routes: [
                  GoRoute(
                    path: 'new',
                    builder: (_, state) => VehicleFormScreen(
                      initialPlate: state.uri.queryParameters['plate'],
                      initialCustomerId: state.uri.queryParameters['customerId'],
                      startServiceAfter: state.uri.queryParameters['next'] == 'start',
                    ),
                  ),
                  GoRoute(
                    path: ':vehicleId',
                    builder: (_, state) => VehicleDetailScreen(vehicleId: state.pathParameters['vehicleId']!),
                    routes: [
                      GoRoute(path: 'edit', builder: (_, state) => VehicleFormScreen(vehicleId: state.pathParameters['vehicleId'])),
                      GoRoute(path: 'start', builder: (_, state) => StartServiceScreen(vehicleId: state.pathParameters['vehicleId']!)),
                    ],
                  ),
                ],
              ),
              GoRoute(path: 'new-service', builder: (_, _) => const VehicleSearchScreen(intakeMode: true)),
              GoRoute(
                path: 'customers',
                builder: (_, _) => const CustomersScreen(),
                routes: [
                  GoRoute(path: 'new', builder: (_, _) => const CustomerFormScreen()),
                  GoRoute(
                    path: ':customerId',
                    builder: (_, state) => CustomerDetailScreen(customerId: state.pathParameters['customerId']!),
                    routes: [
                      GoRoute(path: 'edit', builder: (_, state) => CustomerFormScreen(customerId: state.pathParameters['customerId'])),
                    ],
                  ),
                ],
              ),
              GoRoute(
                path: 'services',
                builder: (_, _) => const ServicesScreen(),
                routes: [
                  GoRoute(path: 'new', builder: (_, _) => const ServiceFormScreen()),
                  GoRoute(path: ':serviceId', builder: (_, state) => ServiceFormScreen(serviceId: state.pathParameters['serviceId'])),
                ],
              ),
              GoRoute(
                path: 'jobs',
                builder: (_, _) => const IntakesScreen(),
                routes: [
                  GoRoute(path: ':intakeId', builder: (_, state) => IntakeDetailScreen(intakeId: state.pathParameters['intakeId']!)),
                ],
              ),
              GoRoute(path: 'my-jobs', builder: (_, _) => const MyJobsScreen()),
              GoRoute(
                path: 'invoices',
                builder: (_, _) => const InvoicesScreen(),
                routes: [
                  GoRoute(path: ':invoiceId', builder: (_, state) => InvoiceDetailScreen(invoiceId: state.pathParameters['invoiceId']!)),
                ],
              ),
              GoRoute(path: 'payments', builder: (_, _) => const PaymentsScreen()),
              GoRoute(
                path: 'receipts',
                builder: (_, _) => const ReceiptsScreen(),
                routes: [
                  GoRoute(path: ':receiptId', builder: (_, state) => ReceiptScreen(receiptId: state.pathParameters['receiptId']!)),
                ],
              ),
              GoRoute(path: 'credit', builder: (_, _) => const CreditScreen()),
              GoRoute(
                path: 'loyalty',
                builder: (_, _) => const LoyaltyScreen(),
                routes: [
                  GoRoute(path: ':vehicleId', builder: (_, state) => VehicleLoyaltyScreen(vehicleId: state.pathParameters['vehicleId']!)),
                ],
              ),
              GoRoute(
                path: 'users',
                builder: (_, _) => const UsersScreen(),
                routes: [
                  GoRoute(path: 'new', builder: (_, _) => const UserFormScreen()),
                  GoRoute(
                    path: ':uid',
                    builder: (_, state) => UserDetailScreen(uid: state.pathParameters['uid']!),
                    routes: [
                      GoRoute(
                        path: 'edit',
                        builder: (_, state) => UserFormScreen(uid: state.pathParameters['uid']),
                      ),
                      GoRoute(
                        path: 'permissions',
                        builder: (_, state) => UserPermissionsScreen(uid: state.pathParameters['uid']!),
                      ),
                    ],
                  ),
                ],
              ),
              // Finance, expenses and inventory (Phase 5).
              GoRoute(
                path: 'finance',
                builder: (_, _) => const FinanceDashboardScreen(),
                routes: [
                  GoRoute(
                    path: 'accounts',
                    builder: (_, _) => const AccountsScreen(),
                    routes: [
                      GoRoute(path: ':accountId', builder: (_, state) => AccountDetailScreen(accountId: state.pathParameters['accountId']!)),
                    ],
                  ),
                  GoRoute(
                    path: 'transactions',
                    builder: (_, _) => const TransactionsScreen(),
                    routes: [
                      GoRoute(path: ':transactionId', builder: (_, state) => TransactionDetailScreen(transactionId: state.pathParameters['transactionId']!)),
                    ],
                  ),
                  GoRoute(path: 'transfers', builder: (_, _) => const TransfersScreen()),
                  GoRoute(path: 'banking', builder: (_, _) => const BankingScreen()),
                  GoRoute(path: 'reconciliation', builder: (_, _) => const ReconciliationScreen()),
                  GoRoute(path: 'reports', builder: (_, _) => const FinanceReportsScreen()),
                ],
              ),
              GoRoute(path: 'financial-summary', builder: (_, _) => const FinanceDashboardScreen()),
              GoRoute(path: 'transactions', builder: (_, _) => const TransactionsScreen(standalone: true)),
              GoRoute(path: 'reconciliation', builder: (_, _) => const ReconciliationScreen(standalone: true)),
              GoRoute(
                path: 'expenses',
                builder: (_, _) => const ExpensesScreen(),
                routes: [
                  GoRoute(path: 'new', builder: (_, _) => const ExpenseFormScreen()),
                  GoRoute(
                    path: ':expenseId',
                    builder: (_, state) => ExpenseDetailScreen(expenseId: state.pathParameters['expenseId']!),
                    routes: [
                      GoRoute(path: 'edit', builder: (_, state) => ExpenseFormScreen(expenseId: state.pathParameters['expenseId'])),
                    ],
                  ),
                ],
              ),
              GoRoute(
                path: 'inventory',
                builder: (_, _) => const InventoryScreen(),
                routes: [
                  GoRoute(path: 'items/new', builder: (_, _) => const ItemFormScreen()),
                  GoRoute(
                    path: 'items/:itemId',
                    builder: (_, state) => ItemDetailScreen(itemId: state.pathParameters['itemId']!),
                    routes: [
                      GoRoute(path: 'edit', builder: (_, state) => ItemFormScreen(itemId: state.pathParameters['itemId'])),
                    ],
                  ),
                  GoRoute(path: 'suppliers/:supplierId', builder: (_, state) => SupplierDetailScreen(supplierId: state.pathParameters['supplierId']!)),
                  GoRoute(path: 'purchases/new', builder: (_, _) => const PurchaseFormScreen()),
                  GoRoute(path: 'purchases/:purchaseId', builder: (_, state) => PurchaseDetailScreen(purchaseId: state.pathParameters['purchaseId']!)),
                ],
              ),
              // Attendance, allowances, payroll and losses (Phase 6).
              GoRoute(
                path: 'attendance',
                builder: (_, _) => const AttendanceScreen(),
                routes: [
                  GoRoute(path: ':attendanceId', builder: (_, state) => AttendanceDetailScreen(attendanceId: state.pathParameters['attendanceId']!)),
                ],
              ),
              GoRoute(path: 'allowances', builder: (_, _) => const AllowancesScreen()),
              GoRoute(
                path: 'payroll',
                builder: (_, _) => const PayrollScreen(),
                routes: [
                  GoRoute(path: 'run/:payrollId', builder: (_, state) => PayrollDetailScreen(payrollId: state.pathParameters['payrollId']!)),
                  GoRoute(path: 'salary/:staffUid', builder: (_, state) => SalaryDetailScreen(staffUid: state.pathParameters['staffUid']!)),
                  GoRoute(path: 'deduction/:deductionId', builder: (_, state) => DeductionDetailScreen(deductionId: state.pathParameters['deductionId']!)),
                ],
              ),
              GoRoute(
                path: 'losses',
                builder: (_, _) => const LossesScreen(),
                routes: [
                  GoRoute(path: ':incidentId', builder: (_, state) => LossDetailScreen(incidentId: state.pathParameters['incidentId']!)),
                ],
              ),
              // Shareholders, shares and dividends (Phase 7).
              GoRoute(
                path: 'shareholders',
                builder: (_, _) => const ShareholdersScreen(),
                routes: [
                  GoRoute(path: 'new', builder: (_, _) => const ShareholderFormScreen()),
                  GoRoute(
                    path: ':shareholderId',
                    builder: (_, state) => ShareholderDetailScreen(shareholderId: state.pathParameters['shareholderId']!),
                    routes: [
                      GoRoute(path: 'edit', builder: (_, state) => ShareholderFormScreen(shareholderId: state.pathParameters['shareholderId'])),
                    ],
                  ),
                ],
              ),
              GoRoute(
                path: 'shares',
                builder: (_, _) => const SharesScreen(),
                routes: [
                  GoRoute(path: 'txn/:transactionId', builder: (_, state) => ShareTransactionDetailScreen(transactionId: state.pathParameters['transactionId']!)),
                ],
              ),
              GoRoute(
                path: 'dividends',
                builder: (_, _) => const DividendsScreen(),
                routes: [
                  GoRoute(path: ':dividendId', builder: (_, state) => DividendDetailScreen(dividendId: state.pathParameters['dividendId']!)),
                ],
              ),
              GoRoute(path: 'my-shares', builder: (_, _) => const MyShareholdingScreen()),
              GoRoute(
                path: 'profile/password',
                builder: (_, _) => const ChangePasswordScreen(forced: false),
              ),
              GoRoute(
                path: ':module',
                builder: (_, state) {
                  final module = AppModule.fromKey(state.pathParameters['module']);
                  if (module == AppModule.myProfile) return const MyProfileScreen();
                  if (module == null) return const DashboardHomeScreen();
                  return ModuleNotAvailableScreen(module: module);
                },
              ),
            ],
          ),
        ],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
