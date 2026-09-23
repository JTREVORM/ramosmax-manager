# User management

In-app administration of RamosMAX accounts (Phase 2). Open it from **User Management** on the dashboard, or under
**More** in the bottom bar. It is visible to anyone holding `users.view`: Admins, Managers and Auditors by
default. Every button is shown only when the viewer may use it, and every change is re-checked on the server.

## Screens

| Screen | Route | What it shows / does |
|---|---|---|
| Users | `/app/users` | Cards with photo, name, phone, staff ID, position, role, status, password state, last sign-in, created date and a permission summary. Search by name, phone (any format) or staff ID. Filters: All, Active, Inactive and each role. |
| Add user | `/app/users/new` | Name, phone (+256 default), email, staff link (blank staff ID = next `RMX-STF-####`), position, department, role, specialisation (workers), active switch, extra grants and denials, and a **temporary password** (*Generate secure password* → shown with *Copy* and a warning that it is shown only now; shown once more after creation). |
| User details | `/app/users/{uid}` | Sections: **Account**, **Employment**, **Access**, **Security** (status, reason, last access change, password reset, **Reset/Set password**) and **Access history** (for `audit.view` holders). Account shows the sign-in state (*Password set* / *Password change required* / *No password yet*), never a password. Actions: edit, link staff, change role, permissions, reset password, activate/deactivate. |
| Edit profile | `/app/users/{uid}/edit` | Name, sign-in phone number (confirmation; changed with `changeUserPhone`), email, position, department, specialisation, profile photo. |
| Permissions | `/app/users/{uid}/permissions` | Explicit grants, explicit denials, temporary permissions (with status, window, granted by, reason, revoke) and the read-only role permissions, each marked with its source: *Role permission, Explicit grant, Explicit denial, Temporary permission, Expired permission*. |

Role changes, deactivation, temporary grants and revocations each open a confirmation that shows the consequence
and asks for a **reason**. A reason is required for everything except activation and permission edits, where it is
optional. For example: *"Deactivate John Doe? John will no longer be able to access the RamosMAX system."*

## Staff ↔ user relationship

```
staff/RMX-STF-0001                     users/{firebase-uid}
  staffId:   RMX-STF-0001   ◄────────►   staffId:  RMX-STF-0001
  linkedUid: {firebase-uid}              role, permissions, active …
  fullName, phoneNumber, email,          position, department (display copies)
  position, department, specialization,
  employmentStatus, profilePhotoPath
```

- **Staff record** = employment facts. **User account** = application access.
- A staff member may exist without an account (`linkedUid: null`). An account may exist without a staff record, e.g. a
  shareholder.
- A staff record links to at most one account. Linking one that is already linked fails with *"Staff ID … is
  already linked to another user."*
- Staff IDs are allocated on the server from `counters/staff` (`RMX-STF-0001`, `RMX-STF-0002`, …). An existing
  ID can be entered instead. The staff ID is the document ID, which guarantees uniqueness. Relinking moves an
  account to a different record; a record's own ID never changes.
- Phase 10 (staff management) extends `staff/{staffId}` and adds restricted sub-collections for contracts, salaries
  and documents without touching authentication.

## Backend: Cloud Functions (`functions/src`)

All callable, region `europe-west1`. Each one verifies the caller, checks permissions and rules, validates the input,
writes the change **and its audit entries in one transaction**, and returns only IDs.

| Function | Permission | Notes |
|---|---|---|
| `createUser` | `users.create` (+ `users.permissions.manage` for grants/denials) | Creates the Firebase Auth account (phone number + hidden Email/Password identity holding the temporary password), the profile (`mustChangePassword: true`) and the staff record/link. The password comes from the creator's device (generated) or is generated on the server and returned once. Weak passwords are refused. Duplicate phone → `already-exists`. |
| `updateUserProfile` | `users.edit` | Name, email, position, department, specialisation, photo path. Refuses phone changes (`use_change_phone`). |
| `changeUserPhone` | `users.edit` | New sign-in phone number: validated, checked unique in Firebase Auth, changed in Auth **and** profile (and staff record) together, sessions revoked. Same UID, same password. Not for oneself. |
| `resetUserPassword` | `users.passwords.reset` | Generates a temporary password (returned once), sets `mustChangePassword`, revokes sessions, audits `password.reset` with the reason. Admins: anyone they may administer. Managers: **Workers only**. Never oneself. Also migrates SMS-era accounts (same UID). |
| `signInWithPhonePassword` | none (signed-out) | Phone + password sign-in. See AUTHENTICATION.md. |
| `changeOwnPassword` | signed in | Replaces one's own password after verifying the current one. Allowed while a change is pending. |
| `setUserRole` | `users.roles.manage` | Reason required. Clears specialisation for non-workers. Last-Admin protection. |
| `setUserActive` | `users.activate` / `users.deactivate` | Reason required to deactivate. Revokes sessions; never deletes or disables the Auth account. Last-Admin protection. |
| `setUserPermissions` | `users.permissions.manage` | Replaces explicit grants and denials; one audit entry per change. Refuses to add the Phase 8 authorisation-only permissions (`authorization_only`). |
| `grantTemporaryPermission` | `users.permissions.temporary` or `users.permissions.manage` | Start < end, at most 30 days. Writes the record and the enforcement index. `after_hours.operate` / `after_hours.cash.collect` are refused (`authorization_only`): they come only with an after-hours authorisation (AFTER_HOURS.md). |
| `revokeTemporaryPermission` | same | Ends a running or scheduled grant immediately. |
| `linkStaff` | `users.edit` | Link, relink (optionally creating the record) or unlink. |
| `sweepTemporaryGrants` | scheduled, every 15 min | Housekeeping and "ending soon" notifications. |

