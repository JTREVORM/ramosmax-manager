import 'package:firebase_core/firebase_core.dart';

import 'firebase/firebase_options_dev.dart' as dev;
import 'firebase/firebase_options_prod.dart' as prod;

/// The Firebase environment a build talks to.
///
/// Development and production are separate Firebase projects with separate
/// users, data and security-rule deployments. A build is bound to exactly one
/// of them at compile time by its entrypoint (`lib/main_dev.dart` or
/// `lib/main_prod.dart`) — there is no runtime switch, so a production build
/// can never be pointed at test data or vice versa.
enum AppFlavor {
  dev,
  prod;

  bool get isProduction => this == AppFlavor.prod;
}

/// Immutable description of the environment the app was launched in.
class AppEnvironment {
  const AppEnvironment._({
    required this.flavor,
    required this.firebaseProjectId,
    required this.expectedApplicationId,
    required this.appTitle,
  });

  factory AppEnvironment.forFlavor(AppFlavor flavor) {
    switch (flavor) {
      case AppFlavor.dev:
        return const AppEnvironment._(
          flavor: AppFlavor.dev,
          firebaseProjectId: 'ramos1-c0862',
          expectedApplicationId: 'com.ramosmax.automotive.dev',
          appTitle: 'RamosMAX Dev',
        );
      case AppFlavor.prod:
        return const AppEnvironment._(
          flavor: AppFlavor.prod,
          firebaseProjectId: 'ramosmax-prod',
          expectedApplicationId: 'com.ramosmax.automotive',
          appTitle: 'RamosMAX',
        );
    }
  }

  final AppFlavor flavor;

  /// Firebase project this build is compiled against.
  final String firebaseProjectId;

  /// Android applicationId / iOS bundle ID this flavor must run under. Checked
  /// at startup so a dev entrypoint packaged as the prod app (or the reverse)
  /// fails fast instead of silently crossing environments.
  final String expectedApplicationId;

  final String appTitle;

  bool get isProduction => flavor.isProduction;

  /// Region of the RamosMAX Cloud Functions in both projects, next to
  /// Firestore (`eur3`). Must match `setGlobalOptions` in
  /// functions/src/index.js.
  static const String functionsRegion = 'europe-west1';

  /// Firebase options for the current platform in this environment.
  FirebaseOptions get firebaseOptions {
    switch (flavor) {
      case AppFlavor.dev:
        return dev.DefaultFirebaseOptions.currentPlatform;
      case AppFlavor.prod:
        return prod.DefaultFirebaseOptions.currentPlatform;
    }
  }
}
