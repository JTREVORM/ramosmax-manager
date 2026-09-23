import '../core/money/money.dart';
import 'firestore_converters.dart';

/// Attendance status. Mirrors STATUSES in functions/src/attendance.js; the
/// brief's PRESENT / LATE / ABSENT / EXCUSED / REJECTED / PENDING_VERIFICATION.
enum AttendanceStatus {
  pendingVerification('pending_verification', 'Pending verification'),
  present('present', 'Present'),
  late('late', 'Late'),
  absent('absent', 'Absent'),
  excused('excused', 'Excused'),
  rejected('rejected', 'Rejected');

  const AttendanceStatus(this.key, this.label);
  final String key;
  final String label;

  static AttendanceStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => pendingVerification);
}

/// What was recorded, before verification.
enum ArrivalStatus {
  onTime('on_time', 'On time'),
  late('late', 'Late'),
  absent('absent', 'Absent'),
  excused('excused', 'Excused');

  const ArrivalStatus(this.key, this.label);
  final String key;
  final String label;

  static ArrivalStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => onTime);
}

/// How a manager records a day for someone (`recordAttendance.arrival`).
enum ArrivalEntry {
  present('present', 'Present'),
  absent('absent', 'Absent'),
  excused('excused', 'Excused');

  const ArrivalEntry(this.key, this.label);
  final String key;
  final String label;
}

/// Where a record came from. Only [manual] exists today; biometric devices
/// and imports are prepared for (functions/src/attendance.js ingestAttendance).
enum AttendanceSource {
  manual('manual', 'Manual'),
  biometric('biometric', 'Biometric'),
  imported('imported', 'Imported');

  const AttendanceSource(this.key, this.label);
  final String key;
  final String label;

  static AttendanceSource parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => manual);
}

/// `attendance/{staffUid}_{yyyy-mm-dd}` — one per person per EAT business day.
class AttendanceRecord {
  const AttendanceRecord({
    required this.attendanceId,
    required this.attendanceNumber,
    required this.staffUid,
    required this.staffName,
    required this.dayKey,
    required this.status,
    required this.arrivalStatus,
    required this.verificationStatus,
    required this.source,
    this.staffId,
    this.date,
    this.clockInAt,
    this.clockOutAt,
    this.expectedReportingAt,
    this.reportingTime,
    this.gracePeriodMinutes = 0,
    this.minutesLate = 0,
    this.late = false,
    this.severelyLate = false,
    this.workingDay = true,
    this.recordedVia,
    this.recordedByName,
    this.verifiedByName,
    this.verifiedAt,
    this.verificationNotes,
    this.rejectionReason,
    this.notes,
    this.allowanceId,
    this.correctionCount = 0,
    this.attachmentPath,
  });

  final String attendanceId;
  final String attendanceNumber;
  final String staffUid;
  final String staffName;
  final String? staffId;
  final String dayKey;
  final DateTime? date;
  final DateTime? clockInAt;
  final DateTime? clockOutAt;
  final DateTime? expectedReportingAt;
  final String? reportingTime;
  final int gracePeriodMinutes;
  final int minutesLate;
  final bool late;
  final bool severelyLate;
  final bool workingDay;
  final AttendanceStatus status;
  final ArrivalStatus arrivalStatus;
  final String verificationStatus;
  final AttendanceSource source;
  final String? recordedVia;
  final String? recordedByName;
  final String? verifiedByName;
  final DateTime? verifiedAt;
  final String? verificationNotes;
  final String? rejectionReason;
  final String? notes;
  final String? allowanceId;
  final int correctionCount;
  final String? attachmentPath;

  bool get isPending => verificationStatus == 'pending';
  bool get isApproved => verificationStatus == 'approved';
  bool get canClockOut => clockInAt != null && clockOutAt == null && isPending;

  static AttendanceRecord fromFirestore(String id, Map<String, dynamic> d) => AttendanceRecord(
        attendanceId: id,
        attendanceNumber: d['attendanceNumber'] as String? ?? '',
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        staffId: d['staffId'] as String?,
        dayKey: d['dayKey'] as String? ?? '',
        date: FirestoreConverters.toDateTime(d['date']),
        clockInAt: FirestoreConverters.toDateTime(d['clockInAt']),
        clockOutAt: FirestoreConverters.toDateTime(d['clockOutAt']),
        expectedReportingAt: FirestoreConverters.toDateTime(d['expectedReportingAt']),
        reportingTime: d['reportingTime'] as String?,
        gracePeriodMinutes: (d['gracePeriodMinutes'] as num?)?.toInt() ?? 0,
        minutesLate: (d['minutesLate'] as num?)?.toInt() ?? 0,
        late: d['late'] == true,
        severelyLate: d['severelyLate'] == true,
        workingDay: d['workingDay'] != false,
        status: AttendanceStatus.parse(d['status']),
        arrivalStatus: ArrivalStatus.parse(d['arrivalStatus']),
        verificationStatus: d['verificationStatus'] as String? ?? 'pending',
        source: AttendanceSource.parse(d['source']),
        recordedVia: d['recordedVia'] as String?,
        recordedByName: d['recordedByName'] as String?,
        verifiedByName: d['verifiedByName'] as String?,
        verifiedAt: FirestoreConverters.toDateTime(d['verifiedAt']),
        verificationNotes: d['verificationNotes'] as String?,
        rejectionReason: d['rejectionReason'] as String?,
        notes: d['notes'] as String?,
        allowanceId: d['allowanceId'] as String?,
        correctionCount: (d['correctionCount'] as num?)?.toInt() ?? 0,
        attachmentPath: d['attachmentPath'] as String?,
      );
}

