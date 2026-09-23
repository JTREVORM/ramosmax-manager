import 'package:cloud_firestore/cloud_firestore.dart';

import '../core/constants/firestore_collections.dart';
import '../models/audit_log_entry.dart';

/// Append-only writer for `audit_logs`.
///
/// Client-written entries cover actions the client itself performs (sign-in,
/// sign-out, UI-initiated requests). From Phase 2 on, financially significant
/// actions are audited by the trusted server code that performs them, so the
/// audit trail does not depend on an untrusted device remembering to log.
class AuditLogRepository {
  AuditLogRepository(this._db);

  final FirebaseFirestore _db;

  Future<void> record(AuditLogEntry entry) =>
      _db.collection(FirestoreCollections.auditLogs).add(entry.toFirestore());

  /// Phase 9: the audit trail for audit.view holders, newest first, bounded.
  /// Index: (module, timestamp desc) when filtered by module.
  Stream<List<AuditRecord>> watchLogs({String? module, int limit = 100}) {
    Query<Map<String, dynamic>> q = _db.collection(FirestoreCollections.auditLogs);
    if (module != null) q = q.where('module', isEqualTo: module);
    return q.orderBy('timestamp', descending: true).limit(limit).snapshots()
        .map((s) => [for (final d in s.docs) AuditRecord.fromFirestore(d.id, d.data())]);
  }
}
