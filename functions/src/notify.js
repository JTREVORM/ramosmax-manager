// In-app + push notifications (Phases 2-9).
//
// Payloads carry a type and a record ID only. Titles and bodies are generic -
// no names, roles, permissions or amounts - because they appear on locked
// screens (docs/NOTIFICATIONS_AND_MONITORING.md).
//
// Phase 9 hardening:
//   * one in-app record per (recipient, type, record) within DEDUPE_WINDOW_MS:
//     a retried or repeated trigger never notifies twice (the record ID is
//     deterministic and written with create(), which refuses duplicates);
//   * inactive or missing recipients are skipped (except the "access turned
//     off" notice itself);
//   * people may turn off PUSH for non-critical categories
//     (users/{uid}.notificationPreferences, set by updateNotificationPreferences).
//     The in-app record is always written, and critical notices (access,
//     personal pay, after-hours authorisation, cash discrepancies) always push;
//   * the push outcome is recorded on the in-app record (auditability);
//   * tokens FCM reports as unregistered or invalid are removed;
//   * nothing here ever throws into a business transaction: callers use
//     notifySafely, after their transaction has committed.

import { FieldValue } from 'firebase-admin/firestore';

import { NotificationType } from './user_admin.js';

const TEXT = {
  [NotificationType.accountActivated]: ['Account activated', 'Your RamosMAX account is active. You can sign in.'],
  [NotificationType.accountDeactivated]: ['RamosMAX access changed', 'Your RamosMAX access has been turned off. Contact an administrator.'],
  [NotificationType.roleChanged]: ['Your role has changed', 'Open RamosMAX to see your updated access.'],
  [NotificationType.temporaryPermissionGranted]: ['Temporary access granted', 'You have been given temporary access in RamosMAX.'],
  [NotificationType.temporaryPermissionExpiring]: ['Temporary access ending soon', 'Your temporary access in RamosMAX ends within 30 minutes.'],
  [NotificationType.passwordReset]: ['Password reset', 'Your RamosMAX password was reset by an administrator. If you did not expect this, tell a manager.'],
  [NotificationType.workOrderAssigned]: ['New job assigned', 'A job has been assigned to you. Open RamosMAX to accept it.'],
  [NotificationType.workOrderReassigned]: ['Job moved', 'A job assigned to you has been moved to someone else.'],
  [NotificationType.workOrderCancelled]: ['Job cancelled', 'A job assigned to you has been cancelled. Open RamosMAX for details.'],
  [NotificationType.jobReadyToInvoice]: ['Job ready to invoice', 'All work on a job you started is complete. Open RamosMAX to invoice it.'],
  [NotificationType.loyaltyRewardUnlocked]: ['Loyalty reward unlocked', 'A vehicle has unlocked a loyalty reward. Open RamosMAX for details.'],
  [NotificationType.recurringExpenseDue]: ['Bill due soon', 'A recurring expense is due. Open RamosMAX to review it.'],
  [NotificationType.lowStock]: ['Stock running low', 'An inventory item is low or out of stock. Open RamosMAX for details.'],
  [NotificationType.expenseAwaitingApproval]: ['Expense to review', 'An expense is waiting for review or approval. Open RamosMAX for details.'],
  [NotificationType.expenseDecided]: ['Expense updated', 'An expense you recorded has been approved, rejected or paid. Open RamosMAX for details.'],
  [NotificationType.reconciliationDifference]: ['Reconciliation difference', 'An account reconciliation found a difference. Open RamosMAX to review it.'],
  // Phase 6: generic on purpose - never a name, salary or amount on a lock screen.
  [NotificationType.attendanceReview]: ['Attendance to review', 'A late arrival is waiting for verification. Open RamosMAX to review it.'],
  [NotificationType.attendanceRejected]: ['Attendance not approved', 'One of your attendance records was not approved. Open RamosMAX for details.'],
  [NotificationType.attendanceCorrected]: ['Attendance corrected', 'One of your attendance records was corrected. Open RamosMAX for details.'],
  [NotificationType.allowanceAwaitingApproval]: ['Allowances to approve', 'Daily allowances are waiting for approval. Open RamosMAX to review them.'],
  [NotificationType.allowanceApproved]: ['Allowance approved', 'Your daily allowance has been approved. Open RamosMAX for details.'],
  [NotificationType.payrollReview]: ['Payroll needs attention', 'A payroll is waiting for review or approval. Open RamosMAX for details.'],
  [NotificationType.payrollApproved]: ['Payroll approved', 'A payroll has been approved and is ready to pay. Open RamosMAX for details.'],
  [NotificationType.payrollPaid]: ['Pay processed', 'Your pay for the period has been processed. Open RamosMAX to see your payslip.'],
  [NotificationType.lossIncidentCreated]: ['Loss incident reported', 'A loss incident has been reported. Open RamosMAX to review it.'],
  [NotificationType.lossRecoveryScheduled]: ['Recovery scheduled', 'A recovery from your pay has been scheduled. Open RamosMAX for details.'],
  [NotificationType.deductionAwaitingApproval]: ['Deduction to approve', 'A salary deduction is waiting for approval. Open RamosMAX for details.'],
  [NotificationType.deductionApplied]: ['Deduction applied', 'A deduction was applied to your pay. Open RamosMAX to see your payslip.'],
  // Phase 8: generic on purpose - never a name or an amount.
  [NotificationType.afterHoursAuthorized]: ['After-hours work authorised', 'You have been authorised for after-hours work. Open RamosMAX for the times.'],
  [NotificationType.afterHoursExpiring]: ['After-hours ending soon', 'Your after-hours authorisation ends within 30 minutes. Close your session and hand over cash.'],
  [NotificationType.cashHandoverPending]: ['Cash handover pending', 'An after-hours session has closed and its cash is waiting to be handed over.'],
  [NotificationType.cashHandoverSubmitted]: ['Cash handover submitted', 'A cash handover is waiting to be counted and received. Open RamosMAX to receive it.'],
  [NotificationType.cashHandoverReminder]: ['Cash handover overdue', 'An after-hours cash handover is still waiting to be completed. Open RamosMAX for details.'],
  [NotificationType.cashDiscrepancyDetected]: ['Cash discrepancy', 'A cash handover did not match the expected amount. Open RamosMAX to review it.'],
  [NotificationType.cashDiscrepancyResolved]: ['Cash discrepancy resolved', 'A cash handover discrepancy has been resolved. Open RamosMAX for details.'],
  // Phase 7: generic on purpose - never a shareholder name, share count or amount.
  [NotificationType.shareTransactionPending]: ['Share transaction to approve', 'A share transaction is waiting for approval. Open RamosMAX to review it.'],
  [NotificationType.shareTransactionCompleted]: ['Share transaction completed', 'A share transaction you requested has been decided. Open RamosMAX for details.'],
  [NotificationType.dividendDeclared]: ['Dividend to approve', 'A dividend has been declared and is waiting for approval. Open RamosMAX to review it.'],
  [NotificationType.dividendApproved]: ['Dividend approved', 'A dividend has been approved and is ready to pay. Open RamosMAX for details.'],
  [NotificationType.dividendPaid]: ['Dividend paid', 'A dividend payment to you has been recorded. Open RamosMAX to see your shareholding.'],
};

