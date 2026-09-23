import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../../repositories/user_repository.dart';

/// Notification types the system will send. Payloads carry the type and a
/// record ID only — never amounts, names or other business data, because
/// notification content is visible on a locked screen.
abstract final class NotificationTypes {
  static const String jobAssigned = 'job_assigned';
  static const String jobCompleted = 'job_completed';
  static const String attendanceApproval = 'attendance_approval';
  static const String allowanceApproval = 'allowance_approval';
  static const String payrollApproval = 'payroll_approval';
  static const String outstandingCredit = 'outstanding_credit';
  static const String loyaltyRewardUnlocked = 'loyalty_reward_unlocked';
  static const String lowInventory = 'low_inventory';
  static const String recurringBillDue = 'recurring_bill_due';
  static const String cashHandoverPending = 'cash_handover_pending';
  static const String financialDiscrepancy = 'financial_discrepancy';

  // Access changes (Phase 2) — sent by functions/src/notify.js.
  static const String accountActivated = 'account_activated';
  static const String accountDeactivated = 'account_deactivated';
  static const String roleChanged = 'role_changed';
  static const String temporaryPermissionGranted = 'temporary_permission_granted';
  static const String temporaryPermissionExpiring = 'temporary_permission_expiring';

  // Attendance, allowances, payroll and losses (Phase 6) - sent by
  // functions/src/notify.js. A worker only ever receives the ones about
  // themselves (rejected attendance, approved allowance, pay processed,
  // recovery scheduled, deduction applied).
  static const String attendanceReview = 'attendance_review';
  static const String attendanceRejected = 'attendance_rejected';
  static const String allowanceAwaitingApproval = 'allowance_awaiting_approval';
  static const String allowanceApproved = 'allowance_approved';
  static const String payrollReview = 'payroll_review';
  static const String payrollApproved = 'payroll_approved';
  static const String payrollPaid = 'payroll_paid';
  static const String lossIncidentCreated = 'loss_incident_created';
  static const String lossRecoveryScheduled = 'loss_recovery_scheduled';
  static const String deductionAwaitingApproval = 'deduction_awaiting_approval';
  static const String deductionApplied = 'deduction_applied';

  // After-hours work and cash handovers (Phase 8) - sent by
  // functions/src/after_hours.js. The worker receives only the ones about
  // their own authorisation, handover or discrepancy.
  static const String afterHoursAuthorized = 'after_hours_authorized';
  static const String afterHoursExpiring = 'after_hours_expiring';
  static const String cashHandoverSubmitted = 'cash_handover_submitted';
  static const String cashDiscrepancyDetected = 'cash_discrepancy_detected';
  static const String cashDiscrepancyResolved = 'cash_discrepancy_resolved';
}

/// Background handler — must be a top-level function. Phase 1 performs no
/// background work; the system tray displays notification messages itself.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {}

/// FCM foundation: permission, device-token registration against the
/// signed-in user's profile, and a stream of foreground messages.
///
/// Messages are *sent* only by trusted server code (Phase 2+ Cloud Functions);
/// the client never authors notifications for other users.
class NotificationService {
  NotificationService(this._users, {FirebaseMessaging? messaging})
      : _injectedMessaging = messaging;

  final UserRepository _users;
  final FirebaseMessaging? _injectedMessaging;

  // Resolved lazily so the service can be constructed before/without Firebase.
  FirebaseMessaging get _messaging => _injectedMessaging ?? FirebaseMessaging.instance;

  /// Must match the Android manifest `default_notification_channel_id`.
  static const String defaultChannelId = 'ramosmax_default';

  StreamSubscription<String>? _tokenRefresh;
  String? _registeredUid;
  String? _currentToken;

  Stream<RemoteMessage> get foregroundMessages => FirebaseMessaging.onMessage;
  Stream<RemoteMessage> get openedFromNotification => FirebaseMessaging.onMessageOpenedApp;

  static void registerBackgroundHandler() {
    if (kIsWeb) return;
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  }

  /// Requests permission and links this device's token to [uid]. Safe to call
  /// on every session start; failures are non-fatal (a user without push can
  /// still work).
  Future<void> registerDevice(String uid) async {
    if (kIsWeb || _registeredUid == uid) return;
    final settings = await _messaging.requestPermission();
    if (settings.authorizationStatus == AuthorizationStatus.denied) return;

    final token = await _messaging.getToken();
    if (token != null) {
      await _users.addFcmToken(uid, token);
      _currentToken = token;
    }
    _registeredUid = uid;
    await _tokenRefresh?.cancel();
    _tokenRefresh = _messaging.onTokenRefresh.listen((fresh) async {
      final old = _currentToken;
      _currentToken = fresh;
      await _users.addFcmToken(uid, fresh);
      if (old != null && old != fresh) await _users.removeFcmToken(uid, old);
    });
  }

  /// Unlinks this device before sign-out so the next person to use a shared
  /// handset doesn't receive the previous user's notifications.
  Future<void> unregisterDevice() async {
    await _tokenRefresh?.cancel();
    _tokenRefresh = null;
    final uid = _registeredUid;
    final token = _currentToken;
    _registeredUid = null;
    _currentToken = null;
    if (kIsWeb || uid == null || token == null) return;
    await _users.removeFcmToken(uid, token);
    await _messaging.deleteToken();
  }
}
