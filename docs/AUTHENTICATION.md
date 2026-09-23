# Authentication and the user profile

RamosMAX staff sign in with **phone number + password**. There is no SMS code and no email address to remember.

Related: roles and permissions in [ROLES_AND_PERMISSIONS.md](ROLES_AND_PERMISSIONS.md), managing accounts in
[USER_MANAGEMENT.md](USER_MANAGEMENT.md), and the first Admin and the CLI in [ADMIN_PROVISIONING.md](ADMIN_PROVISIONING.md).

## Identity vs access

```
phone + password ──► signInWithPhonePassword (Cloud Function) ──► Firebase custom token
       ──► Firebase Auth session (UID) ──► Firestore users/{uid} ──► role + permissions ──► dashboard
```

| Firebase Authentication | Firestore `users/{uid}` |
|---|---|
| UID, phone number, the password (Email/Password provider), sessions | Name, role, permissions, active status, staff link, credential *state* (`mustChangePassword`), metadata |

Being signed in grants **nothing** by itself. Access requires a `users/{uid}` document that exists, has a known
`role`, has `active == true`, has no past `accessExpiresAt`, has **no pending password change**, and whose
`phoneNumber` equals the phone number on the Firebase Auth account. The Firestore and Storage rules apply the same
checks on every request (`isActive()`).

## How sign-in works

Firebase has no "phone number + password" provider, and Firebase Phone Auth always sends an SMS code. RamosMAX
therefore uses the **Email/Password** provider behind a server-side mapping:

- Each Firebase Auth account carries the person's **phone number** (Firebase keeps it unique) and a **random,
  hidden sign-in identity** such as `3f9c…@users.ramosmax.invalid`. It is not derived from the phone number and
  uses the reserved `.invalid` domain, so no mail can ever be sent to it. Nobody ever sees or types it.
- The app sends `{phoneNumber, password}` over HTTPS to the callable **`signInWithPhonePassword`**. That is the
  only function open to signed-out callers. It:
  1. normalises the phone (`0772123456` → `+256772123456`, the same rules as `PhoneNumbers.toE164`);
  2. refuses if the number is locked out (5 failed attempts → 15-minute cool-off, keyed by a hash of the number);
  3. finds the Auth account with that phone number (Admin SDK) and checks the password with Firebase
     Authentication (Identity Toolkit API);
  4. on any failure returns **"Incorrect phone number or password."**, the same answer for an unknown number,
     a wrong password or an account without a password, so accounts cannot be enumerated;
  5. once the password is right, checks the profile: not registered, inactive or expired are refused with a clear
     message;
  6. mints a **Firebase custom token** for that UID, audits `session.sign_in` and returns
     `{token, mustChangePassword}`.
- The app calls `FirebaseAuth.signInWithCustomToken(token)`. From then on it is a normal Firebase session
  (persisted, refreshed, and restored on relaunch).

The app never stores, caches or logs a password. It is typed, sent once and dropped (the field is cleared after a
failed attempt). Passwords never reach Analytics or Crashlytics.

| Step | Code |
|---|---|
| Phone (+256 default, country picker), password with show/hide, "Forgot password?" | `LoginScreen` |
| Normalisation, validation, analytics (no identifiers) | `LoginController`, `PhoneNumbers`, `Validators` |
| Server call + custom-token sign-in | `FirebaseAuthRepository.signIn` |
| Password verification, lock-out, profile checks, audit | `functions/src/session.js` → `signInWithPhonePassword` |
| Profile lookup and access decision | `authSnapshotProvider` → `SessionResolver` |
| Routing (dashboard, forced password change, access denied) | `RouteGuard` |

## Login errors

| Situation | Message |
|---|---|
| Invalid phone format | "Enter a valid Ugandan number, e.g. 772 123 456" (checked before anything is sent) |
| Wrong password / unknown number / no password yet | "Incorrect phone number or password." |
| Too many failed attempts | "Too many sign-in attempts. Wait N minutes and try again." |
| Profile missing | "This phone number is not registered for RamosMAX access. Please contact an administrator." |
| Deactivated | "Your RamosMAX account is inactive. Please contact an administrator." |
| Access period ended | "Your RamosMAX access period has ended. …" |
| Offline / timeout | "No internet connection. Check your network and try again." |
| Service unavailable | "Sign-in is not available right now. Please try again later." |

## Temporary passwords and the first sign-in

Every new account, and every administrator reset, gets a **temporary password** and `mustChangePassword: true`.

```
phone + temporary password ─► signed in ─► "Choose your password" screen (nothing else reachable)
        ─► changeOwnPassword(current, new) ─► Firebase password replaced, mustChangePassword = false
        ─► other sessions revoked, this device continues with a fresh token ─► dashboard
```

The change **cannot be bypassed**:

- the router allows only `/change-password` in the `PasswordChangeRequired` session state;
- the security rules treat `mustChangePassword == true` as inactive, so nothing but the person's own profile can
  be read;
