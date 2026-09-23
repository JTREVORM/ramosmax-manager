import '../core/money/money.dart';
import 'firestore_converters.dart';

/// Item categories. Mirrors `inventoryCategories` in
/// functions/src/access_catalog.json (checked by a unit test).
enum InventoryCategory {
  chemicals('chemicals', 'Chemicals'),
  soapsShampoo('soaps_shampoo', 'Soaps & shampoo'),
  waxPolish('wax_polish', 'Wax & polish'),
  towelsCloths('towels_cloths', 'Towels & cloths'),
  brushesTools('brushes_tools', 'Brushes & tools'),
  cleaningMaterials('cleaning_materials', 'Cleaning materials'),
  spareParts('spare_parts', 'Spare parts'),
  other('other', 'Other supplies');

  const InventoryCategory(this.key, this.label);
  final String key;
  final String label;

  static InventoryCategory parse(Object? v) => values.firstWhere((c) => c.key == v, orElse: () => other);
}

/// Units of measure. Mirrors `inventoryUnits` in access_catalog.json.
enum InventoryUnit {
  piece('piece', 'Piece'),
  bottle('bottle', 'Bottle'),
  litre('litre', 'Litre'),
  kg('kg', 'Kilogram'),
  pack('pack', 'Pack'),
  box('box', 'Box'),
  roll('roll', 'Roll'),
  pair('pair', 'Pair'),
  set('set', 'Set'),
  can('can', 'Can'),
  other('other', 'Unit');

  const InventoryUnit(this.key, this.label);
  final String key;
  final String label;

  static InventoryUnit parse(Object? v) => values.firstWhere((u) => u.key == v, orElse: () => other);

  /// `3 bottles`, `1 kg`.
  String quantity(int n) {
    final name = this == kg ? 'kg' : label.toLowerCase();
    if (this == kg || n == 1) return '$n $name';
    final plural = RegExp(r'(s|x|ch|sh)$').hasMatch(name) ? '${name}es' : '${name}s';
    return '$n $plural';
  }
}

/// OK / LOW / OUT_OF_STOCK. Same rule as stockStatusFor in functions/src/inventory.js.
enum StockStatus {
  ok('ok', 'OK'),
  low('low', 'Low'),
  outOfStock('out_of_stock', 'Out of stock');

  const StockStatus(this.key, this.label);
  final String key;
  final String label;

  static StockStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => ok);

  static StockStatus of(int quantity, int minimumStock, int reorderLevel) {
    if (quantity <= 0) return outOfStock;
    if (quantity <= (minimumStock > reorderLevel ? minimumStock : reorderLevel)) return low;
    return ok;
  }

  static const List<StockStatus> needsAttention = [low, outOfStock];
}

/// `inventory_items/{id}`. [quantity] changes only through stock movements
/// written by the Cloud Functions.
class InventoryItem {
  const InventoryItem({
    required this.itemId,
    required this.sku,
    required this.name,
    required this.category,
    required this.unit,
    required this.quantity,
    required this.minimumStock,
    required this.reorderLevel,
    required this.stockStatus,
    required this.active,
    this.description,
    this.isConsumable = true,
    this.preferredSupplierId,
    this.preferredSupplierName,
    this.lastUnitCost,
    this.lastMovementAt,
  });

  final String itemId;
  final String sku;
  final String name;
  final InventoryCategory category;
  final InventoryUnit unit;
  final int quantity;
  final int minimumStock;
  final int reorderLevel;
  final StockStatus stockStatus;
  final bool active;
  final String? description;
  final bool isConsumable;
  final String? preferredSupplierId;
  final String? preferredSupplierName;

  /// Unit cost on the most recent stock-in that recorded one.
  final Money? lastUnitCost;
  final DateTime? lastMovementAt;

  /// Quantity × last unit cost — indicative only (not an accounting valuation).
  Money? get indicativeValue => lastUnitCost?.times(quantity);

