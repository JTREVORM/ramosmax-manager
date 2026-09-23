import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/widgets.dart' show StringCharacters;

import '../core/auth/permissions.dart';
import '../core/auth/user_role.dart';
import 'firestore_converters.dart';

/// The window in which a temporary permission is effective. Stored in the
/// profile's `temporaryPermissions` map, which is the copy the security rules
/// enforce. The full record (who granted it and why) is a [TemporaryGrant].
class TemporaryWindow {
  const TemporaryWindow({required this.expiresAt, this.startsAt, this.grantId});

  /// Null for grants written in the Phase 1 format (effective immediately).
  final DateTime? startsAt;
  final DateTime expiresAt;
  final String? grantId;

  bool isLive(DateTime now) =>
      now.isBefore(expiresAt) && (startsAt == null || !now.isBefore(startsAt!));

  bool isScheduled(DateTime now) => startsAt != null && now.isBefore(startsAt!);

  /// Accepts `{startsAt, expiresAt, grantId}` or a bare expiry Timestamp.
  static TemporaryWindow? fromFirestore(Object? raw) {
    if (raw is Map) {
      final expires = FirestoreConverters.toDateTime(raw['expiresAt']);
      if (expires == null) return null;
      return TemporaryWindow(
        expiresAt: expires,
        startsAt: FirestoreConverters.toDateTime(raw['startsAt']),
        grantId: raw['grantId'] as String?,
      );
    }
    final expires = FirestoreConverters.toDateTime(raw);
    return expires == null ? null : TemporaryWindow(expiresAt: expires);
  }

  Map<String, dynamic> toFirestore() => {
        'startsAt': FirestoreConverters.fromDateTime(startsAt),
        'expiresAt': Timestamp.fromDate(expiresAt),
        'grantId': grantId,
      };
}

/// A RamosMAX business profile, stored at `users/{firebaseUid}`.
///
/// Firebase Auth proves *who* someone is (phone number + password). This
/// document decides *whether* they may use RamosMAX and *what* they may do.
/// It never holds credentials: no passwords or hashes (Firebase Auth holds
/// them) and no auth tokens (FCM device registration tokens are addressing
/// data, not credentials). Legacy `phoneVerified` fields from the retired SMS
/// sign-in may remain in old documents; they are ignored.
///
/// Only the Cloud Functions write the access fields (role, permissions,
/// active, staff link, profile details); see docs/USER_MANAGEMENT.md.
class AppUser {
  const AppUser({
    required this.uid,
    required this.phoneNumber,
    required this.role,
    required this.active,
    this.fullName,
    this.email,
    this.staffId,
    this.position,
    this.department,
    this.profilePhotoPath,
    this.specialization,
    this.permissions = const {},
    this.deniedPermissions = const {},
    this.temporaryPermissions = const {},
    this.accessExpiresAt,
    this.passwordSet = false,
    this.mustChangePassword = false,
    this.passwordChangedAt,
    this.passwordResetAt,
    this.statusReason,
    this.statusChangedAt,
    this.statusChangedBy,
    this.lastAccessChangeAt,
    this.lastAccessChangeBy,
    this.createdAt,
    this.updatedAt,
    this.createdBy,
    this.updatedBy,
    this.lastLoginAt,
  });

  final String uid;

  /// E.164 (e.g. `+256772123456`). Must match the Firebase Auth phone number.
  final String phoneNumber;
  final UserRole role;
  final bool active;

  final String? fullName;
  final String? email;

  /// Link to the employment record `staff/{staffId}` (e.g. `RMX-STF-0001`),
  /// distinct from [uid].
  final String? staffId;

  /// Display copies of the linked staff record's job details, kept in sync by
  /// the Cloud Functions so the user list needs no extra reads.
  final String? position;
  final String? department;

  /// Storage path, not a public URL — resolved through StorageService.
  final String? profilePhotoPath;
  final WorkerSpecialization? specialization;

  /// Extra permissions granted beyond the role's defaults.
  final Set<Permission> permissions;

