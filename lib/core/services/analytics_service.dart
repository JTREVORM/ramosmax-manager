import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:flutter/foundation.dart';

/// Product analytics with an explicit allow-list.
///
/// Only events and parameter names declared in [AnalyticsEvents] can be sent,
/// and parameter values are restricted to short non-identifying strings,
/// booleans and small integers. This makes it structurally hard to leak phone
/// numbers, amounts, plates or other business data into Analytics.
class AnalyticsService {
  AnalyticsService({required bool enabled, FirebaseAnalytics? analytics})
      : _analytics = enabled ? (analytics ?? FirebaseAnalytics.instance) : null;

  final FirebaseAnalytics? _analytics;

  Future<void> initialize() async {
    await _analytics?.setAnalyticsCollectionEnabled(true);
  }

  Future<void> setUser({required String uid, required String role}) async {
    await _analytics?.setUserId(id: uid);
    await _analytics?.setUserProperty(name: 'role', value: role);
  }

  Future<void> clearUser() async {
    await _analytics?.setUserId(id: null);
    await _analytics?.setUserProperty(name: 'role', value: null);
  }

  Future<void> logScreen(String screenName) async {
    await _analytics?.logScreenView(screenName: screenName);
  }

  Future<void> logEvent(String name, [Map<String, Object> parameters = const {}]) async {
    assert(AnalyticsEvents.all.contains(name), 'Unregistered analytics event: $name');
    if (!AnalyticsEvents.all.contains(name)) return;
    final safe = <String, Object>{
      for (final e in parameters.entries)
        if (AnalyticsEvents.allowedParams.contains(e.key) && _isSafeValue(e.value)) e.key: e.value,
    };
    if (kDebugMode) debugPrint('[analytics] $name $safe');
    await _analytics?.logEvent(name: name, parameters: safe);
  }

  static bool _isSafeValue(Object v) =>
      v is bool ||
      (v is int && v.abs() < 1000) ||
      (v is String && v.length <= 40 && !RegExp(r'\d{4,}').hasMatch(v));
}

/// Registry of analytics events. Add new events here — and nowhere else.
abstract final class AnalyticsEvents {
  // Sign-in (phone number + password). Never carries the phone number or
  // anything about the password — only a failure category.
  static const String signInSucceeded = 'sign_in_succeeded';
  static const String signInFailed = 'sign_in_failed';
  static const String passwordChanged = 'password_changed';
  static const String passwordReset = 'password_reset';
  static const String sessionStarted = 'session_started';
  static const String accessDenied = 'access_denied';
  static const String signedOut = 'signed_out';

  // User management (Phase 2). Only the role KEY is ever attached — never
  // names, phone numbers, staff IDs or UIDs of the people being managed.
  static const String userManagementOpened = 'user_management_opened';
  static const String userCreated = 'user_created';
  static const String userRoleChanged = 'user_role_changed';
  static const String userActivated = 'user_activated';
  static const String userDeactivated = 'user_deactivated';
  static const String userPermissionsChanged = 'user_permissions_changed';
  static const String temporaryPermissionCreated = 'temporary_permission_created';

  // Customers, vehicles, services (Phase 3). Never the plate, name or phone.
  static const String vehicleSearched = 'vehicle_searched';
  static const String vehicleRegistered = 'vehicle_registered';
  static const String customerCreated = 'customer_created';
  static const String serviceSaved = 'service_saved';
  static const String serviceIntakeCreated = 'service_intake_created';

  // Jobs, billing and loyalty (Phase 4). Never amounts, plates or names;
  // `outcome` carries only an action or method key.
  static const String workOrderAssigned = 'work_order_assigned';
  static const String workOrderUpdated = 'work_order_updated';
  static const String invoiceCreated = 'invoice_created';
  static const String discountApplied = 'discount_applied';
  static const String paymentRecorded = 'payment_recorded';
  static const String paymentReversed = 'payment_reversed';
  static const String invoiceMarkedCredit = 'invoice_marked_credit';
  static const String invoiceCancelled = 'invoice_cancelled';
  static const String loyaltyRewardApplied = 'loyalty_reward_applied';
  static const String loyaltyAdjusted = 'loyalty_adjusted';
  static const String receiptShared = 'receipt_shared';

  // Phase 5 - no amounts, account numbers or names; `outcome` holds only a type/action key.
  static const String financeAction = 'finance_action';
  static const String expenseAction = 'expense_action';
  static const String inventoryAction = 'inventory_action';

  // Phase 6 - never a salary, amount or name; `outcome` holds only an action key.
  static const String attendanceAction = 'attendance_action';
  static const String allowanceAction = 'allowance_action';
  static const String payrollAction = 'payroll_action';
  static const String lossAction = 'loss_action';

  // Phase 7 - never a name, share count or amount; `outcome` holds only an action key.
  static const String shareholderAction = 'shareholder_action';
  static const String shareAction = 'share_action';
  static const String dividendAction = 'dividend_action';

  // Phase 8 - never a name or amount; `outcome` holds only an action key.
  static const String afterHoursAction = 'after_hours_action';

  static const Set<String> all = {
    signInSucceeded, signInFailed, passwordChanged, passwordReset, sessionStarted, accessDenied, signedOut,
    userManagementOpened, userCreated, userRoleChanged, userActivated, userDeactivated,
    userPermissionsChanged, temporaryPermissionCreated,
    vehicleSearched, vehicleRegistered, customerCreated, serviceSaved, serviceIntakeCreated,
    workOrderAssigned, workOrderUpdated, invoiceCreated, discountApplied, paymentRecorded, paymentReversed,
    invoiceMarkedCredit, invoiceCancelled, loyaltyRewardApplied, loyaltyAdjusted, receiptShared,
    financeAction, expenseAction, inventoryAction,
    attendanceAction, allowanceAction, payrollAction, lossAction,
    shareholderAction, shareAction, dividendAction,
    afterHoursAction,
  };

  static const Set<String> allowedParams = {'role', 'reason', 'country', 'resend', 'failure_kind', 'outcome', 'count'};
}
