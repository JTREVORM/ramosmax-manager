import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/app.dart';
import 'package:ramosmax_auto_manager/core/branding/brand.dart';
import 'package:ramosmax_auto_manager/core/constants/firestore_collections.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';

import '../support/fake_auth_repository.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeAuthRepository auth;
  late FakeFirebaseFirestore db;

  setUp(() {
    auth = FakeAuthRepository();
    db = FakeFirebaseFirestore();
    // As the server does after a successful change.
    auth.onPasswordChanged = (uid) => db.collection('users').doc(uid).update({'mustChangePassword': false});
  });

  Future<void> pumpApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 1000));
    await tester.pumpWidget(ProviderScope(
      overrides: testOverrides(auth: auth, db: db),
      child: const RamosMaxApp(),
    ));
    await tester.pumpAndSettle();
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.binding.setSurfaceSize(null);
  }

  Future<void> signInThroughUi(WidgetTester tester, {String phone = '0772123456', String password = FakeAuthRepository.validPassword}) async {
    await tester.enterText(find.byKey(const Key('phone-field')), phone);
    await tester.enterText(find.byKey(const Key('password-field')), password);
    await tester.tap(find.byKey(const Key('sign-in-button')));
    await tester.pumpAndSettle();
  }

  Future<List<Map<String, dynamic>>> auditEntries() async =>
      (await db.collection(FirestoreCollections.auditLogs).get()).docs.map((d) => d.data()).toList();

  testWidgets('signed-out users see the branded phone + password login (no SMS code)', (tester) async {
    await pumpApp(tester);
    expect(find.byKey(const Key('phone-field')), findsOneWidget);
    expect(find.byKey(const Key('password-field')), findsOneWidget);
    expect(find.byKey(const Key('sign-in-button')), findsOneWidget);
    expect(find.byKey(const Key('forgot-password-button')), findsOneWidget);
    expect(find.text('🇺🇬 +256'), findsOneWidget);
    expect(find.textContaining('SMS'), findsNothing);
    expect(find.byKey(const Key('otp-field')), findsNothing);
    expect(
      find.byWidgetPredicate((w) => w is Image && w.image is AssetImage && (w.image as AssetImage).assetName == Brand.logo),
      findsOneWidget,
    );
    expect(find.text('DEVELOPMENT · TEST DATA'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('password is hidden by default and can be shown', (tester) async {
    await pumpApp(tester);
    TextField field() => tester.widget<TextField>(
        find.descendant(of: find.byKey(const Key('password-field')), matching: find.byType(TextField)));
    expect(field().obscureText, isTrue);
    await tester.tap(find.byKey(const Key('password-visibility')));
    await tester.pump();
    expect(field().obscureText, isFalse);
    await unmount(tester);
  });

  testWidgets('invalid phone number is rejected before anything is sent', (tester) async {
    await pumpApp(tester);
    await signInThroughUi(tester, phone: '12345');
    expect(find.textContaining('valid Ugandan number'), findsOneWidget);
    expect(auth.attempts, isEmpty);
    await unmount(tester);
  });

  testWidgets('wrong password shows one generic message and clears the password field', (tester) async {
    auth.addAccount(testPhone);
    await pumpApp(tester);
    await signInThroughUi(tester, password: 'Wrong!Pass1');
    expect(find.text('Incorrect phone number or password.'), findsOneWidget);
    expect(auth.attempts, [testPhone], reason: 'local 0772… normalised to +256772…');
    expect(tester.widget<TextField>(find.descendant(
        of: find.byKey(const Key('password-field')), matching: find.byType(TextField))).controller!.text, isEmpty);
    await unmount(tester);
  });

  testWidgets('correct phone + password reaches the role dashboard', (tester) async {
    auth.addAccount(testPhone);
    await db.collection('users').doc('uid-1').set(userDocData(role: 'worker', fullName: 'Jane Washer'));
    await pumpApp(tester);
    await signInThroughUi(tester);

    expect(find.byKey(const Key('dashboard-name')), findsOneWidget);
    expect(find.text('Jane Washer'), findsOneWidget);
    expect(find.text('Worker'), findsOneWidget);
    expect(find.text('My'), findsWidgets);
    expect(find.text('Payroll'), findsNothing);
    final profile = (await db.collection('users').doc('uid-1').get()).data()!;
    expect(profile['lastLoginAt'], isNotNull);
    expect(profile.keys.where((k) => k.toLowerCase().contains('password') && k != 'passwordSet' && k != 'mustChangePassword'),
        isEmpty, reason: 'no password data is written by the app');
    await unmount(tester);
  });

  testWidgets('inactive account cannot sign in', (tester) async {
    auth.addAccount(testPhone);
    auth.refusals[testPhone] = const AppFailure(FailureKind.permissionDenied,
        'Your RamosMAX account is inactive. Please contact an administrator.', code: 'inactive');
    await pumpApp(tester);
    await signInThroughUi(tester);
    expect(find.textContaining('account is inactive'), findsOneWidget);
    expect(find.byKey(const Key('dashboard-name')), findsNothing);
    await unmount(tester);
  });

  testWidgets('signed in without a RamosMAX profile is blocked', (tester) async {
    auth = FakeAuthRepository(initialUser: MockUser(uid: 'uid-1', phoneNumber: testPhone));
    await pumpApp(tester);
    expect(find.byKey(const Key('access-denied-title')), findsOneWidget);
    expect(find.byKey(const Key('dashboard-name')), findsNothing);
    await tester.tap(find.byKey(const Key('different-number-button')));
    await tester.pumpAndSettle();
    expect(auth.signOutCalls, 1);
    expect(find.byKey(const Key('phone-field')), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('first sign-in with a temporary password forces a password change', (tester) async {
    const temporary = 'Tq7!mV2p#Kd9';
    auth.addAccount(testPhone, password: temporary);
    await db.collection('users').doc('uid-1')
        .set(userDocData(role: 'cashier', fullName: 'Carl Cashier', mustChangePassword: true));
    await pumpApp(tester);
    await signInThroughUi(tester, password: temporary);

    expect(find.text('Choose your password'), findsOneWidget);
    expect(find.byKey(const Key('dashboard-name')), findsNothing, reason: 'cannot be bypassed');

    await tester.enterText(find.byKey(const Key('current-password-field')), temporary);
    await tester.enterText(find.byKey(const Key('new-password-field')), 'weak');
    await tester.enterText(find.byKey(const Key('confirm-password-field')), 'weak');
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Use at least 8 characters.'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('new-password-field')), 'Fresh!Pass42');
    await tester.enterText(find.byKey(const Key('confirm-password-field')), 'Fresh!Pass4');
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();
    expect(find.text('The passwords do not match.'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('confirm-password-field')), 'Fresh!Pass42');
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('dashboard-name')), findsOneWidget);
    expect(find.text('Carl Cashier'), findsOneWidget);
    expect(auth.passwordOf(testPhone), 'Fresh!Pass42', reason: 'temporary password replaced');
    await unmount(tester);
  });

  testWidgets('forced password change: wrong temporary password is refused', (tester) async {
    auth.addAccount(testPhone, password: 'Tq7!mV2p#Kd9');
    await db.collection('users').doc('uid-1').set(userDocData(mustChangePassword: true));
    await pumpApp(tester);
    await signInThroughUi(tester, password: 'Tq7!mV2p#Kd9');
    await tester.enterText(find.byKey(const Key('current-password-field')), 'Not!It12');
    await tester.enterText(find.byKey(const Key('new-password-field')), 'Fresh!Pass42');
    await tester.enterText(find.byKey(const Key('confirm-password-field')), 'Fresh!Pass42');
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Your current password is incorrect.'), findsOneWidget);
    expect(find.text('Choose your password'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('existing session is restored on launch', (tester) async {
    await db.collection('users').doc('uid-1').set(userDocData(role: 'cashier', fullName: 'Carl Cashier'));
    auth = FakeAuthRepository(initialUser: MockUser(uid: 'uid-1', phoneNumber: testPhone));
    await pumpApp(tester);
    expect(find.text('Carl Cashier'), findsOneWidget);
    expect(find.text('Cashier'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('deactivating a signed-in user removes access immediately', (tester) async {
    await db.collection('users').doc('uid-1').set(userDocData(role: 'manager'));
    auth = FakeAuthRepository(initialUser: MockUser(uid: 'uid-1', phoneNumber: testPhone));
    await pumpApp(tester);
    expect(find.byKey(const Key('dashboard-name')), findsOneWidget);

    await db.collection('users').doc('uid-1').update({'active': false});
    await tester.pumpAndSettle();
    expect(find.text('Account inactive'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('an administrator password reset takes a signed-in user to the password change', (tester) async {
    await db.collection('users').doc('uid-1').set(userDocData(role: 'worker'));
    auth = FakeAuthRepository(initialUser: MockUser(uid: 'uid-1', phoneNumber: testPhone));
    await pumpApp(tester);
    expect(find.byKey(const Key('dashboard-name')), findsOneWidget);
    await db.collection('users').doc('uid-1').update({'mustChangePassword': true});
    await tester.pumpAndSettle();
    expect(find.text('Choose your password'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('My Profile → Change password', (tester) async {
    auth.addAccount(testPhone);
    await db.collection('users').doc('uid-1').set(userDocData(role: 'admin', fullName: 'Ada Admin'));
    await pumpApp(tester);
    await signInThroughUi(tester);
    await tester.tap(find.byKey(const Key('account-button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('change-password-button')));
    await tester.pumpAndSettle();
    expect(find.text('Change password'), findsWidgets);
    await tester.enterText(find.byKey(const Key('current-password-field')), FakeAuthRepository.validPassword);
    await tester.enterText(find.byKey(const Key('new-password-field')), 'Another!Pass7');
    await tester.enterText(find.byKey(const Key('confirm-password-field')), 'Another!Pass7');
    await tester.ensureVisible(find.byKey(const Key('change-password-submit')));
    await tester.tap(find.byKey(const Key('change-password-submit')));
    await tester.pumpAndSettle();
    expect(auth.passwordOf(testPhone), 'Another!Pass7');
    expect(find.text('Your password has been changed.'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('sign out requires confirmation, returns to login and is audited', (tester) async {
    await db.collection('users').doc('uid-1').set(userDocData(role: 'admin', fullName: 'Ada Admin'));
    auth = FakeAuthRepository(initialUser: MockUser(uid: 'uid-1', phoneNumber: testPhone));
    await pumpApp(tester);

    await tester.tap(find.byKey(const Key('account-button')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('sign-out-button')));
    await tester.tap(find.byKey(const Key('sign-out-button')));
    await tester.pumpAndSettle();
    expect(find.text('Sign out?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Sign out'));
    await tester.pumpAndSettle();

    expect(auth.signOutCalls, 1);
    expect(find.byKey(const Key('phone-field')), findsOneWidget);
    expect((await auditEntries()).map((e) => e['action']), contains('session.sign_out'));
    await unmount(tester);
  });

  testWidgets('forgot password explains how to get a reset', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.byKey(const Key('forgot-password-button')));
    await tester.pumpAndSettle();
    expect(find.textContaining('manager or a RamosMAX administrator'), findsOneWidget);
    await unmount(tester);
  });
}
