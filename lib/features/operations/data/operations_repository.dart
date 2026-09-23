import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../core/utils/number_plates.dart';
import '../../../models/catalog_service.dart';
import '../../../models/customer.dart';
import '../../../models/service_intake.dart';
import '../../../models/vehicle.dart';
import '../application/customer_search.dart';

/// Reads for customers, vehicles, the service catalogue and service intakes.
///
/// Every query is bounded and index-backed — nothing downloads a whole
/// collection to search on the phone (except the service catalogue, which is
/// small reference data and is kept in the offline cache on purpose). All
/// writes go through [OperationsApi] (Cloud Functions); the rules deny client
/// writes. With Firestore persistence on, these reads fall back to the cache
/// offline.
class OperationsRepository {
  OperationsRepository(this._db);

  final FirebaseFirestore _db;

  static const int plateResultLimit = 10;
  static const int listLimit = 30;

  CollectionReference<Map<String, dynamic>> get _vehicles => _db.collection(FirestoreCollections.vehicles);
  CollectionReference<Map<String, dynamic>> get _customers => _db.collection(FirestoreCollections.customers);
  CollectionReference<Map<String, dynamic>> get _intakes => _db.collection(FirestoreCollections.serviceIntakes);

  // --- Vehicles --------------------------------------------------------------

  /// Plate search: an exact-or-prefix range on `normalizedNumberPlate`
  /// (single-field index), at most [plateResultLimit] results. Empty input
  /// lists the most recently registered vehicles.
  Future<List<Vehicle>> searchVehicles(String input) async {
    final key = NumberPlates.key(input);
    final Query<Map<String, dynamic>> query = key.isEmpty
        ? _vehicles.orderBy('createdAt', descending: true).limit(listLimit)
        : _vehicles
            .where('normalizedNumberPlate', isGreaterThanOrEqualTo: key)
            .where('normalizedNumberPlate', isLessThan: '$key')
            .orderBy('normalizedNumberPlate')
            .limit(plateResultLimit);
    final snap = await query.get();
    return [for (final d in snap.docs) Vehicle.fromFirestore(d.id, d.data())];
  }

  Stream<Vehicle?> watchVehicle(String vehicleId) => _vehicles
      .doc(vehicleId)
      .snapshots()
      .map((s) => s.exists ? Vehicle.fromFirestore(s.id, s.data()!) : null);

  Stream<List<Vehicle>> watchVehiclesOf(String customerId) => _vehicles
      .where('customerId', isEqualTo: customerId)
      .limit(100)
      .snapshots()
      .map((s) => [for (final d in s.docs) Vehicle.fromFirestore(d.id, d.data())]
        ..sort((a, b) => a.numberPlate.compareTo(b.numberPlate)));

  // --- Customers -------------------------------------------------------------

  Future<List<Customer>> searchCustomers(String input, {RecordStatus? status}) async {
    final q = CustomerQuery.parse(input);
    List<Customer> read(QuerySnapshot<Map<String, dynamic>> s) =>
        [for (final d in s.docs) Customer.fromFirestore(d.id, d.data())];

    final List<Customer> results;
    switch (q) {
      case RecentCustomers():
        Query<Map<String, dynamic>> query = _customers;
        if (status != null) query = query.where('status', isEqualTo: status.key);
        results = read(await query.orderBy('createdAt', descending: true).limit(listLimit).get());
      case IncompletePhone():
        return const [];
      case PhoneQuery(:final e164):
        final byMain = await _customers.where('phoneNumber', isEqualTo: e164).limit(5).get();
        final byAlt = await _customers.where('alternativePhone', isEqualTo: e164).limit(5).get();
        final seen = <String>{};
        results = [
          for (final c in [...read(byMain), ...read(byAlt)])
            if (seen.add(c.customerId)) c,
        ];
      case CustomerNumberQuery(:final customerNumber):
        results = read(await _customers.where('customerNumber', isEqualTo: customerNumber).limit(1).get());
      case NameQuery():
        final snap = await _customers.where('searchTokens', arrayContains: q.token).limit(listLimit).get();
        results = read(snap).where(q.matches).toList()
          ..sort((a, b) => a.fullName.toLowerCase().compareTo(b.fullName.toLowerCase()));
    }
    return status == null ? results : results.where((c) => c.status == status).toList();
  }

  Stream<Customer?> watchCustomer(String customerId) => _customers
      .doc(customerId)
      .snapshots()
      .map((s) => s.exists ? Customer.fromFirestore(s.id, s.data()!) : null);

  // --- Service catalogue -----------------------------------------------------

  Stream<List<CatalogService>> watchServices() => _db
      .collection(FirestoreCollections.services)
      .orderBy('name')
      .limit(500)
      .snapshots()
      .map((s) => [for (final d in s.docs) CatalogService.fromFirestore(d.id, d.data())]);

  // --- Service intakes -------------------------------------------------------

  Stream<List<ServiceIntake>> watchIntakes({IntakeStatus? status}) {
    Query<Map<String, dynamic>> query = _intakes;
    if (status != null) query = query.where('status', isEqualTo: status.key);
    return query
        .orderBy('createdAt', descending: true)
        .limit(50)
        .snapshots()
        .map((s) => [for (final d in s.docs) ServiceIntake.fromFirestore(d.id, d.data())]);
  }

  Stream<List<ServiceIntake>> watchIntakesFor({String? vehicleId, String? customerId}) => _intakes
      .where(vehicleId != null ? 'vehicleId' : 'customerId', isEqualTo: vehicleId ?? customerId)
      .orderBy('createdAt', descending: true)
      .limit(20)
      .snapshots()
      .map((s) => [for (final d in s.docs) ServiceIntake.fromFirestore(d.id, d.data())]);

  Stream<ServiceIntake?> watchIntake(String intakeId) => _intakes
      .doc(intakeId)
      .snapshots()
      .map((s) => s.exists ? ServiceIntake.fromFirestore(s.id, s.data()!) : null);
}
