import '../core/money/money.dart';
import 'firestore_converters.dart';

Money _m(Object? v) => Money((v as num?)?.toInt() ?? 0);
Money? _mOrNull(Object? v) => v is num ? Money(v.toInt()) : null;

// ---------------------------------------------------------------------------
// Daily allowances
// ---------------------------------------------------------------------------

/// Mirrors STATUSES in functions/src/allowances.js.
enum AllowanceStatus {
  calculated('calculated', 'Calculated'),
  pendingApproval('pending_approval', 'Pending approval'),
  approved('approved', 'Approved · unpaid'),
  rejected('rejected', 'Rejected'),
  paid('paid', 'Paid'),
  cancelled('cancelled', 'Cancelled');

  const AllowanceStatus(this.key, this.label);
  final String key;
  final String label;

  static AllowanceStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => calculated);

  bool get awaitsDecision => this == calculated || this == pendingApproval;
}

/// The manager's decision on an allowance (FULL / DEDUCT / REJECT).
enum AllowanceDecision {
  full('full', 'Full'),
  deduct('deduct', 'Deduct'),
  reject('reject', 'Reject');

  const AllowanceDecision(this.key, this.label);
  final String key;
  final String label;

  static AllowanceDecision? tryParse(Object? v) {
    for (final d in values) {
      if (d.key == v) return d;
    }
    return null;
  }
}

/// `worker_allowances/{id}`. Every amount is decided by the server.
class WorkerAllowance {
  const WorkerAllowance({
    required this.allowanceId,
    required this.allowanceNumber,
    required this.staffUid,
    required this.staffName,
    required this.dayKey,
    required this.calculatedAmount,
    required this.status,
    this.attendanceId,
    this.date,
    this.late = false,
    this.minutesLate = 0,
    this.suggestedDecision,
    this.suggestedDeduction = Money.zero,
    this.decision,
    this.proposedDecision,
    this.proposedDeduction,
    this.proposedByName,
    this.proposalReason,
    this.deduction = Money.zero,
    this.deductionReason,
    this.approvedAmount,
    this.approvedByName,
    this.rejectionReason,
    this.paidVia,
    this.paidAt,
    this.paidFromAccountName,
    this.financialTransactionId,
    this.financialTransactionNumber,
    this.payrollNumber,
    this.cancelReason,
    this.autoApproved = false,
  });

  final String allowanceId;
  final String allowanceNumber;
  final String staffUid;
  final String staffName;
  final String dayKey;
  final String? attendanceId;
  final DateTime? date;
  final bool late;
  final int minutesLate;
  final Money calculatedAmount;
  final AllowanceDecision? suggestedDecision;
  final Money suggestedDeduction;
  final AllowanceDecision? decision;
  final AllowanceDecision? proposedDecision;
  final Money? proposedDeduction;
  final String? proposedByName;
  final String? proposalReason;
  final Money deduction;
  final String? deductionReason;
  final Money? approvedAmount;
  final AllowanceStatus status;
  final String? approvedByName;
  final String? rejectionReason;
  final String? paidVia;
  final DateTime? paidAt;
  final String? paidFromAccountName;
  final String? financialTransactionId;
  final String? financialTransactionNumber;
  final String? payrollNumber;
  final String? cancelReason;
  final bool autoApproved;

  /// What the person receives (or will): approved amount, else the calculation.
  Money get amount => approvedAmount ?? calculatedAmount;

