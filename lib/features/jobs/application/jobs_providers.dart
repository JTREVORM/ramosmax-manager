import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../models/app_user.dart';
import '../../../models/service_intake.dart';
import '../../../models/work_order.dart';
import '../data/jobs_api.dart';
import '../data/jobs_repository.dart';

final jobsRepositoryProvider = Provider<JobsRepository>((ref) => JobsRepository(ref.watch(firestoreProvider)));

final jobsApiProvider = Provider<JobsApi>((ref) => CallableJobsApi(ref.watch(firebaseFunctionsProvider)));

final jobOrdersProvider = StreamProvider.family<List<WorkOrder>, String>(
    (ref, intakeId) => ref.watch(jobsRepositoryProvider).watchOrdersOf(intakeId));

/// The signed-in worker's own orders (rules: workerId == uid).
final myOrdersProvider = StreamProvider.family<List<WorkOrder>, String>(
    (ref, uid) => ref.watch(jobsRepositoryProvider).watchOrdersFor(uid));

final workOrderProvider = StreamProvider.family<WorkOrder?, String>(
    (ref, id) => ref.watch(jobsRepositoryProvider).watchOrder(id));

final assignableWorkersProvider = FutureProvider.autoDispose<List<AppUser>>((ref) {
  final now = ref.read(clockProvider).value ?? DateTime.now();
  return ref.watch(jobsRepositoryProvider).assignableWorkers(now);
});

/// Filter for the manager's Jobs screen.
enum JobFilter {
  open('Open', IntakeStatus.open),
  completed('Completed', IntakeStatus.completed),
  cancelled('Cancelled', IntakeStatus.cancelled),
  all('All', null);

  const JobFilter(this.label, this.status);
  final String label;
  final IntakeStatus? status;
}

/// Client-side search within the loaded jobs: plate, job number or worker.
bool jobMatches(ServiceIntake job, String query) {
  final q = query.trim().toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  if (q.isEmpty) return true;
  String norm(String? s) => (s ?? '').toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  return norm(job.numberPlate).contains(q) ||
      norm(job.jobNumber).contains(q) ||
      job.orders.any((o) => norm(o.workerName).contains(q));
}

final jobsActionsProvider = Provider<JobsActions>(JobsActions.new);

/// Assignment and worker status commands. Online-only.
class JobsActions {
  JobsActions(this._ref);
  final Ref _ref;

  JobsApi get _api => _ref.read(jobsApiProvider);

  Future<Result<void>> assign(String orderId, String workerId, {String? notes}) =>
      runOnline(_ref, () => _api.assign(orderId, workerId, notes: notes), event: AnalyticsEvents.workOrderAssigned);

  Future<Result<void>> reassign(String orderId, String workerId, {required String reason}) =>
      runOnline(_ref, () => _api.reassign(orderId, workerId, reason: reason),
          event: AnalyticsEvents.workOrderAssigned, params: {'outcome': 'reassigned'});

  Future<Result<void>> cancelOrder(String orderId, {required String reason}) =>
      runOnline(_ref, () => _api.cancelOrder(orderId, reason: reason),
          event: AnalyticsEvents.workOrderUpdated, params: {'outcome': 'cancelled'});

  Future<Result<void>> act(String orderId, WorkerAction action, {String? reason, String? completionNotes}) =>
      runOnline(_ref, () => _api.updateStatus(orderId, action, reason: reason, completionNotes: completionNotes),
          event: AnalyticsEvents.workOrderUpdated, params: {'outcome': action.key});
}
