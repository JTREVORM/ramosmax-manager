import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../models/attendance.dart';
import '../../../models/payroll.dart';

/// A manager's attendance entry for someone else. Times are UTC instants.
class AttendanceEntry {
  const AttendanceEntry({required this.staffUid, required this.date, required this.arrival, this.clockInAt, this.clockOutAt, this.notes});
  final String staffUid;
  final DateTime date;
  final ArrivalEntry arrival;
  final DateTime? clockInAt;
  final DateTime? clockOutAt;
  final String? notes;

  Map<String, Object?> toJson() => {
        'staffUid': staffUid,
        'date': date.millisecondsSinceEpoch,
        'arrival': arrival.key,
        'clockInAt': ?clockInAt?.millisecondsSinceEpoch,
        'clockOutAt': ?clockOutAt?.millisecondsSinceEpoch,
        'notes': ?notes,
      };
}

/// What someone entered for a salary change. The server validates it and
/// writes a new, effective-dated version.
class SalaryDraft {
  const SalaryDraft({
    required this.staffUid,
    required this.basicSalary,
    required this.frequency,
    required this.allowanceEligible,
    required this.effectiveFrom,
    this.allowanceAmount,
    this.active = true,
    this.notes,
    this.reason,
  });

  final String staffUid;
  final Money basicSalary;
  final PaymentFrequency frequency;
  final bool allowanceEligible;
  final Money? allowanceAmount;
  final DateTime effectiveFrom;
  final bool active;
  final String? notes;
  final String? reason;

  Map<String, Object?> toJson() => {
        'staffUid': staffUid,
        'basicSalaryUgx': basicSalary.ugx,
        'paymentFrequency': frequency.key,
        'allowanceEligible': allowanceEligible,
        'allowanceAmountUgx': allowanceAmount?.ugx,
        'effectiveFrom': effectiveFrom.millisecondsSinceEpoch,
        'active': active,
        'notes': ?notes,
        'reason': ?reason,
      };
}

/// Phase 6 commands — Cloud Functions in functions/src/{workforce,attendance,
/// allowances,payroll,losses}.js. Every amount and status is decided there.
abstract class WorkforceApi {
  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason});

  Future<Result<String>> clockIn();
  Future<Result<void>> clockOut({String? attendanceId, DateTime? at});
  Future<Result<String>> recordAttendance(AttendanceEntry entry);
  Future<Result<void>> verifyAttendance(List<String> attendanceIds, {required bool approve, String? reason, String? notes});
  Future<Result<void>> correctAttendance(String attendanceId,
      {required String reason, ArrivalEntry? arrival, DateTime? clockInAt, DateTime? clockOutAt, bool clearClockOut, String? notes});

  Future<Result<({int created, List<String> skipped})>> calculateAllowances(DateTime day);
  Future<Result<void>> reviewAllowances(List<String> allowanceIds, AllowanceDecision decision, {Money? deduction, String? reason});
  Future<Result<void>> payAllowances(List<String> allowanceIds, {required String accountId, required String requestId, String? reference});
  Future<Result<void>> reverseAllowancePayment(String transactionId, {required String reason});
  Future<Result<void>> cancelAllowances(List<String> allowanceIds, {required String reason});

  Future<Result<void>> setSalary(SalaryDraft draft);
  Future<Result<String>> createPayroll({required int year, required int month});
  Future<Result<void>> preparePayroll(String payrollId);
  Future<Result<void>> correctPayroll(String payrollId, {required String reason});
  Future<Result<void>> addEarning(String payrollId, {required String staffUid, required String description, required Money amount, required String reason});
  Future<Result<void>> removeEarning(String payrollId, String entryId, {required String reason});
  Future<Result<void>> payrollAction(String payrollId, PayrollAction action, {String? reason, String? notes});
  Future<Result<void>> payPayroll(String payrollId, {required String accountId, required String requestId, String? reference});
  Future<Result<void>> reversePayrollPayment(String payrollId, {required String reason});
  Future<Result<void>> lockPayroll(String payrollId);
  Future<Result<void>> cancelPayroll(String payrollId, {required String reason});

  Future<Result<String>> reportLoss({
    required LossType type,
    required Money amount,
    required String description,
    required DateTime incidentDate,
    required String requestId,
    String? staffUid,
    String? notes,
    String? attachmentPath,
  });
  Future<Result<void>> reviewLoss(String incidentId, {String? notes});
  Future<Result<void>> decideLoss(String incidentId, {required bool approve, required String reason, Money? recovery});
  Future<Result<void>> scheduleRecovery(String incidentId, {required Money instalment, required DateTime startDate, String? reason});
  Future<Result<void>> cancelLoss(String incidentId, {required String reason});
  Future<Result<void>> createDeduction({
    required String staffUid,
    required DeductionType type,
    required Money total,
    required Money instalment,
    required String reason,
    required String reference,
    required DateTime startDate,
    required String requestId,
  });
  Future<Result<void>> decideDeduction(String deductionId, {required bool approve, String? reason});
  Future<Result<void>> cancelDeduction(String deductionId, {required String reason});
}