  /// Permissions withheld even though the role would grant them.
  final Set<Permission> deniedPermissions;

  /// Time-boxed grants (e.g. after-hours access): permission → window.
  final Map<Permission, TemporaryWindow> temporaryPermissions;

  /// Optional hard end to the whole account's access (e.g. contract end).
  final DateTime? accessExpiresAt;

  /// A password exists in Firebase Authentication for this account. False
  /// for accounts from the retired SMS sign-in until an administrator issues
  /// a password (the migration path).
  final bool passwordSet;

  /// The account holds a temporary password (new account or administrator
  /// reset) and must replace it before doing anything else. Enforced by the
  /// security rules and the Cloud Functions, not only by the app.
  final bool mustChangePassword;
  final DateTime? passwordChangedAt;
  final DateTime? passwordResetAt;

  /// Reason recorded with the last activation/deactivation.
  final String? statusReason;
  final DateTime? statusChangedAt;
  final String? statusChangedBy;

  /// Last change to role, permissions, temporary access or status.
  final DateTime? lastAccessChangeAt;
  final String? lastAccessChangeBy;

  final DateTime? createdAt;
  final DateTime? updatedAt;
  final String? createdBy;
  final String? updatedBy;
  final DateTime? lastLoginAt;

  String get displayName =>
      (fullName != null && fullName!.trim().isNotEmpty) ? fullName!.trim() : phoneNumber;

