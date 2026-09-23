import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'app_failure.dart';

/// Converts any thrown error into an [AppFailure] with a user-safe message.
/// All Firebase error handling funnels through here so wording is consistent.
abstract final class ErrorMapper {
  static const _network =
      'No internet connection. Check your network and try again.';

  static AppFailure map(Object error) {
    if (error is AppFailure) return error;
    if (error is FirebaseAuthException) return _auth(error);
    if (error is FirebaseFunctionsException) return functions(error.code, error.message, error.details);
    if (error is FirebaseException) return _firebase(error);
    if (error is TimeoutException) {
      return const AppFailure(FailureKind.network, _network, code: 'timeout', retryable: true);
    }
    return const AppFailure(
      FailureKind.unknown,
      'Something went wrong. Please try again.',
      retryable: true,
    );
  }

  static const _badCredentials = 'Incorrect phone number or password.';

  /// Firebase Auth errors. With phone + password sign-in the app only calls
  /// `signInWithCustomToken`; the password itself is checked by the
  /// `signInWithPhonePassword` function (see [functions]).
  static AppFailure _auth(FirebaseAuthException e) {
    switch (e.code) {
      case 'invalid-credential':
      case 'wrong-password':
      case 'user-not-found':
        return AppFailure(FailureKind.invalidCredentials, _badCredentials, code: e.code);
      case 'invalid-custom-token':
      case 'custom-token-mismatch':
        return AppFailure(FailureKind.unavailable,
            'Sign-in is not available right now. Please try again later.',
            code: e.code, retryable: true);
      case 'too-many-requests':
        return AppFailure(FailureKind.tooManyRequests,
            'Too many attempts from this device. Wait a while before trying again.',
            code: e.code);
      case 'network-request-failed':
        return AppFailure(FailureKind.network, _network, code: e.code, retryable: true);
      case 'user-disabled':
        return AppFailure(FailureKind.permissionDenied,
            'This account has been disabled. Contact an administrator.',
            code: e.code);
      case 'operation-not-allowed':
      case 'app-not-authorized':
        return AppFailure(FailureKind.unavailable,
            'Sign-in is not available right now. Contact an administrator.',
            code: e.code);
      case 'requires-recent-login':
      case 'user-token-expired':
        return AppFailure(FailureKind.unauthenticated,
            'Your session has ended. Please sign in again.',
            code: e.code);
      default:
        return AppFailure(FailureKind.unknown,
            'Sign-in failed. Please try again.',
            code: e.code, retryable: true);
    }
  }

  /// Errors from the RamosMAX Cloud Functions. Our functions attach
  /// `details.reason` to every error they raise deliberately, and their
  /// message is written for the user — so it is shown as-is. Anything else
  /// (a platform or internal error) gets a generic message, so no server
  /// internals ever reach the screen. [code] on the result carries the
  /// reason (e.g. `last_admin`) for logic and tests.
  static AppFailure functions(String code, String? message, Object? details) {
    final reason = details is Map ? details['reason'] : null;
    final ours = reason is String && message != null && message.isNotEmpty;
    final kind = switch ((code, reason)) {
      (_, 'invalid_credentials') => FailureKind.invalidCredentials,
      (_, 'too_many_attempts') => FailureKind.tooManyRequests,
      (_, 'wrong_password' || 'weak_password' || 'same_password') => FailureKind.invalidPassword,
      (_, 'phone') => FailureKind.invalidPhoneNumber,
      ('invalid-argument', _) => FailureKind.invalidInput,
      ('already-exists', _) => FailureKind.alreadyExists,
      ('failed-precondition', _) => FailureKind.conflict,
      ('permission-denied', _) => FailureKind.permissionDenied,
      ('not-found', _) => FailureKind.notFound,
      ('unauthenticated', _) => FailureKind.unauthenticated,
      ('unavailable' || 'deadline-exceeded', _) => FailureKind.network,
      ('resource-exhausted', _) => FailureKind.quotaExceeded,
      _ => FailureKind.unknown,
    };
    if (ours) {
      return AppFailure(kind, message, code: reason,
          details: (details as Map).map((k, v) => MapEntry(k.toString(), v)));
    }
    return switch (kind) {
      FailureKind.network => AppFailure(kind, _network, code: code, retryable: true),
      FailureKind.unauthenticated =>
        AppFailure(kind, 'Your session has ended. Please sign in again.', code: code),
      FailureKind.permissionDenied =>
        AppFailure(kind, 'You do not have permission to do this.', code: code),
      _ => AppFailure(FailureKind.unknown, 'Something went wrong. Please try again.',
          code: code, retryable: true),
    };
  }

  static AppFailure _firebase(FirebaseException e) {
    switch (e.code) {
      case 'permission-denied':
      case 'unauthorized':
        return AppFailure(FailureKind.permissionDenied,
            'You do not have permission to do this.',
            code: e.code);
      case 'not-found':
      case 'object-not-found':
        return AppFailure(FailureKind.notFound,
            'The requested record could not be found.',
            code: e.code);
      case 'unavailable':
      case 'deadline-exceeded':
      case 'retry-limit-exceeded':
        return AppFailure(FailureKind.network, _network, code: e.code, retryable: true);
      case 'unauthenticated':
        return AppFailure(FailureKind.unauthenticated,
            'Your session has ended. Please sign in again.',
            code: e.code);
      case 'invalid-argument':
      case 'failed-precondition':
        return AppFailure(FailureKind.invalidInput,
            'Some information is invalid. Check your entries and try again.',
            code: e.code);
      case 'quota-exceeded':
      case 'resource-exhausted':
        return AppFailure(FailureKind.quotaExceeded,
            'The service is busy. Please try again shortly.',
            code: e.code, retryable: true);
      case 'canceled':
        return AppFailure(FailureKind.storage, 'The upload was cancelled.', code: e.code);
      default:
        return AppFailure(FailureKind.unknown,
            'Something went wrong. Please try again.',
            code: e.code, retryable: true);
    }
  }
}
