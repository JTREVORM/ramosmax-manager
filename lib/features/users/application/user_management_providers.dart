import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/constants/storage_paths.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../models/app_user.dart';
import '../../../models/audit_log_entry.dart';
import '../../../models/staff_record.dart';
import '../../../models/temporary_grant.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/application/session_state.dart';
import '../data/user_admin_api.dart';
import '../data/user_directory_repository.dart';
import 'user_filter.dart';

final userDirectoryRepositoryProvider = Provider<UserDirectoryRepository>(
  (ref) => UserDirectoryRepository(ref.watch(firestoreProvider)),
);

final userAdminApiProvider = Provider<UserAdminApi>(
  (ref) => CallableUserAdminApi(ref.watch(firebaseFunctionsProvider)),
);

/// The signed-in administrator, or null when not authorised.
final currentUserProvider = Provider<AppUser?>((ref) {
  final session = ref.watch(sessionProvider);
  return session is Authorized ? session.user : null;
});

final allUsersProvider = StreamProvider<List<AppUser>>(
  (ref) => ref.watch(userDirectoryRepositoryProvider).watchAll(),
);

final managedUserProvider = StreamProvider.family<AppUser?, String>(
  (ref, uid) => ref.watch(userDirectoryRepositoryProvider).watchUser(uid),
);

final temporaryGrantsProvider = StreamProvider.family<List<TemporaryGrant>, String>(
  (ref, uid) => ref.watch(userDirectoryRepositoryProvider).watchTemporaryGrants(uid),
);

final staffRecordProvider = StreamProvider.family<StaffRecord?, String>(
  (ref, staffId) => ref.watch(userDirectoryRepositoryProvider).watchStaff(staffId),
);

final accessHistoryProvider = StreamProvider.family<List<AuditRecord>, String>(
  (ref, uid) => ref.watch(userDirectoryRepositoryProvider).watchAccessHistory(uid),
);

/// Short-lived download URL for a profile photo path (never persisted).
final profilePhotoUrlProvider = FutureProvider.family<String?, String>((ref, path) async {
  final result = await ref.watch(storageServiceProvider).downloadUrl(path);
  return result.when(success: (url) => url, failure: (_) => null);
});

/// Search box and filter chip state for the Users screen.
class UserListQuery {
  const UserListQuery({this.filter = UserListFilter.all, this.text = ''});
  final UserListFilter filter;
  final String text;
}

final userListQueryProvider = NotifierProvider<UserListQueryNotifier, UserListQuery>(
  UserListQueryNotifier.new,
);

class UserListQueryNotifier extends Notifier<UserListQuery> {
  @override
  UserListQuery build() => const UserListQuery();

  void setFilter(UserListFilter filter) => state = UserListQuery(filter: filter, text: state.text);
  void setText(String text) => state = UserListQuery(filter: state.filter, text: text);
}

final filteredUsersProvider = Provider<AsyncValue<List<AppUser>>>((ref) {
  final query = ref.watch(userListQueryProvider);
  return ref
      .watch(allUsersProvider)
      .whenData((users) => UserSearch.apply(users, query.filter, query.text));
});

/// UIDs → display names, for "changed by" / "granted by" labels.
final userNamesProvider = Provider<Map<String, String>>((ref) {
  final users = ref.watch(allUsersProvider).value ?? const [];
  return {for (final u in users) u.uid: u.displayName};
});

/// User-administration commands.
///
/// Every command is online-only: it checks connectivity first so the person
/// gets an immediate, clear message, and then calls a Cloud Function, which
/// cannot be queued offline. Nothing sensitive is ever written to the local
/// Firestore cache to "sync later".
final userAdminActionsProvider = Provider<UserAdminActions>(UserAdminActions.new);

class UserAdminActions {
  UserAdminActions(this._ref);
  final Ref _ref;

  UserAdminApi get _api => _ref.read(userAdminApiProvider);
  AnalyticsService get _analytics => _ref.read(analyticsProvider);

  static const _offline = AppFailure(
    FailureKind.network,
    'User management needs an internet connection. Connect and try again.',
    code: 'offline',
    retryable: true,
  );

  Future<Result<T>> _online<T>(Future<Result<T>> Function() action) async {
    try {
      await _ref.read(connectivityServiceProvider).ensureOnline();
    } catch (_) {
      return const Failure(_offline);
    }
    return action();
  }

