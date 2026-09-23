import 'customer.dart';
import 'firestore_converters.dart';

/// Vehicle types offered at registration. Mirrors `vehicleTypes` in
/// functions/src/access_catalog.json.
enum VehicleType {
  car('car', 'Car'),
  suv('suv', 'SUV'),
  pickup('pickup', 'Pick-up'),
  van('van', 'Van'),
  bus('bus', 'Bus'),
  truck('truck', 'Truck'),
  motorcycle('motorcycle', 'Motorcycle'),
  other('other', 'Other');

  const VehicleType(this.key, this.label);
  final String key;
  final String label;

  static VehicleType? tryParse(Object? value) {
    for (final t in values) {
      if (t.key == value) return t;
    }
    return null;
  }
}

/// A vehicle at `vehicles/{vehicleId}` — identified in daily operations by
/// its number plate. The document ID is separate from the plate so a
/// corrected plate never orphans history. Written only by the Cloud Functions.
class Vehicle {
  const Vehicle({
    required this.vehicleId,
    required this.numberPlate,
    required this.normalizedNumberPlate,
    required this.model,
    required this.colour,
    this.make,
    this.year,
    this.vehicleType,
    this.notes,
    this.customerId,
    this.customerName,
    this.customerNumber,
    this.previousPlates = const [],
    this.status = RecordStatus.active,
    this.lastIntakeAt,
    this.createdAt,
  });

  final String vehicleId;

  /// Display form, e.g. `UGB 123A`.
  final String numberPlate;

  /// Search/uniqueness key, e.g. `UGB123A`. Unique across all vehicles.
  final String normalizedNumberPlate;
  final String model;
  final String colour;
  final String? make;
  final int? year;
  final VehicleType? vehicleType;
  final String? notes;

  /// The one primary customer, if known. The name and number are display
  /// copies kept in sync by the server (they are visible to anyone who can
  /// look up plates; phone numbers are not copied here).
  final String? customerId;
  final String? customerName;
  final String? customerNumber;

  /// Earlier plates of this vehicle (after an authorised plate change).
  final List<String> previousPlates;
  final RecordStatus status;
  final DateTime? lastIntakeAt;
  final DateTime? createdAt;

  bool get isActive => status == RecordStatus.active;

  /// `Toyota Harrier · Black`
  String get description => [
        [make, model].whereType<String>().where((s) => s.isNotEmpty).join(' '),
        colour,
      ].where((s) => s.isNotEmpty).join(' · ');

  static Vehicle fromFirestore(String id, Map<String, dynamic> d) => Vehicle(
        vehicleId: id,
        numberPlate: d['numberPlate'] as String? ?? '',
        normalizedNumberPlate: d['normalizedNumberPlate'] as String? ?? '',
        model: d['model'] as String? ?? '',
        colour: d['colour'] as String? ?? '',
        make: d['make'] as String?,
        year: (d['year'] as num?)?.toInt(),
        vehicleType: VehicleType.tryParse(d['vehicleType']),
        notes: d['notes'] as String?,
        customerId: d['customerId'] as String?,
        customerName: d['customerName'] as String?,
        customerNumber: d['customerNumber'] as String?,
        previousPlates: [for (final p in (d['previousPlates'] as List? ?? const [])) if (p is String) p],
        status: RecordStatus.parse(d['status']),
        lastIntakeAt: FirestoreConverters.toDateTime(d['lastIntakeAt']),
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
      );
}