Errors carry a user-safe message and a machine `reason` (`last_admin`, `self_modification`, `staff_linked`,
`user_exists`, `phone_in_use`, `not_held`, `rank`, `admin_target`, …). The app shows the message
(`ErrorMapper.functions`). Anything unexpected becomes *"Something went wrong. Please try again."*; details
are only logged server-side.

## Audit trail

`audit_logs`, module `users`, written by the functions in the same transaction as the change:

| Action | Recorded |
|---|---|
| `user.created` | role, active, staff ID |
| `user.updated` | changed fields, before and after |
| `user.phone_changed` | masked old/new number, reason |
| `password.reset` | actor, target, reason, `migratedFromSms` when applicable. **Never the password.** |
| `password.changed` | the user themself (module `auth`) |
| `session.sign_in` / `session.sign_in_failed` | written by the sign-in function (module `auth`) |
| `user.role_changed` | previous role, new role, reason |
| `user.activated` / `user.deactivated` | previous and new status, reason |
| `permission.granted` / `permission.grant_removed` | permission |
| `permission.denied` / `permission.denial_removed` | permission |
| `permission.temporary_granted` / `permission.temporary_revoked` | permission, start, end, reason |
| `staff.linked` / `staff.unlinked` | staff ID, UID |

Each entry also stores the actor (`userId`, `userRole`), the target (`recordId`/`targetUserId`) and a server
`timestamp`. The log is append-only for everyone.

## Offline behaviour

User lists and details come from the Firestore cache, so they are readable offline. **Every change is online-only.**
The app checks connectivity first ("User management needs an internet connection…"), and the change itself is a
Cloud Function call, which cannot be queued. Nothing sensitive is ever written locally to sync later.

## Notifications

Sent by the functions (in-app `notifications` document + FCM push, generic text, no names or permissions):
`account_activated`, `account_deactivated`, `role_changed`, `temporary_permission_granted`,
`temporary_permission_expiring`. A deactivated person gets the push but can no longer open the app.

## Analytics

`user_management_opened`, `user_created`, `user_role_changed`, `user_activated`, `user_deactivated`,
`user_permissions_changed`, `temporary_permission_created`, `password_reset`. The only parameter is the role key. No names,
phone numbers, staff IDs or target UIDs are sent.

## Testing

| Suite | Command | Covers |
|---|---|---|
| Dart unit + widget | `flutter test` | Policy per role, self-escalation, search and filters, temporary windows, error mapping, catalogue sync, and screens: list, search, filters, details, create validation, role change, deactivation confirmation, permission editing, role-restricted views, offline refusal, password generation shown once, reset flow (Manager → Workers only), sign-in/forced-change flows |
| Functions (emulator) | `cd functions && npm test` | Every function's authorisation per role, self-escalation, unauthorised role and permission changes, last-Admin protection including a concurrent race, deactivated callers, duplicate phone/staff, temporary grant windows/revoke/sweep, **plus `session.test.js`**: sign-in (right/wrong password, unknown phone, inactive/expired/unregistered, lock-out), first-login change, resets per role, no password in Firestore or the audit log, phone changes (old number stops working), SMS-account migration |
| Security rules (emulator) | same command | Unauthenticated, no profile, each role's read access, deactivated/expired accounts, denials, expired/scheduled/legacy temporary grants, direct writes by every role (admin included), self-escalation, credential fields not client-writable, pending password change blocks access, sign-in throttle server-only, staff, counters, audit append-only and anti-forgery |

`npm test` starts the Auth and Firestore emulators (`firebase emulators:exec`) and needs Java 21+ on `PATH`.

## Passwords

| Who | May do |
|---|---|
| Admin | Generate the temporary password when creating any account; reset the password of anyone they may administer (not their own, which they change instead) |
| Manager | Reset passwords for **Workers only** (`users.passwords.reset`, limited by `passwordResetRolesForNonAdmins`). A Manager given `users.create` by an Admin can also create Worker/Cashier accounts. |
| Cashier, Worker, Auditor, Shareholder | Nothing on other accounts. They can only change their own password. |

The flow for a reset: **Users → person → Security → Reset password** → confirmation (*"Reset John Doe's
password?"*) with a reason → the new temporary password is shown **once** with *Copy* → the person's sessions end →
at their next sign-in they must choose their own password.

The UI never shows a current password, hash or Firebase credential data, and a temporary password cannot be
retrieved later. It exists only in the creator's dialog and in Firebase Authentication.
