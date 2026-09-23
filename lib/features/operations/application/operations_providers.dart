import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../models/catalog_service.dart';
import '../../../models/customer.dart';
import '../../../models/service_intake.dart';
import '../../../models/vehicle.dart';
import '../data/operations_api.dart';
import '../data/operations_repository.dart';

final operationsRepositoryProvider =
    Provider<OperationsRepository>((ref) => OperationsRepository(ref.watch(firestoreProvider)));

final operationsApiProvider =
    Provider<OperationsApi>((ref) => CallableOperationsApi(ref.watch(firebaseFunctionsProvider)));

final vehicleProvider = StreamProvider.family<Vehicle?, String>(
    (ref, id) => ref.watch(operationsRepositoryProvider).watchVehicle(id));

final customerProvider = StreamProvider.family<Customer?, String>(
    (ref, id) => ref.watch(operationsRepositoryProvider).watchCustomer(id));

final customerVehiclesProvider = StreamProvider.family<List<Vehicle>, String>(
    (ref, customerId) => ref.watch(operationsRepositoryProvider).watchVehiclesOf(customerId));

/// The whole catalogue (small reference data, cached for offline use).
final servicesProvider =
    StreamProvider<List<CatalogService>>((ref) => ref.watch(operationsRepositoryProvider).watchServices());

final intakesProvider = StreamProvider.family<List<ServiceIntake>, IntakeStatus?>(
    (ref, status) => ref.watch(operationsRepositoryProvider).watchIntakes(status: status));

final vehicleIntakesProvider = StreamProvider.family<List<ServiceIntake>, String>(
    (ref, vehicleId) => ref.watch(operationsRepositoryProvider).watchIntakesFor(vehicleId: vehicleId));

final customerIntakesProvider = StreamProvider.family<List<ServiceIntake>, String>(
    (ref, customerId) => ref.watch(operationsRepositoryProvider).watchIntakesFor(customerId: customerId));

final intakeProvider = StreamProvider.family<ServiceIntake?, String>(
    (ref, id) => ref.watch(operationsRepositoryProvider).watchIntake(id));

/// Customer / vehicle / service / intake commands.
///
/// All are online-only: they need the server to guarantee unique plates,
/// valid references and whole-shilling prices, and to write the audit trail.
/// Nothing is queued offline; the person is told to reconnect instead.
final operationsActionsProvider = Provider<OperationsActions>(OperationsActions.new);

class OperationsActions {
  OperationsActions(this._ref);
  final Ref _ref;

  OperationsApi get _api => _ref.read(operationsApiProvider);

  static const offline = AppFailure(
    FailureKind.network,
    'This needs an internet connection. Connect and try again — saved information is still viewable offline.',
    code: 'offline',
    retryable: true,
  );

  Future<Result<T>> _online<T>(Future<Result<T>> Function() action, {String? event}) async {
    try {
      await _ref.read(connectivityServiceProvider).ensureOnline();
    } catch (_) {
      return const Failure(offline);
    }
    final result = await action();
    if (result is Success<T> && event != null) {
      try {
        await _ref.read(analyticsProvider).logEvent(event);
      } catch (_) {}
    }
    return result;
  }

  Future<Result<String>> createCustomer(CustomerInput input) =>
      _online(() => _api.createCustomer(input), event: AnalyticsEvents.customerCreated);

  Future<Result<void>> updateCustomer(String id, CustomerInput changes, {String? status, String? reason}) =>
      _online(() => _api.updateCustomer(id, changes, status: status, reason: reason));

  Future<Result<String>> createVehicle(VehicleInput input, CustomerLink customer) =>
      _online(() => _api.createVehicle(input, customer), event: AnalyticsEvents.vehicleRegistered);

  Future<Result<void>> updateVehicle(String id, VehicleInput changes,
          {CustomerLink? customer, bool clearYear = false, String? status, String? reason}) =>
      _online(() => _api.updateVehicle(id, changes, customer: customer, clearYear: clearYear, status: status, reason: reason));

  Future<Result<String>> createService(ServiceInput input) =>
      _online(() => _api.createService(input), event: AnalyticsEvents.serviceSaved);

  Future<Result<void>> updateService(String id, ServiceInput changes, {String? reason}) =>
      _online(() => _api.updateService(id, changes, reason: reason), event: AnalyticsEvents.serviceSaved);

  Future<Result<String>> createServiceIntake(String vehicleId, List<String> serviceIds, {String? notes}) =>
      _online(() => _api.createServiceIntake(vehicleId, serviceIds, notes: notes),
          event: AnalyticsEvents.serviceIntakeCreated);

  Future<Result<void>> updateServiceIntake(String id, {List<String>? serviceIds, String? status, String? reason}) =>
      _online(() => _api.updateServiceIntake(id, serviceIds: serviceIds, status: status, reason: reason));

  Future<void> logSearch({required bool found}) async {
    try {
      await _ref.read(analyticsProvider).logEvent(AnalyticsEvents.vehicleSearched, {'outcome': found ? 'found' : 'not_found'});
    } catch (_) {}
  }
}