  static WorkerAllowance fromFirestore(String id, Map<String, dynamic> d) => WorkerAllowance(
        allowanceId: id,
        allowanceNumber: d['allowanceNumber'] as String? ?? '',
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        dayKey: d['dayKey'] as String? ?? '',
        attendanceId: d['attendanceId'] as String?,
        date: FirestoreConverters.toDateTime(d['date']),
        late: d['late'] == true,
        minutesLate: (d['minutesLate'] as num?)?.toInt() ?? 0,
        calculatedAmount: _m(d['calculatedAmountUgx']),
        suggestedDecision: AllowanceDecision.tryParse(d['suggestedDecision']),
        suggestedDeduction: _m(d['suggestedDeductionUgx']),
        decision: AllowanceDecision.tryParse(d['decision']),
        proposedDecision: AllowanceDecision.tryParse(d['proposedDecision']),
        proposedDeduction: _mOrNull(d['proposedDeductionUgx']),
        proposedByName: d['proposedByName'] as String?,
        proposalReason: d['proposalReason'] as String?,
        deduction: _m(d['deductionUgx']),
        deductionReason: d['deductionReason'] as String?,
        approvedAmount: _mOrNull(d['approvedAmountUgx']),
        status: AllowanceStatus.parse(d['status']),
        approvedByName: d['approvedByName'] as String?,
        rejectionReason: d['rejectionReason'] as String?,
        paidVia: d['paidVia'] as String?,
        paidAt: FirestoreConverters.toDateTime(d['paidAt']),
        paidFromAccountName: d['paidFromAccountName'] as String?,
        financialTransactionId: d['financialTransactionId'] as String?,
        financialTransactionNumber: d['financialTransactionNumber'] as String?,
        payrollNumber: d['payrollNumber'] as String?,
        cancelReason: d['cancelReason'] as String?,
        autoApproved: d['autoApproved'] == true,
      );
}

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

enum PaymentFrequency {
  monthly('monthly', 'Monthly'),
  weekly('weekly', 'Weekly');

  const PaymentFrequency(this.key, this.label);
  final String key;
  final String label;

  static PaymentFrequency parse(Object? v) => values.firstWhere((f) => f.key == v, orElse: () => monthly);
}

/// `salary_profiles/{staffUid}` (the latest version) or one `salary_history`
/// version. Versions are never edited; a change is a new version.
class SalaryVersion {
  const SalaryVersion({
    required this.staffUid,
    required this.staffName,
    required this.basicSalary,
    required this.frequency,
    required this.allowanceEligible,
    required this.active,
    required this.version,
    this.staffId,
    this.allowanceAmount,
    this.effectiveFrom,
    this.reason,
    this.notes,
    this.changedByName,
    this.createdAt,
    this.previousBasicSalary,
  });

  final String staffUid;
  final String staffName;
  final String? staffId;
  final Money basicSalary;
  final PaymentFrequency frequency;
  final bool allowanceEligible;

  /// Null: the policy's default daily allowance applies.
  final Money? allowanceAmount;
  final bool active;
  final int version;
  final DateTime? effectiveFrom;
  final String? reason;
  final String? notes;
  final String? changedByName;
  final DateTime? createdAt;
  final Money? previousBasicSalary;

  static SalaryVersion fromFirestore(Map<String, dynamic> d) => SalaryVersion(
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        staffId: d['staffId'] as String?,
        basicSalary: _m(d['basicSalaryUgx']),
        frequency: PaymentFrequency.parse(d['paymentFrequency']),
        allowanceEligible: d['allowanceEligible'] == true,
        allowanceAmount: _mOrNull(d['allowanceAmountUgx']),
        active: d['active'] != false,
        version: (d['version'] as num?)?.toInt() ?? 1,
        effectiveFrom: FirestoreConverters.toDateTime(d['effectiveFrom']),
        reason: d['reason'] as String?,
        notes: d['notes'] as String?,
        changedByName: (d['createdByName'] ?? d['updatedByName']) as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        previousBasicSalary: d['previousValue'] is Map ? _mOrNull((d['previousValue'] as Map)['basicSalaryUgx']) : null,
      );

