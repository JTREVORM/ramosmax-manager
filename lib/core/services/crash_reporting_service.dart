import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

import '../errors/app_failure.dart';

/// Thin wrapper around Crashlytics.
///
/// Privacy contract: only the Firebase UID (a pseudonymous identifier) and
/// the role are attached to reports. Phone numbers, names, passwords, tokens,
/// amounts, bank/ID numbers and salary data are never passed here. Callers
/// report the *error*, not the business record that was involved.
class CrashReportingService {
  CrashReportingService({required bool enabled, FirebaseCrashlytics? crashlytics})
      : _enabled = enabled && !kIsWeb,
        _crashlytics = (enabled && !kIsWeb) ? (crashlytics ?? FirebaseCrashlytics.instance) : null;

  final bool _enabled;
  final FirebaseCrashlytics? _crashlytics;

  /// Installs global Flutter and platform error hooks. Call once at startup.
  Future<void> initialize() async {
    if (!_enabled) return;
    await _crashlytics!.setCrashlyticsCollectionEnabled(true);
    FlutterError.onError = _crashlytics.recordFlutterFatalError;
    PlatformDispatcher.instance.onError = (error, stack) {
      _crashlytics.recordError(error, stack, fatal: true);
      return true;
    };
  }

  Future<void> setUser({required String uid, required String role}) async {
    if (!_enabled) return;
    await _crashlytics!.setUserIdentifier(uid);
    await _crashlytics.setCustomKey('role', role);
  }

  Future<void> clearUser() async {
    if (!_enabled) return;
    await _crashlytics!.setUserIdentifier('');
    await _crashlytics.setCustomKey('role', 'none');
  }

  /// Records a non-fatal error. [reason] must be a static description
  /// ("user profile lookup failed"), never interpolated user data.
  Future<void> recordError(Object error, StackTrace? stack, {String? reason}) async {
    if (!_enabled) {
      if (kDebugMode) debugPrint('[crash] ${reason ?? ''} ${_describe(error)}');
      return;
    }
    await _crashlytics!.recordError(_sanitise(error), stack, reason: reason);
  }

  Future<void> log(String message) async {
    if (!_enabled) return;
    await _crashlytics!.log(message);
  }

  // AppFailure messages are user-facing text; report kind + provider code only.
  Object _sanitise(Object error) =>
      error is AppFailure ? 'AppFailure(${error.kind.name}, ${error.code ?? '-'})' : error;

  String _describe(Object error) => _sanitise(error).toString();
}