  static InventoryItem fromFirestore(String id, Map<String, dynamic> d) {
    final q = (d['quantity'] as num?)?.toInt() ?? 0;
    final min = (d['minimumStock'] as num?)?.toInt() ?? 0;
    final reorder = (d['reorderLevel'] as num?)?.toInt() ?? 0;
    return InventoryItem(
      itemId: id,
      sku: d['sku'] as String? ?? '',
      name: d['name'] as String? ?? '',
      category: InventoryCategory.parse(d['category']),
      unit: InventoryUnit.parse(d['unit']),
      quantity: q,
      minimumStock: min,
      reorderLevel: reorder,
      stockStatus: d['stockStatus'] == null ? StockStatus.of(q, min, reorder) : StockStatus.parse(d['stockStatus']),
      active: d['active'] == true,
      description: d['description'] as String?,
      isConsumable: d['isConsumable'] != false,
      preferredSupplierId: d['preferredSupplierId'] as String?,
      preferredSupplierName: d['preferredSupplierName'] as String?,
      lastUnitCost: d['lastUnitCostUgx'] == null ? null : Money((d['lastUnitCostUgx'] as num).toInt()),
      lastMovementAt: FirestoreConverters.toDateTime(d['lastMovementAt']),
    );
  }
}

/// Stock movement kinds. Mirrors functions/src/inventory.js.
enum MovementType {
  stockIn('stock_in', 'Stock in'),
  usage('usage', 'Used'),
  stockOut('stock_out', 'Stock out'),
  returned('return', 'Returned to supplier'),
  adjustmentIn('adjustment_in', 'Adjustment +'),
  adjustmentOut('adjustment_out', 'Adjustment −'),
  reversal('reversal', 'Reversal');

  const MovementType(this.key, this.label);
  final String key;
  final String label;

  static MovementType parse(Object? v) => values.firstWhere((t) => t.key == v, orElse: () => adjustmentIn);

  /// Types a person records directly with recordStockMovement.
  static const List<MovementType> manual = [usage, stockOut, stockIn, returned];
  bool get isIncrease => this == stockIn || this == adjustmentIn;
}

enum StockOutReason {
  damaged('damaged', 'Damaged'),
  expired('expired', 'Expired'),
  wastage('wastage', 'Wastage'),
  internalUse('internal_use', 'Approved internal use'),
  other('other', 'Other');

  const StockOutReason(this.key, this.label);
  final String key;
  final String label;

  static StockOutReason? tryParse(Object? v) {
    for (final r in values) {
      if (r.key == v) return r;
    }
    return null;
  }
}

/// `stock_movements/{id}` — immutable.
class StockMovement {
  const StockMovement({
    required this.movementId,
    required this.movementNumber,
    required this.itemId,
    required this.itemName,
    required this.type,
    required this.quantityChange,
    required this.quantityAfter,
    required this.unit,
    required this.reversed,
    this.sku,
    this.reason,
    this.reasonCode,
    this.reference,
    this.purchaseNumber,
    this.jobNumber,
    this.workerName,
    this.unitCost,
    this.createdByName,
    this.createdAt,
    this.purchaseId,
  });

  final String movementId;
  final String movementNumber;
  final String itemId;
  final String itemName;
  final String? sku;
  final MovementType type;
  final int quantityChange;
  final int quantityAfter;
  final InventoryUnit unit;
  final bool reversed;
  final String? reason;
  final StockOutReason? reasonCode;
  final String? reference;
  final String? purchaseId;
  final String? purchaseNumber;
  final String? jobNumber;
  final String? workerName;
  final Money? unitCost;
  final String? createdByName;
  final DateTime? createdAt;

  bool get canReverse => !reversed && type != MovementType.reversal && purchaseId == null;

  static StockMovement fromFirestore(String id, Map<String, dynamic> d) => StockMovement(
        movementId: id,
        movementNumber: d['movementNumber'] as String? ?? '',
        itemId: d['itemId'] as String? ?? '',
        itemName: d['itemName'] as String? ?? '',
        sku: d['sku'] as String?,
        type: MovementType.parse(d['type']),
        quantityChange: (d['quantityChange'] as num?)?.toInt() ?? 0,
        quantityAfter: (d['quantityAfter'] as num?)?.toInt() ?? 0,
        unit: InventoryUnit.parse(d['unit']),
        reversed: d['status'] == 'reversed',
        reason: d['reason'] as String?,
        reasonCode: StockOutReason.tryParse(d['reasonCode']),
        reference: d['reference'] as String?,
        purchaseId: d['purchaseId'] as String?,
        purchaseNumber: d['purchaseNumber'] as String?,
        jobNumber: d['jobNumber'] as String?,
        workerName: d['workerName'] as String?,
        unitCost: d['unitCostUgx'] == null ? null : Money((d['unitCostUgx'] as num).toInt()),
        createdByName: d['createdByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
      );
}

/// `suppliers/{id}`.
class Supplier {
  const Supplier({
    required this.supplierId,
    required this.supplierNumber,
    required this.name,
    required this.active,
    this.contactPerson,
    this.phone,
    this.email,
    this.address,
    this.notes,
    this.purchaseCount = 0,
    this.totalPurchased = Money.zero,
  });

