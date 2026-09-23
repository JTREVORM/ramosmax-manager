import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/crash_reporting_service.dart';
import '../../../core/utils/stream_extensions.dart';
import '../../../models/audit_log_entry.dart';
import '../../../repositories/user_repository.dart';
import 'session_state.dart';

/// Raw inputs to the session decision: the Firebase user and their profile.
class AuthSnapshot {
  const AuthSnapshot.signedOut() : user = null, lookup = null, error = null;
  const AuthSnapshot.profile(User this.user, ProfileLookup this.lookup) : error = null;
  const AuthSnapshot.failed(this.user, Object this.error) : lookup = null;

  final User? user;
  final ProfileLookup? lookup;
  final Object? error;
}

/// Follows auth state and, for a signed-in user, their live profile.
final authSnapshotProvider = StreamProvider<AuthSnapshot>((ref) {
  final auth = ref.watch(authRepositoryProvider);
  final users = ref.watch(userRepositoryProvider);

  return auth.authStateChanges().switchMap<AuthSnapshot>((user) {
    if (user == null) return Stream.value(const AuthSnapshot.signedOut());
    return users
        .watchProfile(user.uid)
        .map<AuthSnapshot>((lookup) => AuthSnapshot.profile(user, lookup))
        .transform(StreamTransformer.fromHandlers(
          handleError: (error, stack, sink) => sink.add(AuthSnapshot.failed(user, error)),
        ));
  });
});

/// The current [SessionState]. Re-evaluated when auth, the profile, or the
/// clock changes (so an access expiry takes effect without a restart).
final sessionProvider = Provider<SessionState>((ref) {
  final snapshot = ref.watch(authSnapshotProvider);
  final now = ref.watch(clockProvider).value ?? DateTime.now();

  return switch (snapshot) {
    AsyncData(:final value) => _fromSnapshot(value, now),
    AsyncError(:final error) => SessionFailed(ErrorMapper.map(error)),
    _ => const SessionResolving(),
  };
});

SessionState _fromSnapshot(AuthSnapshot s, DateTime now) {
  if (s.error != null) return SessionFailed(ErrorMapper.map(s.error!));
  final user = s.user;
  if (user == null) return const SignedOut();
  return SessionResolver.resolve(
    uid: user.uid,
    authPhoneNumber: user.phoneNumber,
    lookup: s.lookup!,
    now: now,
  );
}

/// Side effects of session transitions: login bookkeeping, analytics and
/// Crashlytics identity, push registration. Watched once by the root widget.
///
/// Sign-ins are audited by the `signInWithPhonePassword` function itself
/// (it is the only place a session can start), so the audit trail does not
/// depend on the device.
final sessionEffectsProvider = Provider<void>((ref) {
  ref.listen<SessionState>(sessionProvider, (previous, next) {
    final prevUid = previous is Authorized ? previous.user.uid : null;

    if (next is Authorized && next.user.uid != prevUid) {
      unawaited(_onAuthorized(ref, next));
    } else if (next is AccessDenied && previous is! AccessDenied) {
      unawaited(ref.read(analyticsProvider).logEvent(
            AnalyticsEvents.accessDenied,
            {'reason': next.reason.name},
          ));
    } else if (next is SignedOut && previous is! SignedOut) {
      unawaited(ref.read(analyticsProvider).clearUser());
      unawaited(ref.read(crashReportingProvider).clearUser());
    }
  });
});

Future<void> _onAuthorized(Ref ref, Authorized session) async {
  final user = session.user;
  final crash = ref.read(crashReportingProvider);
  final analytics = ref.read(analyticsProvider);

  await _guard(crash, 'crash identity', () => crash.setUser(uid: user.uid, role: user.role.key));
  await _guard(crash, 'analytics identity', () async {
    await analytics.setUser(uid: user.uid, role: user.role.key);
    await analytics.logEvent(AnalyticsEvents.sessionStarted, {'role': user.role.key});
  });
  await _guard(crash, 'record login', () => ref.read(userRepositoryProvider).recordLogin(user.uid));

  await _guard(crash, 'push registration',
      () => ref.read(notificationServiceProvider).registerDevice(user.uid));
}

/// Session side effects are best-effort: a failure to, say, register for
/// push must never block someone from working. Failures are reported.
Future<void> _guard(CrashReportingService crash, String what, Future<void> Function() action) async {
  try {
    await action().timeout(const Duration(seconds: 15));
  } catch (e, st) {
    if (kDebugMode) debugPrint('[session] $what failed: $e');
    await crash.recordError(e, st, reason: 'session side effect failed: $what');
  }
}

/// User-initiated session actions.
final sessionActionsProvider = Provider<SessionActions>(SessionActions.new);

class SessionActions {
  SessionActions(this._ref);
  final Ref _ref;

  Future<void> signOut() async {
    final session = _ref.read(sessionProvider);
    final crash = _ref.read(crashReportingProvider);
    if (session is Authorized) {
      final user = session.user;
      await _guard(crash, 'audit sign-out', () => _ref.read(auditLogRepositoryProvider).record(
            AuditLogEntry(
              userId: user.uid,
              userRole: user.role,
              action: 'session.sign_out',
              module: AuditModule.auth,
              recordId: user.uid,
            ),
          ));
      await _guard(crash, 'push unregister',
          () => _ref.read(notificationServiceProvider).unregisterDevice());
    }
    await _guard(crash, 'analytics sign-out',
        () => _ref.read(analyticsProvider).logEvent(AnalyticsEvents.signedOut));
    await _ref.read(authRepositoryProvider).signOut();
  }

  /// Replaces the signed-in user's own password — the forced first-login
  /// change and "Change password" in My Profile. The server checks the
  /// current password and the policy, clears `mustChangePassword`, ends
  /// other sessions and audits it. Needs a connection; never queued.
  Future<Result<void>> changePassword({required String currentPassword, required String newPassword}) async {
    try {
      await _ref.read(connectivityServiceProvider).ensureOnline();
    } catch (_) {
      return const Failure(AppFailure(FailureKind.network,
          'Changing your password needs an internet connection. Connect and try again.',
          code: 'offline', retryable: true));
    }
    final result = await _ref
        .read(authRepositoryProvider)
        .changePassword(currentPassword: currentPassword, newPassword: newPassword);
    if (result is Success) {
      await _guard(_ref.read(crashReportingProvider), 'analytics password',
          () => _ref.read(analyticsProvider).logEvent(AnalyticsEvents.passwordChanged));
    }
    return result;
  }
}
