import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/attendance.dart';
import '../../../models/payroll.dart';

/// Reads for attendance, allowances, salaries, payroll and losses. Bounded and
/// index-backed (firebase/firestore.indexes.json); offline they come from the
/// cache. Queries for one's OWN records always filter on `staffUid` (and
/// `visibleToStaff` where the rules require it) - firebase/firestore.rules
/// refuses anything broader. Writes go through [WorkforceApi].
class WorkforceRepository {
  WorkforceRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 100;

  CollectionReference<Map<String, dynamic>> _c(String name) => _db.collection(name);

  // --- policy ---

  Stream<WorkforcePolicy> watchPolicy() => _c(FirestoreCollections.settings)
      .doc(FirestoreDocs.payrollPolicy)
      .snapshots()
      .map((s) => WorkforcePolicy.fromFirestore(s.data()));

  // --- attendance ---

  List<AttendanceRecord> _att(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) AttendanceRecord.fromFirestore(d.id, d.data())];

  /// Everyone's attendance on one EAT day (attendance.view). Index: (dayKey, staffName).
  Stream<List<AttendanceRecord>> watchDay(String dayKey) =>
      _c(FirestoreCollections.attendance).where('dayKey', isEqualTo: dayKey).orderBy('staffName').limit(200).snapshots().map(_att);

  /// Waiting for verification, newest first. Index: (verificationStatus, date desc).
  Stream<List<AttendanceRecord>> watchPendingAttendance() => _c(FirestoreCollections.attendance)
      .where('verificationStatus', isEqualTo: 'pending')
      .orderBy('date', descending: true)
      .limit(listLimit)
      .snapshots()
      .map(_att);

  /// One person's history, newest first (their own, or attendance.view). Index: (staffUid, date desc).
  Stream<List<AttendanceRecord>> watchStaffAttendance(String staffUid, {int limit = 62}) => _c(FirestoreCollections.attendance)
      .where('staffUid', isEqualTo: staffUid)
      .orderBy('date', descending: true)
      .limit(limit)
      .snapshots()
      .map(_att);

  Stream<AttendanceRecord?> watchAttendance(String id) => _c(FirestoreCollections.attendance)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? AttendanceRecord.fromFirestore(s.id, s.data()!) : null);

  /// Corrections of one record. [staffUid] keeps a worker's query inside the rules.
  Stream<List<AttendanceCorrection>> watchCorrections(String attendanceId, {String? staffUid}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.attendanceCorrections).where('attendanceId', isEqualTo: attendanceId);
    if (staffUid != null) q = q.where('staffUid', isEqualTo: staffUid);
    return q
        .orderBy('createdAt', descending: true)
        .limit(20)
        .snapshots()
        .map((s) => [for (final d in s.docs) AttendanceCorrection.fromFirestore(d.id, d.data())]);
  }

  // --- allowances ---

  List<WorkerAllowance> _alw(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) WorkerAllowance.fromFirestore(d.id, d.data())];

  /// By status, newest day first (allowances.view). Index: (status, date desc).
  Stream<List<WorkerAllowance>> watchAllowances(AllowanceStatus status) => _c(FirestoreCollections.workerAllowances)
      .where('status', isEqualTo: status.key)
      .orderBy('date', descending: true)
      .limit(200)
      .snapshots()
      .map(_alw);

  /// One person's allowances (their own, or allowances.view). Index: (staffUid, date desc).
  Stream<List<WorkerAllowance>> watchStaffAllowances(String staffUid) => _c(FirestoreCollections.workerAllowances)
      .where('staffUid', isEqualTo: staffUid)
      .orderBy('date', descending: true)
      .limit(listLimit)
      .snapshots()
      .map(_alw);

  // --- salaries ---

  Stream<List<SalaryVersion>> watchSalaryProfiles() => _c(FirestoreCollections.salaryProfiles)
      .orderBy('staffName')
      .limit(200)
      .snapshots()
      .map((s) => [for (final d in s.docs) SalaryVersion.fromFirestore(d.data())]);

  Stream<SalaryVersion?> watchSalaryProfile(String staffUid) => _c(FirestoreCollections.salaryProfiles)
      .doc(staffUid)
      .snapshots()
      .map((s) => s.exists ? SalaryVersion.fromFirestore(s.data()!) : null);

  /// Every version, newest first (salary.history.view, or one's own). Index: (staffUid, effectiveFrom desc).
  Stream<List<SalaryVersion>> watchSalaryHistory(String staffUid) => _c(FirestoreCollections.salaryHistory)
      .where('staffUid', isEqualTo: staffUid)
      .orderBy('effectiveFrom', descending: true)
      .limit(60)
      .snapshots()
      .map((s) => [for (final d in s.docs) SalaryVersion.fromFirestore(d.data())]);

  // --- payroll ---

  Stream<List<PayrollRun>> watchPayrolls() => _c(FirestoreCollections.payroll)
      .orderBy('periodStart', descending: true)
      .limit(48)
      .snapshots()
      .map((s) => [for (final d in s.docs) PayrollRun.fromFirestore(d.id, d.data())]);

  Stream<PayrollRun?> watchPayroll(String id) =>
      _c(FirestoreCollections.payroll).doc(id).snapshots().map((s) => s.exists ? PayrollRun.fromFirestore(s.id, s.data()!) : null);

  /// The current version's items. Index: (payrollId, current, staffName).
  Stream<List<PayrollItem>> watchPayrollItems(String payrollId) => _c(FirestoreCollections.payrollItems)
      .where('payrollId', isEqualTo: payrollId)
      .where('current', isEqualTo: true)
      .orderBy('staffName')
      .limit(300)
      .snapshots()
      .map((s) => [for (final d in s.docs) PayrollItem.fromFirestore(d.id, d.data())]);

  /// A person's payslips once paid. Index: (staffUid, visibleToStaff, periodStart desc).
  Stream<List<PayrollItem>> watchPayslips(String staffUid) => _c(FirestoreCollections.payrollItems)
      .where('staffUid', isEqualTo: staffUid)
      .where('visibleToStaff', isEqualTo: true)
      .orderBy('periodStart', descending: true)
      .limit(36)
      .snapshots()
      .map((s) => [for (final d in s.docs) PayrollItem.fromFirestore(d.id, d.data())]);

  // --- deductions and losses ---

  List<SalaryDeduction> _ded(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) SalaryDeduction.fromFirestore(d.id, d.data())];

  /// Index: (status, createdAt desc).
  Stream<List<SalaryDeduction>> watchDeductions({DeductionStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.salaryDeductions);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_ded);
  }

  /// Index: (staffUid, createdAt desc).
  Stream<List<SalaryDeduction>> watchStaffDeductions(String staffUid) => _c(FirestoreCollections.salaryDeductions)
      .where('staffUid', isEqualTo: staffUid)
      .orderBy('createdAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map(_ded);

  Stream<SalaryDeduction?> watchDeduction(String id) => _c(FirestoreCollections.salaryDeductions)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? SalaryDeduction.fromFirestore(s.id, s.data()!) : null);

  List<LossIncident> _loss(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) LossIncident.fromFirestore(d.id, d.data())];

  /// Index: (status, createdAt desc).
  Stream<List<LossIncident>> watchLosses({LossStatus? status}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.lossIncidents);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_loss);
  }

  /// Decided incidents about [staffUid]. Index: (staffUid, visibleToStaff, createdAt desc).
  Stream<List<LossIncident>> watchStaffLosses(String staffUid) => _c(FirestoreCollections.lossIncidents)
      .where('staffUid', isEqualTo: staffUid)
      .where('visibleToStaff', isEqualTo: true)
      .orderBy('createdAt', descending: true)
      .limit(50)
      .snapshots()
      .map(_loss);

  Stream<LossIncident?> watchLoss(String id) => _c(FirestoreCollections.lossIncidents)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? LossIncident.fromFirestore(s.id, s.data()!) : null);
}
