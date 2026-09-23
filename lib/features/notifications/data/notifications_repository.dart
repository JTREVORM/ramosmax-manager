import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/constants/firestore_collections.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/services/callables.dart';
import '../../../models/app_notification.dart';

/// The signed-in person's own notifications (Phase 9). The rules allow a
/// query only when it filters on `recipientId == uid`, and a client may only
/// change `read` / `readAt` / `updatedAt`. Index: (recipientId, createdAt desc).
class NotificationsRepository {
  NotificationsRepository(this._db);
  final FirebaseFirestore _db;

  static const int pageSize = 50;

  CollectionReference<Map<String, dynamic>> get _c => _db.collection(FirestoreCollections.notifications);

  Stream<List<AppNotification>> watchMine(String uid, {int limit = pageSize}) => _c
      .where('recipientId', isEqualTo: uid)
      .orderBy('createdAt', descending: true)
      .limit(limit)
      .snapshots()
      .map((s) => [for (final d in s.docs) AppNotification.fromFirestore(d.id, d.data())]);

  /// Unread count for the badge (capped: the badge shows 99+).
  Stream<int> watchUnreadCount(String uid) => _c
      .where('recipientId', isEqualTo: uid)
      .where('read', isEqualTo: false)
      .limit(100)
      .snapshots()
      .map((s) => s.docs.length);

  Future<void> markRead(String id) => _c.doc(id).update({
        'read': true,
        'readAt': FieldValue.serverTimestamp(),
        'updatedAt': FieldValue.serverTimestamp(),
      });

  /// Marks up to 100 unread notices read in one batch.
  Future<int> markAllRead(String uid) async {
    final unread = await _c.where('recipientId', isEqualTo: uid).where('read', isEqualTo: false).limit(100).get();
    if (unread.docs.isEmpty) return 0;
    final batch = _db.batch();
    for (final d in unread.docs) {
      batch.update(d.reference, {'read': true, 'readAt': FieldValue.serverTimestamp(), 'updatedAt': FieldValue.serverTimestamp()});
    }
    await batch.commit();
    return unread.docs.length;
  }
}

/// Server command for push preferences (users/{uid}.notificationPreferences
/// is written only by the updateNotificationPreferences function).
abstract class NotificationsApi {
  Future<Result<Map<String, bool>>> updatePreferences(Map<String, bool> preferences);
}

class CallableNotificationsApi implements NotificationsApi {
  CallableNotificationsApi(this._functions);
  final FirebaseFunctions _functions;

  @override
  Future<Result<Map<String, bool>>> updatePreferences(Map<String, bool> preferences) async =>
      (await callFunction(_functions, 'updateNotificationPreferences', {'preferences': preferences})).when(
        success: (d) => Success({
          for (final e in ((d['preferences'] as Map?) ?? const {}).entries)
            if (e.value is bool) e.key.toString(): e.value as bool,
        }),
        failure: Failure.new,
      );
}
