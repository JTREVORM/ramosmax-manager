import 'package:cloud_firestore/cloud_firestore.dart';

import '../constants/firestore_collections.dart';

/// Firestore configuration and the shared metadata conventions.
///
/// Repositories use this for typed collection access and audit metadata; UI
/// code never touches `FirebaseFirestore` directly.
class FirestoreService {
  FirestoreService(this.db);

  final FirebaseFirestore db;

  /// 100 MB on-device cache: enough for a busy day's jobs, vehicles and
  /// service catalogue without unbounded growth on low-end handsets.
  static const int cacheSizeBytes = 100 * 1024 * 1024;

  /// Enables offline persistence. Must run before the first Firestore call.
  ///
  /// Offline policy (docs/OFFLINE.md): reads of operational data (assigned
  /// jobs, vehicles, services) are served from cache when offline. Financial
  /// writes must NOT rely on this cache — they go through transactions or
  /// server-side functions, both of which require connectivity and fail
  /// instead of queueing.
  static void configure(FirebaseFirestore db) {
    db.settings = const Settings(
      persistenceEnabled: true,
      cacheSizeBytes: cacheSizeBytes,
    );
  }

  CollectionReference<Map<String, dynamic>> collection(String name) => db.collection(name);

  DocumentReference<Map<String, dynamic>> userDoc(String uid) =>
      db.collection(FirestoreCollections.users).doc(uid);

  /// Metadata for a new document. Timestamps come from the server clock so a
  /// handset with a wrong date cannot back- or future-date a record.
  static Map<String, dynamic> createMetadata(String actorUid) => {
        FirestoreFields.createdAt: FieldValue.serverTimestamp(),
        FirestoreFields.updatedAt: FieldValue.serverTimestamp(),
        FirestoreFields.createdBy: actorUid,
        FirestoreFields.updatedBy: actorUid,
      };

  static Map<String, dynamic> updateMetadata(String actorUid) => {
        FirestoreFields.updatedAt: FieldValue.serverTimestamp(),
        FirestoreFields.updatedBy: actorUid,
      };
}
