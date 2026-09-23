import '../core/money/money.dart';
import 'catalog_service.dart';
import 'firestore_converters.dart';
import 'work_order.dart';

enum IntakeStatus {
  draft('draft', 'Draft'),
  open('open', 'Open'),
  completed('completed', 'Completed'),
  cancelled('cancelled', 'Cancelled');

  const IntakeStatus(this.key, this.label);
  final String key;
  final String label;

  static IntakeStatus parse(Object? value) => switch (value) {
        'draft' => draft,
        'completed' => completed,
        'cancelled' => cancelled,
        _ => open,
      };
}

/// A service as it was selected at intake time. The price is a snapshot, so
/// later catalogue price changes never rewrite a visit (Phase 4 invoices
/// from these lines).
class SelectedService {
  const SelectedService({
    required this.serviceId,
    required this.name,
    required this.category,
    required this.price,
    this.qualifiesForLoyalty = false,
  });

  final String serviceId;
  final String name;
  final ServiceCategory category;
  final Money price;
  final bool qualifiesForLoyalty;

  static SelectedService fromMap(Map<String, dynamic> m) => SelectedService(
        serviceId: m['serviceId'] as String? ?? '',
        name: m['name'] as String? ?? '',
        category: ServiceCategory.parse(m['category']),
        price: Money((m['priceUgx'] as num?)?.toInt() ?? 0),
        qualifiesForLoyalty: m['qualifiesForLoyalty'] == true,
      );
}

/// A job at `service_intakes/{intakeId}` (`RMX-JOB-000001`): which vehicle
/// came in, which services were requested (with price snapshots), a summary
/// of each service's worker order and, once completed, its invoice. Written
/// only by the Cloud Functions (functions/src/jobs.js).
class ServiceIntake {
  const ServiceIntake({
    required this.intakeId,
    required this.vehicleId,
    required this.numberPlate,
    required this.status,
    required this.selectedServices,
    this.vehicleSummary,
    this.customerId,
    this.customerName,
    this.notes,
    this.cancelReason,
    this.createdAt,
    this.createdBy,
    this.createdByName,
    this.jobNumber,
    this.orders = const [],
    this.workerIds = const [],
    this.invoiceId,
    this.invoiceNumber,
    this.completedAt,
  });

  final String intakeId;
  final String vehicleId;

  /// Plate at intake time (kept even if the plate is later corrected).
  final String numberPlate;
  final String? vehicleSummary;
  final String? customerId;
  final String? customerName;
  final IntakeStatus status;
  final List<SelectedService> selectedServices;
  final String? notes;
  final String? cancelReason;
  final DateTime? createdAt;
  final String? createdBy;
  final String? createdByName;

  /// `RMX-JOB-000001`; null on Phase 3 intakes created before jobs existed.
  final String? jobNumber;
  final List<WorkOrderSummary> orders;
  final List<String> workerIds;
  final String? invoiceId;
  final String? invoiceNumber;
  final DateTime? completedAt;

  String get reference => jobNumber ?? 'Intake';

  bool get isInvoiced => invoiceId != null;

  /// Completed, not yet invoiced: ready for the cashier.
  bool get awaitingInvoice => status == IntakeStatus.completed && !isInvoiced;

  int get completedOrders => orders.where((o) => o.status == WorkOrderStatus.completed).length;
  int get liveOrders => orders.where((o) => o.status != WorkOrderStatus.cancelled).length;

  bool get isOpen => status == IntakeStatus.open || status == IntakeStatus.draft;

  static ServiceIntake fromFirestore(String id, Map<String, dynamic> d) => ServiceIntake(
        intakeId: id,
        vehicleId: d['vehicleId'] as String? ?? '',
        numberPlate: d['numberPlate'] as String? ?? '',
        vehicleSummary: d['vehicleSummary'] as String?,
        customerId: d['customerId'] as String?,
        customerName: d['customerName'] as String?,
        status: IntakeStatus.parse(d['status']),
        selectedServices: [
          for (final s in (d['selectedServices'] as List? ?? const []))
            if (s is Map) SelectedService.fromMap(s.map((k, v) => MapEntry(k.toString(), v))),
        ],
        notes: d['notes'] as String?,
        cancelReason: d['cancelReason'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        createdBy: d['createdBy'] as String?,
        createdByName: d['createdByName'] as String?,
        jobNumber: d['jobNumber'] as String?,
        orders: [
          for (final o in (d['orders'] as List? ?? const []))
            if (o is Map) WorkOrderSummary.fromMap(o.map((k, v) => MapEntry(k.toString(), v))),
        ],
        workerIds: [for (final w in (d['workerIds'] as List? ?? const [])) if (w is String) w],
        invoiceId: d['invoiceId'] as String?,
        invoiceNumber: d['invoiceNumber'] as String?,
        completedAt: FirestoreConverters.toDateTime(d['completedAt']),
      );
}
