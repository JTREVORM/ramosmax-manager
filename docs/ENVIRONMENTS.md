# Development and production environments

RamosMAX uses **two completely separate Firebase projects**. They share no users, data, files or tokens.

| | Development | Production |
|---|---|---|
| Firebase project | `ramos1-c0862` | `ramosmax-prod` ("RamosMAX Automotive Care") |
| Firestore location | `nam5` (US) | `eur3` (Europe multi-region) |
| Android application ID | `com.ramosmax.automotive.dev` | `com.ramosmax.automotive` |
| iOS bundle ID | `com.ramosmax.automotive.dev` | `com.ramosmax.automotive` |
| App name on device | RamosMAX Dev | RamosMAX |
| Entrypoint | `lib/main_dev.dart` | `lib/main_prod.dart` |
| Android flavor | `dev` | `prod` |
| Data | Test users, dummy transactions | Real staff, customers, money |
| In-app marker | Gold "DEVELOPMENT · TEST DATA" badge | none |

Dangerous or experimental work (payments, payroll, data migrations) is **only ever run against development**.

## Running and building

```bash
# Development
flutter run --flavor dev -t lib/main_dev.dart
flutter build apk --flavor dev -t lib/main_dev.dart            # internal test APK

# Production
flutter run --flavor prod -t lib/main_prod.dart --release
flutter build appbundle --flavor prod -t lib/main_prod.dart    # Google Play upload
flutter build ipa -t lib/main_prod.dart                        # macOS only; see DEPLOYMENT_IOS.md
```

`lib/main.dart` (used when `-t` is omitted) targets **development** on purpose, so a forgotten flag can never
touch production. VS Code launch configurations for both environments are in `.vscode/launch.json`.

## How separation is guaranteed

1. **Compile-time binding.** Each entrypoint passes an `AppFlavor`. `AppEnvironment` then selects
   `firebase_options_dev.dart` or `firebase_options_prod.dart`. There is no runtime switch.
2. **Distinct app identities.** Each Firebase project only has apps registered under its own application ID or
   bundle ID, and each Android flavor has its own `google-services.json`
   (`android/app/src/{dev,prod}/`).
3. **Startup guard.** `bootstrap.dart` compares the running package name with the flavor's expected ID, and the
   initialised Firebase project with the expected project ID. If either is wrong, the app stops at the splash
   with an error instead of connecting. This catches mix-ups such as `--flavor prod -t lib/main_dev.dart`.
4. **Same security rules everywhere.** `firebase/*.rules` are deployed unchanged to both projects. There are
   no relaxed "dev rules" that could be promoted by mistake.

## iOS specifics

iOS has no Gradle flavors. Without Xcode schemes, the environment follows the build configuration:

- `Debug` builds use `RAMOSMAX_BUNDLE_SUFFIX = .dev` (`ios/Flutter/Debug.xcconfig`), giving bundle ID
  `com.ramosmax.automotive.dev`. Run these with `-t lib/main_dev.dart`.
- `Release`/`Profile` builds use no suffix (`ios/Flutter/Release.xcconfig`), giving `com.ramosmax.automotive`.
  Build these with `-t lib/main_prod.dart`.

Firebase is configured from Dart (`FirebaseOptions`), so a `GoogleService-Info.plist` is not required at runtime.
Both plists are kept in `ios/config/{dev,prod}/` for tooling. If you later want `--flavor` on iOS (for example
a release build against dev), create `dev`/`prod` schemes and build configurations in Xcode on a Mac and point
each at an xcconfig that sets `RAMOSMAX_BUNDLE_SUFFIX`. The startup guard keeps any mistake harmless.

## Deploying rules and indexes

```bash
firebase deploy --only firestore,storage --project development
firebase deploy --only firestore,storage --project production
```

Aliases are defined in `.firebaserc`. Always deploy to development first and exercise the app, then deploy the
identical files to production.

## Regenerating Firebase configuration

Only needed if apps are re-registered:

```bash
flutterfire configure --project=ramos1-c0862 --platforms=android,ios,web \
  --android-package-name=com.ramosmax.automotive.dev --ios-bundle-id=com.ramosmax.automotive.dev \
  --out=lib/core/config/firebase/firebase_options_dev.dart \
  --android-out=android/app/src/dev/google-services.json --yes

flutterfire configure --project=ramosmax-prod --platforms=android,ios \
  --android-package-name=com.ramosmax.automotive --ios-bundle-id=com.ramosmax.automotive \
  --out=lib/core/config/firebase/firebase_options_prod.dart \
  --android-out=android/app/src/prod/google-services.json --yes
```

Download the iOS plists with `firebase apps:sdkconfig IOS <app-id> --out ios/config/<env>/GoogleService-Info.plist`.

The development project has a **web** app registered, used only to smoke-test the UI in Chrome
(`flutter run -d chrome -t lib/main_dev.dart`). Production has no web app, and the prod options throw if run on
the web.
