import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:ramosmax_auto_manager/core/config/app_environment.dart';
import 'package:ramosmax_auto_manager/core/providers/core_providers.dart';
import 'package:ramosmax_auto_manager/core/services/analytics_service.dart';
import 'package:ramosmax_auto_manager/core/services/crash_reporting_service.dart';

import 'fake_auth_repository.dart';
import 'fake_user_admin_api.dart';

/// Provider overrides that replace every Firebase dependency with a fake,
/// so the real app widget tree can run in widget tests.
List<Override> testOverrides({
  required FakeAuthRepository auth,
  required FakeFirebaseFirestore db,
  FakeConnectivityService? connectivity,
  DateTime? now,
}) =>
    [
      appEnvironmentProvider.overrideWithValue(AppEnvironment.forFlavor(AppFlavor.dev)),
      crashReportingProvider.overrideWithValue(CrashReportingService(enabled: false)),
      analyticsProvider.overrideWithValue(AnalyticsService(enabled: false)),
      authRepositoryProvider.overrideWithValue(auth),
      firestoreProvider.overrideWithValue(db),
      connectivityServiceProvider.overrideWithValue(connectivity ?? FakeConnectivityService()),
      isOnlineProvider.overrideWith((ref) => Stream.value(true)),
      clockProvider.overrideWith((ref) => Stream.value(now ?? DateTime.now())),
    ];
