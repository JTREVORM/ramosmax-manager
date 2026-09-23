import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/features/auth/application/session_state.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/repositories/user_repository.dart';
import 'package:ramosmax_auto_manager/routes/app_routes.dart';

import '../support/fixtures.dart';

void main() {
  final now = DateTime.utc(2026, 9, 21, 12);

  SessionState resolve(ProfileLookup lookup, {String uid = 'uid-1', String? phone = testPhone}) =>
      SessionResolver.resolve(uid: uid, authPhoneNumber: phone, lookup: lookup, now: now);

  group('SessionResolver', () {
    test('authorised active user', () {
      final s = resolve(ProfileFound(testUser(role: UserRole.manager)));
      expect(s, isA<Authorized>());
      expect((s as Authorized).user.role, UserRole.manager);
    });

    test('verified phone without profile is denied as not registered', () {
      final s = resolve(const ProfileMissing());
      expect(s, isA<AccessDenied>().having((d) => d.reason, 'reason', AccessDeniedReason.notRegistered));
    });

    test('inactive profile is denied', () {
      final s = resolve(ProfileFound(testUser(active: false)));
      expect(s, isA<AccessDenied>().having((d) => d.reason, 'reason', AccessDeniedReason.inactive));
    });

    test('expired access is denied', () {
      final s = resolve(ProfileFound(testUser(accessExpiresAt: now.subtract(const Duration(minutes: 1)))));
      expect(s, isA<AccessDenied>().having((d) => d.reason, 'reason', AccessDeniedReason.expired));
    });

    test('malformed profile is denied', () {
      expect(resolve(const ProfileMalformed()),
          isA<AccessDenied>().having((d) => d.reason, 'reason', AccessDeniedReason.misconfigured));
    });

    test('profile provisioned for another phone number is denied', () {
      final s = resolve(ProfileFound(testUser(phone: '+256700000000')));
      expect(s, isA<AccessDenied>().having((d) => d.reason, 'reason', AccessDeniedReason.misconfigured));
    });

    test('a pending temporary password requires a password change, not access', () {
      final s = resolve(ProfileFound(testUser(role: UserRole.admin, mustChangePassword: true)));
      expect(s, isA<PasswordChangeRequired>());
      expect((s as PasswordChangeRequired).user.effectivePermissions(now), isEmpty);
    });

    test('an inactive account with a pending change is still just inactive', () {
      final s = resolve(ProfileFound(testUser(active: false, mustChangePassword: true)));
      expect(s, isA<AccessDenied>());
    });

    test('offline with no cached profile waits instead of denying', () {
      expect(resolve(const ProfilePendingServer()), isA<AwaitingConnection>());
    });
  });

  group('RouteGuard', () {
    String? go(SessionState s, String location) => RouteGuard.redirect(session: s, location: location, now: now);

    test('resolving sessions stay on the splash', () {
      expect(go(const SessionResolving(), AppRoutes.home), AppRoutes.splash);
      expect(go(const SessionResolving(), AppRoutes.splash), isNull);
      expect(go(const SessionFailed(AppFailure(FailureKind.network, 'x')), AppRoutes.login), AppRoutes.splash);
    });

    test('signed-out users are confined to login', () {
      expect(go(const SignedOut(), AppRoutes.home), AppRoutes.login);
      expect(go(const SignedOut(), AppRoutes.splash), AppRoutes.login);
      expect(go(const SignedOut(), AppRoutes.login), isNull);
    });

    test('a temporary password confines the session to the password change', () {
      final s = PasswordChangeRequired(testUser(role: UserRole.admin, mustChangePassword: true));
      expect(go(s, AppRoutes.home), AppRoutes.changePassword);
      expect(go(s, AppRoutes.module(AppModule.users)), AppRoutes.changePassword);
      expect(go(s, AppRoutes.login), AppRoutes.changePassword);
      expect(go(s, AppRoutes.changePassword), isNull);
      expect(go(Authorized(testUser()), AppRoutes.changePassword), AppRoutes.home);
      expect(go(const SignedOut(), AppRoutes.changePassword), AppRoutes.login);
    });

    test('self-service password change is reachable inside the app', () {
      expect(go(Authorized(testUser()), AppRoutes.profilePassword), isNull);
    });

    test('denied users cannot reach the app', () {
      const denied = AccessDenied(AccessDeniedReason.notRegistered);
      expect(go(denied, AppRoutes.home), AppRoutes.accessDenied);
      expect(go(denied, '/app/payroll'), AppRoutes.accessDenied);
      expect(go(denied, AppRoutes.accessDenied), isNull);
    });

    test('authorised users land on the dashboard', () {
      final s = Authorized(testUser(role: UserRole.cashier));
      expect(go(s, AppRoutes.splash), AppRoutes.home);
      expect(go(s, AppRoutes.login), AppRoutes.home);
      expect(go(s, AppRoutes.home), isNull);
      expect(go(s, AppRoutes.module(AppModule.invoices)), isNull);
    });

    test('deep links to modules outside the role are refused', () {
      final cashier = Authorized(testUser(role: UserRole.cashier));
      expect(go(cashier, AppRoutes.module(AppModule.payroll)), AppRoutes.home);
      final worker = Authorized(testUser(role: UserRole.worker));
      expect(go(worker, AppRoutes.module(AppModule.users)), AppRoutes.home);
      expect(go(worker, '/app/not-a-module'), AppRoutes.home);
    });
  });
}