class CallableWorkforceApi implements WorkforceApi {
  CallableWorkforceApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<Map<String, dynamic>>> _call(String name, Map<String, Object?> data) => callFunction(_functions, name, data);

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await _call(name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<void>> updatePolicy(Map<String, Object?> changes, {required String reason}) =>
      _done('updatePayrollPolicy', {'changes': changes, 'reason': reason});

  @override
  Future<Result<String>> clockIn() async =>
      (await _call('recordAttendance', {})).when(success: (d) => Success(d['attendanceId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> clockOut({String? attendanceId, DateTime? at}) =>
      _done('clockOut', {'attendanceId': ?attendanceId, 'clockOutAt': ?at?.millisecondsSinceEpoch});

  @override
  Future<Result<String>> recordAttendance(AttendanceEntry entry) async =>
      (await _call('recordAttendance', entry.toJson())).when(success: (d) => Success(d['attendanceId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> verifyAttendance(List<String> attendanceIds, {required bool approve, String? reason, String? notes}) =>
      _done('verifyAttendance', {'attendanceIds': attendanceIds, 'action': approve ? 'approve' : 'reject', 'reason': ?reason, 'notes': ?notes});

  @override
  Future<Result<void>> correctAttendance(String attendanceId,
          {required String reason, ArrivalEntry? arrival, DateTime? clockInAt, DateTime? clockOutAt, bool clearClockOut = false, String? notes}) =>
      _done('correctAttendance', {
        'attendanceId': attendanceId,
        'reason': reason,
        'arrival': ?arrival?.key,
        'clockInAt': ?clockInAt?.millisecondsSinceEpoch,
        if (clockOutAt != null) 'clockOutAt': clockOutAt.millisecondsSinceEpoch else if (clearClockOut) 'clockOutAt': null,
        'notes': ?notes,
      });

  @override
  Future<Result<({int created, List<String> skipped})>> calculateAllowances(DateTime day) async =>
      (await _call('calculateAllowances', {'date': day.millisecondsSinceEpoch})).when(
        success: (d) => Success((
          created: (d['created'] as num?)?.toInt() ?? 0,
          skipped: [
            for (final s in (d['skipped'] as List? ?? const []))
              if (s is Map) '${s['staffName']}: ${s['reason']}',
          ],
        )),
        failure: Failure.new,
      );

  @override
  Future<Result<void>> reviewAllowances(List<String> allowanceIds, AllowanceDecision decision, {Money? deduction, String? reason}) =>
      _done('reviewAllowance', {'allowanceIds': allowanceIds, 'decision': decision.key, 'deductionUgx': ?deduction?.ugx, 'reason': ?reason});

  @override
  Future<Result<void>> payAllowances(List<String> allowanceIds, {required String accountId, required String requestId, String? reference}) =>
      _done('payAllowances', {'allowanceIds': allowanceIds, 'accountId': accountId, 'requestId': requestId, 'reference': ?reference});

  @override
  Future<Result<void>> reverseAllowancePayment(String transactionId, {required String reason}) =>
      _done('reverseAllowancePayment', {'transactionId': transactionId, 'reason': reason});

  @override
  Future<Result<void>> cancelAllowances(List<String> allowanceIds, {required String reason}) =>
      _done('cancelAllowance', {'allowanceIds': allowanceIds, 'reason': reason});

  @override
  Future<Result<void>> setSalary(SalaryDraft draft) => _done('setSalaryProfile', draft.toJson());

  @override
  Future<Result<String>> createPayroll({required int year, required int month}) async =>
      (await _call('createPayroll', {'frequency': 'monthly', 'year': year, 'month': month}))
          .when(success: (d) => Success(d['payrollId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> preparePayroll(String payrollId) => _done('preparePayroll', {'payrollId': payrollId});

  @override
  Future<Result<void>> correctPayroll(String payrollId, {required String reason}) =>
      _done('correctPayroll', {'payrollId': payrollId, 'reason': reason});

  @override
  Future<Result<void>> addEarning(String payrollId, {required String staffUid, required String description, required Money amount, required String reason}) =>
      _done('addPayrollEarning', {'payrollId': payrollId, 'staffUid': staffUid, 'description': description, 'amountUgx': amount.ugx, 'reason': reason});

  @override
  Future<Result<void>> removeEarning(String payrollId, String entryId, {required String reason}) =>
      _done('removePayrollEarning', {'payrollId': payrollId, 'entryId': entryId, 'reason': reason});

  @override
  Future<Result<void>> payrollAction(String payrollId, PayrollAction action, {String? reason, String? notes}) =>
      _done('updatePayrollStatus', {'payrollId': payrollId, 'action': action.key, 'reason': ?reason, 'notes': ?notes});

  @override
  Future<Result<void>> payPayroll(String payrollId, {required String accountId, required String requestId, String? reference}) =>
      _done('payPayroll', {'payrollId': payrollId, 'accountId': accountId, 'requestId': requestId, 'reference': ?reference});

  @override
  Future<Result<void>> reversePayrollPayment(String payrollId, {required String reason}) =>
      _done('reversePayrollPayment', {'payrollId': payrollId, 'reason': reason});

  @override
  Future<Result<void>> lockPayroll(String payrollId) => _done('lockPayroll', {'payrollId': payrollId});

  @override
  Future<Result<void>> cancelPayroll(String payrollId, {required String reason}) =>
      _done('cancelPayroll', {'payrollId': payrollId, 'reason': reason});

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
      (await _call('createLossIncident', {
        'incidentType': type.key,
        'amountUgx': amount.ugx,
        'description': description,
        'incidentDate': incidentDate.millisecondsSinceEpoch,
        'requestId': requestId,
        'staffUid': staffUid,
        'notes': ?notes,
        'attachmentPath': ?attachmentPath,
      }))
          .when(success: (d) => Success(d['incidentId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> reviewLoss(String incidentId, {String? notes}) => _done('reviewLossIncident', {'incidentId': incidentId, 'notes': ?notes});

  @override
  Future<Result<void>> decideLoss(String incidentId, {required bool approve, required String reason, Money? recovery}) =>
      _done('decideLossIncident', {
        'incidentId': incidentId,
        'decision': approve ? 'approve' : 'reject',
        'reason': reason,
        'approvedRecoveryUgx': ?recovery?.ugx,
      });

  @override
  Future<Result<void>> scheduleRecovery(String incidentId, {required Money instalment, required DateTime startDate, String? reason}) =>
      _done('scheduleLossRecovery', {
        'incidentId': incidentId,
        'instalmentUgx': instalment.ugx,
        'startDate': startDate.millisecondsSinceEpoch,
        'reason': ?reason,
      });

  @override
  Future<Result<void>> cancelLoss(String incidentId, {required String reason}) =>
      _done('cancelLossIncident', {'incidentId': incidentId, 'reason': reason});

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
  }) =>
      _done('createSalaryDeduction', {
        'staffUid': staffUid,
        'type': type.key,
        'totalAmountUgx': total.ugx,
        'instalmentUgx': instalment.ugx,
        'reason': reason,
        'reference': reference,
        'startDate': startDate.millisecondsSinceEpoch,
        'requestId': requestId,
      });

  @override
  Future<Result<void>> decideDeduction(String deductionId, {required bool approve, String? reason}) =>
      _done('decideSalaryDeduction', {'deductionId': deductionId, 'decision': approve ? 'approve' : 'reject', 'reason': ?reason});

  @override
  Future<Result<void>> cancelDeduction(String deductionId, {required String reason}) =>
      _done('cancelSalaryDeduction', {'deductionId': deductionId, 'reason': reason});
}