  final String supplierId;
  final String supplierNumber;
  final String name;
  final bool active;
  final String? contactPerson;
  final String? phone;
  final String? email;
  final String? address;
  final String? notes;
  final int purchaseCount;
  final Money totalPurchased;

  static Supplier fromFirestore(String id, Map<String, dynamic> d) => Supplier(
        supplierId: id,
        supplierNumber: d['supplierNumber'] as String? ?? '',
        name: d['name'] as String? ?? '',
        active: d['active'] == true,
        contactPerson: d['contactPerson'] as String?,
        phone: d['phone'] as String?,
        email: d['email'] as String?,
        address: d['address'] as String?,
        notes: d['notes'] as String?,
        purchaseCount: (d['purchaseCount'] as num?)?.toInt() ?? 0,
        totalPurchased: Money((d['totalPurchasedUgx'] as num?)?.toInt() ?? 0),
      );
}

enum PurchaseStatus {
  pendingApproval('pending_approval', 'Awaiting approval'),
  approved('approved', 'Approved'),
  received('received', 'Received'),
  cancelled('cancelled', 'Cancelled');

  const PurchaseStatus(this.key, this.label);
  final String key;
  final String label;

  static PurchaseStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => pendingApproval);
}

class PurchaseLine {
  const PurchaseLine({required this.itemId, required this.name, required this.quantity, required this.unitCost, this.unit = InventoryUnit.other, this.sku});
  final String itemId;
  final String name;
  final String? sku;
  final InventoryUnit unit;
  final int quantity;
  final Money unitCost;

  Money get total => unitCost.times(quantity);
}

/// `inventory_purchases/{id}` — stock acquisition, not an operating expense.
class InventoryPurchase {
  const InventoryPurchase({
    required this.purchaseId,
    required this.purchaseNumber,
    required this.supplierId,
    required this.supplierName,
    required this.lines,
    required this.total,
    required this.status,
    required this.paid,
    this.supplierReference,
    this.purchaseDate,
    this.notes,
    this.createdByName,
    this.createdAt,
    this.paidFromAccountId,
    this.financialTransactionId,
  });

  final String purchaseId;
  final String purchaseNumber;
  final String supplierId;
  final String supplierName;
  final List<PurchaseLine> lines;
  final Money total;
  final PurchaseStatus status;
  final bool paid;
  final String? supplierReference;
  final DateTime? purchaseDate;
  final String? notes;
  final String? createdByName;
  final DateTime? createdAt;
  final String? paidFromAccountId;
  final String? financialTransactionId;

  bool get canApprove => status == PurchaseStatus.pendingApproval;
  bool get canReceive => status == PurchaseStatus.approved;
  bool get canPay => !paid && (status == PurchaseStatus.approved || status == PurchaseStatus.received);
  bool get canCancel => !paid && (status == PurchaseStatus.pendingApproval || status == PurchaseStatus.approved);

  static InventoryPurchase fromFirestore(String id, Map<String, dynamic> d) => InventoryPurchase(
        purchaseId: id,
        purchaseNumber: d['purchaseNumber'] as String? ?? '',
        supplierId: d['supplierId'] as String? ?? '',
        supplierName: d['supplierName'] as String? ?? '',
        lines: [
          for (final l in (d['items'] as List? ?? const []))
            if (l is Map)
              PurchaseLine(
                itemId: l['itemId'] as String? ?? '',
                name: l['name'] as String? ?? '',
                sku: l['sku'] as String?,
                unit: InventoryUnit.parse(l['unit']),
                quantity: (l['quantity'] as num?)?.toInt() ?? 0,
                unitCost: Money((l['unitCostUgx'] as num?)?.toInt() ?? 0),
              ),
        ],
        total: Money((d['totalUgx'] as num?)?.toInt() ?? 0),
        status: PurchaseStatus.parse(d['status']),
        paid: d['paymentStatus'] == 'paid',
        supplierReference: d['supplierReference'] as String?,
        purchaseDate: FirestoreConverters.toDateTime(d['purchaseDate']),
        notes: d['notes'] as String?,
        createdByName: d['createdByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        paidFromAccountId: d['paidFromAccountId'] as String?,
        financialTransactionId: d['financialTransactionId'] as String?,
      );
}
