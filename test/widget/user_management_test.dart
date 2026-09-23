import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:ramosmax_auto_manager/app.dart';
import 'package:ramosmax_auto_manager/core/auth/password_policy.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/features/dashboard/presentation/dashboard_shell.dart';
import 'package:ramosmax_auto_manager/features/users/application/user_management_providers.dart';

import '../support/fake_auth_repository.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeUserAdminApi api;
  late FakeConnectivityService connectivity;

  setUp(() {
    db = FakeFirebaseFirestore();
    api = FakeUserAdminApi();
    connectivity = FakeConnectivityService();
  });

  /// Seeds a small company. The signed-in user is `me` with [role].
  Future<void> seed({String role = 'admin'}) async {
    final users = db.collection('users');
    await users.doc('me').set(userDocData(role: role, fullName: 'Ada Admin'));
    await users.doc('admin2').set(userDocData(role: 'admin', fullName: 'Abe Second', phone: '+256700000001'));
    await users.doc('w1').set(userDocData(
        role: 'worker', fullName: 'Jane Washer', phone: '+256772000111', staffId: 'RMX-STF-0001'));
    await users.doc('w2').set(userDocData(
        role: 'worker', fullName: 'John Polisher', phone: '+256701000222', staffId: 'RMX-STF-0002', active: false));
    await users.doc('c1').set(userDocData(
        role: 'cashier', fullName: 'Carl Cashier', phone: '+256752000333', mustChangePassword: true));
  }

  Future<void> pumpAt(WidgetTester tester, String location) async {
    await tester.binding.setSurfaceSize(const Size(430, 1600));
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...testOverrides(
          auth: FakeAuthRepository(initialUser: MockUser(uid: 'me', phoneNumber: testPhone)),
          db: db,
          connectivity: connectivity,
        ),
        userAdminApiProvider.overrideWithValue(api),
      ],
      child: const RamosMaxApp(),
    ));
    await tester.pumpAndSettle();
    GoRouter.of(tester.element(find.byType(DashboardShell))).go(location);
    await tester.pumpAndSettle();
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.binding.setSurfaceSize(null);
  }

  /// Scrolls [key] to the middle of its list (clear of the app and
  /// navigation bars), then taps it.
  Future<void> tapKey(WidgetTester tester, String key) async {
    if (find.byKey(Key(key)).evaluate().isEmpty) {
      // Not built yet: further down a lazily built list.
      await tester.scrollUntilVisible(find.byKey(Key(key)), 300,
          scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first);
    }
    final element = tester.element(find.byKey(Key(key)));
    if (Scrollable.maybeOf(element) != null) {
      await Scrollable.ensureVisible(element, alignment: 0.5);
      await tester.pumpAndSettle();
    }
    await tester.tap(find.byKey(Key(key)));
    await tester.pumpAndSettle();
  }

  testWidgets('user list loads with cards, statuses and an Add button for admins', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users');

    expect(find.text('User Management'), findsWidgets);
    for (final uid in ['me', 'admin2', 'w1', 'w2', 'c1']) {
      expect(find.byKey(Key('user-card-$uid')), findsOneWidget);
    }
    expect(find.text('Ada Admin (you)'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('user-card-w2')), matching: find.text('Inactive')), findsOneWidget);
    expect(find.text('RMX-STF-0001'), findsOneWidget);
    expect(find.byKey(const Key('add-user-button')), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('search by name, phone and staff ID', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users');

    await tester.enterText(find.byKey(const Key('users-search')), 'polish');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('user-card-w2')), findsOneWidget);
    expect(find.byKey(const Key('user-card-w1')), findsNothing);

    await tester.enterText(find.byKey(const Key('users-search')), '0752 000');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('user-card-c1')), findsOneWidget);
    expect(find.byKey(const Key('user-card-w2')), findsNothing);

    await tester.enterText(find.byKey(const Key('users-search')), 'rmx-stf-0001');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('user-card-w1')), findsOneWidget);
    expect(find.byKey(const Key('user-card-c1')), findsNothing);

    await tester.enterText(find.byKey(const Key('users-search')), 'nobody here');
    await tester.pumpAndSettle();
    expect(find.text('No matching users'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('filter chips narrow the list', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users');

    await tapKey(tester, 'user-filter-inactive');
    expect(find.byKey(const Key('user-card-w2')), findsOneWidget);
    expect(find.byKey(const Key('user-card-w1')), findsNothing);

    await tapKey(tester, 'user-filter-cashier');
    expect(find.byKey(const Key('user-card-c1')), findsOneWidget);
    expect(find.byKey(const Key('user-card-w2')), findsNothing);

    await tapKey(tester, 'user-filter-admin');
    expect(find.byKey(const Key('user-card-me')), findsOneWidget);
    expect(find.byKey(const Key('user-card-admin2')), findsOneWidget);
    expect(find.byKey(const Key('user-card-c1')), findsNothing);
    await unmount(tester);
  });

  testWidgets('user details show account, employment, access and security sections', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users');
    await tapKey(tester, 'user-card-w1');

    expect(find.byKey(const Key('user-detail-name')), findsOneWidget);
    for (final section in ['Account', 'Employment', 'Access', 'Security', 'Access history']) {
      expect(find.text(section), findsOneWidget, reason: section);
    }
    expect(find.text('RMX-STF-0001'), findsOneWidget);
    expect(find.text('Password set'), findsOneWidget);
    expect(find.byKey(const Key('user-deactivate-button')), findsOneWidget);
    expect(find.byKey(const Key('user-change-role-button')), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('create-user form validates and submits a normalised request', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users');
    await tapKey(tester, 'add-user-button');

    await tapKey(tester, 'user-save-button');
    expect(find.text('Enter the full name'), findsOneWidget);
    expect(find.text('Enter your phone number'), findsOneWidget);
    expect(api.calls, isEmpty);

    await tester.enterText(find.byKey(const Key('user-name-field')), 'Peter Detailer');
    await tester.enterText(find.byKey(const Key('user-phone-field')), '0772 999 888');
    await tester.enterText(find.byKey(const Key('user-staff-id-field')), 'bad id!');
    await tapKey(tester, 'user-save-button');
    expect(find.textContaining('capital letters, digits and dashes'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('user-staff-id-field')), '');
    await tapKey(tester, 'user-save-button');
    expect(find.text('Choose a role.'), findsOneWidget);
    expect(api.calls, isEmpty);

    await tapKey(tester, 'user-role-field');
    expect(find.byKey(const Key('role-option-admin')), findsOneWidget);
    await tester.tap(find.byKey(const Key('role-option-worker')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('user-specialization-field')), findsOneWidget);

    await tapKey(tester, 'user-save-button');
    expect(find.text('Generate a temporary password.'), findsOneWidget);
    expect(api.calls, isEmpty);

    await tapKey(tester, 'generate-password-button');
    final shown = tester.widget<SelectableText>(find.byKey(const Key('temporary-password-text'))).data!;
    expect(PasswordPolicy.problems(shown), isEmpty);
    expect(find.textContaining('This password will only be shown now'), findsOneWidget);
    expect(find.byKey(const Key('copy-password-button')), findsOneWidget);

    await tapKey(tester, 'user-save-button');
    expect(api.names, ['createUser']);
    final request = api.calls.single.$2;
    expect(request['phoneNumber'], '+256772999888');
    expect(request['role'], 'worker');
    expect(request['fullName'], 'Peter Detailer');
    expect(request['linkStaff'], isTrue);
    expect(request['staffId'], isNull);
    expect(request['password'], shown);

    // Shown once more after creation, then gone.
    expect(find.text('Peter Detailer was added'), findsOneWidget);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.text(shown)), findsOneWidget);
    await tester.tap(find.byKey(const Key('temporary-password-done')));
    await tester.pumpAndSettle();
    expect(find.text(shown), findsNothing);
    await unmount(tester);
  });

  testWidgets('admin resets a password: confirmation with reason, shown once', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users/c1');
    await tapKey(tester, 'user-reset-password-button');
    expect(find.text("Reset Carl Cashier's password?"), findsOneWidget);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Forgot password');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.calls.single.$1, 'resetPassword');
    expect(api.calls.single.$2, {'uid': 'c1', 'reason': 'Forgot password'});
    expect(find.text(FakeUserAdminApi.resetPasswordValue), findsOneWidget);
    await tester.tap(find.byKey(const Key('temporary-password-done')));
    await tester.pumpAndSettle();
    expect(find.text(FakeUserAdminApi.resetPasswordValue), findsNothing);
    await unmount(tester);
  });

  testWidgets('manager may reset Workers\' passwords only', (tester) async {
    await seed(role: 'manager');
    await pumpAt(tester, '/app/users/w1');
    expect(find.byKey(const Key('user-reset-password-button')), findsOneWidget);
    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/users/c1');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('user-reset-password-button')), findsNothing);
    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/users/admin2');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('user-reset-password-button')), findsNothing);
    await unmount(tester);
  });

  testWidgets('user details show sign-in status, never a password', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users/c1');
    expect(find.text('Password change required'), findsWidgets);
    expect(find.text('Yes — at next sign-in'), findsOneWidget);
    expect(find.textContaining('SMS'), findsNothing);
    await unmount(tester);
  });

  testWidgets('role change asks for confirmation and a reason', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users/w1');

    await tapKey(tester, 'user-change-role-button');
    await tester.tap(find.byKey(const Key('role-option-manager')));
    await tester.pumpAndSettle();
    expect(find.text('Change role?'), findsOneWidget);
    expect(find.textContaining('Worker → Manager'), findsOneWidget);

    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Enter a reason'), findsOneWidget);
    expect(api.calls, isEmpty);

    await tester.enterText(find.byKey(const Key('reason-field')), 'Promoted to shift manager');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.names, ['setRole']);
    expect(api.calls.single.$2, {'uid': 'w1', 'role': 'manager', 'reason': 'Promoted to shift manager'});
    await unmount(tester);
  });

  testWidgets('deactivation requires confirmation; cancelling does nothing', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users/w1');

    await tapKey(tester, 'user-deactivate-button');
    expect(find.text('Deactivate Jane Washer?'), findsOneWidget);
    expect(find.textContaining('will no longer be able to access the RamosMAX system'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty);

    await tapKey(tester, 'user-deactivate-button');
    await tester.enterText(find.byKey(const Key('reason-field')), 'Left the company');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.names, ['setActive']);
    expect(api.calls.single.$2, {'uid': 'w1', 'active': false, 'reason': 'Left the company'});
    expect(find.text('Jane Washer has been deactivated.'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('inactive users offer activation instead of deactivation', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users/w2');
    expect(find.byKey(const Key('user-deactivate-button')), findsNothing);
    await tapKey(tester, 'user-activate-button');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.names, ['setActive']);
    expect(api.calls.single.$2['active'], isTrue);
    await unmount(tester);
  });

  testWidgets('permission management: grant a permission and save', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users/w1/permissions');

    expect(find.text('Worker role permissions'), findsOneWidget);
    expect(find.text('Explicit grants'), findsOneWidget);
    expect(find.text('Temporary permissions'), findsOneWidget);
    expect(find.byKey(const Key('save-permissions-button')), findsNothing);

    await tapKey(tester, 'add-grant-button');
    await tester.enterText(find.byKey(const Key('permission-search')), 'receive payments');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('permission-option-payments.record')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('perm-grant-payments.record')), findsOneWidget);

    await tapKey(tester, 'save-permissions-button');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.names, ['setPermissions']);
    expect(api.calls.single.$2['permissions'], {'payments.record'});
    expect(api.calls.single.$2['deniedPermissions'], <String>{});
    await unmount(tester);
  });

  testWidgets('admins cannot change their own access', (tester) async {
    await seed();
    await pumpAt(tester, '/app/users/me');
    expect(find.textContaining('You cannot change your own role'), findsOneWidget);
    expect(find.byKey(const Key('user-change-role-button')), findsNothing);
    expect(find.byKey(const Key('user-deactivate-button')), findsNothing);

    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/users/me/permissions');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('permissions-read-only')), findsOneWidget);
    expect(find.byKey(const Key('add-grant-button')), findsNothing);
    await unmount(tester);
  });

  testWidgets('manager sees users but cannot create, re-role or deactivate; admins are off-limits', (tester) async {
    await seed(role: 'manager');
    await pumpAt(tester, '/app/users');
    expect(find.byKey(const Key('user-card-w1')), findsOneWidget);
    expect(find.byKey(const Key('add-user-button')), findsNothing);

    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/users/w1');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('user-change-role-button')), findsNothing);
    expect(find.byKey(const Key('user-deactivate-button')), findsNothing);

    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/users/w1/permissions');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('add-temporary-button')), findsOneWidget);
    expect(find.byKey(const Key('add-grant-button')), findsNothing);

    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/users/admin2/permissions');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('add-temporary-button')), findsNothing);

    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/users/new');
    await tester.pumpAndSettle();
    expect(find.text('Not permitted'), findsOneWidget);
    await unmount(tester);
  });

  for (final role in ['worker', 'cashier', 'shareholder']) {
    testWidgets('$role cannot open user management', (tester) async {
      await seed(role: role);
      await pumpAt(tester, '/app/users/w1');
      expect(find.byKey(const Key('user-detail-name')), findsNothing);
      expect(find.byKey(const Key('dashboard-name')), findsOneWidget);
      await unmount(tester);
    });
  }

  testWidgets('auditor gets a read-only view', (tester) async {
    await seed(role: 'auditor');
    await pumpAt(tester, '/app/users/w1');
    expect(find.byKey(const Key('user-detail-name')), findsOneWidget);
    expect(find.byKey(const Key('user-edit-button')), findsNothing);
    expect(find.byKey(const Key('user-deactivate-button')), findsNothing);
    expect(find.byKey(const Key('user-change-role-button')), findsNothing);
    await unmount(tester);
  });

  testWidgets('offline: sensitive changes are refused, never queued', (tester) async {
    await seed();
    connectivity.online = false;
    await pumpAt(tester, '/app/users/w1');
    await tapKey(tester, 'user-deactivate-button');
    await tester.enterText(find.byKey(const Key('reason-field')), 'Left the company');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty);
    expect(find.textContaining('needs an internet connection'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('server refusals are shown to the user (last admin)', (tester) async {
    await seed();
    api.nextFailure = const AppFailure(FailureKind.conflict,
        'RamosMAX must always have at least one active Administrator. Add another Administrator first.',
        code: 'last_admin');
    await pumpAt(tester, '/app/users/admin2');
    await tapKey(tester, 'user-deactivate-button');
    await tester.enterText(find.byKey(const Key('reason-field')), 'Testing');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(find.textContaining('at least one active Administrator'), findsOneWidget);
    await unmount(tester);
  });
}