/**
 * Preference categories. `access`, `pay` and the critical after-hours notices
 * cannot be muted: they tell a person about their own access, their own pay or
 * cash they are accountable for.
 */
export const NOTIFICATION_CATEGORIES = Object.freeze({
  access: [NotificationType.accountActivated, NotificationType.accountDeactivated, NotificationType.roleChanged,
    NotificationType.temporaryPermissionGranted, NotificationType.temporaryPermissionExpiring, NotificationType.passwordReset],
  jobs: [NotificationType.workOrderAssigned, NotificationType.workOrderReassigned, NotificationType.workOrderCancelled,
    NotificationType.jobReadyToInvoice],
  sales: [NotificationType.loyaltyRewardUnlocked],
  finance: [NotificationType.recurringExpenseDue, NotificationType.lowStock, NotificationType.expenseAwaitingApproval,
    NotificationType.expenseDecided, NotificationType.reconciliationDifference],
  workforce: [NotificationType.attendanceReview, NotificationType.attendanceRejected, NotificationType.attendanceCorrected,
    NotificationType.allowanceAwaitingApproval, NotificationType.allowanceApproved, NotificationType.payrollReview,
    NotificationType.payrollApproved, NotificationType.lossIncidentCreated, NotificationType.deductionAwaitingApproval],
  pay: [NotificationType.payrollPaid, NotificationType.deductionApplied, NotificationType.lossRecoveryScheduled],
  shareholding: [NotificationType.shareTransactionPending, NotificationType.shareTransactionCompleted,
    NotificationType.dividendDeclared, NotificationType.dividendApproved, NotificationType.dividendPaid],
  after_hours: [NotificationType.afterHoursAuthorized, NotificationType.afterHoursExpiring, NotificationType.cashHandoverPending,
    NotificationType.cashHandoverSubmitted, NotificationType.cashHandoverReminder, NotificationType.cashDiscrepancyDetected,
    NotificationType.cashDiscrepancyResolved],
});

