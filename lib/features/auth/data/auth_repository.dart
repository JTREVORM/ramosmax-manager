import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions, HttpsCallableOptions;
import 'package:firebase_auth/firebase_auth.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';

/// Phone number + password authentication.
///
/// Firebase Authentication holds every credential. The app never learns how a
/// phone number maps to its Firebase sign-in identity: it sends the phone
/// number and password to the `signInWithPhonePassword` Cloud Function over
/// HTTPS, which verifies them and returns a one-time Firebase custom token.
/// Signing in with that token gives a normal Firebase session (persisted and
/// refreshed by Firebase as before). Passwords are never stored, cached or
/// logged by the app.
abstract class AuthRepository {
  Stream<User?> authStateChanges();
  User? get currentUser;

  /// [phoneE164] must already be normalised (see `PhoneNumbers.toE164`).
  Future<Result<void>> signIn(String phoneE164, String password);

  /// Replaces the signed-in user's own password (including a temporary one)
  /// and continues the session with a fresh sign-in.
  Future<Result<void>> changePassword({required String currentPassword, required String newPassword});

  Future<void> signOut();
}

class FirebaseAuthRepository implements AuthRepository {
  FirebaseAuthRepository(this._auth, this._functions);

  final FirebaseAuth _auth;
  final FirebaseFunctions _functions;

  static const Duration timeout = Duration(seconds: 30);

  @override
  Stream<User?> authStateChanges() => _auth.authStateChanges();

  @override
  User? get currentUser => _auth.currentUser;

  Future<String> _token(String function, Map<String, Object?> data) async {
    final result = await _functions
        .httpsCallable(function, options: HttpsCallableOptions(timeout: timeout))
        .call<Object?>(data);
    final raw = result.data;
    final token = raw is Map ? raw['token'] : null;
    if (token is! String) throw const AppFailure(FailureKind.unknown, 'Sign-in failed. Please try again.');
    return token;
  }

  @override
  Future<Result<void>> signIn(String phoneE164, String password) async {
    try {
      final token = await _token('signInWithPhonePassword', {'phoneNumber': phoneE164, 'password': password});
      await _auth.signInWithCustomToken(token);
      return const Success(null);
    } catch (e) {
      return Failure(ErrorMapper.map(e));
    }
  }

  @override
  Future<Result<void>> changePassword({required String currentPassword, required String newPassword}) async {
    try {
      final token = await _token('changeOwnPassword', {
        'currentPassword': currentPassword,
        'newPassword': newPassword,
      });
      // The server ended every session for this account (other devices);
      // continue this one with a fresh token.
      await _auth.signInWithCustomToken(token);
      return const Success(null);
    } catch (e) {
      return Failure(ErrorMapper.map(e));
    }
  }

  @override
  Future<void> signOut() => _auth.signOut();
}
