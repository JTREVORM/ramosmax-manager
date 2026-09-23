import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/models/app_user.dart';

const testPhone = '+256772123456';

/// [temporary] maps a permission to its expiry (effective immediately);
/// [temporaryWindows] allows a start time as well.
AppUser testUser({
  String uid = 'uid-1',
  String phone = testPhone,
  UserRole role = UserRole.worker,
  bool active = true,
  String? fullName = 'Test User',
  String? staffId,
  Set<Permission> permissions = const {},
  Set<Permission> denied = const {},
  Map<Permission, DateTime> temporary = const {},
  Map<Permission, TemporaryWindow> temporaryWindows = const {},
  DateTime? accessExpiresAt,
  bool mustChangePassword = false,
}) =>
    AppUser(
      uid: uid,
      phoneNumber: phone,
      role: role,
      active: active,
      fullName: fullName,
      staffId: staffId,
      permissions: permissions,
      deniedPermissions: denied,
      temporaryPermissions: {
        for (final e in temporary.entries) e.key: TemporaryWindow(expiresAt: e.value),
        ...temporaryWindows,
      },
      accessExpiresAt: accessExpiresAt,
      passwordSet: true,
      mustChangePassword: mustChangePassword,
    );

Map<String, dynamic> userDocData({
  String phone = testPhone,
  String role = 'worker',
  bool active = true,
  String fullName = 'Test User',
  String? staffId,
  List<String> permissions = const [],
  List<String> denied = const [],
  bool mustChangePassword = false,
}) =>
    {
      'uid': 'ignored',
      'phoneNumber': phone,
      'role': role,
      'active': active,
      'fullName': fullName,
      'staffId': staffId,
      'permissions': permissions,
      'deniedPermissions': denied,
      'passwordSet': true,
      'mustChangePassword': mustChangePassword,
    };
