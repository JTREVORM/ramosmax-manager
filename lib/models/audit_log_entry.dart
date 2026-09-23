import 'package:cloud_firestore/cloud_firestore.dart';

import '../core/auth/user_role.dart';

/// Modules that write audit entries. Stored as the string key.
enum AuditModule {
  auth('auth'),
  users('users'),
  staff('staff'),
  customers('customers'),
  vehicles('vehicles'),
  services('services'),
  jobs('jobs'),
  payments('payments'),
  discounts('discounts'),
  expenses('expenses'),
  finance('finance'),
  payroll('payroll'),
  attendance('attendance'),
  losses('losses'),
  loyalty('loyalty'),
  cashHandover('cash_handover'),
  afterHours('after_hours'),
  inventory('inventory'),
  settings('settings');

  const AuditModule(this.key);
  final String key;
}

/// One immutable entry in `audit_logs`.
///
/// Entries are append-only (rules forbid update and delete). [timestamp] is
/// always the server clock and [userId]/[userRole] must match the caller —
/// both enforced by the rules, so entries cannot be back-dated or forged.
///
/// [previousValue]/[newValue] must never contain secrets or full sensitive
/// records (bank numbers, national IDs); store the changed fields only.
class AuditLogEntry {
  const AuditLogEntry({
    required this.userId,
    required this.userRole,
    required this.action,
    required this.module,
    this.recordId,
    this.description,
    this.previousValue,
    this.newValue,
  });

  final String userId;
  final UserRole userRole;

  /// Verb-style identifier, e.g. `session.sign_in`, `payment.recorded`.
  final String action;
  final AuditModule module;
  final String? recordId;
  final String? description;
  final Map<String, dynamic>? previousValue;
  final Map<String, dynamic>? newValue;

  Map<String, dynamic> toFirestore() => {
        'userId': userId,
        'userRole': userRole.key,
        'action': action,
        'module': module.key,
        'recordId': recordId,
        'description': description,
        'previousValue': previousValue,
        'newValue': newValue,
        'timestamp': FieldValue.serverTimestamp(),
      };
}

/// An audit entry as read back for display (access history). Entries written
/// by the Cloud Functions also carry [reason] and a target user.
class AuditRecord {
  const AuditRecord({
    required this.id,
    required this.userId,
    required this.action,
    this.userRole,
    this.description,
    this.reason,
    this.previousValue,
    this.newValue,
    this.timestamp,
  });

  final String id;

  /// Actor UID, or `admin-cli:<name>` for the provisioning tool.
  final String userId;
  final UserRole? userRole;
  final String action;
  final String? description;
  final String? reason;
  final Map<String, dynamic>? previousValue;
  final Map<String, dynamic>? newValue;
  final DateTime? timestamp;

  static AuditRecord fromFirestore(String id, Map<String, dynamic> data) => AuditRecord(
        id: id,
        userId: data['userId'] as String? ?? 'unknown',
        userRole: UserRole.tryParse(data['userRole'] as String?),
        action: data['action'] as String? ?? 'unknown',
        description: data['description'] as String?,
        reason: data['reason'] as String?,
        previousValue: _map(data['previousValue']),
        newValue: _map(data['newValue']),
        timestamp: data['timestamp'] is Timestamp ? (data['timestamp'] as Timestamp).toDate() : null,
      );

  static Map<String, dynamic>? _map(Object? raw) =>
      raw is Map ? raw.map((k, v) => MapEntry(k.toString(), v)) : null;
}
