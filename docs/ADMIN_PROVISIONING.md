# Admin provisioning

Day-to-day, users are added **in the app** (User Management). This document covers what the app cannot do for
itself: preparing each Firebase project, the **first Administrator**, migration from the retired SMS sign-in, and
break-glass recovery.

**Nothing in this repository deploys automatically.** Every step below is run by a person, deliberately.

The mobile app never contains service-account keys, Admin SDK credentials, API secrets or passwords. Privileged work
happens in two trusted places only:

| Where | Credentials | Used for |
|---|---|---|
| Cloud Functions (`functions/`) | Google-managed runtime identity plus the `RAMOSMAX_AUTH_API_KEY` secret (Secret Manager) | Sign-in, password changes/resets, everything in User Management |
| Admin CLI (`tool/admin/provision.mjs`) | A service-account key held **outside** the repo by an administrator | First Admin, migration, recovery, scripted maintenance |

## 1. Prepare each project (`ramos1-c0862`, then `ramosmax-prod`)

1. **Blaze plan** (required for Cloud Functions).
2. **Authentication → Sign-in method:** enable **Email/Password** (not "Email link"). **Disable Phone**, which is no
   longer used. Recommended: Settings → User actions → **email enumeration protection** on.
3. **API key for password checks:** Google Cloud Console → APIs & Services → Credentials → *Create API key* →
   *Restrict key* → API restrictions: **Identity Toolkit API** only, no application restriction (it is used from
   the server). Store it as a Functions secret:

   ```bash
   firebase functions:secrets:set RAMOSMAX_AUTH_API_KEY --project development   # paste the key
   firebase functions:secrets:set RAMOSMAX_AUTH_API_KEY --project production
   ```

   Use a separate key per project. The key is never committed and never shipped in the app.
4. **Custom-token signing:** the Functions runtime service account (`<project-number>-compute@developer.gserviceaccount.com`
   for 2nd-gen functions) needs **Service Account Token Creator** on itself (IAM → the account → *Grant access*), and
   the **IAM Service Account Credentials API** must be enabled. Without this, sign-in fails with "Sign-in is not
   available right now".

## 2. Deploy the backend (manually)

```bash
cd functions && npm install && cd ..
firebase deploy --project development --only firestore:rules,firestore:indexes,storage,functions
firebase deploy --project production  --only firestore:rules,firestore:indexes,storage,functions
```

Deploy rules, indexes and functions together. The rules deny writes that only the new functions make correctly, and
the app build that uses password sign-in needs `signInWithPhonePassword` to exist.

## 3. Create the first Administrator

```bash
cd tool/admin && npm install
# PowerShell: $env:GOOGLE_APPLICATION_CREDENTIALS="C:\secure\ramosmax-dev-admin.json"
set GOOGLE_APPLICATION_CREDENTIALS=C:\secure\ramosmax-dev-admin.json

node provision.mjs bootstrap-admin --env dev --phone 0772123456 --name "Jane Doe" [--staff-id RMX-STF-0001]
```

- It refuses if an active Administrator already exists (`--force` only for break-glass recovery).
- It shows what will be created and asks you to type **`yes`** (development) or **`ramosmax-prod`** (production).
  Production also needs `--confirm-production` on the command line.
- It creates the Firebase Auth account (phone number + hidden Email/Password identity) and the profile with
  `mustChangePassword: true`, and writes `user.created` audit entries attributed to `admin-cli:<your OS user>`.
- It prints a **temporary password once** in the terminal. Hand it to the Administrator in person or over a secure
  channel. It is not stored anywhere else.

```bash
node provision.mjs bootstrap-admin --env prod --confirm-production --phone 0772123456 --name "Jane Doe"
# → Type "ramosmax-prod" to confirm:
```

## 4. The Administrator signs in

1. Install the app for that environment (dev build: *RamosMAX Dev*).
2. Enter the phone number (+256 preselected) and the temporary password.
3. The app asks them to **choose their own password**. After that they reach the Admin dashboard.

## 5. Additional users

In the app: **User Management → Add user** → *Generate secure password* → create. The temporary password is shown
once to the creator, who hands it to the employee. The employee signs in with phone + temporary password and
chooses their own. Managers reset Workers' passwords from the Worker's Security section; Admins reset anyone else's.

The CLI `create-user` command works for scripted setup of non-admin users (it prints the temporary password once) and
refuses `--role admin`. Further Administrators are added in the app so the audit trail names a real person.

## 6. Migrating accounts from the retired SMS sign-in

```bash
node provision.mjs list-legacy --env dev          # profiles whose Auth account has no password
node provision.mjs reset-password --env dev --phone 0772123456 --reason "Move to password sign-in"
```

`reset-password` keeps the **same Firebase UID**. It adds a hidden Email/Password identity and a temporary password
to the existing Auth account, so the profile, staff link, role, permissions and audit history are untouched. The same
works in the app (**Set password** on the user's Security section). Legacy accounts are never deleted. Until they
are reset they simply cannot sign in ("Incorrect phone number or password"). When this change was made, the
development project had **no** Auth accounts, so nothing needed migrating there.

## CLI reference

```bash
node provision.mjs create-user    --env dev --phone 0701234567 --role worker --name "Sam" --specialization detailer
node provision.mjs reset-password --env dev --phone 0701234567 --reason "Forgot password"
node provision.mjs set-role       --env dev --phone 0701234567 --role cashier --reason "Moved to the till"
node provision.mjs deactivate     --env dev --phone 0701234567 --reason "Left the company"   # refuses the last active Admin
node provision.mjs activate       --env dev --phone 0701234567
node provision.mjs grant-temp     --env dev --phone 0701234567 --permission payments.record --hours 4 --reason "Evening cover"
node provision.mjs revoke-temp    --env dev --phone 0701234567 --permission payments.record
node provision.mjs show           --env dev --phone 0701234567
node provision.mjs list-legacy    --env dev
```

The CLI reads roles and permissions from `functions/src/access_catalog.json` and the password generator from
`functions/src/passwords.js`, so it can never disagree with the app or the server.

## Protecting production

- Keep the production service-account key with as few people as possible, outside the repo (`.gitignore` blocks
  common key file names). Rotate it if exposed. Prefer short-lived keys, deleted after bootstrap.
- Never edit production rules, Auth accounts or user documents in the console. Changes made there bypass validation
  and RamosMAX's audit trail.
- Never set or read a staff member's password in the console. Use Reset password, so the change is audited and forces
  a new password.
- Recovery when every Administrator is locked out: `bootstrap-admin --force` or `reset-password` with the production
  key and typed confirmation, then review `audit_logs`.
- Consider **App Check** on Cloud Functions (`enforceAppCheck` in `functions/src/index.js`) before go-live, which
  also hardens the sign-in endpoint against scripted guessing.