- every privileged Cloud Function refuses such a caller (`password_change_required`).

The temporary password stops working as soon as the new one is set.

## Changing your own password

My Profile → **Security** → **Change password** asks for the current password, the new one and a confirmation.
The server verifies the current password, applies the policy, updates Firebase Authentication, records
`password.changed` and signs out the person's other devices. Nobody can change another user's password from this
screen; administrators *reset* passwords instead (see USER_MANAGEMENT.md).

**Forgot password?** There is no SMS or email recovery. Staff ask their Manager (Workers) or an Administrator, who
issues a temporary password from User Management.

## Password policy

The same rules are enforced in the app (`PasswordPolicy`) and on the server (`functions/src/passwords.js`, which
decides):

- at least 8 characters (at most 128);
- an uppercase letter, a lowercase letter, a number and a symbol;
- not a common or predictable password (`password`, `123456…`, `Ramos123`, …);
- not containing the person's phone number, staff ID or name.

Generated temporary passwords are 12 characters from a CSPRNG (`crypto.randomInt` on the server, `Random.secure()`
in the app), always contain every character class, and avoid look-alikes (`0 O o 1 l I`).

## Sessions

- Deactivation: the profile's `active: false` blocks every request immediately (rules + live profile listener),
  refresh tokens are revoked, and future sign-ins are refused. The Auth account is kept for reactivation.
- Administrator password reset: refresh tokens are revoked, and a signed-in device moves straight to the forced
  password change.
- Password change: other sessions are revoked, and the current device continues.
- Phone number change: sessions are revoked, and the person signs in again with the new number and the same password.

## The `users` document

`users/{firebaseUid}`. The document ID is the Firebase UID.

| Field | Type | Written by | Notes |
|---|---|---|---|
| `uid`, `phoneNumber`, `role`, `active`, `fullName`, `email`, `staffId`, `position`, `department`, `specialization`, `profilePhotoPath` | | functions | See USER_MANAGEMENT.md |
| `permissions`, `deniedPermissions`, `temporaryPermissions`, `accessExpiresAt` | | functions | See ROLES_AND_PERMISSIONS.md |
| `passwordSet` | bool | functions | A password exists in Firebase Auth (false/missing = legacy SMS account) |
| `mustChangePassword` | bool | functions | Temporary password pending; blocks all access except the change |
| `passwordChangedAt`, `passwordResetAt`, `passwordResetBy` | | functions | When and by whom, never what |
| `statusReason`, `statusChangedAt/By`, `lastAccessChangeAt/By` | | functions | |
| `fcmTokens`, `lastLoginAt`, `updatedAt` | | **the user** | Session bookkeeping, the only client-writable fields |
| `createdAt`, `createdBy`, `updatedBy` | | functions | |

Never stored in Firestore: passwords, password hashes, temporary passwords or the hidden sign-in identity.

**Deprecated:** `phoneVerified` / `phoneVerifiedAt` came from the retired SMS sign-in. They may remain in old
documents but are no longer read, written or used for any access decision.

## Firebase console configuration (both `ramos1-c0862` and `ramosmax-prod`)

| Setting | Required state |
|---|---|
| Authentication → Sign-in method → **Email/Password** | **Enabled** (Email link: disabled) |
| Authentication → Sign-in method → **Phone** | **Disable**. No longer used. Existing phone numbers on accounts are unaffected. |
| Authentication → Settings → **User actions** → email enumeration protection | Enabled (recommended) |
| Authentication → Settings → **Password policy** | Optional: enforce ≥ 8 characters with upper/lower/number/symbol (matches the app) |
| Google Cloud → APIs → **Identity Toolkit API** | Enabled (on by default with Firebase Auth) |
| Secret `RAMOSMAX_AUTH_API_KEY` | An API key restricted to the Identity Toolkit API. See ADMIN_PROVISIONING.md. |
| IAM: the Functions runtime service account | **Service Account Token Creator** on itself (needed to sign custom tokens) |

## Migration from the retired SMS sign-in

Accounts created before this change have a Firebase Auth account with a phone number but **no password**. They are
not deleted and nothing breaks silently:

1. `node tool/admin/provision.mjs list-legacy --env <dev|prod>` lists every profile whose Auth account has no
   password yet. The development project had **no** Auth accounts when this change was made.
2. An Administrator resets each one: **User Management → user → Security → Set password**, or
   `provision.mjs reset-password --phone … --reason "Move to password sign-in"`.
3. The reset attaches a hidden Email/Password identity and a temporary password **to the same Firebase UID**
   (`auth.updateUser`, which Firebase supports). The profile, role, permissions, staff link and audit history stay
   exactly as they were. The audit entry is marked `migratedFromSms`.
4. The person signs in with their phone number and the temporary password, then chooses their own.

Until reset, a legacy account simply gets "Incorrect phone number or password". It is never exposed or deleted.
