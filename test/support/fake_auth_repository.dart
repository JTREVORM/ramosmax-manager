import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/features/auth/data/auth_repository.dart';

/// Stand-in for the phone + password sign-in (the real checks live in the
/// `signInWithPhonePassword` / `changeOwnPassword` Cloud Functions and are
/// tested against the emulators in functions/test). Accounts are registered
/// with [addAccount]; anything else fails exactly like the server does.
class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository({User? initialUser}) : _user = initialUser;

  static const validPassword = 'Correct!Pass42';

  final _controller = StreamController<User?>.broadcast();
  User? _user;

  final Map<String, ({String uid, String password})> _accounts = {};
  final List<String> attempts = [];
  int signOutCalls = 0;

  /// Phone numbers the server would refuse after a correct password (e.g.
  /// inactive accounts) → the server's message.
  final Map<String, AppFailure> refusals = {};

  /// Called when the password changes — tests use it to clear
  /// `mustChangePassword` in the fake Firestore, as the server would.
  Future<void> Function(String uid)? onPasswordChanged;

  void addAccount(String phoneE164, {String uid = 'uid-1', String password = validPassword}) =>
      _accounts[phoneE164] = (uid: uid, password: password);

  static const badCredentials = AppFailure(
    FailureKind.invalidCredentials,
    'Incorrect phone number or password.',
    code: 'invalid_credentials',
  );

  @override
  Stream<User?> authStateChanges() async* {
    yield _user;
    yield* _controller.stream;
  }

  @override
  User? get currentUser => _user;

  @override
  Future<Result<void>> signIn(String phoneE164, String password) async {
    attempts.add(phoneE164);
    final account = _accounts[phoneE164];
    if (account == null || account.password != password) return const Failure(badCredentials);
    final refusal = refusals[phoneE164];
    if (refusal != null) return Failure(refusal);
    _user = MockUser(uid: account.uid, phoneNumber: phoneE164);
    _controller.add(_user);
    return const Success(null);
  }

  @override
  Future<Result<void>> changePassword({required String currentPassword, required String newPassword}) async {
    final user = _user;
    final entry = _accounts.entries.where((e) => e.value.uid == user?.uid).firstOrNull;
    if (user == null || entry == null) {
      return const Failure(AppFailure(FailureKind.unauthenticated, 'Your session has ended.'));
    }
    if (entry.value.password != currentPassword) {
      return const Failure(AppFailure(FailureKind.invalidPassword, 'Your current password is incorrect.',
          code: 'wrong_password'));
    }
    _accounts[entry.key] = (uid: entry.value.uid, password: newPassword);
    await onPasswordChanged?.call(entry.value.uid);
    return const Success(null);
  }

  String? passwordOf(String phoneE164) => _accounts[phoneE164]?.password;

  @override
  Future<void> signOut() async {
    signOutCalls++;
    _user = null;
    _controller.add(null);
  }
}
