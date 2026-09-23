import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions, HttpsCallableOptions;

import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';

/// Customer fields as entered. Null = leave unchanged (updates) or empty
/// (creation); an empty string clears an optional field.
class CustomerInput {
  const CustomerInput({this.fullName, this.phoneNumber, this.alternativePhone, this.email, this.address, this.notes});

  final String? fullName;
  final String? phoneNumber;
  final String? alternativePhone;
  final String? email;
  final String? address;
  final String? notes;

  Map<String, Object?> toJson() => {
        if (fullName != null) 'fullName': fullName,
        if (phoneNumber != null) 'phoneNumber': phoneNumber,
        if (alternativePhone != null) 'alternativePhone': alternativePhone,
        if (email != null) 'email': email,
        if (address != null) 'address': address,
        'notes': ?notes,
      };
}

class VehicleInput {
  const VehicleInput({this.numberPlate, this.make, this.model, this.colour, this.year, this.vehicleType, this.notes});

  final String? numberPlate;
  final String? make;
  final String? model;
  final String? colour;

  /// Null = unchanged; use [clearYear] to remove it.
  final int? year;
  final String? vehicleType;
  final String? notes;

  Map<String, Object?> toJson() => {
        if (numberPlate != null) 'numberPlate': numberPlate,
        if (make != null) 'make': make,
        if (model != null) 'model': model,
        if (colour != null) 'colour': colour,
        if (year != null) 'year': year,
        if (vehicleType != null) 'vehicleType': vehicleType,
        'notes': ?notes,
      };
}

/// How a vehicle's customer is chosen when registering or relinking.
sealed class CustomerLink {
  const CustomerLink();
}

final class NoCustomer extends CustomerLink {
  const NoCustomer();
}

final class ExistingCustomer extends CustomerLink {
  const ExistingCustomer(this.customerId, this.label);
  final String customerId;
  final String label;
}

final class NewCustomer extends CustomerLink {
  const NewCustomer(this.input);
  final CustomerInput input;
}

class ServiceInput {
  const ServiceInput({
    this.name,
    this.description,
    this.category,
    this.priceUgx,
    this.estimatedDurationMinutes,
    this.clearDuration = false,
    this.qualifiesForLoyalty,
    this.isActive,
  });

  final String? name;
  final String? description;
  final String? category;
  final int? priceUgx;
  final int? estimatedDurationMinutes;
  final bool clearDuration;
  final bool? qualifiesForLoyalty;
  final bool? isActive;

  Map<String, Object?> toJson() => {
        if (name != null) 'name': name,
        if (description != null) 'description': description,
        if (category != null) 'category': category,
        if (priceUgx != null) 'priceUgx': priceUgx,
        if (estimatedDurationMinutes != null || clearDuration) 'estimatedDurationMinutes': estimatedDurationMinutes,
        if (qualifiesForLoyalty != null) 'qualifiesForLoyalty': qualifiesForLoyalty,
        if (isActive != null) 'isActive': isActive,
      };
}

/// Writes for customers, vehicles, services and intakes. Each is a Cloud
/// Function (functions/src/operations.js) that authorises the caller,
/// validates, enforces uniqueness and audits in one transaction.
abstract class OperationsApi {
  Future<Result<String>> createCustomer(CustomerInput input);
  Future<Result<void>> updateCustomer(String customerId, CustomerInput changes, {String? status, String? reason});

  Future<Result<String>> createVehicle(VehicleInput input, CustomerLink customer);
  Future<Result<void>> updateVehicle(String vehicleId, VehicleInput changes,
      {CustomerLink? customer, bool clearYear = false, String? status, String? reason});

  Future<Result<String>> createService(ServiceInput input);
  Future<Result<void>> updateService(String serviceId, ServiceInput changes, {String? reason});

  Future<Result<String>> createServiceIntake(String vehicleId, List<String> serviceIds, {String? notes});
  Future<Result<void>> updateServiceIntake(String intakeId, {List<String>? serviceIds, String? status, String? reason});
}

class CallableOperationsApi implements OperationsApi {
  CallableOperationsApi(this._functions);
  final FirebaseFunctions _functions;

  static const Duration timeout = Duration(seconds: 30);

  Future<Result<Map<String, dynamic>>> _call(String name, Map<String, Object?> data) async {
    try {
      final result = await _functions
          .httpsCallable(name, options: HttpsCallableOptions(timeout: timeout))
          .call<Object?>(data);
      final raw = result.data;
      return Success(raw is Map ? raw.map((k, v) => MapEntry(k.toString(), v)) : <String, dynamic>{});
    } catch (e) {
      return Failure(ErrorMapper.map(e));
    }
  }

  Future<Result<String>> _id(String name, Map<String, Object?> data, String field) async =>
      (await _call(name, data)).when(success: (d) => Success(d[field] as String), failure: Failure.new);

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await _call(name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  static Map<String, Object?> _link(CustomerLink link) => switch (link) {
        NoCustomer() => {'customerId': null},
        ExistingCustomer(:final customerId) => {'customerId': customerId},
        NewCustomer(:final input) => {'newCustomer': input.toJson()},
      };

  @override
  Future<Result<String>> createCustomer(CustomerInput input) => _id('createCustomer', input.toJson(), 'customerId');

  @override
  Future<Result<void>> updateCustomer(String customerId, CustomerInput changes, {String? status, String? reason}) =>
      _done('updateCustomer', {
        'customerId': customerId,
        ...changes.toJson(),
        'status': ?status,
        'reason': ?reason,
      });

  @override
  Future<Result<String>> createVehicle(VehicleInput input, CustomerLink customer) =>
      _id('createVehicle', {...input.toJson(), ..._link(customer)}, 'vehicleId');

  @override
  Future<Result<void>> updateVehicle(String vehicleId, VehicleInput changes,
          {CustomerLink? customer, bool clearYear = false, String? status, String? reason}) =>
      _done('updateVehicle', {
        'vehicleId': vehicleId,
        ...changes.toJson(),
        if (clearYear) 'year': null,
        if (customer != null) ..._link(customer),
        'status': ?status,
        'reason': ?reason,
      });

  @override
  Future<Result<String>> createService(ServiceInput input) => _id('createService', input.toJson(), 'serviceId');

  @override
  Future<Result<void>> updateService(String serviceId, ServiceInput changes, {String? reason}) =>
      _done('updateService', {'serviceId': serviceId, ...changes.toJson(), 'reason': ?reason});

  @override
  Future<Result<String>> createServiceIntake(String vehicleId, List<String> serviceIds, {String? notes}) =>
      _id('createServiceIntake', {'vehicleId': vehicleId, 'serviceIds': serviceIds, 'notes': ?notes},
          'intakeId');

  @override
  Future<Result<void>> updateServiceIntake(String intakeId, {List<String>? serviceIds, String? status, String? reason}) =>
      _done('updateServiceIntake', {
        'intakeId': intakeId,
        'serviceIds': ?serviceIds,
        'status': ?status,
        'reason': ?reason,
      });
}