  /// Up to two initials for avatars.
  String get initials {
    final parts = displayName.split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty || fullName == null) return '#';
    final first = parts.first.characters.first;
    final last = parts.length > 1 ? parts.last.characters.first : '';
    return (first + last).toUpperCase();
  }

  bool hasAccessExpired(DateTime now) =>
      accessExpiresAt != null && !now.isBefore(accessExpiresAt!);

  /// Whether this profile may open a session right now.
  bool canSignIn(DateTime now) => active && !hasAccessExpired(now);

  /// May use RamosMAX: signed in AND not waiting for a password change.
  /// Mirrors `isActive()` in the rules.
  bool isLive(DateTime now) => canSignIn(now) && !mustChangePassword;

  /// Temporary grants that are in force at [now] (started and not expired).
  Set<Permission> activeTemporaryPermissions(DateTime now) => {
        for (final entry in temporaryPermissions.entries)
          if (entry.value.isLive(now)) entry.key,
      };

  /// Role defaults ∪ direct grants — denials. What the user has without any
  /// temporary access.
  Set<Permission> permanentPermissions() =>
      {...RolePermissions.forRole(role), ...permissions}..removeAll(deniedPermissions);

  /// Role defaults ∪ direct grants ∪ live temporary grants, minus denials.
  /// Mirrors `hasPermission()` in `firebase/firestore.rules` and
  /// `effectivePermissions()` in `functions/src/access.js`.
  Set<Permission> effectivePermissions(DateTime now) {
    if (!isLive(now)) return const {};
    return {
      ...RolePermissions.forRole(role),
      ...permissions,
      ...activeTemporaryPermissions(now),
    }..removeAll(deniedPermissions);
  }

  bool can(Permission permission, DateTime now) =>
      effectivePermissions(now).contains(permission);

  /// Parses a `users` document. Returns null when the document is structurally
  /// unusable (missing or unknown role) — callers treat that as "no access"
  /// rather than guessing a role.
  static AppUser? fromFirestore(String uid, Map<String, dynamic> data) {
    final role = UserRole.tryParse(data['role'] as String?);
    final phone = data['phoneNumber'] as String?;
    if (role == null || phone == null) return null;

    return AppUser(
      uid: uid,
      phoneNumber: phone,
      role: role,
      // Anything other than an explicit `true` is inactive: fail closed.
      active: data['active'] == true,
      fullName: data['fullName'] as String?,
      email: data['email'] as String?,
      staffId: data['staffId'] as String?,
      position: data['position'] as String?,
      department: data['department'] as String?,
      profilePhotoPath: data['profilePhotoPath'] as String?,
      specialization: WorkerSpecialization.tryParse(data['specialization'] as String?),
      permissions: _parsePermissionList(data['permissions']),
      deniedPermissions: _parsePermissionList(data['deniedPermissions']),
      temporaryPermissions: _parseTemporary(data['temporaryPermissions']),
      accessExpiresAt: FirestoreConverters.toDateTime(data['accessExpiresAt']),
      passwordSet: data['passwordSet'] == true,
      // A missing flag (profiles from before passwords) means no pending
      // change; the rules read it the same way.
      mustChangePassword: data['mustChangePassword'] == true,
      passwordChangedAt: FirestoreConverters.toDateTime(data['passwordChangedAt']),
      passwordResetAt: FirestoreConverters.toDateTime(data['passwordResetAt']),
      statusReason: data['statusReason'] as String?,
      statusChangedAt: FirestoreConverters.toDateTime(data['statusChangedAt']),
      statusChangedBy: data['statusChangedBy'] as String?,
      lastAccessChangeAt: FirestoreConverters.toDateTime(data['lastAccessChangeAt']),
      lastAccessChangeBy: data['lastAccessChangeBy'] as String?,
      createdAt: FirestoreConverters.toDateTime(data['createdAt']),
      updatedAt: FirestoreConverters.toDateTime(data['updatedAt']),
      createdBy: data['createdBy'] as String?,
      updatedBy: data['updatedBy'] as String?,
      lastLoginAt: FirestoreConverters.toDateTime(data['lastLoginAt']),
    );
  }

  /// Full document shape, used by tests and fixtures. The app itself never
  /// writes these fields — the Cloud Functions do (see the `users` rules).
  Map<String, dynamic> toFirestore() => {
        'uid': uid,
        'phoneNumber': phoneNumber,
        'role': role.key,
        'active': active,
        'fullName': fullName,
        'email': email,
        'staffId': staffId,
        'position': position,
        'department': department,
        'profilePhotoPath': profilePhotoPath,
        'specialization': specialization?.key,
        'permissions': permissions.map((p) => p.key).toList(),
        'deniedPermissions': deniedPermissions.map((p) => p.key).toList(),
        'temporaryPermissions': {
          for (final e in temporaryPermissions.entries) e.key.key: e.value.toFirestore(),
        },
        'accessExpiresAt': FirestoreConverters.fromDateTime(accessExpiresAt),
        'passwordSet': passwordSet,
        'mustChangePassword': mustChangePassword,
        'passwordChangedAt': FirestoreConverters.fromDateTime(passwordChangedAt),
        'passwordResetAt': FirestoreConverters.fromDateTime(passwordResetAt),
        'statusReason': statusReason,
        'statusChangedAt': FirestoreConverters.fromDateTime(statusChangedAt),
        'statusChangedBy': statusChangedBy,
        'lastAccessChangeAt': FirestoreConverters.fromDateTime(lastAccessChangeAt),
        'lastAccessChangeBy': lastAccessChangeBy,
        'createdAt': FirestoreConverters.fromDateTime(createdAt),
        'updatedAt': FirestoreConverters.fromDateTime(updatedAt),
        'createdBy': createdBy,
        'updatedBy': updatedBy,
        'lastLoginAt': FirestoreConverters.fromDateTime(lastLoginAt),
      };

  // Unknown keys are dropped rather than failing the whole profile, so a
  // permission added in a newer app version doesn't lock out older clients.
  static Set<Permission> _parsePermissionList(Object? raw) {
    if (raw is! List) return const {};
    return {
      for (final v in raw)
        if (v is String && Permission.tryParse(v) != null) Permission.tryParse(v)!,
    };
  }

  static Map<Permission, TemporaryWindow> _parseTemporary(Object? raw) {
    if (raw is! Map) return const {};
    final result = <Permission, TemporaryWindow>{};
    raw.forEach((key, value) {
      final permission = key is String ? Permission.tryParse(key) : null;
      final window = TemporaryWindow.fromFirestore(value);
      if (permission != null && window != null) result[permission] = window;
    });
    return result;
  }
}
