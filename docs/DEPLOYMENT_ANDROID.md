# Android deployment (Google Play)

## Identity

| | |
|---|---|
| Application ID (production) | `com.ramosmax.automotive`. **Permanent once published; never change it.** |
| Application ID (dev flavor) | `com.ramosmax.automotive.dev` |
| Namespace / Kotlin package | `com.ramosmax.automotive` |
| App name | `RamosMAX` (prod) / `RamosMAX Dev` (dev), from the flavor `resValue` |
| minSdk / targetSdk | 23 (Firebase requirement) / Flutter default |

## Build configuration (`android/app/build.gradle.kts`)

- `dev` and `prod` product flavors, each with its own `google-services.json` in `src/<flavor>/`
- Release: R8 minification and resource shrinking, `proguard-rules.pro`, Crashlytics mapping upload
- Signing: reads `android/key.properties` (git-ignored). If it is absent, release builds fall back to the debug
  key, so they run locally but **cannot be uploaded to Play**.

## 1. Create the upload key (once, on a secure machine)

Requires a JDK (Android Studio bundles one under `jbr/bin`):

```bash
keytool -genkeypair -v -keystore C:/secure/ramosmax-upload-keystore.jks \
  -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias ramosmax-upload
```

- Store the `.jks` file and both passwords in the company password manager, with an offline backup.
  **Losing it means you cannot update the app** (unless Play App Signing key reset is used).
- Never commit it. `*.jks` is git-ignored.

## 2. Configure signing

Copy `android/key.properties.example` to `android/key.properties` and fill in:

```properties
storePassword=...
keyPassword=...
keyAlias=ramosmax-upload
storeFile=C:/secure/ramosmax-upload-keystore.jks
```

## 3. Build the bundle

```bash
flutter build appbundle --flavor prod -t lib/main_prod.dart --obfuscate --split-debug-info=build/symbols
```

Output: `build/app/outputs/bundle/prodRelease/app-prod-release.aab`. Keep `build/symbols` for each release;
upload it to Crashlytics with `firebase crashlytics:symbols:upload --app=<prod android app id> build/symbols`.

## 4. Google Play Console

1. Create the app "RamosMAX" with package `com.ramosmax.automotive`.
2. Enrol in **Play App Signing** (Google holds the app signing key; yours is the upload key).
3. Complete store listing, content rating, data-safety form (phone number collected for authentication),
   target audience (business app, not for children) and privacy policy URL.
4. Upload the `.aab` to **Internal testing** first, then promote.

## 5. Register SHA fingerprints with Firebase (recommended)

Sign-in is phone number + password and no longer needs Play Integrity or SMS. Registering every signing certificate
is still recommended: API-key restriction, App Check (Play Integrity) and future Google services rely on it.

| Certificate | Where to get SHA-1 / SHA-256 | Add to project |
|---|---|---|
| Debug keystore (each developer machine) | `cd android && ./gradlew signingReport` | `ramos1-c0862` (dev app) |
| Upload key | `keytool -list -v -keystore ramosmax-upload-keystore.jks` | `ramosmax-prod` |
| Play App Signing key | Play Console → Setup → App integrity | `ramosmax-prod` |

Firebase console → Project settings → Your apps → Android app → Add fingerprint. Enable the **Play Integrity API**
when you turn on App Check.

## Release checklist

- [ ] Version bumped in `pubspec.yaml` (see `VERSIONING.md`)
- [ ] `flutter analyze` clean, `flutter test` green
- [ ] Rules deployed to production and matching `firebase/`
- [ ] Built with `--flavor prod -t lib/main_prod.dart`
- [ ] Tested on a physical device via Internal testing
- [ ] Symbols uploaded to Crashlytics
