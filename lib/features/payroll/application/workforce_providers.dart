import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../models/attendance.dart';
import '../../../models/payroll.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../data/workforce_api.dart';
import '../data/workforce_repository.dart';

final workforceRepositoryProvider = Provider<WorkforceRepository>((ref) => WorkforceRepository(ref.watch(firestoreProvider)));

final workforceApiProvider = Provider<WorkforceApi>((ref) => CallableWorkforceApi(ref.watch(firebaseFunctionsProvider)));

final workforcePolicyProvider = StreamProvider<WorkforcePolicy>((ref) => ref.watch(workforceRepositoryProvider).watchPolicy());

// --- attendance ---

final attendanceDayProvider =
    StreamProvider.family<List<AttendanceRecord>, String>((ref, dayKey) => ref.watch(workforceRepositoryProvider).watchDay(dayKey));

final pendingAttendanceProvider =
    StreamProvider<List<AttendanceRecord>>((ref) => ref.watch(workforceRepositoryProvider).watchPendingAttendance());

final staffAttendanceProvider = StreamProvider.family<List<AttendanceRecord>, String>(
    (ref, staffUid) => ref.watch(workforceRepositoryProvider).watchStaffAttendance(staffUid));

/// The signed-in person's own attendance.
final myAttendanceProvider = StreamProvider<List<AttendanceRecord>>((ref) {
  final uid = ref.watch(currentUserProvider)?.uid;
  if (uid == null) return const Stream.empty();
  return ref.watch(workforceRepositoryProvider).watchStaffAttendance(uid);
});

/// Today's own record (EAT), if any.
final myTodayAttendanceProvider = Provider<AsyncValue<AttendanceRecord?>>((ref) {
  final now = ref.watch(clockProvider).value ?? DateTime.now();
  final today = EastAfricaTime.businessDayKey(now);
  return ref.watch(myAttendanceProvider).whenData((list) => list.where((a) => a.dayKey == today).firstOrNull);
});

final attendanceProvider =
    StreamProvider.family<AttendanceRecord?, String>((ref, id) => ref.watch(workforceRepositoryProvider).watchAttendance(id));

final attendanceCorrectionsProvider = StreamProvider.family<List<AttendanceCorrection>, ({String attendanceId, String? staffUid})>(
    (ref, k) => ref.watch(workforceRepositoryProvider).watchCorrections(k.attendanceId, staffUid: k.staffUid));

// --- allowances ---

final allowancesByStatusProvider = StreamProvider.family<List<WorkerAllowance>, AllowanceStatus>(
    (ref, status) => ref.watch(workforceRepositoryProvider).watchAllowances(status));

/// Allowances waiting for a decision (calculated + pending approval).
final allowancesToDecideProvider = Provider<AsyncValue<List<WorkerAllowance>>>((ref) {
  final a = ref.watch(allowancesByStatusProvider(AllowanceStatus.calculated));
  final b = ref.watch(allowancesByStatusProvider(AllowanceStatus.pendingApproval));
  if (a is AsyncError) return a;
  if (b is AsyncError) return b;
  if (!a.hasValue || !b.hasValue) return const AsyncLoading();
  return AsyncData([...b.value!, ...a.value!]);
});

final staffAllowancesProvider = StreamProvider.family<List<WorkerAllowance>, String>(
    (ref, staffUid) => ref.watch(workforceRepositoryProvider).watchStaffAllowances(staffUid));

final myAllowancesProvider = StreamProvider<List<WorkerAllowance>>((ref) {
  final uid = ref.watch(currentUserProvider)?.uid;
  if (uid == null) return const Stream.empty();
  return ref.watch(workforceRepositoryProvider).watchStaffAllowances(uid);
});

// --- salary and payroll ---

final salaryProfilesProvider = StreamProvider<List<SalaryVersion>>((ref) => ref.watch(workforceRepositoryProvider).watchSalaryProfiles());

final salaryProfileProvider =
    StreamProvider.family<SalaryVersion?, String>((ref, staffUid) => ref.watch(workforceRepositoryProvider).watchSalaryProfile(staffUid));

final salaryHistoryProvider =
    StreamProvider.family<List<SalaryVersion>, String>((ref, staffUid) => ref.watch(workforceRepositoryProvider).watchSalaryHistory(staffUid));

final payrollsProvider = StreamProvider<List<PayrollRun>>((ref) => ref.watch(workforceRepositoryProvider).watchPayrolls());

final payrollProvider = StreamProvider.family<PayrollRun?, String>((ref, id) => ref.watch(workforceRepositoryProvider).watchPayroll(id));

final payrollItemsProvider =
    StreamProvider.family<List<PayrollItem>, String>((ref, id) => ref.watch(workforceRepositoryProvider).watchPayrollItems(id));

final myPayslipsProvider = StreamProvider<List<PayrollItem>>((ref) {
  final uid = ref.watch(currentUserProvider)?.uid;
  if (uid == null) return const Stream.empty();
  return ref.watch(workforceRepositoryProvider).watchPayslips(uid);
});

