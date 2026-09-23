import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../core/services/notification_service.dart' show NotificationTap;
import '../../../models/app_notification.dart';
import '../../../models/app_user.dart';
import '../../../routes/app_routes.dart';
import '../../dashboard/application/role_navigation.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../data/notifications_repository.dart';

final notificationsRepositoryProvider = Provider<NotificationsRepository>((ref) => NotificationsRepository(ref.watch(firestoreProvider)));

final notificationsApiProvider = Provider<NotificationsApi>((ref) => CallableNotificationsApi(ref.watch(firebaseFunctionsProvider)));

final myNotificationsProvider = StreamProvider<List<AppNotification>>((ref) {
  final uid = ref.watch(currentUserProvider.select((u) => u?.uid));
  return uid == null ? Stream.value(const []) : ref.watch(notificationsRepositoryProvider).watchMine(uid);
});

/// Unread count for the app-bar badge. One bounded listener per session.
final unreadNotificationsProvider = StreamProvider<int>((ref) {
  final uid = ref.watch(currentUserProvider.select((u) => u?.uid));
  return uid == null ? Stream.value(0) : ref.watch(notificationsRepositoryProvider).watchUnreadCount(uid);
});

/// Pushes the person tapped (Phase 9). Empty without Firebase.
final notificationTapsProvider = StreamProvider<NotificationTap>((ref) => ref.watch(notificationServiceProvider).taps());

final notificationActionsProvider = Provider<NotificationActions>(NotificationActions.new);

class NotificationActions {
  NotificationActions(this._ref);
  final Ref _ref;

  /// Marking read is a plain field update the rules allow; offline it is
  /// queued by Firestore and applied on reconnect (harmless and idempotent).
  Future<void> markRead(String id) async {
    try {
      await _ref.read(notificationsRepositoryProvider).markRead(id);
    } catch (_) {}
  }

  Future<Result<int>> markAllRead() async {
    final uid = _ref.read(currentUserProvider)?.uid;
    if (uid == null) return const Success(0);
    return runOnline(_ref, () async {
      try {
        return Success(await _ref.read(notificationsRepositoryProvider).markAllRead(uid));
      } catch (e) {
        return Failure(ErrorMapper.map(e));
      }
    });
  }

  Future<Result<Map<String, bool>>> updatePreferences(Map<String, bool> preferences) => runOnline(
      _ref, () => _ref.read(notificationsApiProvider).updatePreferences(preferences),
      event: AnalyticsEvents.notificationPreferencesChanged, params: {'count': preferences.length});
}

/// Where a notification leads. Unknown types, or screens the person cannot
/// open, fall back to the inbox or the dashboard (the route guard decides).
String notificationRoute(AppNotification n, AppUser? user, DateTime now) {
  final id = n.recordId;
  bool can(Permission p) => user?.can(p, now) ?? false;
  final supervisor = can(Permission.afterHoursView) || can(Permission.cashHandoverApprove) || can(Permission.afterHoursDiscrepancyReview);
  switch (n.type) {
    case 'job_assigned' || 'job_reassigned' || 'job_cancelled':
      return AppRoutes.myJobs;
    case 'job_ready_to_invoice':
      return id == null ? AppRoutes.jobs : AppRoutes.intakeDetail(id);
    case 'loyalty_reward_unlocked':
      return id == null ? AppRoutes.invoices : AppRoutes.invoiceDetail(id);
    case 'recurring_expense_due' || 'expense_awaiting_approval' || 'expense_decided':
      return id == null ? AppRoutes.expenses : AppRoutes.expenseDetail(id);
    case 'inventory_low_stock':
      return id == null ? AppRoutes.inventory : AppRoutes.inventoryItem(id);
    case 'reconciliation_difference':
      return AppRoutes.financeReconciliation;
    case 'attendance_review' || 'attendance_rejected' || 'attendance_corrected':
      return id == null ? AppRoutes.attendance : AppRoutes.attendanceDetail(id);
    case 'allowance_awaiting_approval' || 'allowance_approved' || 'payroll_paid' || 'deduction_applied' || 'loss_recovery_scheduled':
      return AppRoutes.allowances;
    case 'payroll_review' || 'payroll_approved':
      return id == null ? AppRoutes.payroll : AppRoutes.payrollDetail(id);
    case 'deduction_awaiting_approval':
      return id == null ? AppRoutes.payroll : AppRoutes.deductionDetail(id);
    case 'loss_incident_created':
      return id == null ? AppRoutes.losses : AppRoutes.lossDetail(id);
    case 'share_transaction_pending' || 'share_transaction_completed':
      return id == null ? AppRoutes.shares : AppRoutes.shareTransaction(id);
    case 'dividend_declared' || 'dividend_approved':
      return id == null ? AppRoutes.dividends : AppRoutes.dividendDetail(id);
    case 'dividend_paid':
      return AppRoutes.myShareholding;
    case 'after_hours_authorized' || 'after_hours_expiring':
      return AppRoutes.myAfterHours;
    case 'cash_handover_pending' || 'cash_handover_submitted' || 'cash_handover_reminder':
      if (id == null) return supervisor ? AppRoutes.afterHours : AppRoutes.myAfterHours;
      return supervisor ? AppRoutes.afterHoursHandover(id) : AppRoutes.myHandover(id);
    case 'cash_discrepancy_detected' || 'cash_discrepancy_resolved':
      if (id == null) return supervisor ? AppRoutes.afterHours : AppRoutes.myAfterHours;
      return supervisor ? AppRoutes.afterHoursDiscrepancy(id) : AppRoutes.myDiscrepancy(id);
    case 'account_activated' || 'account_deactivated' || 'role_changed' || 'temporary_permission_granted' ||
          'temporary_permission_expiring' || 'password_reset':
      return AppRoutes.module(AppModule.myProfile);
    default:
      return AppRoutes.notifications;
  }
}
