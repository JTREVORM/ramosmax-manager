import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'app.dart';
import 'core/config/app_environment.dart';
import 'core/providers/core_providers.dart';
import 'core/services/analytics_service.dart';
import 'core/services/crash_reporting_service.dart';
import 'core/services/firestore_service.dart';
import 'core/services/notification_service.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/presentation/splash_screen.dart';

/// Shared entry for every flavor. Shows the branded splash immediately, then
/// initialises Firebase behind it (the splash is what "initialises
/// Firebase"), then hands over to the real app.
void bootstrap(AppFlavor flavor) {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(AppBootstrapper(environment: AppEnvironment.forFlavor(flavor)));
}

class _CoreServices {
  const _CoreServices(this.crash, this.analytics);
  final CrashReportingService crash;
  final AnalyticsService analytics;
}

class AppBootstrapper extends StatefulWidget {
  const AppBootstrapper({super.key, required this.environment});
  final AppEnvironment environment;

  @override
  State<AppBootstrapper> createState() => _AppBootstrapperState();
}

class _AppBootstrapperState extends State<AppBootstrapper> {
  late Future<_CoreServices> _init = _initialise();

  Future<_CoreServices> _initialise() async {
    final env = widget.environment;
    await _verifyApplicationId(env);

    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: env.firebaseOptions);
    }
    final options = Firebase.app().options;
    if (options.projectId != env.firebaseProjectId) {
      throw StateError('Firebase project mismatch for ${env.flavor.name} build.');
    }

    FirestoreService.configure(FirebaseFirestore.instance);
    NotificationService.registerBackgroundHandler();

    // Crash reports only from release builds of real devices; debug sessions
    // print locally instead so development noise never reaches Crashlytics.
    final crash = CrashReportingService(enabled: !kDebugMode);
    await crash.initialize();
    final analytics = AnalyticsService(enabled: !kDebugMode || env.isProduction);
    await analytics.initialize();
    return _CoreServices(crash, analytics);
  }

  /// Refuses to start if this entrypoint was packaged under the other
  /// flavor's application ID — the guarantee that a dev build can't write to
  /// production (or vice versa) even if someone mixes up `-t` and `--flavor`.
  Future<void> _verifyApplicationId(AppEnvironment env) async {
    if (kIsWeb) return;
    final info = await PackageInfo.fromPlatform();
    if (info.packageName != env.expectedApplicationId) {
      throw StateError(
        'This ${env.flavor.name} build is running as "${info.packageName}" but must run as '
        '"${env.expectedApplicationId}". Build with the matching --flavor and -t entrypoint.',
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_CoreServices>(
      future: _init,
      builder: (context, snapshot) {
        if (snapshot.hasData) {
          final services = snapshot.data!;
          return ProviderScope(
            overrides: [
              appEnvironmentProvider.overrideWithValue(widget.environment),
              crashReportingProvider.overrideWithValue(services.crash),
              analyticsProvider.overrideWithValue(services.analytics),
            ],
            child: const RamosMaxApp(),
          );
        }
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light(),
          home: BrandedSplash(
            status: snapshot.hasError
                ? _StartupError(
                    details: kDebugMode ? snapshot.error.toString() : null,
                    onRetry: () => setState(() => _init = _initialise()),
                  )
                : null,
          ),
        );
      },
    );
  }
}

class _StartupError extends StatelessWidget {
  const _StartupError({required this.onRetry, this.details});
  final VoidCallback onRetry;
  final String? details;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        child: Column(children: [
          const Text(
            'RamosMAX could not start. Check your connection and try again.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white),
          ),
          if (details != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(details!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white54, fontSize: 11)),
            ),
          TextButton(onPressed: onRetry, child: const Text('Try again')),
        ]),
      );
}
