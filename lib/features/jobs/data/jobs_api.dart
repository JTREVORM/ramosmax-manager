import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/services/callables.dart';
import '../../../models/work_order.dart';

/// Worker-order commands. Each is a Cloud Function (functions/src/jobs.js)
/// that re-checks the caller's permission, enforces the status flow and
/// audits in one transaction. The rules deny every client write.
abstract class JobsApi {
  Future<Result<void>> assign(String workerOrderId, String workerId, {String? notes});
  Future<Result<void>> reassign(String workerOrderId, String workerId, {required String reason});
  Future<Result<void>> cancelOrder(String workerOrderId, {required String reason});
  Future<Result<void>> updateStatus(String workerOrderId, WorkerAction action, {String? reason, String? completionNotes});
}

class CallableJobsApi implements JobsApi {
  CallableJobsApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await callFunction(_functions, name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<void>> assign(String workerOrderId, String workerId, {String? notes}) =>
      _done('assignWorkerOrder', {'workerOrderId': workerOrderId, 'workerId': workerId, 'notes': ?notes});

  @override
  Future<Result<void>> reassign(String workerOrderId, String workerId, {required String reason}) =>
      _done('reassignWorkerOrder', {'workerOrderId': workerOrderId, 'workerId': workerId, 'reason': reason});

  @override
  Future<Result<void>> cancelOrder(String workerOrderId, {required String reason}) =>
      _done('cancelWorkerOrder', {'workerOrderId': workerOrderId, 'reason': reason});

  @override
  Future<Result<void>> updateStatus(String workerOrderId, WorkerAction action, {String? reason, String? completionNotes}) =>
      _done('updateWorkerOrderStatus', {
        'workerOrderId': workerOrderId,
        'action': action.key,
        'reason': ?reason,
        'completionNotes': ?completionNotes,
      });
}