  Future<void> _log(String event, [Map<String, Object> params = const {}]) async {
    try {
      await _analytics.logEvent(event, params);
    } catch (_) {
      // Analytics must never break an administrative action.
    }
  }

  Future<Result<CreatedUser>> createUser(NewUserRequest request) async {
    final r = await _online<CreatedUser>(() => _api.createUser(request));
    if (r is Success) await _log(AnalyticsEvents.userCreated, {'role': request.role.key});
    return r;
  }

  Future<Result<void>> updateProfile(String uid, ProfileUpdate update) =>
      _online(() => _api.updateProfile(uid, update));

  Future<Result<void>> changePhone(String uid, String phoneE164, {String? reason}) =>
      _online(() => _api.changePhone(uid, phoneE164, reason: reason));

  /// Returns the new temporary password. The caller shows it once and
  /// must not keep it.
  Future<Result<String>> resetPassword(String uid, {required String reason}) async {
    final r = await _online<String>(() => _api.resetPassword(uid, reason: reason));
    if (r is Success) await _log(AnalyticsEvents.passwordReset);
    return r;
  }

  Future<Result<void>> setRole(String uid, UserRole role, {required String reason}) async {
    final r = await _online<void>(() => _api.setRole(uid, role, reason: reason));
    if (r is Success) await _log(AnalyticsEvents.userRoleChanged, {'role': role.key});
    return r;
  }

  Future<Result<void>> setActive(String uid, {required bool active, String? reason}) async {
    final r = await _online<void>(() => _api.setActive(uid, active: active, reason: reason));
    if (r is Success) await _log(active ? AnalyticsEvents.userActivated : AnalyticsEvents.userDeactivated);
    return r;
  }

  Future<Result<void>> setPermissions(
    String uid, {
    required Set<Permission> permissions,
    required Set<Permission> deniedPermissions,
    String? reason,
  }) async {
    final r = await _online<void>(() => _api.setPermissions(uid,
        permissions: permissions, deniedPermissions: deniedPermissions, reason: reason));
    if (r is Success) await _log(AnalyticsEvents.userPermissionsChanged);
    return r;
  }

  Future<Result<String>> grantTemporary(
    String uid, {
    required Permission permission,
    required DateTime startsAt,
    required DateTime expiresAt,
    required String reason,
  }) async {
    final r = await _online<String>(() => _api.grantTemporary(uid,
        permission: permission, startsAt: startsAt, expiresAt: expiresAt, reason: reason));
    if (r is Success) await _log(AnalyticsEvents.temporaryPermissionCreated);
    return r;
  }

  Future<Result<void>> revokeTemporary(String uid, String grantId, {required String reason}) =>
      _online(() => _api.revokeTemporary(uid, grantId, reason: reason));

  Future<Result<void>> linkStaff(String uid, String? staffId, {bool createIfMissing = false}) =>
      _online(() => _api.linkStaff(uid, staffId, createIfMissing: createIfMissing));

  /// Uploads a new profile photo under the user's staff folder, then records
  /// its path on the profile through the Cloud Function.
  Future<Result<void>> setProfilePhoto(
    AppUser user, {
    required Uint8List bytes,
    required String contentType,
  }) =>
      _online(() async {
        final staffId = user.staffId;
        if (staffId == null) {
          return const Failure(AppFailure(FailureKind.invalidInput,
              'Link a staff record before adding a profile photo.'));
        }
        final actor = _ref.read(currentUserProvider);
        final ext = contentType == 'image/png' ? 'png' : 'jpg';
        final path = StoragePaths.staffProfilePhoto(
            staffId, 'photo_${DateTime.now().millisecondsSinceEpoch}.$ext');
        try {
          final upload = await _ref.read(storageServiceProvider).upload(
                path: path,
                bytes: bytes,
                contentType: contentType,
                uploadedBy: actor?.uid ?? 'unknown',
              );
          if (upload is Failure<String>) return Failure(upload.error);
        } catch (e) {
          return Failure(ErrorMapper.map(e));
        }
        final saved = await _api.updateProfile(user.uid, ProfileUpdate(profilePhotoPath: path));
        return saved.when(success: (_) => const Success(null), failure: Failure.new);
      });

  Future<void> logOpened() => _log(AnalyticsEvents.userManagementOpened);
}
