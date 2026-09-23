import 'dart:typed_data';

import 'package:firebase_storage/firebase_storage.dart';

import '../errors/app_failure.dart';
import '../errors/error_mapper.dart';

/// Uploads and resolves files under the controlled paths in `StoragePaths`.
///
/// Firestore stores the *path* of a file, never a long-lived download URL:
/// download URLs are bearer links that bypass Storage rules once shared, so
/// they are resolved on demand for users the rules already allow.
class StorageService {
  StorageService(this._storage);

  final FirebaseStorage _storage;

  static const Set<String> allowedContentTypes = {
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
  };

  Future<Result<String>> upload({
    required String path,
    required Uint8List bytes,
    required String contentType,
    required String uploadedBy,
  }) async {
    if (!allowedContentTypes.contains(contentType)) {
      return const Failure(AppFailure(FailureKind.invalidInput, 'This file type is not supported.'));
    }
    try {
      await _storage.ref(path).putData(
            bytes,
            SettableMetadata(
              contentType: contentType,
              customMetadata: {'uploadedBy': uploadedBy},
            ),
          );
      return Success(path);
    } catch (e) {
      return Failure(ErrorMapper.map(e));
    }
  }

  /// Short-lived access for display. Callers must not persist the result.
  Future<Result<String>> downloadUrl(String path) async {
    try {
      return Success(await _storage.ref(path).getDownloadURL());
    } catch (e) {
      return Failure(ErrorMapper.map(e));
    }
  }
}
