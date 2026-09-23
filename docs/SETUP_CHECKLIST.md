# Outstanding manual setup

Everything in the repository is configured. These steps need console access, a Mac, or signing material, so
they could not be done from the development machine.

## Firebase — both projects (`ramos1-c0862` and `ramosmax-prod`)

- [ ] **Authentication → Sign-in method:** enable **Email/Password**; **disable Phone** (no longer used). Then create
      the `RAMOSMAX_AUTH_API_KEY` secret and grant *Service Account Token Creator* (see `ADMIN_PROVISIONING.md` §1).
      Until then, sign-in fails with "Sign-in is not available right now".
- [ ] **Enable Storage.** Console → Storage → *Get started*. New projects need the **Blaze** (pay-as-you-go)
      plan for a default bucket. Pick a location near Firestore (e.g. `europe-west1` for prod). Then run
      `firebase deploy --only storage --project development` and again with `--project production`. Accept the
      prompt to let Storage rules read Firestore.
- [ ] **Blaze plan** is required for Cloud Functions (sign-in and user management run there).
      Set a budget alert.
- [ ] **Android SHA-1 / SHA-256 fingerprints** for each signing key (see `DEPLOYMENT_ANDROID.md` §5), and enable
      the **Play Integrity API** in Google Cloud Console.
- [ ] **APNs key** uploaded under Cloud Messaging (see `DEPLOYMENT_IOS.md`).
- [ ] **Restrict API keys** (Google Cloud Console → Credentials) to the Android package plus SHA-1 and the iOS bundle ID.
- [ ] **Deploy Phase 2 backend** (Blaze required): `firebase deploy --project <development|production> --only
      firestore:rules,firestore:indexes,functions`. The first functions deploy enables the Cloud Functions,
      Cloud Build, Artifact Registry and Cloud Scheduler APIs (the last is for `sweepTemporaryGrants`).

## Development project only

- [ ] Create test accounts of each role in the app (User Management) after bootstrapping the dev Admin. No SMS test
      numbers are needed any more; remove any configured under the Phone provider.
- [ ] Generate a dev service-account key and create the first admin:
      `node tool/admin/provision.mjs bootstrap-admin --env dev --phone +256700000001 --name "Dev Admin"`.
      Then add test users of each role in the app (User Management).
- [ ] Optional tidy-up: delete the unused Android app `com.example.ramosmax_auto_manager` from project
      settings (a leftover from the original scaffold).

## Production project

- [ ] Create the first real administrator: `bootstrap-admin --env prod --confirm-production …` (typed
      confirmation of `ramosmax-prod`). See `ADMIN_PROVISIONING.md`.
- [ ] Keep the production service-account key with the fewest possible people.
- [ ] Consider enabling **App Check** before go-live.

## Development machine

- [ ] Install Android Studio (Android SDK plus JDK). **Not present on the machine used for Phases 1–2**, so no
      Android build has been produced yet. (Phase 2's emulator tests used a portable Temurin JRE 21.)
- [ ] Free disk space on `C:`. During Phase 2 it had under 1 GB free, which broke npm and tool temp files.
- [ ] `flutter doctor` clean for Android.
- [ ] First Android build: `flutter build apk --flavor dev -t lib/main_dev.dart`, then run on a device.

## Branding and business details

- [ ] Supply a **high-resolution logo** (≥1024 px or vector) and regenerate icons and splash (`ARCHITECTURE.md` → Branding).
- [ ] Fill in verified company phone, email, address, website and TIN in `lib/core/branding/brand.dart`.
- [ ] Publish a privacy policy URL (required by both stores).
