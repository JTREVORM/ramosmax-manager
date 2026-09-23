import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/access_policy.dart';
import 'package:ramosmax_auto_manager/core/auth/password_policy.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/errors/error_mapper.dart';
import 'package:ramosmax_auto_manager/core/providers/core_providers.dart';
import 'package:ramosmax_auto_manager/core/services/analytics_service.dart';
import 'package:ramosmax_auto_manager/features/auth/application/login_controller.dart';
import 'package:ramosmax_auto_manager/models/app_user.dart';

import '../support/fake_auth_repository.dart';
import '../support/fixtures.dart';

void main() {
  final now = DateTime.utc(2026, 9, 21, 12);

  group('PasswordPolicy', () {
    test('minimum 8, upper, lower, number, symbol', () {
      expect(PasswordPolicy.problems('Fresh!Pass42'), isEmpty);
      expect(PasswordPolicy.problems('Sh0rt!a'), contains('Use at least 8 characters.'));
      expect(PasswordPolicy.problems('fresh!pass42'), contains('Add an uppercase letter.'));
      expect(PasswordPolicy.problems('FRESH!PASS42'), contains('Add a lowercase letter.'));
      expect(PasswordPolicy.problems('Fresh!Pass'), contains('Add a number.'));
      expect(PasswordPolicy.problems('FreshPass42'), contains('Add a symbol, e.g. ! @ # \$ %.'));
    });

    test('predictable and personal passwords are rejected', () {
      for (final bad in ['123456', 'password', 'Password1!', 'Ramos123!', 'Qwerty123!']) {
        expect(PasswordPolicy.problems(bad), isNotEmpty, reason: bad);
      }
      expect(PasswordPolicy.problems('Ab!772123456', phoneNumber: '+256772123456'), contains('Do not use your phone number.'));
      expect(PasswordPolicy.problems('Rmx-Stf-0001!a', staffId: 'RMX-STF-0001'), contains('Do not use your staff ID.'));
      expect(PasswordPolicy.problems('Walter!2026x', fullName: 'Walter Worker'), contains('Do not use your name.'));
    });

    test('generated passwords: secure, 12 characters, policy-compliant, no look-alikes, all different', () {
      final seen = <String>{};
      for (var i = 0; i < 300; i++) {
        final p = PasswordPolicy.generate();
        expect(p.length, PasswordPolicy.generatedLength);
        expect(PasswordPolicy.problems(p), isEmpty, reason: p);
        expect(RegExp('[0O1lIo]').hasMatch(p), isFalse, reason: p);
        seen.add(p);
      }
      expect(seen.length, 300);
    });

    test('mirrors the server policy constants', () {
      final js = File('functions/src/passwords.js').readAsStringSync();
      expect(js, contains('MIN_LENGTH = ${PasswordPolicy.minLength}'));
      expect(js, contains('GENERATED_LENGTH = ${PasswordPolicy.generatedLength}'));
    });
  });

  group('LoginController', () {
    late FakeAuthRepository auth;
    late ProviderContainer container;

    setUp(() {
      auth = FakeAuthRepository()..addAccount(testPhone);
      container = ProviderContainer(overrides: [
        authRepositoryProvider.overrideWithValue(auth),
        analyticsProvider.overrideWithValue(AnalyticsService(enabled: false)),
      ]);
    });
    tearDown(() => container.dispose());

    LoginController ctrl() => container.read(loginControllerProvider.notifier);
    LoginState state() => container.read(loginControllerProvider);

    test('normalises a Ugandan local number to +256 before signing in', () async {
      await ctrl().signIn('0772 123 456', FakeAuthRepository.validPassword);
      expect(auth.attempts, ['+256772123456']);
      expect(state().failure, isNull);
      expect(auth.currentUser?.uid, 'uid-1');
    });

    test('invalid phone never reaches the server', () async {
      await ctrl().signIn('12345', 'whatever');
      expect(auth.attempts, isEmpty);
      expect(state().failure?.kind, FailureKind.invalidPhoneNumber);
    });

    test('empty password never reaches the server', () async {
      await ctrl().signIn('0772123456', '');
      expect(auth.attempts, isEmpty);
      expect(state().failure, isNotNull);
    });

    test('wrong password → one generic message', () async {
      await ctrl().signIn('0772123456', 'Wrong!Pass1');
      expect(state().failure?.message, 'Incorrect phone number or password.');
      expect(state().busy, isFalse);
      expect(auth.currentUser, isNull);
    });
  });

  group('Password resets (UI policy; enforced by resetUserPassword)', () {
    final admin = testUser(uid: 'a', role: UserRole.admin);
    final manager = testUser(uid: 'm', role: UserRole.manager);
    final worker = testUser(uid: 'w', role: UserRole.worker);
    final cashier = testUser(uid: 'c', role: UserRole.cashier);
    final auditor = testUser(uid: 'u', role: UserRole.auditor);
    final shareholder = testUser(uid: 's', role: UserRole.shareholder);
    bool can(AppUser actor, AppUser target) => AccessPolicy.can(actor, UserAdminAction.resetPassword, target, now);

    test('admin resets anyone but themselves', () {
      for (final t in [manager, worker, cashier, auditor, shareholder, testUser(uid: 'a2', role: UserRole.admin)]) {
        expect(can(admin, t), isTrue, reason: t.role.key);
      }
      expect(can(admin, admin), isFalse);
    });

    test('manager resets Workers only', () {
      expect(can(manager, worker), isTrue);
      for (final t in [cashier, admin, auditor, shareholder, testUser(uid: 'm2', role: UserRole.manager)]) {
        expect(can(manager, t), isFalse, reason: t.role.key);
      }
    });

    test('workers, cashiers, auditors and shareholders cannot reset passwords', () {
      for (final actor in [worker, cashier, auditor, shareholder]) {
        expect(can(actor, testUser(uid: 'w9', role: UserRole.worker)), isFalse, reason: actor.role.key);
      }
    });

    test('an account with a pending temporary password has no permissions at all', () {
      final pending = testUser(uid: 'a', role: UserRole.admin, mustChangePassword: true);
      expect(pending.effectivePermissions(now), isEmpty);
      expect(can(pending, worker), isFalse);
      expect(AccessPolicy.canCreateUsers(pending, now), isFalse);
    });

    test('catalogue: reset scope and permission match the Cloud Functions', () {
      final catalog = jsonDecode(File('functions/src/access_catalog.json').readAsStringSync()) as Map<String, dynamic>;
      expect((catalog['passwordResetRolesForNonAdmins'] as List).cast<String>().toSet(),
          AccessPolicy.passwordResetRolesForNonAdmins.map((r) => r.key).toSet());
      expect(RolePermissions.forRole(UserRole.manager), contains(Permission.usersPasswordsReset));
      expect(Permission.usersPasswordsReset.isAdminOnly, isTrue);
    });
  });

  group('sign-in errors', () {
    test('server refusals keep their safe message and category', () {
      expect(ErrorMapper.functions('unauthenticated', 'Incorrect phone number or password.', {'reason': 'invalid_credentials'}).kind,
          FailureKind.invalidCredentials);
      expect(ErrorMapper.functions('resource-exhausted', 'Too many sign-in attempts. Wait 15 minutes and try again.',
              {'reason': 'too_many_attempts'}).kind,
          FailureKind.tooManyRequests);
      final inactive = ErrorMapper.functions('permission-denied',
          'Your RamosMAX account is inactive. Please contact an administrator.', {'reason': 'inactive'});
      expect(inactive.message, contains('inactive'));
      expect(ErrorMapper.functions('internal', 'INTERNAL', null).message, 'Something went wrong. Please try again.');
    });
  });
}
