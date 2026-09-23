import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/features/operations/data/operations_api.dart';

/// Records operations calls instead of calling Cloud Functions. The server
/// behaviour itself is tested in functions/test/operations.test.js.
class FakeOperationsApi implements OperationsApi {
  final List<(String, Map<String, Object?>)> calls = [];
  AppFailure? nextFailure;

  Iterable<String> get names => calls.map((c) => c.$1);

  Result<T> _respond<T>(String name, Map<String, Object?> args, T value) {
    calls.add((name, args));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(value);
  }

  static Map<String, Object?> link(CustomerLink c) => switch (c) {
        NoCustomer() => {'customer': 'none'},
        ExistingCustomer(:final customerId) => {'customerId': customerId},
        NewCustomer(:final input) => {'newCustomer': input.toJson()},
      };

  @override
  Future<Result<String>> createCustomer(CustomerInput input) async => _respond('createCustomer', input.toJson(), 'new-customer');

  @override
  Future<Result<void>> updateCustomer(String customerId, CustomerInput changes, {String? status, String? reason}) async =>
      _respond<void>('updateCustomer', {'customerId': customerId, ...changes.toJson(), 'status': status, 'reason': reason}, null);

  @override
  Future<Result<String>> createVehicle(VehicleInput input, CustomerLink customer) async =>
      _respond('createVehicle', {...input.toJson(), ...link(customer)}, 'new-vehicle');

  @override
  Future<Result<void>> updateVehicle(String vehicleId, VehicleInput changes,
          {CustomerLink? customer, bool clearYear = false, String? status, String? reason}) async =>
      _respond<void>('updateVehicle', {
        'vehicleId': vehicleId, ...changes.toJson(), if (customer != null) ...link(customer), 'status': status, 'reason': reason,
      }, null);

  @override
  Future<Result<String>> createService(ServiceInput input) async => _respond('createService', input.toJson(), 'new-service');

  @override
  Future<Result<void>> updateService(String serviceId, ServiceInput changes, {String? reason}) async =>
      _respond<void>('updateService', {'serviceId': serviceId, ...changes.toJson(), 'reason': reason}, null);

  @override
  Future<Result<String>> createServiceIntake(String vehicleId, List<String> serviceIds, {String? notes}) async =>
      _respond('createServiceIntake', {'vehicleId': vehicleId, 'serviceIds': serviceIds, 'notes': notes}, 'new-intake');

  @override
  Future<Result<void>> updateServiceIntake(String intakeId, {List<String>? serviceIds, String? status, String? reason}) async =>
      _respond<void>('updateServiceIntake', {'intakeId': intakeId, 'serviceIds': serviceIds, 'status': status, 'reason': reason}, null);
}
