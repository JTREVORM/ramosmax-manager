import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions, HttpsCallableOptions;

import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';

/// Everything an administrator submits when registering a new user.
class NewUserRequest {
  const NewUserRequest({
    required this.fullName,
    required this.phoneNumber,
    required this.role,
    required this.password,
    this.email,
    this.specialization,
    this.position,
    this.department,
    this.active = true,
    this.linkStaff = true,
    this.staffId,
    this.permissions = const {},
    this.deniedPermissions = const {},
  });

  final String fullName;

  /// E.164, already validated and normalised on the device (and again on the
  /// server).
  final String phoneNumber;
  final UserRole role;

  /// Temporary password, generated securely on the creator's device and shown
  /// to them once. Sent over HTTPS to the server, which checks the policy and
  /// hands it to Firebase Authentication. Never stored anywhere else.
  final String password;
  final String? email;
  final WorkerSpecialization? specialization;
  final String? position;
  final String? department;
  final bool active;

  /// Link the account to a staff record. With no [staffId], the server
  /// allocates the next `RMX-STF-####`.
  final bool linkStaff;
  final String? staffId;
  final Set<Permission> permissions;
  final Set<Permission> deniedPermissions;

  Map<String, Object?> toJson() => {
        'fullName': fullName,
        'phoneNumber': phoneNumber,
        'role': role.key,
        'password': password,
        'email': email,
        'specialization': specialization?.key,
        'position': position,
        'department': department,
        'active': active,
        'linkStaff': linkStaff,
        'staffId': staffId,
        'permissions': [for (final p in permissions) p.key],
        'deniedPermissions': [for (final p in deniedPermissions) p.key],
      };
}

/// Profile edits. A null field is left unchanged; an empty string clears an
/// optional field. The phone number is the sign-in identity and changes
/// through [UserAdminApi.changePhone] instead.
class ProfileUpdate {
  const ProfileUpdate({
    this.fullName,
    this.email,
    this.position,
    this.department,
    this.specialization,
    this.profilePhotoPath,
  });

  final String? fullName;
  final String? email;
  final String? position;
  final String? department;

  /// Specialisation key, or '' to clear.
  final String? specialization;
  final String? profilePhotoPath;

  bool get isEmpty => toJson().isEmpty;

  Map<String, Object?> toJson() => {
        if (fullName != null) 'fullName': fullName,
        if (email != null) 'email': email,
        if (position != null) 'position': position,
        if (department != null) 'department': department,
        if (specialization != null) 'specialization': specialization,
        if (profilePhotoPath != null) 'profilePhotoPath': profilePhotoPath,
      };
}

class CreatedUser {
  const CreatedUser({required this.uid, this.staffId});
  final String uid;
  final String? staffId;
}

/// Privileged user-administration operations. Each is a Cloud Function that
/// authorises the caller on the server (functions/src/user_admin.js); the app
/// sends only the request, never its own role or permissions.
abstract class UserAdminApi {
  Future<Result<CreatedUser>> createUser(NewUserRequest request);

  Future<Result<void>> updateProfile(String uid, ProfileUpdate update);

  /// Changes the sign-in phone number (Firebase Auth and profile together).
  /// The person keeps their password; their sessions end.
  Future<Result<void>> changePhone(String uid, String phoneE164, {String? reason});

  /// Issues a new temporary password and returns it — the only time it can
  /// be seen. The account must change it at next sign-in.
  Future<Result<String>> resetPassword(String uid, {required String reason});
  Future<Result<void>> setRole(String uid, UserRole role, {required String reason});
  Future<Result<void>> setActive(String uid, {required bool active, String? reason});
  Future<Result<void>> setPermissions(
    String uid, {
    required Set<Permission> permissions,
    required Set<Permission> deniedPermissions,
    String? reason,
  });
  Future<Result<String>> grantTemporary(
    String uid, {
    required Permission permission,
    required DateTime startsAt,
    required DateTime expiresAt,
    required String reason,
  });
  Future<Result<void>> revokeTemporary(String uid, String grantId, {required String reason});

  /// Links [uid] to staff record [staffId], or unlinks when null.
  Future<Result<void>> linkStaff(String uid, String? staffId, {bool createIfMissing = false});
}

class CallableUserAdminApi implements UserAdminApi {
  CallableUserAdminApi(this._functions);

  final FirebaseFunctions _functions;

  /// Callables must not hang forever on a poor connection.
  static const Duration timeout = Duration(seconds: 30);

  Future<Result<Map<String, dynamic>>> _call(String name, Map<String, Object?> data) async {
    try {
      final result = await _functions
          .httpsCallable(name, options: HttpsCallableOptions(timeout: timeout))
          .call<Object?>(data);
      final raw = result.data;
      return Success(raw is Map ? raw.map((k, v) => MapEntry(k.toString(), v)) : <String, dynamic>{});
    } catch (e) {
      return Failure(ErrorMapper.map(e));
    }
  }

  Result<void> _done(Result<Map<String, dynamic>> r) =>
      r.when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<CreatedUser>> createUser(NewUserRequest request) async =>
      (await _call('createUser', request.toJson())).when(
        success: (d) => Success(CreatedUser(uid: d['uid'] as String, staffId: d['staffId'] as String?)),
        failure: Failure.new,
      );

  @override
  Future<Result<void>> updateProfile(String uid, ProfileUpdate update) async =>
      _done(await _call('updateUserProfile', {'uid': uid, ...update.toJson()}));

  @override
  Future<Result<void>> changePhone(String uid, String phoneE164, {String? reason}) async =>
      _done(await _call('changeUserPhone', {'uid': uid, 'phoneNumber': phoneE164, 'reason': reason}));

  @override
  Future<Result<String>> resetPassword(String uid, {required String reason}) async =>
      (await _call('resetUserPassword', {'uid': uid, 'reason': reason})).when(
        success: (d) => Success(d['temporaryPassword'] as String),
        failure: Failure.new,
      );

  @override
  Future<Result<void>> setRole(String uid, UserRole role, {required String reason}) async =>
      _done(await _call('setUserRole', {'uid': uid, 'role': role.key, 'reason': reason}));

  @override
  Future<Result<void>> setActive(String uid, {required bool active, String? reason}) async =>
      _done(await _call('setUserActive', {'uid': uid, 'active': active, 'reason': reason}));

  @override
  Future<Result<void>> setPermissions(
    String uid, {
    required Set<Permission> permissions,
    required Set<Permission> deniedPermissions,
    String? reason,
  }) async =>
      _done(await _call('setUserPermissions', {
        'uid': uid,
        'permissions': [for (final p in permissions) p.key],
        'deniedPermissions': [for (final p in deniedPermissions) p.key],
        'reason': reason,
      }));

  @override
  Future<Result<String>> grantTemporary(
    String uid, {
    required Permission permission,
    required DateTime startsAt,
    required DateTime expiresAt,
    required String reason,
  }) async =>
      (await _call('grantTemporaryPermission', {
        'uid': uid,
        'permission': permission.key,
        'startsAt': startsAt.millisecondsSinceEpoch,
        'expiresAt': expiresAt.millisecondsSinceEpoch,
        'reason': reason,
      }))
          .when(success: (d) => Success(d['grantId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> revokeTemporary(String uid, String grantId, {required String reason}) async =>
      _done(await _call('revokeTemporaryPermission', {'uid': uid, 'grantId': grantId, 'reason': reason}));

  @override
  Future<Result<void>> linkStaff(String uid, String? staffId, {bool createIfMissing = false}) async =>
      _done(await _call('linkStaff', {'uid': uid, 'staffId': staffId, 'createIfMissing': createIfMissing}));
}
