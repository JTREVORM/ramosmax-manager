import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/app_user.dart';
import '../../../models/audit_log_entry.dart';
import '../../../models/staff_record.dart';
import '../../../models/temporary_grant.dart';

/// Read-only access to other people's accounts for user management.
///
/// Every query here is also gated by the security rules: `users` needs
/// `users.view`, `staff` needs `staff.view`, `audit_logs` needs `audit.view`.
/// Reads work from the offline cache; writes never happen here (see
/// [UserAdminApi]).
class UserDirectoryRepository {
  UserDirectoryRepository(this._db);

  final FirebaseFirestore _db;

  CollectionReference<Map<String, dynamic>> get _users =>
      _db.collection(FirestoreCollections.users);

  /// Every user, sorted by name. RamosMAX has tens of staff, not thousands,
  /// so the list is loaded whole and searched on the device — which also keeps
  /// search working offline. Malformed profiles are skipped.
  Stream<List<AppUser>> watchAll() => _users.snapshots().map((snap) {
        final users = [
          for (final d in snap.docs)
            if (AppUser.fromFirestore(d.id, d.data()) case final AppUser u) u,
        ];
        users.sort((a, b) => a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()));
        return users;
      });

  Stream<AppUser?> watchUser(String uid) => _users.doc(uid).snapshots().map(
        (snap) => snap.exists ? AppUser.fromFirestore(uid, snap.data()!) : null,
      );

  /// Temporary grant records, newest first.
  Stream<List<TemporaryGrant>> watchTemporaryGrants(String uid) => _users
      .doc(uid)
      .collection(FirestoreCollections.temporaryGrants)
      .orderBy('createdAt', descending: true)
      .limit(50)
      .snapshots()
      .map((snap) => [
            for (final d in snap.docs)
              if (TemporaryGrant.fromFirestore(d.id, d.data()) case final TemporaryGrant g) g,
          ]);

  Stream<StaffRecord?> watchStaff(String staffId) => _db
      .collection(FirestoreCollections.staff)
      .doc(staffId)
      .snapshots()
      .map((snap) => snap.exists ? StaffRecord.fromFirestore(snap.id, snap.data()!) : null);

  /// Audit entries about one user's account, newest first.
  Stream<List<AuditRecord>> watchAccessHistory(String uid, {int limit = 30}) => _db
      .collection(FirestoreCollections.auditLogs)
      .where('recordId', isEqualTo: uid)
      .orderBy('timestamp', descending: true)
      .limit(limit)
      .snapshots()
      .map((snap) => [for (final d in snap.docs) AuditRecord.fromFirestore(d.id, d.data())]);
}
