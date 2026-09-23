import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/config/app_environment.dart';
import 'package:ramosmax_auto_manager/core/constants/firestore_collections.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/models/audit_log_entry.dart';
import 'package:ramosmax_auto_manager/repositories/audit_log_repository.dart';
import 'package:ramosmax_auto_manager/repositories/user_repository.dart';

import '../support/fixtures.dart';

void main() {
  late FakeFirebaseFirestore db;
  late UserRepository users;

  setUp(() {
    db = FakeFirebaseFirestore();
    users = UserRepository(db);
  });

  group('UserRepository profile lookup', () {
    test('missing document → ProfileMissing', () async {
      final result = await users.fetchProfile('nobody');
      expect(result, isA<Success<ProfileLookup>>());
      expect((result as Success<ProfileLookup>).value, isA<ProfileMissing>());
      expect(await users.watchProfile('nobody').first, isA<ProfileMissing>());
    });

    test('valid document → ProfileFound with role', () async {
      await db.collection('users').doc('uid-1').set(userDocData(role: 'cashier'));
      final lookup = await users.watchProfile('uid-1').first;
      expect(lookup, isA<ProfileFound>());
      final user = (lookup as ProfileFound).user;
      expect(user.uid, 'uid-1');
      expect(user.role, UserRole.cashier);
      expect(user.active, isTrue);
    });

    test('inactive document is found but inactive', () async {
      await db.collection('users').doc('uid-1').set(userDocData(active: false));
      final lookup = await users.watchProfile('uid-1').first as ProfileFound;
      expect(lookup.user.active, isFalse);
    });

    test('document without a valid role → ProfileMalformed', () async {
      await db.collection('users').doc('uid-1').set(userDocData(role: 'owner'));
      expect(await users.watchProfile('uid-1').first, isA<ProfileMalformed>());
    });

    test('profile changes stream live (deactivation takes effect)', () async {
      final ref = db.collection('users').doc('uid-1');
      await ref.set(userDocData());
      final stream = users.watchProfile('uid-1');
      final expectation = expectLater(
        stream.map((l) => (l as ProfileFound).user.active),
        emitsThrough(false),
      );
      await ref.update({'active': false});
      await expectation;
    });

    test('recordLogin and FCM token bookkeeping', () async {
      await db.collection('users').doc('uid-1').set(userDocData());
      await users.recordLogin('uid-1');
      await users.addFcmToken('uid-1', 'token-a');
      await users.addFcmToken('uid-1', 'token-a');
      final data = (await db.collection('users').doc('uid-1').get()).data()!;
      expect(data['lastLoginAt'], isNotNull);
      expect(data['fcmTokens'], ['token-a']);
      await users.removeFcmToken('uid-1', 'token-a');
      expect((await db.collection('users').doc('uid-1').get()).data()!['fcmTokens'], isEmpty);
    });
  });

  group('AuditLogRepository', () {
    test('appends an entry with server timestamp and actor', () async {
      await AuditLogRepository(db).record(const AuditLogEntry(
        userId: 'uid-1',
        userRole: UserRole.manager,
        action: 'session.sign_in',
        module: AuditModule.auth,
        recordId: 'uid-1',
      ));
      final docs = (await db.collection(FirestoreCollections.auditLogs).get()).docs;
      expect(docs, hasLength(1));
      final data = docs.single.data();
      expect(data['userId'], 'uid-1');
      expect(data['userRole'], 'manager');
      expect(data['module'], 'auth');
      expect(data['timestamp'], isNotNull);
    });
  });

  group('environment configuration', () {
    test('dev and prod are bound to different Firebase projects and app IDs', () {
      final dev = AppEnvironment.forFlavor(AppFlavor.dev);
      final prod = AppEnvironment.forFlavor(AppFlavor.prod);
      expect(dev.firebaseProjectId, 'ramos1-c0862');
      expect(prod.firebaseProjectId, 'ramosmax-prod');
      expect(dev.expectedApplicationId, 'com.ramosmax.automotive.dev');
      expect(prod.expectedApplicationId, 'com.ramosmax.automotive');
      expect(prod.isProduction, isTrue);
      expect(dev.isProduction, isFalse);
    });

    test('generated Firebase options match each environment', () {
      // Tests run with defaultTargetPlatform == android.
      expect(AppEnvironment.forFlavor(AppFlavor.dev).firebaseOptions.projectId, 'ramos1-c0862');
      expect(AppEnvironment.forFlavor(AppFlavor.prod).firebaseOptions.projectId, 'ramosmax-prod');
    });
  });
}
