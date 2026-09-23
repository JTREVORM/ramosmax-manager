import '../../../core/errors/app_failure.dart';
import '../../../models/app_user.dart';
import '../../../repositories/user_repository.dart';

/// Why an authenticated phone number is not allowed into RamosMAX.
enum AccessDeniedReason {
  /// Signed in, but no `users` profile exists for this UID.
  notRegistered,

  /// Profile exists but `active` is not true.
  inactive,

  /// Profile's `accessExpiresAt` has passed.
  expired,

  /// Profile exists but is structurally invalid (no/unknown role).
  misconfigured,
}

/// Where the user stands, derived from Firebase Auth + their Firestore profile.
sealed class SessionState {
  const SessionState();
}

/// Firebase is still reporting the initial auth / profile state.
final class SessionResolving extends SessionState {
  const SessionResolving();
}

final class SignedOut extends SessionState {
  const SignedOut();
}

/// Signed in, but offline with no cached profile — we cannot decide yet.
final class AwaitingConnection extends SessionState {
  const AwaitingConnection(this.phoneNumber);
  final String? phoneNumber;
}

final class AccessDenied extends SessionState {
  const AccessDenied(this.reason, {this.phoneNumber});
  final AccessDeniedReason reason;
  final String? phoneNumber;
}

final class Authorized extends SessionState {
  const Authorized(this.user);
  final AppUser user;
}

/// Signed in with a temporary password (new account or administrator reset).
/// The only thing the person can do is choose their own password: the router
/// allows no other screen, and the security rules and Cloud Functions refuse
/// every other request until `mustChangePassword` is cleared on the server.
final class PasswordChangeRequired extends SessionState {
  const PasswordChangeRequired(this.user);
  final AppUser user;
}

final class SessionFailed extends SessionState {
  const SessionFailed(this.failure);
  final AppFailure failure;
}

/// Pure access decision. Kept free of Firebase types so it is exhaustively
/// unit-tested (test/unit/session_resolver_test.dart).
///
/// The profile's phone number must match the phone number on the Firebase Auth
/// record (the sign-in identity): a profile for one number can never be used
/// through another account.
abstract final class SessionResolver {
  static SessionState resolve({
    required String uid,
    required String? authPhoneNumber,
    required ProfileLookup lookup,
    required DateTime now,
  }) {
    switch (lookup) {
      case ProfilePendingServer():
        return AwaitingConnection(authPhoneNumber);
      case ProfileMissing():
        return AccessDenied(AccessDeniedReason.notRegistered, phoneNumber: authPhoneNumber);
      case ProfileMalformed():
        return AccessDenied(AccessDeniedReason.misconfigured, phoneNumber: authPhoneNumber);
      case ProfileFound(:final user):
        if (user.uid != uid ||
            (authPhoneNumber != null && user.phoneNumber != authPhoneNumber)) {
          return AccessDenied(AccessDeniedReason.misconfigured, phoneNumber: authPhoneNumber);
        }
        if (!user.active) {
          return AccessDenied(AccessDeniedReason.inactive, phoneNumber: authPhoneNumber);
        }
        if (user.hasAccessExpired(now)) {
          return AccessDenied(AccessDeniedReason.expired, phoneNumber: authPhoneNumber);
        }
        if (user.mustChangePassword) return PasswordChangeRequired(user);
        return Authorized(user);
    }
  }
}