/** Always pushed, whatever the recipient's preferences. */
export const CRITICAL_TYPES = new Set([
  ...NOTIFICATION_CATEGORIES.access,
  ...NOTIFICATION_CATEGORIES.pay,
  NotificationType.afterHoursAuthorized, NotificationType.afterHoursExpiring, NotificationType.cashHandoverReminder,
  NotificationType.cashDiscrepancyDetected,
]);

/** Categories a person may mute (push only). */
export const MUTABLE_CATEGORIES = Object.freeze(['jobs', 'sales', 'finance', 'workforce', 'shareholding', 'after_hours']);

export function categoryOf(type) {
  for (const [category, types] of Object.entries(NOTIFICATION_CATEGORIES)) if (types.includes(type)) return category;
  return 'other';
}

/** A repeat of the same notice to the same person within this window is dropped. */
export const DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_TOKENS = 500; // FCM multicast limit
const STALE_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/** Android channel declared in the app manifest. */
const CHANNEL_ID = 'ramosmax_default';

const safeId = (v) => String(v ?? 'none').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 200);

/** Deterministic in-app record ID: same recipient, type and record within the window → same ID. */
export function notificationId(uid, type, recordId, now) {
  return `${safeId(uid)}_${safeId(type)}_${safeId(recordId)}_${Math.floor(now / DEDUPE_WINDOW_MS)}`;
}

/** Push is sent unless the person muted the category (never for critical types). */
export function pushAllowed(userData, type) {
  if (CRITICAL_TYPES.has(type)) return true;
  const category = categoryOf(type);
  return userData?.notificationPreferences?.[category] !== false;
}

export function makeNotifier(db, messaging, { clock = () => Date.now() } = {}) {
  return async function notify(uid, type, recordId) {
    const now = clock();
    const userRef = db.collection('users').doc(String(uid));
    const user = await userRef.get();
    if (!user.exists) return { status: 'skipped', reason: 'no_user' };
    if (user.get('active') !== true && type !== NotificationType.accountDeactivated) return { status: 'skipped', reason: 'inactive' };

    const [title, body] = TEXT[type] ?? ['RamosMAX', 'Open RamosMAX for details.'];
    const ref = db.collection('notifications').doc(notificationId(uid, type, recordId, now));
    try {
      await ref.create({
        recipientId: uid,
        type,
        category: categoryOf(type),
        critical: CRITICAL_TYPES.has(type),
        recordId: recordId == null ? null : String(recordId),
        title,
        body,
        read: false,
        readAt: null,
        push: { status: 'pending' },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // ALREADY_EXISTS: this exact notice was sent moments ago (a retry or a
      // repeated trigger) - do not notify twice.
      if (e?.code === 6 || /already exists/i.test(e?.message ?? '')) return { status: 'skipped', reason: 'duplicate' };
      throw e;
    }

    let push;
    if (!messaging) push = { status: 'skipped', reason: 'no_messaging' };
    else if (!pushAllowed(user.data(), type)) push = { status: 'skipped', reason: 'muted' };
    else {
      const tokens = [...new Set((user.get('fcmTokens') ?? []).filter((t) => typeof t === 'string' && t.length > 0 && t.length < 4096))]
        .slice(0, MAX_TOKENS);
      if (tokens.length === 0) push = { status: 'skipped', reason: 'no_device' };
      else {
        try {
          const result = await messaging.sendEachForMulticast({
            tokens,
            notification: { title, body },
            data: { type, recordId: String(recordId ?? ''), notificationId: ref.id },
            android: { notification: { channelId: CHANNEL_ID } },
          });
          // Drop tokens FCM says are gone, so we stop addressing dead devices.
          const stale = result.responses
            .map((r, i) => (!r.success && STALE_TOKEN_CODES.has(r.error?.code) ? tokens[i] : null))
            .filter(Boolean);
          if (stale.length > 0) await userRef.update({ fcmTokens: FieldValue.arrayRemove(...stale) });
          push = {
            status: result.successCount > 0 ? (result.failureCount > 0 ? 'partial' : 'sent') : 'failed',
            successCount: result.successCount,
            failureCount: result.failureCount,
            removedTokens: stale.length,
          };
        } catch (e) {
          push = { status: 'failed', reason: String(e?.code ?? 'error').slice(0, 80) };
        }
      }
    }
    await ref.update({ push, updatedAt: FieldValue.serverTimestamp() });
    return { status: 'recorded', notificationId: ref.id, push };
  };
}
