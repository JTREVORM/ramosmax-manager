import '../core/auth/permissions.dart';
import '../core/auth/user_role.dart';
import 'firestore_converters.dart';

/// Lifecycle of a temporary grant as shown to administrators.
enum TemporaryGrantStatus {
  scheduled('Scheduled'),
  active('Active'),
  expired('Expired'),
  revoked('Revoked'),
  superseded('Replaced');

  const TemporaryGrantStatus(this.label);
  final String label;
}

/// The full record of one temporary permission grant, stored at
/// `users/{uid}/temporary_grants/{grantId}` by the Cloud Functions. Read-only
/// in the app.
class TemporaryGrant {
  const TemporaryGrant({
    required this.id,
    required this.permission,
    required this.startsAt,
    required this.expiresAt,
    required this.storedStatus,
    this.reason,
    this.grantedBy,
    this.grantedByName,
    this.grantedByRole,
    this.createdAt,
    this.endedAt,
    this.endReason,
  });

  final String id;
  final Permission permission;
  final DateTime startsAt;
  final DateTime expiresAt;

  /// `active`, `revoked`, `superseded` or `expired` as written by the server.
  /// Use [statusAt] for display: an `active` record past its end is expired
  /// even before the scheduled sweep marks it.
  final String storedStatus;
  final String? reason;
  final String? grantedBy;
  final String? grantedByName;
  final UserRole? grantedByRole;
  final DateTime? createdAt;
  final DateTime? endedAt;
  final String? endReason;

  TemporaryGrantStatus statusAt(DateTime now) {
    switch (storedStatus) {
      case 'revoked':
        return TemporaryGrantStatus.revoked;
      case 'superseded':
        return TemporaryGrantStatus.superseded;
      case 'expired':
        return TemporaryGrantStatus.expired;
    }
    if (!now.isBefore(expiresAt)) return TemporaryGrantStatus.expired;
    if (now.isBefore(startsAt)) return TemporaryGrantStatus.scheduled;
    return TemporaryGrantStatus.active;
  }

  /// Still to run or running — the only grants that can be revoked.
  bool isCurrent(DateTime now) {
    final s = statusAt(now);
    return s == TemporaryGrantStatus.active || s == TemporaryGrantStatus.scheduled;
  }

  static TemporaryGrant? fromFirestore(String id, Map<String, dynamic> data) {
    final permission = Permission.tryParse(data['permission'] as String? ?? '');
    final starts = FirestoreConverters.toDateTime(data['startsAt']);
    final expires = FirestoreConverters.toDateTime(data['expiresAt']);
    if (permission == null || starts == null || expires == null) return null;
    return TemporaryGrant(
      id: id,
      permission: permission,
      startsAt: starts,
      expiresAt: expires,
      storedStatus: data['status'] as String? ?? 'active',
      reason: data['reason'] as String?,
      grantedBy: data['grantedBy'] as String?,
      grantedByName: data['grantedByName'] as String?,
      grantedByRole: UserRole.tryParse(data['grantedByRole'] as String?),
      createdAt: FirestoreConverters.toDateTime(data['createdAt']),
      endedAt: FirestoreConverters.toDateTime(data['endedAt']),
      endReason: data['endReason'] as String?,
    );
  }
}
