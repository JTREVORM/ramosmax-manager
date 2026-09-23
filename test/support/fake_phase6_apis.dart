import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/payroll/data/workforce_api.dart';
import 'package:ramosmax_auto_manager/models/attendance.dart';
import 'package:ramosmax_auto_manager/models/payroll.dart';

/// Records calls instead of calling Cloud Functions. Server behaviour is
/// tested against the emulator in functions/test/{attendance,allowances,
/// payroll,losses}.test.js.
class FakeWorkforceApi implements WorkforceApi {
  final List<(String, Map<String, Object?>)> calls = [];
  AppFailure? nextFailure;

  Result<T> _respond<T>(String name, Map<String, Object?> args, T value) {
    calls.add((name, args));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(value);
  }

  @override
  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason}) async =>
      _respond<void>('updatePolicy', {...changes, 'reason': reason}, null);

  @override
  Future<Result<String>> clockIn() async => _respond('clockIn', {}, 'att-new');

  @override
  Future<Result<void>> clockOut({String? attendanceId, DateTime? at}) async =>
      _respond<void>('clockOut', {'attendanceId': attendanceId}, null);

  @override
  Future<Result<String>> recordAttendance(AttendanceEntry entry) async => _respond('recordAttendance', entry.toJson(), 'att-new');

  @override
  Future<Result<void>> verifyAttendance(List<String> attendanceIds, {required bool approve, String? reason, String? notes}) async =>
      _respond<void>('verifyAttendance', {'ids': attendanceIds, 'approve': approve, 'reason': reason}, null);

  @override
  Future<Result<void>> correctAttendance(String attendanceId,
          {required String reason, ArrivalEntry? arrival, DateTime? clockInAt, DateTime? clockOutAt, bool clearClockOut = false, String? notes}) async =>
      _respond<void>('correctAttendance', {'id': attendanceId, 'reason': reason, 'arrival': arrival?.key, 'clockInAt': clockInAt}, null);

  @override
  Future<Result<({int created, List<String> skipped})>> calculateAllowances(DateTime day) async =>
      _respond('calculateAllowances', {'day': day}, (created: 2, skipped: ['Wash Two: not_eligible']));

  @override
  Future<Result<void>> reviewAllowances(List<String> allowanceIds, AllowanceDecision decision, {Money? deduction, String? reason}) async =>
      _respond<void>('reviewAllowances', {'ids': allowanceIds, 'decision': decision.key, 'deduction': deduction?.ugx, 'reason': reason}, null);

  @override
  Future<Result<void>> payAllowances(List<String> allowanceIds, {required String accountId, required String requestId, String? reference}) async =>
      _respond<void>('payAllowances', {'ids': allowanceIds, 'accountId': accountId, 'requestId': requestId}, null);

  @override
  Future<Result<void>> reverseAllowancePayment(String transactionId, {required String reason}) async =>
      _respond<void>('reverseAllowancePayment', {'transactionId': transactionId, 'reason': reason}, null);

  @override
  Future<Result<void>> cancelAllowances(List<String> allowanceIds, {required String reason}) async =>
      _respond<void>('cancelAllowances', {'ids': allowanceIds, 'reason': reason}, null);

  @override
  Future<Result<void>> setSalary(SalaryDraft draft) async => _respond<void>('setSalary', draft.toJson(), null);

  @override
  Future<Result<String>> createPayroll({required int year, required int month}) async =>
      _respond('createPayroll', {'year': year, 'month': month}, 'pay-new');

  @override
  Future<Result<void>> preparePayroll(String payrollId) async => _respond<void>('preparePayroll', {'id': payrollId}, null);

  @override
  Future<Result<void>> correctPayroll(String payrollId, {required String reason}) async =>
      _respond<void>('correctPayroll', {'id': payrollId, 'reason': reason}, null);

  @override
  Future<Result<void>> addEarning(String payrollId, {required String staffUid, required String description, required Money amount, required String reason}) async =>
      _respond<void>('addEarning', {'id': payrollId, 'staffUid': staffUid, 'amount': amount.ugx, 'reason': reason}, null);

  @override
  Future<Result<void>> removeEarning(String payrollId, String entryId, {required String reason}) async =>
      _respond<void>('removeEarning', {'id': payrollId, 'entryId': entryId}, null);

  @override
  Future<Result<void>> payrollAction(String payrollId, PayrollAction action, {String? reason, String? notes}) async =>
      _respond<void>('payrollAction', {'id': payrollId, 'action': action.key, 'reason': reason}, null);

  @override
  Future<Result<void>> payPayroll(String payrollId, {required String accountId, required String requestId, String? reference}) async =>
      _respond<void>('payPayroll', {'id': payrollId, 'accountId': accountId, 'requestId': requestId}, null);

  @override
  Future<Result<void>> reversePayrollPayment(String payrollId, {required String reason}) async =>
      _respond<void>('reversePayrollPayment', {'id': payrollId, 'reason': reason}, null);

  @override
  Future<Result<void>> lockPayroll(String payrollId) async => _respond<void>('lockPayroll', {'id': payrollId}, null);

  @override
  Future<Result<void>> cancelPayroll(String payrollId, {required String reason}) async =>
      _respond<void>('cancelPayroll', {'id': payrollId, 'reason': reason}, null);

  @override
  Future<Result<String>> reportLoss({
    required LossType type,
    required Money amount,
    required String description,
    required DateTime incidentDate,
    required String requestId,
    String? staffUid,
    String? notes,
    String? attachmentPath,
  }) async =>
      _respond('reportLoss', {'type': type.key, 'amount': amount.ugx, 'description': description, 'staffUid': staffUid, 'requestId': requestId}, 'loss-new');

  @override
  Future<Result<void>> reviewLoss(String incidentId, {String? notes}) async => _respond<void>('reviewLoss', {'id': incidentId}, null);

  @override
  Future<Result<void>> decideLoss(String incidentId, {required bool approve, required String reason, Money? recovery}) async =>
      _respond<void>('decideLoss', {'id': incidentId, 'approve': approve, 'recovery': recovery?.ugx, 'reason': reason}, null);

  @override
  Future<Result<void>> scheduleRecovery(String incidentId, {required Money instalment, required DateTime startDate, String? reason}) async =>
      _respond<void>('scheduleRecovery', {'id': incidentId, 'instalment': instalment.ugx}, null);

  @override
  Future<Result<void>> cancelLoss(String incidentId, {required String reason}) async =>
      _respond<void>('cancelLoss', {'id': incidentId, 'reason': reason}, null);

  @override
  Future<Result<void>> createDeduction({
    required String staffUid,
    required DeductionType type,
    required Money total,
    required Money instalment,
    required String reason,
    required String reference,
    required DateTime startDate,
    required String requestId,
  }) async =>
      _respond<void>('createDeduction', {'staffUid': staffUid, 'type': type.key, 'total': total.ugx, 'instalment': instalment.ugx}, null);

  @override
  Future<Result<void>> decideDeduction(String deductionId, {required bool approve, String? reason}) async =>
      _respond<void>('decideDeduction', {'id': deductionId, 'approve': approve}, null);

  @override
  Future<Result<void>> cancelDeduction(String deductionId, {required String reason}) async =>
      _respond<void>('cancelDeduction', {'id': deductionId, 'reason': reason}, null);
}
