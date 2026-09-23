import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../models/inventory.dart';
import '../data/inventory_api.dart';
import '../data/inventory_repository.dart';

final inventoryRepositoryProvider = Provider<InventoryRepository>((ref) => InventoryRepository(ref.watch(firestoreProvider)));

final inventoryApiProvider = Provider<InventoryApi>((ref) => CallableInventoryApi(ref.watch(firebaseFunctionsProvider)));

final inventoryItemsProvider = StreamProvider<List<InventoryItem>>((ref) => ref.watch(inventoryRepositoryProvider).watchItems());

final lowStockProvider = StreamProvider<List<InventoryItem>>((ref) => ref.watch(inventoryRepositoryProvider).watchLowStock());

final inventoryItemProvider =
    StreamProvider.family<InventoryItem?, String>((ref, id) => ref.watch(inventoryRepositoryProvider).watchItem(id));

final itemMovementsProvider = StreamProvider.family<List<StockMovement>, String>(
    (ref, itemId) => ref.watch(inventoryRepositoryProvider).watchItemMovements(itemId));

final stockMovementsProvider = StreamProvider.family<List<StockMovement>, MovementType?>(
    (ref, type) => ref.watch(inventoryRepositoryProvider).watchMovements(type: type));

final suppliersProvider = StreamProvider<List<Supplier>>((ref) => ref.watch(inventoryRepositoryProvider).watchSuppliers());

final supplierProvider = StreamProvider.family<Supplier?, String>((ref, id) => ref.watch(inventoryRepositoryProvider).watchSupplier(id));

final purchasesProvider = StreamProvider.family<List<InventoryPurchase>, ({PurchaseStatus? status, String? supplierId})>(
    (ref, f) => ref.watch(inventoryRepositoryProvider).watchPurchases(status: f.status, supplierId: f.supplierId));

final purchaseProvider =
    StreamProvider.family<InventoryPurchase?, String>((ref, id) => ref.watch(inventoryRepositoryProvider).watchPurchase(id));

/// Stock figures for the inventory dashboard and reports.
class StockSummary {
  const StockSummary({
    required this.activeItems,
    required this.low,
    required this.outOfStock,
    required this.indicativeValue,
    required this.itemsWithoutCost,
  });

  final int activeItems;
  final int low;
  final int outOfStock;

  /// Σ quantity × last purchase cost over items that have a cost. Indicative
  /// only: Phase 5 implements no inventory costing method (FIFO/average).
  final Money indicativeValue;
  final int itemsWithoutCost;

  static StockSummary of(Iterable<InventoryItem> items) {
    var active = 0, low = 0, out = 0, noCost = 0;
    var value = Money.zero;
    for (final i in items) {
      if (!i.active) continue;
      active++;
      if (i.stockStatus == StockStatus.low) low++;
      if (i.stockStatus == StockStatus.outOfStock) out++;
      final v = i.indicativeValue;
      if (v == null) {
        if (i.quantity > 0) noCost++;
      } else {
        value += v;
      }
    }
    return StockSummary(activeItems: active, low: low, outOfStock: out, indicativeValue: value, itemsWithoutCost: noCost);
  }
}

/// Matches name, SKU or category label (case-insensitive).
bool itemMatches(InventoryItem i, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  return i.name.toLowerCase().contains(q) || i.sku.toLowerCase().contains(q) || i.category.label.toLowerCase().contains(q);
}

final inventoryActionsProvider = Provider<InventoryActions>(InventoryActions.new);

/// Inventory commands (online-only: quantities change only on the server).
class InventoryActions {
  InventoryActions(this._ref);
  final Ref _ref;

  InventoryApi get _api => _ref.read(inventoryApiProvider);

  Future<Result<T>> _run<T>(String outcome, Future<Result<T>> Function() action) =>
      runOnline(_ref, action, event: AnalyticsEvents.inventoryAction, params: {'outcome': outcome});

  Future<Result<String>> createItem(ItemDraft draft, {String? sku, int openingQuantity = 0}) =>
      _run('item_created', () => _api.createItem(draft, sku: sku, openingQuantity: openingQuantity));

  Future<Result<void>> updateItem(String itemId, ItemDraft draft, {bool? active, String? reason}) =>
      _run('item_updated', () => _api.updateItem(itemId, draft, active: active, reason: reason));

  Future<Result<void>> recordMovement({
    required String itemId,
    required MovementType type,
    required int quantity,
    required String reason,
    required String requestId,
    StockOutReason? reasonCode,
    String? reference,
    Money? unitCost,
    String? workerId,
  }) =>
      _run(type.key, () => _api.recordMovement(
          itemId: itemId, type: type, quantity: quantity, reason: reason, requestId: requestId,
          reasonCode: reasonCode, reference: reference, unitCost: unitCost, workerId: workerId));

  Future<Result<void>> adjust(String itemId, {required int countedQuantity, required String reason, required String requestId}) =>
      _run('adjustment', () => _api.adjust(itemId, countedQuantity: countedQuantity, reason: reason, requestId: requestId));

  Future<Result<void>> reverseMovement(String movementId, String reason) =>
      _run('reversal', () => _api.reverseMovement(movementId, reason: reason));

  Future<Result<void>> createSupplier(SupplierDraft draft) => _run('supplier_created', () => _api.createSupplier(draft));

  Future<Result<void>> updateSupplier(String supplierId, SupplierDraft draft, {bool? active, String? reason}) =>
      _run('supplier_updated', () => _api.updateSupplier(supplierId, draft, active: active, reason: reason));

  Future<Result<String>> createPurchase({
    required String supplierId,
    required List<PurchaseLine> lines,
    required String requestId,
    DateTime? purchaseDate,
    String? supplierReference,
    String? notes,
  }) =>
      _run('purchase_created', () => _api.createPurchase(
          supplierId: supplierId, lines: lines, requestId: requestId, purchaseDate: purchaseDate,
          supplierReference: supplierReference, notes: notes));

  Future<Result<void>> approvePurchase(String id) => _run('purchase_approved', () => _api.approvePurchase(id));

  Future<Result<void>> cancelPurchase(String id, String reason) => _run('purchase_cancelled', () => _api.cancelPurchase(id, reason: reason));

  Future<Result<void>> receivePurchase(String id, {required String requestId, String? payFromAccountId}) =>
      _run('purchase_received', () => _api.receivePurchase(id, requestId: requestId, payFromAccountId: payFromAccountId));

  Future<Result<void>> payPurchase(String id, {required String accountId, required String requestId, String? reference}) =>
      _run('purchase_paid', () => _api.payPurchase(id, accountId: accountId, requestId: requestId, reference: reference));
}