final mySalaryProvider = StreamProvider<SalaryVersion?>((ref) {
  final uid = ref.watch(currentUserProvider)?.uid;
  if (uid == null) return const Stream.empty();
  return ref.watch(workforceRepositoryProvider).watchSalaryProfile(uid);
});

// --- deductions and losses ---

final deductionsProvider = StreamProvider.family<List<SalaryDeduction>, DeductionStatus?>(
    (ref, status) => ref.watch(workforceRepositoryProvider).watchDeductions(status: status));

final deductionProvider =
    StreamProvider.family<SalaryDeduction?, String>((ref, id) => ref.watch(workforceRepositoryProvider).watchDeduction(id));

final myDeductionsProvider = StreamProvider<List<SalaryDeduction>>((ref) {
  final uid = ref.watch(currentUserProvider)?.uid;
  if (uid == null) return const Stream.empty();
  return ref.watch(workforceRepositoryProvider).watchStaffDeductions(uid);
});

final lossesProvider =
    StreamProvider.family<List<LossIncident>, LossStatus?>((ref, status) => ref.watch(workforceRepositoryProvider).watchLosses(status: status));

final lossProvider = StreamProvider.family<LossIncident?, String>((ref, id) => ref.watch(workforceRepositoryProvider).watchLoss(id));

final myLossesProvider = StreamProvider<List<LossIncident>>((ref) {
  final uid = ref.watch(currentUserProvider)?.uid;
  if (uid == null) return const Stream.empty();
  return ref.watch(workforceRepositoryProvider).watchStaffLosses(uid);
});

/// Totals for dashboards and lists (from server-written figures only).
abstract final class AllowanceTotals {
  static Money of(Iterable<WorkerAllowance> list) => Money.sum(list.map((a) => a.amount));
}

final workforceActionsProvider = Provider<WorkforceActions>(WorkforceActions.new);

/// Phase 6 commands. Online-only: approvals, allowances, salaries, payroll,
/// loss decisions and payments are never queued offline.
class WorkforceActions {
  WorkforceActions(this._ref);
  final Ref _ref;

  WorkforceApi get _api => _ref.read(workforceApiProvider);

