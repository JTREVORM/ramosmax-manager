// In-app + push notifications for access changes and operations (Phase 4).
//
// Payloads carry a type and a record ID only. Titles and bodies are generic -
// no names, roles, permissions or amounts - because they appear on locked
// screens (docs/NOTIFICATIONS_AND_MONITORING.md).

import { FieldValue } from 'firebase-admin/firestore';

import { NotificationType } from './user_admin.js';

const TEXT = {
  [NotificationType.accountActivated]: ['Account activated', 'Your RamosMAX account is active. You can sign in.'],
  [NotificationType.accountDeactivated]: ['RamosMAX access changed', 'Your RamosMAX access has been turned off. Contact an administrator.'],
  [NotificationType.roleChanged]: ['Your role has changed', 'Open RamosMAX to see your updated access.'],
  [NotificationType.temporaryPermissionGranted]: ['Temporary access granted', 'You have been given temporary access in RamosMAX.'],
  [NotificationType.temporaryPermissionExpiring]: ['Temporary access ending soon', 'Your temporary access in RamosMAX ends within 30 minutes.'],
  [NotificationType.workOrderAssigned]: ['New job assigned', 'A job has been assigned to you. Open RamosMAX to accept it.'],
  [NotificationType.loyaltyRewardUnlocked]: ['Loyalty reward unlocked', 'A vehicle has unlocked a loyalty reward. Open RamosMAX for details.'],
  [NotificationType.recurringExpenseDue]: ['Bill due soon', 'A recurring expense is due. Open RamosMAX to review it.'],
  [NotificationType.lowStock]: ['Stock running low', 'An inventory item is low or out of stock. Open RamosMAX for details.'],
  // Phase 6: generic on purpose - never a name, salary or amount on a lock screen.
  [NotificationType.attendanceReview]: ['Attendance to review', 'A late arrival is waiting for verification. Open RamosMAX to review it.'],
  [NotificationType.attendanceRejected]: ['Attendance not approved', 'One of your attendance records was not approved. Open RamosMAX for details.'],
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
  [NotificationType.cashDiscrepancyDetected]: ['Cash discrepancy', 'A cash handover did not match the expected amount. Open RamosMAX to review it.'],
  [NotificationType.cashDiscrepancyResolved]: ['Cash discrepancy resolved', 'A cash handover discrepancy has been resolved. Open RamosMAX for details.'],
  // Phase 7: generic on purpose - never a shareholder name, share count or amount.
  [NotificationType.shareTransactionPending]: ['Share transaction to approve', 'A share transaction is waiting for approval. Open RamosMAX to review it.'],
  [NotificationType.shareTransactionCompleted]: ['Share transaction completed', 'A share transaction you requested has been decided. Open RamosMAX for details.'],
  [NotificationType.dividendDeclared]: ['Dividend to approve', 'A dividend has been declared and is waiting for approval. Open RamosMAX to review it.'],
  [NotificationType.dividendApproved]: ['Dividend approved', 'A dividend has been approved and is ready to pay. Open RamosMAX for details.'],
  [NotificationType.dividendPaid]: ['Dividend paid', 'A dividend payment to you has been recorded. Open RamosMAX to see your shareholding.'],
};

/** Android channel declared in the app manifest. */
const CHANNEL_ID = 'ramosmax_default';

export function makeNotifier(db, messaging) {
  return async function notify(uid, type, recordId) {
    const [title, body] = TEXT[type] ?? ['RamosMAX', 'Open RamosMAX for details.'];
    await db.collection('notifications').add({
      recipientId: uid,
      type,
      recordId,
      title,
      body,
      read: false,
      readAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (!messaging) return;
    const user = await db.collection('users').doc(uid).get();
    const tokens = (user.get('fcmTokens') ?? []).filter((t) => typeof t === 'string');
    if (tokens.length === 0) return;
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { type, recordId: String(recordId) },
      android: { notification: { channelId: CHANNEL_ID } },
    });
    // Drop tokens FCM says are gone, so we stop addressing dead devices.
    const stale = result.responses
      .map((r, i) => (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']
        .includes(r.error?.code) ? tokens[i] : null))
      .filter(Boolean);
    if (stale.length > 0) {
      await user.ref.update({ fcmTokens: FieldValue.arrayRemove(...stale) });
    }
  };
}
