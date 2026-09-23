import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/constants/firestore_collections.dart';
import '../../../models/app_user.dart';
import '../../../models/work_order.dart';

/// Reads for worker orders. Every query is bounded and index-backed
/// (firebase/firestore.indexes.json); writes go through [JobsApi].
class JobsRepository {
  JobsRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 100;

  CollectionReference<Map<String, dynamic>> get _orders => _db.collection(FirestoreCollections.workerOrders);

  List<WorkOrder> _read(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) WorkOrder.fromFirestore(d.id, d.data())];

  /// The orders of one job, in service order.
  Stream<List<WorkOrder>> watchOrdersOf(String intakeId) => _orders
      .where('serviceIntakeId', isEqualTo: intakeId)
      .snapshots()
      .map((s) => _read(s)..sort((a, b) => _orderIndex(a).compareTo(_orderIndex(b))));

  /// A worker's own orders, newest first. The rules only allow this query
  /// with the `workerId == uid` filter for holders of jobs.view.own.
  /// Index: worker_orders (workerId, createdAt desc).
  Stream<List<WorkOrder>> watchOrdersFor(String workerId) => _orders
      .where('workerId', isEqualTo: workerId)
      .orderBy('createdAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map(_read);

  Stream<WorkOrder?> watchOrder(String id) =>
      _orders.doc(id).snapshots().map((s) => s.exists ? WorkOrder.fromFirestore(s.id, s.data()!) : null);

  /// Active staff who can carry out jobs (jobs.complete), for the assign
  /// picker. Needs users.view (managers, admins); the server re-checks the
  /// chosen person anyway.
  Future<List<AppUser>> assignableWorkers(DateTime now) async {
    final snap = await _db.collection(FirestoreCollections.users).where('active', isEqualTo: true).limit(200).get();
    return [
      for (final d in snap.docs)
        if (AppUser.fromFirestore(d.id, d.data()) case final u? when u.can(Permission.jobsComplete, now)) u,
    ]..sort((a, b) {
        // Workers first, then everyone else who may do the work.
        final byRole = (a.role == UserRole.worker ? 0 : 1).compareTo(b.role == UserRole.worker ? 0 : 1);
        return byRole != 0 ? byRole : a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase());
      });
  }

  static int _orderIndex(WorkOrder o) => int.tryParse(o.orderNumber.split('/').last) ?? 0;
}