  Future<Result<T>> _run<T>(String event, String outcome, Future<Result<T>> Function() action) =>
      runOnline(_ref, action, event: event, params: {'outcome': outcome});

  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason}) =>
      _run(AnalyticsEvents.payrollAction, 'policy_updated', () => _api.updatePolicy(changes, reason: reason));

  // attendance
  Future<Result<String>> clockIn() => _run(AnalyticsEvents.attendanceAction, 'clock_in', _api.clockIn);
  Future<Result<void>> clockOut({String? attendanceId, DateTime? at}) =>
      _run(AnalyticsEvents.attendanceAction, 'clock_out', () => _api.clockOut(attendanceId: attendanceId, at: at));
  Future<Result<String>> recordAttendance(AttendanceEntry entry) =>
      _run(AnalyticsEvents.attendanceAction, 'recorded', () => _api.recordAttendance(entry));
  Future<Result<void>> verifyAttendance(List<String> ids, {required bool approve, String? reason, String? notes}) =>
      _run(AnalyticsEvents.attendanceAction, approve ? 'approved' : 'rejected',
          () => _api.verifyAttendance(ids, approve: approve, reason: reason, notes: notes));
  Future<Result<void>> correctAttendance(String id,
          {required String reason, ArrivalEntry? arrival, DateTime? clockInAt, DateTime? clockOutAt, bool clearClockOut = false, String? notes}) =>
      _run(AnalyticsEvents.attendanceAction, 'corrected', () => _api.correctAttendance(id,
          reason: reason, arrival: arrival, clockInAt: clockInAt, clockOutAt: clockOutAt, clearClockOut: clearClockOut, notes: notes));

  // allowances
  Future<Result<({int created, List<String> skipped})>> calculateAllowances(DateTime day) =>
      _run(AnalyticsEvents.allowanceAction, 'calculated', () => _api.calculateAllowances(day));
  Future<Result<void>> reviewAllowances(List<String> ids, AllowanceDecision decision, {Money? deduction, String? reason}) =>
      _run(AnalyticsEvents.allowanceAction, decision.key, () => _api.reviewAllowances(ids, decision, deduction: deduction, reason: reason));
  Future<Result<void>> payAllowances(List<String> ids, {required String accountId, required String requestId, String? reference}) =>
      _run(AnalyticsEvents.allowanceAction, 'paid', () => _api.payAllowances(ids, accountId: accountId, requestId: requestId, reference: reference));
  Future<Result<void>> reverseAllowancePayment(String transactionId, {required String reason}) =>
      _run(AnalyticsEvents.allowanceAction, 'payment_reversed', () => _api.reverseAllowancePayment(transactionId, reason: reason));
  Future<Result<void>> cancelAllowances(List<String> ids, {required String reason}) =>
      _run(AnalyticsEvents.allowanceAction, 'cancelled', () => _api.cancelAllowances(ids, reason: reason));

  // salary and payroll
  Future<Result<void>> setSalary(SalaryDraft draft) => _run(AnalyticsEvents.payrollAction, 'salary_set', () => _api.setSalary(draft));
  Future<Result<String>> createPayroll({required int year, required int month}) =>
      _run(AnalyticsEvents.payrollAction, 'created', () => _api.createPayroll(year: year, month: month));
  Future<Result<void>> preparePayroll(String id) => _run(AnalyticsEvents.payrollAction, 'prepared', () => _api.preparePayroll(id));
  Future<Result<void>> correctPayroll(String id, {required String reason}) =>
      _run(AnalyticsEvents.payrollAction, 'corrected', () => _api.correctPayroll(id, reason: reason));
  Future<Result<void>> addEarning(String id, {required String staffUid, required String description, required Money amount, required String reason}) =>
      _run(AnalyticsEvents.payrollAction, 'earning_added',
          () => _api.addEarning(id, staffUid: staffUid, description: description, amount: amount, reason: reason));
  Future<Result<void>> removeEarning(String id, String entryId, {required String reason}) =>
      _run(AnalyticsEvents.payrollAction, 'earning_removed', () => _api.removeEarning(id, entryId, reason: reason));
  Future<Result<void>> payrollAction(String id, PayrollAction action, {String? reason, String? notes}) =>
      _run(AnalyticsEvents.payrollAction, action.key, () => _api.payrollAction(id, action, reason: reason, notes: notes));
  Future<Result<void>> payPayroll(String id, {required String accountId, required String requestId, String? reference}) =>
      _run(AnalyticsEvents.payrollAction, 'paid', () => _api.payPayroll(id, accountId: accountId, requestId: requestId, reference: reference));
  Future<Result<void>> reversePayrollPayment(String id, {required String reason}) =>
      _run(AnalyticsEvents.payrollAction, 'payment_reversed', () => _api.reversePayrollPayment(id, reason: reason));
  Future<Result<void>> lockPayroll(String id) => _run(AnalyticsEvents.payrollAction, 'locked', () => _api.lockPayroll(id));
  Future<Result<void>> cancelPayroll(String id, {required String reason}) =>
      _run(AnalyticsEvents.payrollAction, 'cancelled', () => _api.cancelPayroll(id, reason: reason));

  // losses and deductions
  Future<Result<String>> reportLoss({
    required LossType type,
    required Money amount,
    required String description,
    required DateTime incidentDate,
    required String requestId,
    String? staffUid,
    String? notes,
    String? attachmentPath,
  }) =>
      _run(AnalyticsEvents.lossAction, 'reported', () => _api.reportLoss(
            type: type, amount: amount, description: description, incidentDate: incidentDate, requestId: requestId,
            staffUid: staffUid, notes: notes, attachmentPath: attachmentPath));
  Future<Result<void>> reviewLoss(String id, {String? notes}) => _run(AnalyticsEvents.lossAction, 'reviewed', () => _api.reviewLoss(id, notes: notes));
  Future<Result<void>> decideLoss(String id, {required bool approve, required String reason, Money? recovery}) =>
      _run(AnalyticsEvents.lossAction, approve ? 'approved' : 'rejected', () => _api.decideLoss(id, approve: approve, reason: reason, recovery: recovery));
  Future<Result<void>> scheduleRecovery(String id, {required Money instalment, required DateTime startDate, String? reason}) =>
      _run(AnalyticsEvents.lossAction, 'scheduled', () => _api.scheduleRecovery(id, instalment: instalment, startDate: startDate, reason: reason));
  Future<Result<void>> cancelLoss(String id, {required String reason}) =>
      _run(AnalyticsEvents.lossAction, 'cancelled', () => _api.cancelLoss(id, reason: reason));
  Future<Result<void>> createDeduction({
    required String staffUid,
    required DeductionType type,
    required Money total,
    required Money instalment,
    required String reason,
    required String reference,
    required DateTime startDate,
    required String requestId,
  }) =>
      _run(AnalyticsEvents.payrollAction, 'deduction_created', () => _api.createDeduction(
            staffUid: staffUid, type: type, total: total, instalment: instalment, reason: reason, reference: reference,
            startDate: startDate, requestId: requestId));
  Future<Result<void>> decideDeduction(String id, {required bool approve, String? reason}) =>
      _run(AnalyticsEvents.payrollAction, approve ? 'deduction_approved' : 'deduction_rejected',
          () => _api.decideDeduction(id, approve: approve, reason: reason));
  Future<Result<void>> cancelDeduction(String id, {required String reason}) =>
      _run(AnalyticsEvents.payrollAction, 'deduction_cancelled', () => _api.cancelDeduction(id, reason: reason));
}
