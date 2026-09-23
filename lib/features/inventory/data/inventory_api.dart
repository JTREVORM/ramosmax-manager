import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../models/inventory.dart';

class ItemDraft {
  const ItemDraft({
    required this.name,
    required this.category,
    required this.unit,
    required this.minimumStock,
    required this.reorderLevel,
    this.description,
    this.isConsumable = true,
    this.preferredSupplierId,
    this.unitCost,
  });

  final String name;
  final InventoryCategory category;
  final InventoryUnit unit;
  final int minimumStock;
  final int reorderLevel;
  final String? description;
  final bool isConsumable;
  final String? preferredSupplierId;
  final Money? unitCost;

  Map<String, Object?> toJson() => {
        'name': name,
        'category': category.key,
        'unit': unit.key,
        'minimumStock': minimumStock,
        'reorderLevel': reorderLevel,
        'description': description,
        'isConsumable': isConsumable,
        'preferredSupplierId': preferredSupplierId,
        'lastUnitCostUgx': unitCost?.ugx,
      };
}

class SupplierDraft {
  const SupplierDraft({required this.name, this.contactPerson, this.phone, this.email, this.address, this.notes});
  final String name;
  final String? contactPerson;
  final String? phone;
  final String? email;
  final String? address;
  final String? notes;

  Map<String, Object?> toJson() =>
      {'name': name, 'contactPerson': contactPerson, 'phone': phone, 'email': email, 'address': address, 'notes': notes};
}

/// Inventory commands — Cloud Functions in functions/src/inventory.js. The
/// app never writes a quantity; it asks for a movement and the server
/// applies it (never below zero) together with the movement record.
abstract class InventoryApi {
  Future<Result<String>> createItem(ItemDraft draft, {String? sku, int openingQuantity = 0});
  Future<Result<void>> updateItem(String itemId, ItemDraft draft, {bool? active, String? reason});
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
  });
  Future<Result<void>> adjust(String itemId, {required int countedQuantity, required String reason, required String requestId});
  Future<Result<void>> reverseMovement(String movementId, {required String reason});
  Future<Result<void>> createSupplier(SupplierDraft draft);
  Future<Result<void>> updateSupplier(String supplierId, SupplierDraft draft, {bool? active, String? reason});
  Future<Result<String>> createPurchase({
    required String supplierId,
    required List<PurchaseLine> lines,
    required String requestId,
    DateTime? purchaseDate,
    String? supplierReference,
    String? notes,
  });
  Future<Result<void>> approvePurchase(String purchaseId);
  Future<Result<void>> cancelPurchase(String purchaseId, {required String reason});
  Future<Result<void>> receivePurchase(String purchaseId, {required String requestId, String? payFromAccountId});
  Future<Result<void>> payPurchase(String purchaseId, {required String accountId, required String requestId, String? reference});
}

class CallableInventoryApi implements InventoryApi {
  CallableInventoryApi(this._functions);
  final FirebaseFunctions _functions;

  Future<Result<void>> _done(String name, Map<String, Object?> data) async =>
      (await callFunction(_functions, name, data)).when(success: (_) => const Success(null), failure: Failure.new);

  @override
  Future<Result<String>> createItem(ItemDraft draft, {String? sku, int openingQuantity = 0}) async =>
      (await callFunction(_functions, 'createInventoryItem', {...draft.toJson(), 'sku': ?sku, 'openingQuantity': openingQuantity}))
          .when(success: (d) => Success(d['itemId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> updateItem(String itemId, ItemDraft draft, {bool? active, String? reason}) =>
      _done('updateInventoryItem', {...draft.toJson(), 'itemId': itemId, 'active': ?active, 'reason': ?reason});

  @override
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
      _done('recordStockMovement', {
        'itemId': itemId,
        'type': type.key,
        'quantity': quantity,
        'reason': reason,
        'requestId': requestId,
        'reasonCode': ?reasonCode?.key,
        'reference': ?reference,
        'unitCostUgx': ?unitCost?.ugx,
        'workerId': ?workerId,
      });

  @override
  Future<Result<void>> adjust(String itemId, {required int countedQuantity, required String reason, required String requestId}) =>
      _done('adjustStock', {'itemId': itemId, 'countedQuantity': countedQuantity, 'reason': reason, 'requestId': requestId});

  @override
  Future<Result<void>> reverseMovement(String movementId, {required String reason}) =>
      _done('reverseStockMovement', {'movementId': movementId, 'reason': reason});

  @override
  Future<Result<void>> createSupplier(SupplierDraft draft) => _done('createSupplier', draft.toJson());

  @override
  Future<Result<void>> updateSupplier(String supplierId, SupplierDraft draft, {bool? active, String? reason}) =>
      _done('updateSupplier', {...draft.toJson(), 'supplierId': supplierId, 'active': ?active, 'reason': ?reason});

  @override
  Future<Result<String>> createPurchase({
    required String supplierId,
    required List<PurchaseLine> lines,
    required String requestId,
    DateTime? purchaseDate,
    String? supplierReference,
    String? notes,
  }) async =>
      (await callFunction(_functions, 'createPurchase', {
        'supplierId': supplierId,
        'items': [for (final l in lines) {'itemId': l.itemId, 'quantity': l.quantity, 'unitCostUgx': l.unitCost.ugx}],
        'requestId': requestId,
        'purchaseDate': ?purchaseDate?.millisecondsSinceEpoch,
        'supplierReference': ?supplierReference,
        'notes': ?notes,
      }))
          .when(success: (d) => Success(d['purchaseId'] as String), failure: Failure.new);

  @override
  Future<Result<void>> approvePurchase(String purchaseId) => _done('updatePurchaseStatus', {'purchaseId': purchaseId, 'action': 'approve'});

  @override
  Future<Result<void>> cancelPurchase(String purchaseId, {required String reason}) =>
      _done('updatePurchaseStatus', {'purchaseId': purchaseId, 'action': 'cancel', 'reason': reason});

  @override
  Future<Result<void>> receivePurchase(String purchaseId, {required String requestId, String? payFromAccountId}) =>
      _done('receivePurchase', {'purchaseId': purchaseId, 'requestId': requestId, 'payFromAccountId': ?payFromAccountId});

  @override
  Future<Result<void>> payPurchase(String purchaseId, {required String accountId, required String requestId, String? reference}) =>
      _done('payPurchase', {'purchaseId': purchaseId, 'accountId': accountId, 'requestId': requestId, 'reference': ?reference});
}
