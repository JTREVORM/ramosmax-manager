# iOS deployment (App Store)

> **Status: configured but not yet built or tested on iOS.** The project was prepared on Windows. No Xcode build,
> simulator run or device test has been done. Treat the first Mac build as a verification step.

## Identity

| | |
|---|---|
| Bundle ID (production) | `com.ramosmax.automotive`. **Keep it stable; it is tied to the App Store record.** |
| Bundle ID (Debug / development) | `com.ramosmax.automotive.dev` (via `RAMOSMAX_BUNDLE_SUFFIX` in `ios/Flutter/Debug.xcconfig`) |
| Display name | RamosMAX |
| Deployment target | iOS 15.0 |
| Version | `CFBundleShortVersionString` / `CFBundleVersion` from `pubspec.yaml` |

## Already configured in the repository

- Bundle IDs and the environment suffix (`project.pbxproj`, `Debug.xcconfig`, `Release.xcconfig`)
- `Info.plist`: display name, `UIBackgroundModes` (`fetch`, `remote-notification`), photo-library and camera
  usage descriptions (profile photos), `ITSAppUsesNonExemptEncryption = false`. (The phone-auth reCAPTCHA URL
  schemes were removed with the move to phone + password sign-in.)
- `Runner.entitlements` with `aps-environment`, referenced by all Runner build configurations
- App icons (from `flutter_launcher_icons`) and launch screen (from `flutter_native_splash`)
- Firebase iOS apps registered in both projects. Plists are in `ios/config/{dev,prod}/`. The app configures
  Firebase from Dart, so the plist doesn't need to be in the bundle.

## What is required (Mac + Apple accounts)

1. **Apple Developer Program** membership for RamosMAX Automotive Care (U) Ltd (organisation account; needs a
   D-U-N-S number).
2. **App ID** `com.ramosmax.automotive` with the *Push Notifications* capability (and `.dev` for internal
   builds).
3. **Signing:** in Xcode → Runner → Signing & Capabilities select the team. Automatic signing creates the
   development and distribution certificates and provisioning profiles. Never commit `.p12`, `.p8` or
   `.mobileprovision` files.
4. **APNs key:** Apple Developer → Keys → create a key with APNs enabled → download the `.p8` once. Upload it in
   Firebase console → Project settings → Cloud Messaging → Apple app configuration, **for both projects**
   (with Key ID and Team ID). Without it, FCM and silent-push phone verification don't work on iOS.
5. **App Store Connect:** create the app record with bundle ID `com.ramosmax.automotive`, fill in privacy
   details (phone number collected for authentication) and export compliance.
6. Build and upload:

   ```bash
   flutter build ipa -t lib/main_prod.dart --obfuscate --split-debug-info=build/symbols
   # upload build/ios/ipa/*.ipa with Transporter or Xcode Organizer → TestFlight
   ```

7. Test on a physical iPhone via TestFlight: phone sign-in, push permission prompt, session restore.

## First Mac build checklist

- [ ] `flutter build ios --debug -t lib/main_dev.dart` succeeds
- [ ] Signing team set; Push Notifications capability shows as enabled
- [ ] Phone sign-in works on a real device (simulators need a Firebase test phone number)
- [ ] Release archive uses bundle ID `com.ramosmax.automotive` with `main_prod.dart`
- [ ] Optional: add `dev`/`prod` Xcode schemes if iOS `--flavor` builds are wanted (see `ENVIRONMENTS.md`)