/// `attendance_corrections/{id}` — the original and corrected values of one correction.
class AttendanceCorrection {
  const AttendanceCorrection({
    required this.correctionId,
    required this.attendanceId,
    required this.reason,
    required this.previous,
    required this.corrected,
    this.correctedByName,
    this.createdAt,
  });

  final String correctionId;
  final String attendanceId;
  final String reason;
  final Map<String, Object?> previous;
  final Map<String, Object?> corrected;
  final String? correctedByName;
  final DateTime? createdAt;

  static AttendanceCorrection fromFirestore(String id, Map<String, dynamic> d) => AttendanceCorrection(
        correctionId: id,
        attendanceId: d['attendanceId'] as String? ?? '',
        reason: d['reason'] as String? ?? '',
        previous: Map<String, Object?>.from(d['previousValue'] as Map? ?? const {}),
        corrected: Map<String, Object?>.from(d['newValue'] as Map? ?? const {}),
        correctedByName: d['correctedByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
      );
}

/// Late-arrival allowance policy (the brief's FULL / DEDUCT / REJECT).
enum LatePolicy {
  full('full', 'Full allowance'),
  deduct('deduct', 'Deduct part'),
  reject('reject', 'No allowance');

  const LatePolicy(this.key, this.label);
  final String key;
  final String label;

  static LatePolicy parse(Object? v) => values.firstWhere((p) => p.key == v, orElse: () => deduct);
}

/// `settings/payroll_policy`, merged over the server defaults
/// (DEFAULT_POLICY in functions/src/workforce.js). The app reads it for
/// display and previews; the server applies it.
class WorkforcePolicy {
  const WorkforcePolicy({
    this.reportingTime = '08:00',
    this.workingDays = const [1, 2, 3, 4, 5, 6],
    this.gracePeriodMinutes = 15,
    this.lateThresholdMinutes = 120,
    this.requireClockOut = false,
    this.allowanceOnNonWorkingDays = false,
    this.defaultDailyAllowance = const Money(5000),
    this.allowanceEligibleRoles = const ['cashier', 'manager', 'worker'],
    this.lateAllowancePolicy = LatePolicy.deduct,
    this.lateDeduction = const Money(2500),
    this.maxLateDeduction = const Money(5000),
    this.allowanceApprovalRequired = true,
    this.maxDeductionPercentOfGross = 100,
    this.payrollRequiresAdminApproval = true,
  });

  final String reportingTime;
  final List<int> workingDays;
  final int gracePeriodMinutes;
  final int lateThresholdMinutes;
  final bool requireClockOut;
  final bool allowanceOnNonWorkingDays;
  final Money defaultDailyAllowance;
  final List<String> allowanceEligibleRoles;
  final LatePolicy lateAllowancePolicy;
  final Money lateDeduction;
  final Money maxLateDeduction;
  final bool allowanceApprovalRequired;
  final int maxDeductionPercentOfGross;
  final bool payrollRequiresAdminApproval;

  static const defaults = WorkforcePolicy();

  static const List<String> weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  int get reportingMinutes {
    final parts = reportingTime.split(':');
    return int.parse(parts[0]) * 60 + int.parse(parts[1]);
  }

  /// Minutes late for a clock-in at EAT wall-clock [hour]:[minute]; same rule
  /// as the server (whole minutes, on time up to the grace period).
  ({int minutesLate, bool late}) lateness(int hour, int minute) {
    final m = hour * 60 + minute - reportingMinutes;
    final minutesLate = m < 0 ? 0 : m;
    return (minutesLate: minutesLate, late: minutesLate > gracePeriodMinutes);
  }

  static WorkforcePolicy fromFirestore(Map<String, dynamic>? d) {
    if (d == null) return defaults;
    const x = defaults;
    Money m(Object? v, Money fallback) => v is num ? Money(v.toInt()) : fallback;
    int i(Object? v, int fallback) => v is num ? v.toInt() : fallback;
    bool b(Object? v, bool fallback) => v is bool ? v : fallback;
    return WorkforcePolicy(
      reportingTime: d['reportingTime'] is String ? d['reportingTime'] as String : x.reportingTime,
      workingDays: d['workingDays'] is List ? [for (final v in d['workingDays'] as List) if (v is num) v.toInt()] : x.workingDays,
      gracePeriodMinutes: i(d['gracePeriodMinutes'], x.gracePeriodMinutes),
      lateThresholdMinutes: i(d['lateThresholdMinutes'], x.lateThresholdMinutes),
      requireClockOut: b(d['requireClockOut'], x.requireClockOut),
      allowanceOnNonWorkingDays: b(d['allowanceOnNonWorkingDays'], x.allowanceOnNonWorkingDays),
      defaultDailyAllowance: m(d['defaultDailyAllowanceUgx'], x.defaultDailyAllowance),
      allowanceEligibleRoles:
          d['allowanceEligibleRoles'] is List ? [for (final v in d['allowanceEligibleRoles'] as List) v.toString()] : x.allowanceEligibleRoles,
      lateAllowancePolicy: d['lateAllowancePolicy'] == null ? x.lateAllowancePolicy : LatePolicy.parse(d['lateAllowancePolicy']),
      lateDeduction: m(d['lateDeductionUgx'], x.lateDeduction),
      maxLateDeduction: m(d['maxLateDeductionUgx'], x.maxLateDeduction),
      allowanceApprovalRequired: b(d['allowanceApprovalRequired'], x.allowanceApprovalRequired),
      maxDeductionPercentOfGross: i(d['maxDeductionPercentOfGross'], x.maxDeductionPercentOfGross),
      payrollRequiresAdminApproval: b(d['payrollRequiresAdminApproval'], x.payrollRequiresAdminApproval),
    );
  }
}