  /// The version in force on [day] among [versions] (same rule as the server's versionOn).
  static SalaryVersion? inForce(Iterable<SalaryVersion> versions, DateTime day) {
    SalaryVersion? best;
    for (final v in versions) {
      final from = v.effectiveFrom;
      if (from == null || from.isAfter(day)) continue;
      if (best == null ||
          from.isAfter(best.effectiveFrom!) ||
          (from.isAtSameMomentAs(best.effectiveFrom!) && v.version > best.version)) {
        best = v;
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

/// Mirrors PAYROLL_STATUSES in functions/src/payroll.js.
enum PayrollStatus {
  draft('draft', 'Draft'),
  prepared('prepared', 'Prepared'),
  pendingReview('pending_review', 'Pending review'),
  approved('approved', 'Approved · unpaid'),
  paid('paid', 'Paid'),
  locked('locked', 'Locked'),
  cancelled('cancelled', 'Cancelled');

  const PayrollStatus(this.key, this.label);
  final String key;
  final String label;

  static PayrollStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => draft);
}

/// Workflow steps of `updatePayrollStatus`.
enum PayrollAction {
  submit('submit', 'Submit for review'),
  review('review', 'Mark reviewed'),
  returnForCorrection('return', 'Return for correction'),
  approve('approve', 'Approve');

  const PayrollAction(this.key, this.label);
  final String key;
  final String label;
}

class PayrollTotals {
  const PayrollTotals({
    this.basic = Money.zero,
    this.allowances = Money.zero,
    this.otherEarnings = Money.zero,
    this.gross = Money.zero,
    this.salaryDeductions = Money.zero,
    this.lossRecoveries = Money.zero,
    this.otherDeductions = Money.zero,
    this.deductions = Money.zero,
    this.net = Money.zero,
  });

  final Money basic;
  final Money allowances;
  final Money otherEarnings;
  final Money gross;
  final Money salaryDeductions;
  final Money lossRecoveries;
  final Money otherDeductions;
  final Money deductions;
  final Money net;

  static PayrollTotals fromPayroll(Map<String, dynamic> d) => PayrollTotals(
        basic: _m(d['totalBasicUgx']),
        allowances: _m(d['totalAllowancesUgx']),
        otherEarnings: _m(d['totalOtherEarningsUgx']),
        gross: _m(d['totalGrossUgx']),
        salaryDeductions: _m(d['totalSalaryDeductionsUgx']),
        lossRecoveries: _m(d['totalLossRecoveriesUgx']),
        otherDeductions: _m(d['totalOtherDeductionsUgx']),
        deductions: _m(d['totalDeductionsUgx']),
        net: _m(d['totalNetUgx']),
      );
}

class PayrollEarningEntry {
  const PayrollEarningEntry({required this.entryId, required this.staffUid, required this.description, required this.amount, this.reason});
  final String entryId;
  final String staffUid;
  final String description;
  final Money amount;
  final String? reason;

  static PayrollEarningEntry fromMap(Map<dynamic, dynamic> d) => PayrollEarningEntry(
        entryId: d['entryId'] as String? ?? '',
        staffUid: d['staffUid'] as String? ?? '',
        description: d['description'] as String? ?? '',
        amount: _m(d['amountUgx']),
        reason: d['reason'] as String?,
      );
}

/// `payroll/{id}` — the run for one period; totals only.
class PayrollRun {
  const PayrollRun({
    required this.payrollId,
    required this.payrollNumber,
    required this.periodKey,
    required this.periodLabel,
    required this.frequency,
    required this.status,
    required this.totals,
    this.version = 0,
    this.employeeCount = 0,
    this.periodStart,
    this.periodEnd,
    this.earningEntries = const [],
    this.createdByName,
    this.preparedByName,
    this.preparedAt,
    this.reviewedByName,
    this.reviewedAt,
    this.reviewNotes,
    this.returnedReason,
    this.approvedByName,
    this.approvedAt,
    this.paidByName,
    this.paidAt,
    this.paidFromAccountName,
    this.financialTransactionId,
    this.financialTransactionNumber,
    this.paymentReference,
    this.lockedAt,
    this.cancelReason,
    this.correctionCount = 0,
    this.lastCorrectionReason,
    this.paymentReversalReason,
  });

  final String payrollId;
  final String payrollNumber;
  final String periodKey;
  final String periodLabel;
  final PaymentFrequency frequency;
  final PayrollStatus status;
  final PayrollTotals totals;
  final int version;
  final int employeeCount;
  final DateTime? periodStart;
  final DateTime? periodEnd;
  final List<PayrollEarningEntry> earningEntries;
  final String? createdByName;
  final String? preparedByName;
  final DateTime? preparedAt;
  final String? reviewedByName;
  final DateTime? reviewedAt;
  final String? reviewNotes;
  final String? returnedReason;
  final String? approvedByName;
  final DateTime? approvedAt;
  final String? paidByName;
  final DateTime? paidAt;
  final String? paidFromAccountName;
  final String? financialTransactionId;
  final String? financialTransactionNumber;
  final String? paymentReference;
  final DateTime? lockedAt;
  final String? cancelReason;
  final int correctionCount;
  final String? lastCorrectionReason;
  final String? paymentReversalReason;

  bool get isReviewed => reviewedAt != null;

  /// Steps the workflow allows now (the server re-checks everything).
  Set<PayrollAction> get availableActions => switch (status) {
        PayrollStatus.prepared when employeeCount > 0 => {PayrollAction.submit},
        PayrollStatus.pendingReview => {
            if (!isReviewed) PayrollAction.review else PayrollAction.approve,
            PayrollAction.returnForCorrection,
          },
        _ => const {},
      };

  bool get canPrepare => status == PayrollStatus.draft || status == PayrollStatus.prepared;
  bool get canCorrect => status == PayrollStatus.prepared || status == PayrollStatus.pendingReview || status == PayrollStatus.approved;
  bool get canPay => status == PayrollStatus.approved;
  bool get canLock => status == PayrollStatus.paid;
  bool get canReversePayment => status == PayrollStatus.paid;
  bool get canCancel => const {PayrollStatus.draft, PayrollStatus.prepared, PayrollStatus.pendingReview, PayrollStatus.approved}.contains(status);
  bool get canEditEarnings => status == PayrollStatus.prepared;

  static PayrollRun fromFirestore(String id, Map<String, dynamic> d) => PayrollRun(
        payrollId: id,
        payrollNumber: d['payrollNumber'] as String? ?? '',
        periodKey: d['periodKey'] as String? ?? '',
        periodLabel: d['periodLabel'] as String? ?? '',
        frequency: PaymentFrequency.parse(d['frequency']),
        status: PayrollStatus.parse(d['status']),
        totals: PayrollTotals.fromPayroll(d),
        version: (d['version'] as num?)?.toInt() ?? 0,
        employeeCount: (d['employeeCount'] as num?)?.toInt() ?? 0,
        periodStart: FirestoreConverters.toDateTime(d['periodStart']),
        periodEnd: FirestoreConverters.toDateTime(d['periodEnd']),
        earningEntries: [for (final e in (d['earningEntries'] as List? ?? const [])) if (e is Map) PayrollEarningEntry.fromMap(e)],
        createdByName: d['createdByName'] as String?,
        preparedByName: d['preparedByName'] as String?,
        preparedAt: FirestoreConverters.toDateTime(d['preparedAt']),
        reviewedByName: d['reviewedByName'] as String?,
        reviewedAt: FirestoreConverters.toDateTime(d['reviewedAt']),
        reviewNotes: d['reviewNotes'] as String?,
        returnedReason: d['returnedReason'] as String?,
        approvedByName: d['approvedByName'] as String?,
        approvedAt: FirestoreConverters.toDateTime(d['approvedAt']),
        paidByName: d['paidByName'] as String?,
        paidAt: FirestoreConverters.toDateTime(d['paidAt']),
        paidFromAccountName: d['paidFromAccountName'] as String?,
        financialTransactionId: d['financialTransactionId'] as String?,
        financialTransactionNumber: d['financialTransactionNumber'] as String?,
        paymentReference: d['paymentReference'] as String?,
        lockedAt: FirestoreConverters.toDateTime(d['lockedAt']),
        cancelReason: d['cancelReason'] as String?,
        correctionCount: (d['correctionCount'] as num?)?.toInt() ?? 0,
        lastCorrectionReason: d['lastCorrectionReason'] as String?,
        paymentReversalReason: d['paymentReversalReason'] as String?,
      );
}

enum DeductionType {
  lossRecovery('loss_recovery', 'Loss recovery'),
  authorizedDeduction('authorized_deduction', 'Authorised salary deduction'),
  other('other', 'Other approved deduction');

  const DeductionType(this.key, this.label);
  final String key;
  final String label;

  static DeductionType parse(Object? v) => values.firstWhere((t) => t.key == v, orElse: () => other);
}

/// One deduction taken in a payroll item.
class PayDeductionLine {
  const PayDeductionLine({
    required this.deductionId,
    required this.deductionNumber,
    required this.type,
    required this.planned,
    required this.amount,
    this.reason,
    this.lossNumber,
  });

  final String deductionId;
  final String deductionNumber;
  final DeductionType type;
  final Money planned;
  final Money amount;
  final String? reason;
  final String? lossNumber;

  static PayDeductionLine fromMap(Map<dynamic, dynamic> d) => PayDeductionLine(
        deductionId: d['deductionId'] as String? ?? '',
        deductionNumber: d['deductionNumber'] as String? ?? '',
        type: DeductionType.parse(d['type']),
        planned: _m(d['plannedUgx']),
        amount: _m(d['amountUgx']),
        reason: d['reason'] as String?,
        lossNumber: d['lossNumber'] as String?,
      );
}

/// `payroll_items/{id}` — one employee's pay in one payroll version (a payslip once paid).
class PayrollItem {
  const PayrollItem({
    required this.itemId,
    required this.itemNumber,
    required this.payrollId,
    required this.payrollNumber,
    required this.periodLabel,
    required this.staffUid,
    required this.staffName,
    required this.basicSalary,
    required this.allowances,
    required this.otherEarnings,
    required this.gross,
    required this.salaryDeductions,
    required this.lossRecoveries,
    required this.otherDeductions,
    required this.totalDeductions,
    required this.net,
    required this.paymentStatus,
    required this.status,
    this.allowanceDays = 0,
    this.deductionLines = const [],
    this.otherEarningLines = const [],
    this.deductionCapped = false,
    this.current = true,
    this.periodStart,
    this.paidAt,
    this.staffId,
  });

  final String itemId;
  final String itemNumber;
  final String payrollId;
  final String payrollNumber;
  final String periodLabel;
  final String staffUid;
  final String staffName;
  final String? staffId;
  final Money basicSalary;
  final Money allowances;
  final int allowanceDays;
  final Money otherEarnings;
  final Money gross;
  final Money salaryDeductions;
  final Money lossRecoveries;
  final Money otherDeductions;
  final Money totalDeductions;
  final Money net;
  final List<PayDeductionLine> deductionLines;
  final List<PayrollEarningEntry> otherEarningLines;
  final bool deductionCapped;
  final String paymentStatus;
  final String status;
  final bool current;
  final DateTime? periodStart;
  final DateTime? paidAt;

  static PayrollItem fromFirestore(String id, Map<String, dynamic> d) => PayrollItem(
        itemId: id,
        itemNumber: d['itemNumber'] as String? ?? '',
        payrollId: d['payrollId'] as String? ?? '',
        payrollNumber: d['payrollNumber'] as String? ?? '',
        periodLabel: d['periodLabel'] as String? ?? '',
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        staffId: d['staffId'] as String?,
        basicSalary: _m(d['basicSalaryUgx']),
        allowances: _m(d['allowancesUgx']),
        allowanceDays: (d['allowanceDays'] as num?)?.toInt() ?? 0,
        otherEarnings: _m(d['otherEarningsUgx']),
        gross: _m(d['grossUgx']),
        salaryDeductions: _m(d['salaryDeductionsUgx']),
        lossRecoveries: _m(d['lossRecoveriesUgx']),
        otherDeductions: _m(d['otherDeductionsUgx']),
        totalDeductions: _m(d['totalDeductionsUgx']),
        net: _m(d['netUgx']),
        deductionLines: [for (final l in (d['deductions'] as List? ?? const [])) if (l is Map) PayDeductionLine.fromMap(l)],
        otherEarningLines: [
          for (final e in (d['otherEarnings'] as List? ?? const []))
            if (e is Map) PayrollEarningEntry.fromMap({...e, 'staffUid': d['staffUid']}),
        ],
        deductionCapped: d['deductionCapped'] == true,
        paymentStatus: d['paymentStatus'] as String? ?? 'unpaid',
        status: d['status'] as String? ?? 'prepared',
        current: d['current'] != false,
        periodStart: FirestoreConverters.toDateTime(d['periodStart']),
        paidAt: FirestoreConverters.toDateTime(d['paidAt']),
      );
}

/// The pay formula, identical to payFor() in functions/src/payroll.js. The
/// app uses it only to explain figures; the server's numbers are the ones
/// that count.
abstract final class PayCalculator {
  static ({Money gross, Money deductions, Money net, bool capped, List<Money> taken}) compute({
    required Money basic,
    required Money allowances,
    required Money otherEarnings,
    required List<({Money instalment, Money remaining})> deductions,
    required int capPercent,
  }) {
    final gross = basic + allowances + otherEarnings;
    var left = gross.ugx * capPercent ~/ 100;
    var capped = false;
    final taken = <Money>[];
    for (final d in deductions) {
      final planned = d.instalment.ugx < d.remaining.ugx ? d.instalment.ugx : d.remaining.ugx;
      final amount = planned < left ? planned : left;
      if (amount < planned) capped = true;
      left -= amount;
      taken.add(Money(amount));
    }
    final total = Money.sum(taken);
    return (gross: gross, deductions: total, net: gross - total, capped: capped, taken: taken);
  }
}

// ---------------------------------------------------------------------------
// Salary deductions and loss incidents
// ---------------------------------------------------------------------------

enum DeductionStatus {
  pendingApproval('pending_approval', 'Pending approval'),
  active('active', 'Active'),
  completed('completed', 'Completed'),
  rejected('rejected', 'Rejected'),
  cancelled('cancelled', 'Cancelled');

  const DeductionStatus(this.key, this.label);
  final String key;
  final String label;

  static DeductionStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => pendingApproval);
}

/// `salary_deductions/{id}` — an approved schedule taken through payroll.
class SalaryDeduction {
  const SalaryDeduction({
    required this.deductionId,
    required this.deductionNumber,
    required this.staffUid,
    required this.staffName,
    required this.type,
    required this.status,
    required this.total,
    required this.instalment,
    required this.recovered,
    required this.remaining,
    this.reason,
    this.reference,
    this.lossIncidentId,
    this.lossNumber,
    this.startsFrom,
    this.approvedByName,
    this.createdByName,
    this.createdAt,
    this.cancelReason,
    this.rejectionReason,
    this.applications = const [],
  });

  final String deductionId;
  final String deductionNumber;
  final String staffUid;
  final String staffName;
  final DeductionType type;
  final DeductionStatus status;
  final Money total;
  final Money instalment;
  final Money recovered;
  final Money remaining;
  final String? reason;
  final String? reference;
  final String? lossIncidentId;
  final String? lossNumber;
  final DateTime? startsFrom;
  final String? approvedByName;
  final String? createdByName;
  final DateTime? createdAt;
  final String? cancelReason;
  final String? rejectionReason;
  final List<({String payrollNumber, String periodKey, Money amount, bool reversed})> applications;

  static SalaryDeduction fromFirestore(String id, Map<String, dynamic> d) => SalaryDeduction(
        deductionId: id,
        deductionNumber: d['deductionNumber'] as String? ?? '',
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        type: DeductionType.parse(d['type']),
        status: DeductionStatus.parse(d['status']),
        total: _m(d['totalAmountUgx']),
        instalment: _m(d['instalmentUgx']),
        recovered: _m(d['recoveredUgx']),
        remaining: _m(d['remainingUgx']),
        reason: d['reason'] as String?,
        reference: d['reference'] as String?,
        lossIncidentId: d['lossIncidentId'] as String?,
        lossNumber: d['lossNumber'] as String?,
        startsFrom: FirestoreConverters.toDateTime(d['startsFrom']),
        approvedByName: d['approvedByName'] as String?,
        createdByName: d['createdByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        cancelReason: d['cancelReason'] as String?,
        rejectionReason: d['rejectionReason'] as String?,
        applications: [
          for (final a in (d['applications'] as List? ?? const []))
            if (a is Map)
              (
                payrollNumber: a['payrollNumber'] as String? ?? '',
                periodKey: a['periodKey'] as String? ?? '',
                amount: _m(a['amountUgx']),
                reversed: a['reversed'] == true,
              ),
        ],
      );
}

enum LossType {
  damagedEquipment('damaged_equipment', 'Damaged equipment'),
  damagedCustomerProperty('damaged_customer_property', 'Damaged customer property'),
  stockLoss('stock_loss', 'Stock loss'),
  workerRelatedLoss('worker_related_loss', 'Documented worker-related loss'),
  other('other', 'Other approved business loss');

  const LossType(this.key, this.label);
  final String key;
  final String label;

  static LossType parse(Object? v) => values.firstWhere((t) => t.key == v, orElse: () => other);
}

/// Mirrors INCIDENT_STATUSES in functions/src/losses.js.
enum LossStatus {
  reported('reported', 'Reported'),
  underReview('under_review', 'Under review'),
  approved('approved', 'Approved'),
  rejected('rejected', 'Rejected'),
  recoveryScheduled('recovery_scheduled', 'Recovery scheduled'),
  partiallyRecovered('partially_recovered', 'Partially recovered'),
  recovered('recovered', 'Recovered'),
  cancelled('cancelled', 'Cancelled');

  const LossStatus(this.key, this.label);
  final String key;
  final String label;

  static LossStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => reported);

  bool get isOpen => this == reported || this == underReview;
}

/// `loss_incidents/{id}`. An incident never deducts anything by itself.
class LossIncident {
  const LossIncident({
    required this.incidentId,
    required this.lossNumber,
    required this.type,
    required this.amount,
    required this.description,
    required this.status,
    this.staffUid,
    this.staffName,
    this.incidentDate,
    this.approvedRecovery = Money.zero,
    this.recovered = Money.zero,
    this.outstanding = Money.zero,
    this.recoveryReason,
    this.rejectionReason,
    this.reportedByName,
    this.reviewedByName,
    this.reviewNotes,
    this.approvedByName,
    this.deductionId,
    this.deductionNumber,
    this.cancelReason,
    this.cancelledOutstanding = Money.zero,
    this.attachmentPath,
    this.notes,
    this.createdAt,
  });

  final String incidentId;
  final String lossNumber;
  final LossType type;
  final Money amount;
  final String description;
  final LossStatus status;
  final String? staffUid;
  final String? staffName;
  final DateTime? incidentDate;
  final Money approvedRecovery;
  final Money recovered;
  final Money outstanding;
  final String? recoveryReason;
  final String? rejectionReason;
  final String? reportedByName;
  final String? reviewedByName;
  final String? reviewNotes;
  final String? approvedByName;
  final String? deductionId;
  final String? deductionNumber;
  final String? cancelReason;
  final Money cancelledOutstanding;
  final String? attachmentPath;
  final String? notes;
  final DateTime? createdAt;

  bool get canSchedule =>
      (status == LossStatus.approved || status == LossStatus.partiallyRecovered) && deductionId == null && outstanding.isPositive;
  bool get canCancel => !const {LossStatus.rejected, LossStatus.recovered, LossStatus.cancelled}.contains(status);

  static LossIncident fromFirestore(String id, Map<String, dynamic> d) => LossIncident(
        incidentId: id,
        lossNumber: d['lossNumber'] as String? ?? '',
        type: LossType.parse(d['incidentType']),
        amount: _m(d['amountUgx']),
        description: d['description'] as String? ?? '',
        status: LossStatus.parse(d['status']),
        staffUid: d['staffUid'] as String?,
        staffName: d['staffName'] as String?,
        incidentDate: FirestoreConverters.toDateTime(d['incidentDate']),
        approvedRecovery: _m(d['approvedRecoveryUgx']),
        recovered: _m(d['recoveredUgx']),
        outstanding: _m(d['outstandingUgx']),
        recoveryReason: d['recoveryReason'] as String?,
        rejectionReason: d['rejectionReason'] as String?,
        reportedByName: d['reportedByName'] as String?,
        reviewedByName: d['reviewedByName'] as String?,
        reviewNotes: d['reviewNotes'] as String?,
        approvedByName: d['approvedByName'] as String?,
        deductionId: d['deductionId'] as String?,
        deductionNumber: d['deductionNumber'] as String?,
        cancelReason: d['cancelReason'] as String?,
        cancelledOutstanding: _m(d['cancelledOutstandingUgx']),
        attachmentPath: d['attachmentPath'] as String?,
        notes: d['notes'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
      );
}
