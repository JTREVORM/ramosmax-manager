import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/services/connectivity_service.dart';
import 'package:ramosmax_auto_manager/features/users/data/user_admin_api.dart';

/// Records every privileged call instead of reaching Cloud Functions. The
/// real server-side enforcement is tested in functions/test against the
/// Firebase emulators.
class FakeUserAdminApi implements UserAdminApi {
  final List<(String, Map<String, Object?>)> calls = [];

  /// When set, the next call fails with this.
  AppFailure? nextFailure;

  Result<T> _respond<T>(String name, Map<String, Object?> args, T value) {
    calls.add((name, args));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(value);
  }

  Iterable<String> get names => calls.map((c) => c.$1);

  @override
  Future<Result<CreatedUser>> createUser(NewUserRequest request) async =>
      _respond('createUser', request.toJson(), const CreatedUser(uid: 'new-uid', staffId: 'RMX-STF-0009'));

  static const resetPasswordValue = 'Qx7!mV2p#Kd9';

  @override
  Future<Result<void>> updateProfile(String uid, ProfileUpdate update) async =>
      _respond<void>('updateProfile', {'uid': uid, ...update.toJson()}, null);

  @override
  Future<Result<void>> changePhone(String uid, String phoneE164, {String? reason}) async =>
      _respond<void>('changePhone', {'uid': uid, 'phoneNumber': phoneE164}, null);

  @override
  Future<Result<String>> resetPassword(String uid, {required String reason}) async =>
      _respond('resetPassword', {'uid': uid, 'reason': reason}, resetPasswordValue);

  @override
  Future<Result<void>> setRole(String uid, UserRole role, {required String reason}) async =>
      _respond<void>('setRole', {'uid': uid, 'role': role.key, 'reason': reason}, null);

  @override
  Future<Result<void>> setActive(String uid, {required bool active, String? reason}) async =>
      _respond<void>('setActive', {'uid': uid, 'active': active, 'reason': reason}, null);

  @override
  Future<Result<void>> setPermissions(String uid,
          {required Set<Permission> permissions, required Set<Permission> deniedPermissions, String? reason}) async =>
      _respond<void>('setPermissions', {
        'uid': uid,
        'permissions': permissions.map((p) => p.key).toSet(),
        'deniedPermissions': deniedPermissions.map((p) => p.key).toSet(),
        'reason': reason,
      }, null);

  @override
  Future<Result<String>> grantTemporary(String uid,
          {required Permission permission,
          required DateTime startsAt,
          required DateTime expiresAt,
          required String reason}) async =>
      _respond('grantTemporary', {'uid': uid, 'permission': permission.key, 'reason': reason}, 'grant-1');

  @override
  Future<Result<void>> revokeTemporary(String uid, String grantId, {required String reason}) async =>
      _respond<void>('revokeTemporary', {'uid': uid, 'grantId': grantId, 'reason': reason}, null);

  @override
  Future<Result<void>> linkStaff(String uid, String? staffId, {bool createIfMissing = false}) async =>
      _respond<void>('linkStaff', {'uid': uid, 'staffId': staffId}, null);
}

/// Connectivity without the platform plugin.
class FakeConnectivityService extends ConnectivityService {
  FakeConnectivityService({this.online = true});
  bool online;

  @override
  Future<bool> isOnline() async => online;

  @override
  Stream<bool> get onlineChanges => Stream.value(online);

  @override
  Future<void> ensureOnline() async {
    if (!online) {
      throw const AppFailure(FailureKind.network, 'offline', code: 'offline');
    }
  }
}
