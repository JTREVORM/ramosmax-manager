import 'firestore_converters.dart';

/// Status of one service line of a job, carried out by one worker.
///
/// The allowed moves are enforced by the server
/// (functions/src/jobs.js); the app only offers the buttons that fit.
enum WorkOrderStatus {
  pending('pending', 'Pending'),
  assigned('assigned', 'Assigned'),
  accepted('accepted', 'Accepted'),
  inProgress('in_progress', 'In progress'),
  paused('paused', 'Paused'),
  completed('completed', 'Completed'),
  cancelled('cancelled', 'Cancelled');

  const WorkOrderStatus(this.key, this.label);
  final String key;
  final String label;

  static WorkOrderStatus parse(Object? value) =>
      values.firstWhere((s) => s.key == value, orElse: () => pending);

  bool get isFinished => this == completed || this == cancelled;

  /// Being worked on right now (or about to be).
  bool get isActive => this == accepted || this == inProgress || this == paused;
}

/// Actions a worker takes on their own order, and the state each needs.
enum WorkerAction {
  accept('accept', 'Accept', 'accepted', WorkOrderStatus.assigned),
  start('start', 'Start', 'started', WorkOrderStatus.accepted),
  pause('pause', 'Pause', 'paused', WorkOrderStatus.inProgress),
  resume('resume', 'Resume', 'resumed', WorkOrderStatus.paused),
  complete('complete', 'Complete', 'completed', WorkOrderStatus.inProgress);

  const WorkerAction(this.key, this.label, this.done, this.from);
  final String key;
  final String label;

  /// Past tense for confirmations, e.g. "accepted".
  final String done;
  final WorkOrderStatus from;

  static List<WorkerAction> availableFor(WorkOrderStatus status) =>
      [for (final a in values) if (a.from == status) a];
}

/// One entry of an order's assignment history. Reassignment closes the
/// previous entry ([endedAt], [reason]); nothing is removed.
class AssignmentEntry {
  const AssignmentEntry({required this.workerId, this.workerName, this.assignedBy, this.assignedAt, this.endedAt, this.reason});

  final String workerId;
  final String? workerName;
  final String? assignedBy;
  final DateTime? assignedAt;
  final DateTime? endedAt;
  final String? reason;

  static AssignmentEntry fromMap(Map<String, dynamic> m) => AssignmentEntry(
        workerId: m['workerId'] as String? ?? '',
        workerName: m['workerName'] as String?,
        assignedBy: m['assignedBy'] as String?,
        assignedAt: FirestoreConverters.toDateTime(m['assignedAt']),
        endedAt: FirestoreConverters.toDateTime(m['endedAt']),
        reason: m['reason'] as String?,
      );
}

/// Compact copy of an order kept on its job (`service_intakes.orders`), so a
/// job list shows who is doing what without reading every order.
class WorkOrderSummary {
  const WorkOrderSummary({
    required this.workerOrderId,
    required this.orderNumber,
    required this.serviceName,
    required this.status,
    this.serviceId,
    this.workerId,
    this.workerName,
  });

  final String workerOrderId;
  final String orderNumber;
  final String? serviceId;
  final String serviceName;
  final String? workerId;
  final String? workerName;
  final WorkOrderStatus status;

  static WorkOrderSummary fromMap(Map<String, dynamic> m) => WorkOrderSummary(
        workerOrderId: m['workerOrderId'] as String? ?? '',
        orderNumber: m['orderNumber'] as String? ?? '',
        serviceId: m['serviceId'] as String?,
        serviceName: m['serviceName'] as String? ?? '',
        workerId: m['workerId'] as String?,
        workerName: m['workerName'] as String?,
        status: WorkOrderStatus.parse(m['status']),
      );
}

/// `worker_orders/{id}`: one service of a job, assigned to one worker.
/// Written only by the Cloud Functions.
class WorkOrder {
  const WorkOrder({
    required this.workerOrderId,
    required this.orderNumber,
    required this.serviceIntakeId,
    required this.jobNumber,
    required this.vehicleId,
    required this.numberPlate,
    required this.serviceName,
    required this.status,
    this.vehicleSummary,
    this.serviceId,
    this.workerId,
    this.workerName,
    this.assignedAt,
    this.acceptedAt,
    this.startedAt,
    this.pausedAt,
    this.completedAt,
    this.cancelledAt,
    this.totalPausedMs = 0,
    this.notes,
    this.completionNotes,
    this.pauseReason,
    this.cancelReason,
    this.lastReassignReason,
    this.assignmentHistory = const [],
    this.createdAt,
  });

  final String workerOrderId;
  final String orderNumber;
  final String serviceIntakeId;
  final String jobNumber;
  final String vehicleId;
  final String numberPlate;
  final String? vehicleSummary;
  final String? serviceId;
  final String serviceName;
  final WorkOrderStatus status;
  final String? workerId;
  final String? workerName;
  final DateTime? assignedAt;
  final DateTime? acceptedAt;
  final DateTime? startedAt;
  final DateTime? pausedAt;
  final DateTime? completedAt;
  final DateTime? cancelledAt;
  final int totalPausedMs;
  final String? notes;
  final String? completionNotes;
  final String? pauseReason;
  final String? cancelReason;
  final String? lastReassignReason;
  final List<AssignmentEntry> assignmentHistory;
  final DateTime? createdAt;

  List<WorkerAction> get workerActions => WorkerAction.availableFor(status);

  /// Time actually worked: start → completion (or now / the pause), minus pauses.
  Duration workedTime(DateTime now) {
    final start = startedAt;
    if (start == null) return Duration.zero;
    final end = completedAt ?? (status == WorkOrderStatus.paused ? pausedAt : null) ?? now;
    final ms = end.difference(start).inMilliseconds - totalPausedMs;
    return Duration(milliseconds: ms < 0 ? 0 : ms);
  }

  static WorkOrder fromFirestore(String id, Map<String, dynamic> d) => WorkOrder(
        workerOrderId: id,
        orderNumber: d['orderNumber'] as String? ?? '',
        serviceIntakeId: d['serviceIntakeId'] as String? ?? '',
        jobNumber: d['jobNumber'] as String? ?? '',
        vehicleId: d['vehicleId'] as String? ?? '',
        numberPlate: d['numberPlate'] as String? ?? '',
        vehicleSummary: d['vehicleSummary'] as String?,
        serviceId: d['serviceId'] as String?,
        serviceName: d['serviceName'] as String? ?? '',
        status: WorkOrderStatus.parse(d['status']),
        workerId: d['workerId'] as String?,
        workerName: d['workerName'] as String?,
        assignedAt: FirestoreConverters.toDateTime(d['assignedAt']),
        acceptedAt: FirestoreConverters.toDateTime(d['acceptedAt']),
        startedAt: FirestoreConverters.toDateTime(d['startedAt']),
        pausedAt: FirestoreConverters.toDateTime(d['pausedAt']),
        completedAt: FirestoreConverters.toDateTime(d['completedAt']),
        cancelledAt: FirestoreConverters.toDateTime(d['cancelledAt']),
        totalPausedMs: (d['totalPausedMs'] as num?)?.toInt() ?? 0,
        notes: d['notes'] as String?,
        completionNotes: d['completionNotes'] as String?,
        pauseReason: d['pauseReason'] as String?,
        cancelReason: d['cancelReason'] as String?,
        lastReassignReason: d['lastReassignReason'] as String?,
        assignmentHistory: [
          for (final h in (d['assignmentHistory'] as List? ?? const []))
            if (h is Map) AssignmentEntry.fromMap(h.map((k, v) => MapEntry(k.toString(), v))),
        ],
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
      );
}
