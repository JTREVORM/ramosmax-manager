import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/after_hours.dart';

/// Reads for after-hours work (Phase 8). Bounded and index-backed
/// (firebase/firestore.indexes.json); offline they come from the cache.
/// Writes go through [AfterHoursApi].
///
/// A worker may read only their OWN records, so every "my" query filters on
/// `staffUid == uid` - the rules refuse a query that does not.
class AfterHoursRepository {
  AfterHoursRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 100;
  static const int myLimit = 30;

  CollectionReference<Map<String, dynamic>> _c(String name) => _db.collection(name);

  // --- authorisations ---

  List<AfterHoursAuthorization> _auth(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) AfterHoursAuthorization.fromFirestore(d.id, d.data())];

  /// Newest first; optionally one stored status. Index: (status, createdAt desc).
  Stream<List<AfterHoursAuthorization>> watchAuthorizations({AuthorizationStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.afterHoursAccess);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_auth);
  }

  /// Index: (staffUid, createdAt desc).
  Stream<List<AfterHoursAuthorization>> watchMyAuthorizations(String uid) => _c(FirestoreCollections.afterHoursAccess)
      .where('staffUid', isEqualTo: uid)
      .orderBy('createdAt', descending: true)
      .limit(myLimit)
      .snapshots()
      .map(_auth);

  // --- sessions ---

  List<AfterHoursSession> _sessions(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) AfterHoursSession.fromFirestore(d.id, d.data())];

  /// Index: (status, openedAt desc).
  Stream<List<AfterHoursSession>> watchSessions({SessionStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.afterHoursSessions);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    return q.orderBy('openedAt', descending: true).limit(listLimit).snapshots().map(_sessions);
  }

  /// Index: (staffUid, openedAt desc).
  Stream<List<AfterHoursSession>> watchMySessions(String uid) => _c(FirestoreCollections.afterHoursSessions)
      .where('staffUid', isEqualTo: uid)
      .orderBy('openedAt', descending: true)
      .limit(myLimit)
      .snapshots()
      .map(_sessions);

  Stream<AfterHoursSession?> watchSession(String id) => _c(FirestoreCollections.afterHoursSessions)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? AfterHoursSession.fromFirestore(s.id, s.data()!) : null);

  /// The custody entries of one session, oldest first. Filtered on the
  /// session's worker so the same query works for the worker and a manager.
  /// Index: (staffUid, sessionId, createdAt).
  Stream<List<CustodyEntry>> watchCustody({required String staffUid, required String sessionId}) => _c(FirestoreCollections.afterHoursCash)
      .where('staffUid', isEqualTo: staffUid)
      .where('sessionId', isEqualTo: sessionId)
      .orderBy('createdAt')
      .limit(300)
      .snapshots()
      .map((s) => [for (final d in s.docs) CustodyEntry.fromFirestore(d.id, d.data())]);

  // --- handovers ---

  List<CashHandover> _handovers(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) CashHandover.fromFirestore(d.id, d.data())];

  /// Index: (status, createdAt desc).
  Stream<List<CashHandover>> watchHandovers({HandoverStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.cashHandovers);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_handovers);
  }

  /// Index: (staffUid, createdAt desc).
  Stream<List<CashHandover>> watchMyHandovers(String uid) => _c(FirestoreCollections.cashHandovers)
      .where('staffUid', isEqualTo: uid)
      .orderBy('createdAt', descending: true)
      .limit(myLimit)
      .snapshots()
      .map(_handovers);

  Stream<CashHandover?> watchHandover(String id) => _c(FirestoreCollections.cashHandovers)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? CashHandover.fromFirestore(s.id, s.data()!) : null);

  // --- discrepancies ---

  List<CashDiscrepancy> _disc(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) CashDiscrepancy.fromFirestore(d.id, d.data())];

  /// Index: (status, createdAt desc).
  Stream<List<CashDiscrepancy>> watchDiscrepancies({DiscrepancyStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.cashDiscrepancies);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_disc);
  }

  /// Index: (staffUid, createdAt desc).
  Stream<List<CashDiscrepancy>> watchMyDiscrepancies(String uid) => _c(FirestoreCollections.cashDiscrepancies)
      .where('staffUid', isEqualTo: uid)
      .orderBy('createdAt', descending: true)
      .limit(myLimit)
      .snapshots()
      .map(_disc);

  Stream<CashDiscrepancy?> watchDiscrepancy(String id) => _c(FirestoreCollections.cashDiscrepancies)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? CashDiscrepancy.fromFirestore(s.id, s.data()!) : null);

  // --- policy ---

  Stream<AfterHoursPolicy> watchPolicy() => _c(FirestoreCollections.settings)
      .doc(FirestoreDocs.afterHoursPolicy)
      .snapshots()
      .map((s) => AfterHoursPolicy.fromFirestore(s.data()));
}
