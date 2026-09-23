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

Phase 8 adds (generic text — never a name or amount):

| Type | Sent to |
|---|---|
| `after_hours_authorized` | The authorised worker |
| `after_hours_expiring` | The worker, once, 30 minutes before the authorisation ends (scheduled sweep) |
| `cash_handover_pending` | Holders of `cash_handover.approve` when a session closes with cash; the worker if someone else closed it |
| `cash_handover_submitted` | Holders of `cash_handover.approve` |
| `cash_discrepancy_detected` | The worker and holders of `after_hours.discrepancy.review` |
| `cash_discrepancy_resolved` | The worker and the person who recorded the discrepancy |

The Analytics event `after_hours_action` carries only an action key in `outcome`.

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

## Phase 9: notification hardening

**One notifier** (`functions/src/notify.js`); nothing parallel was added.

**New events:**

| Type | Sent to | Category |
|---|---|---|
| `password_reset` | The person whose password an Administrator reset (never the password) | access (always on) |
| `job_reassigned` | The worker a job was taken from | jobs |
| `job_cancelled` | The worker whose job was cancelled | jobs |
| `job_ready_to_invoice` | The person who started the job, when its last order completes | jobs |
| `expense_awaiting_approval` | Holders of `expenses.review` / `expenses.approve` (not the author) | finance |
| `expense_decided` | The author, when approved, rejected or paid | finance |
| `reconciliation_difference` | Holders of `finance.adjust` | finance |
| `attendance_corrected` | The staff member | workforce |
| `cash_handover_reminder` | Worker and receivers, once, when a handover is still open 2 hours after its session closed (scheduled) | after-hours (always on) |

**Reliability:**

- **De-duplicated.** Each in-app record has a deterministic ID from recipient, type, record and a 10-minute window,
  and is written with `create()`. A retried request, an overlapping scheduled run or a repeated trigger never notifies
  twice (tested with three simultaneous sends).
- **Recipients:**
  - an inactive or unknown account receives nothing, except the "access turned off" notice itself;
  - holders of a permission are looked up among active accounts only.
- **Delivery is recorded.** Each record carries `push.status`: `sent`, `partial`, `failed`, or `skipped` (muted, no
  device, no messaging). Also recorded: the success and failure counts, and how many dead tokens were removed.
  Delivery is therefore auditable without logs.
- **Tokens:**
  - unregistered or invalid tokens are removed at send time;
  - transient errors keep the token;
  - duplicates are ignored;
  - at most 500 tokens per send (the FCM limit);
  - the app removes its token at sign-out and replaces it on refresh.
- **Failure never breaks business.** Notifications are sent after the business transaction commits, through
  `notifySafely`. An FCM outage or notifier error is recorded and logged, and never fails the payment, approval or
  change that caused it (tested).
- **No sensitive text.** Titles and bodies stay generic: no names, amounts, salaries or share counts on a lock
  screen.

**Preferences** (`users/{uid}.notificationPreferences`, written only by `updateNotificationPreferences`):

- **What can be muted:** push only, per category (jobs, sales, finance, workforce, shareholding, after-hours). The
  in-app record is always kept.
- **What is always on:** access notices, personal pay (payroll paid, deductions, recoveries), after-hours
  authorisation and ending, overdue handovers, and cash discrepancies.
- **In the app:** Notifications → settings (tune icon). Critical categories are shown locked on.
- **Rules:** a client cannot write the preferences field directly (tested).

**In the app:**

- a bell with the unread count in the app bar;
- the **Notifications** inbox (`/app/notifications`), newest 50: tapping a notice marks it read and opens its record,
  which the route guard still checks; "Mark all as read";
- a tapped push, including the one that launched the app, opens the same record.

**Scheduled jobs:** reviewed, and all retry-safe (see PRODUCTION_READINESS.md §3). No new schedule was created: the
handover reminder runs in the existing 15-minute sweep.

**Analytics (Phase 9)**, action keys only:

- `notification_preferences_changed` (count);
- `report_viewed` and `report_exported` (report key).

**Crashlytics review (Phase 9):**

- only the Firebase UID and role are attached;
- `AppFailure` is reported as kind and code, never its user-facing message;
- callable failures are expected outcomes and are not reported as crashes;
- functions log only an error's code and message, never request data (which can hold passwords);
- no passwords, tokens, keys, identity documents or amounts are logged.
