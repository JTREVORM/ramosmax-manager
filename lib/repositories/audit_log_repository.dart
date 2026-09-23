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
}
