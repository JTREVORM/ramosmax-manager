# Notifications, Analytics and Crashlytics

## Push notifications (FCM)

Foundation in `lib/core/services/notification_service.dart`:

- On every authorised session start, the app requests notification permission (Android 13+ and iOS), gets the
  device token and adds it to the user's `fcmTokens`. Token refreshes replace the old token.
- On sign-out the token is removed and deleted, so a shared handset stops receiving the previous user's
  notifications.
- A top-level background handler is registered at startup.
- `foregroundMessages` and `openedFromNotification` streams are exposed for later phases.
- Android default channel ID: `ramosmax_default` (manifest meta-data).

Planned notification types (`NotificationTypes`): job assigned or completed, attendance, allowance and payroll
approval, outstanding credit, loyalty reward unlocked, low inventory, recurring bill due, cash handover
pending, financial discrepancy.

Phase 2 sends the access-change notifications `account_activated`, `account_deactivated`, `role_changed`,
`temporary_permission_granted` and `temporary_permission_expiring` from `functions/src/notify.js`. It writes an
in-app `notifications` document plus an FCM push with generic text, and prunes device tokens FCM reports as dead.

Phase 4 adds `job_assigned` (to the worker, on assign/reassign) and `loyalty_reward_unlocked` (to the staff
member whose payment unlocked a vehicle's reward), through the same path. Customer-facing loyalty messages are
prepared as `loyalty_events` records (LOYALTY.md) for a later SMS/WhatsApp phase. Phase 4 Analytics events
(`work_order_*`, `invoice_*`, `payment_*`, `discount_applied`, `loyalty_*`, `receipt_shared`) carry no amounts,
plates or names; `outcome` holds only an action or method key.

Phase 5 adds, through the same path:

- `recurring_expense_due`: sent to holders of `expenses.approve` or `expenses.pay` when the daily sweep creates a
  due item for a recurring bill.
- `inventory_low_stock`: sent to holders of `inventory.manage` when a movement makes an item low or out of stock.
  It is sent once per worsening, not on every movement.

The text is generic ("Bill due soon", "Stock running low"), with no amounts or names. The Phase 5 Analytics events
`finance_action`, `expense_action` and `inventory_action` carry only an action key in `outcome`, such as `transfer`,
`paid` or `usage`. They never carry an amount, an account number or a name.

Phase 6 adds, through the same path (text is generic — never a name, salary or amount):

| Type | Sent to |
|---|---|
| `attendance_review` | Holders of `attendance.approve`/`.review` when a staff member clocks in **late** (on-time records simply wait in the queue) |
| `attendance_rejected` | The staff member whose attendance was rejected |
| `allowance_awaiting_approval` | Holders of `allowances.approve` after a calculation creates allowances to decide |
| `allowance_approved` | The staff member whose allowance was approved |
| `payroll_review` | Holders of `payroll.review` (submitted) and `payroll.approve` (reviewed) |
| `payroll_approved` | Holders of `payroll.pay` |
| `payroll_paid` | Each employee in the paid payroll (record ID = their payroll item) |
| `deduction_applied` | Each employee from whose pay a deduction was taken in that payroll |
| `loss_incident_created` | Holders of `losses.review`/`.approve` (not the person the incident is about) |
| `loss_recovery_scheduled` | The staff member a recovery was scheduled for |
| `deduction_awaiting_approval` | Holders of `payroll.approve` |

Phase 7 adds (generic text — never a shareholder name, share count or amount):

| Type | Sent to |
|---|---|
| `share_transaction_pending` | Holders of `shares.approve` (not the requester) when an issue / transfer / adjustment waits for approval |
| `share_transaction_completed` | The requester, when their share transaction is approved or rejected |
| `dividend_declared` | Holders of `dividends.approve` |
| `dividend_approved` | Holders of `dividends.pay` |
| `dividend_paid` | The shareholder's **linked** sign-in, if any (record ID = their allocation) |

Analytics events `shareholder_action`, `share_action` and `dividend_action` carry only an action key.

Workers only ever receive notifications about themselves. Auditors receive none by default. The Phase 6 Analytics
events `attendance_action`, `allowance_action`, `payroll_action` and `loss_action` carry only an action key in
`outcome`, never a salary, amount or name.

**Sending is server-side only** (Cloud Functions), triggered by the business events above. Payloads
carry a type and a record ID only, never amounts or names, because notifications appear on lock screens. An
in-app `notifications` collection is prepared for the history view.

iOS additionally needs an APNs key uploaded to Firebase (see `DEPLOYMENT_IOS.md`). The `aps-environment`
entitlement and background modes are already configured.

## Analytics

`AnalyticsService` wraps Firebase Analytics with an allow-list:

- Events: `sign_in_succeeded`, `sign_in_failed` (failure category only), `password_changed`, `password_reset`,
  `session_started`, `access_denied`, `signed_out`, and
  for user management `user_management_opened`, `user_created`, `user_role_changed`, `user_activated`,
  `user_deactivated`, `user_permissions_changed`, `temporary_permission_created` (role key only), and for Phase 3
  `vehicle_searched` (`outcome`: found / not_found — never the plate), `vehicle_registered`, `customer_created`,
  `service_saved`, `service_intake_created`.
  Register new events in `AnalyticsEvents`.
- User ID is the Firebase UID. User property: `role`.
- Parameters: only `role`, `reason`, `country`, `resend`, `failure_kind`, with short non-numeric values.

Debug builds of the dev flavor don't send Analytics (events print to the console instead).

## Crashlytics

`CrashReportingService`:

- Installs `FlutterError.onError` and `PlatformDispatcher.onError` handlers in release builds.
- Attaches only UID and role. Non-fatal `recordError` calls take a static reason string.
- Disabled in debug builds. The Android Crashlytics Gradle plugin uploads R8 mapping files for release builds so
  obfuscated traces are readable.

Neither service ever receives passwords, tokens, phone numbers, names, amounts, bank or ID numbers, or salaries.
