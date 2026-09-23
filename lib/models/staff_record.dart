import '../core/auth/user_role.dart';
import 'firestore_converters.dart';

/// An employee's record at `staff/{staffId}`.
///
/// Employment facts live here; application access lives in `users/{uid}`.
/// A staff member may exist without an app account ([linkedUid] null).
/// Phase 2 reads these records and creates/links them through the Cloud
/// Functions; Phase 10 (staff management) extends the record with contract,
/// salary and document references in their own restricted collections.
class StaffRecord {
  const StaffRecord({
    required this.staffId,
    this.fullName,
    this.phoneNumber,
    this.email,
    this.position,
    this.department,
    this.specialization,
    this.employmentStatus,
    this.linkedUid,
    this.createdAt,
  });

  /// Business identifier and document ID, e.g. `RMX-STF-0001`.
  final String staffId;
  final String? fullName;
  final String? phoneNumber;
  final String? email;
  final String? position;
  final String? department;
  final WorkerSpecialization? specialization;
  final String? employmentStatus;

  /// Firebase UID of the linked user account, if any.
  final String? linkedUid;
  final DateTime? createdAt;

  static StaffRecord fromFirestore(String id, Map<String, dynamic> data) => StaffRecord(
        staffId: id,
        fullName: data['fullName'] as String?,
        phoneNumber: data['phoneNumber'] as String?,
        email: data['email'] as String?,
        position: data['position'] as String?,
        department: data['department'] as String?,
        specialization: WorkerSpecialization.tryParse(data['specialization'] as String?),
        employmentStatus: data['employmentStatus'] as String?,
        linkedUid: data['linkedUid'] as String?,
        createdAt: FirestoreConverters.toDateTime(data['createdAt']),
      );
}
