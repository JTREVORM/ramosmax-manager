import 'firestore_converters.dart';

/// Active / inactive — used by customers and vehicles. Records are never
/// deleted as a normal workflow; they become inactive so history stays intact.
enum RecordStatus {
  active('active', 'Active'),
  inactive('inactive', 'Inactive');

  const RecordStatus(this.key, this.label);
  final String key;
  final String label;

  static RecordStatus parse(Object? value) => value == 'inactive' ? inactive : active;
}

/// A customer at `customers/{customerId}`. Written only by the Cloud
/// Functions (`createCustomer`, `updateCustomer`, or `createVehicle` with a
/// new customer). Only the name is required.
class Customer {
  const Customer({
    required this.customerId,
    required this.customerNumber,
    required this.fullName,
    this.phoneNumber,
    this.alternativePhone,
    this.email,
    this.address,
    this.notes,
    this.status = RecordStatus.active,
    this.vehicleCount = 0,
    this.createdAt,
    this.updatedAt,
  });

  /// Firestore document ID.
  final String customerId;

  /// Human-facing ID allocated by the server, e.g. `RMX-CUS-000123`.
  final String customerNumber;
  final String fullName;

  /// E.164 (`+256772123456`), normalised by the server.
  final String? phoneNumber;
  final String? alternativePhone;
  final String? email;
  final String? address;
  final String? notes;
  final RecordStatus status;

  /// Number of vehicles currently linked (maintained by the server).
  final int vehicleCount;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  bool get isActive => status == RecordStatus.active;

  static Customer fromFirestore(String id, Map<String, dynamic> d) => Customer(
        customerId: id,
        customerNumber: d['customerNumber'] as String? ?? '',
        fullName: d['fullName'] as String? ?? '',
        phoneNumber: d['phoneNumber'] as String?,
        alternativePhone: d['alternativePhone'] as String?,
        email: d['email'] as String?,
        address: d['address'] as String?,
        notes: d['notes'] as String?,
        status: RecordStatus.parse(d['status']),
        vehicleCount: (d['vehicleCount'] as num?)?.toInt() ?? 0,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        updatedAt: FirestoreConverters.toDateTime(d['updatedAt']),
      );
}
