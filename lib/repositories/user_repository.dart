import 'package:cloud_firestore/cloud_firestore.dart';

import '../core/constants/firestore_collections.dart';
import '../core/errors/app_failure.dart';
import '../core/errors/error_mapper.dart';
import '../models/app_user.dart';

/// Result of looking up the RamosMAX profile for an authenticated UID.
sealed class ProfileLookup {
  const ProfileLookup();
}

/// A usable profile exists (it may still be inactive — the session decides).
final class ProfileFound extends ProfileLookup {
  const ProfileFound(this.user);
  final AppUser user;
}

/// The server confirms there is no profile: phone is not registered.
final class ProfileMissing extends ProfileLookup {
  const ProfileMissing();
}

/// A document exists but lacks a valid role/phone. Treated as no access.
final class ProfileMalformed extends ProfileLookup {
  const ProfileMalformed();
}

/// Offline and nothing cached: we cannot yet say whether the user is
/// registered. Must NOT be treated as "unregistered".
final class ProfilePendingServer extends ProfileLookup {
  const ProfilePendingServer();
}

/// Reads and self-service updates of the signed-in user's own `users/{uid}`.
///
/// Admin mutations (create, role, permissions, activation) are intentionally
/// absent: the security rules deny them to every client. They are Cloud
/// Function calls — see `features/users/data/user_admin_api.dart`.
class UserRepository {
  UserRepository(this._db);

  final FirebaseFirestore _db;

  DocumentReference<Map<String, dynamic>> _doc(String uid) =>
      _db.collection(FirestoreCollections.users).doc(uid);

  /// Live profile. Deactivating a user or revoking a permission in the
  /// console takes effect on their device immediately.
  Stream<ProfileLookup> watchProfile(String uid) {
    return _doc(uid).snapshots(includeMetadataChanges: true).map((snap) {
      if (!snap.exists) {
        // A cache miss while offline says nothing about registration.
        return snap.metadata.isFromCache
            ? const ProfilePendingServer()
            : const ProfileMissing();
      }
      final user = AppUser.fromFirestore(uid, snap.data()!);
      return user == null ? const ProfileMalformed() : ProfileFound(user);
    });
  }

  Future<Result<ProfileLookup>> fetchProfile(String uid) async {
    try {
      final snap = await _doc(uid).get();
      if (!snap.exists) return const Success(ProfileMissing());
      final user = AppUser.fromFirestore(uid, snap.data()!);
      return Success(user == null ? const ProfileMalformed() : ProfileFound(user));
    } catch (e) {
      return Failure(ErrorMapper.map(e));
    }
  }

  /// Session bookkeeping — one of the few fields the rules let a user write.
  Future<void> recordLogin(String uid) => _doc(uid).update({
        'lastLoginAt': FieldValue.serverTimestamp(),
        'updatedAt': FieldValue.serverTimestamp(),
      });

  Future<void> addFcmToken(String uid, String token) => _doc(uid).update({
        'fcmTokens': FieldValue.arrayUnion([token]),
        'updatedAt': FieldValue.serverTimestamp(),
      });

  Future<void> removeFcmToken(String uid, String token) => _doc(uid).update({
        'fcmTokens': FieldValue.arrayRemove([token]),
        'updatedAt': FieldValue.serverTimestamp(),
      });
}
