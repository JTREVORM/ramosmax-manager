import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/auth/data/auth_repository.dart';
import '../../repositories/audit_log_repository.dart';
import '../../repositories/user_repository.dart';
import '../config/app_environment.dart';
import '../services/analytics_service.dart';
import '../services/connectivity_service.dart';
import '../services/crash_reporting_service.dart';
import '../services/firestore_service.dart';
import '../services/notification_service.dart';
import '../services/storage_service.dart';

/// Dependency graph. Every Firebase SDK instance is created here and only
/// here; tests override these providers with fakes.

final appEnvironmentProvider = Provider<AppEnvironment>(
  (ref) => throw UnimplementedError('appEnvironmentProvider must be overridden in bootstrap'),
);

final firebaseAuthProvider = Provider<FirebaseAuth>((ref) => FirebaseAuth.instance);
final firestoreProvider = Provider<FirebaseFirestore>((ref) => FirebaseFirestore.instance);
final firebaseStorageProvider = Provider<FirebaseStorage>((ref) => FirebaseStorage.instance);
final firebaseFunctionsProvider = Provider<FirebaseFunctions>(
  (ref) => FirebaseFunctions.instanceFor(region: AppEnvironment.functionsRegion),
);

final crashReportingProvider = Provider<CrashReportingService>(
  (ref) => throw UnimplementedError('crashReportingProvider must be overridden in bootstrap'),
);

final analyticsProvider = Provider<AnalyticsService>(
  (ref) => throw UnimplementedError('analyticsProvider must be overridden in bootstrap'),
);

final firestoreServiceProvider =
    Provider<FirestoreService>((ref) => FirestoreService(ref.watch(firestoreProvider)));

final storageServiceProvider =
    Provider<StorageService>((ref) => StorageService(ref.watch(firebaseStorageProvider)));

final connectivityServiceProvider = Provider<ConnectivityService>((ref) => ConnectivityService());

final isOnlineProvider = StreamProvider<bool>((ref) async* {
  final service = ref.watch(connectivityServiceProvider);
  yield await service.isOnline();
  yield* service.onlineChanges;
});

final authRepositoryProvider =
    Provider<AuthRepository>((ref) => FirebaseAuthRepository(ref.watch(firebaseAuthProvider), ref.watch(firebaseFunctionsProvider)));

final userRepositoryProvider =
    Provider<UserRepository>((ref) => UserRepository(ref.watch(firestoreProvider)));

final auditLogRepositoryProvider =
    Provider<AuditLogRepository>((ref) => AuditLogRepository(ref.watch(firestoreProvider)));

final notificationServiceProvider = Provider<NotificationService>(
  (ref) => NotificationService(ref.watch(userRepositoryProvider)),
);

/// Current time, re-emitted every 30 seconds so permission-dependent UI
/// notices when a temporary grant or account access expires while the app is
/// open. Overridable in tests.
final clockProvider = StreamProvider<DateTime>((ref) async* {
  yield DateTime.now();
  yield* Stream.periodic(const Duration(seconds: 30), (_) => DateTime.now());
});
