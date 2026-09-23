import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/inventory.dart';

/// Reads for items, suppliers, movements and purchases. Bounded and
/// index-backed; offline they come from the cache. Writes go through [InventoryApi].
class InventoryRepository {
  InventoryRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 200;

  CollectionReference<Map<String, dynamic>> _c(String name) => _db.collection(name);

  List<StockMovement> _moves(QuerySnapshot<Map<String, dynamic>> s) =>
      [for (final d in s.docs) StockMovement.fromFirestore(d.id, d.data())];

  /// The whole catalogue by name (a workshop's stock list is small; filtered on the device).
  Stream<List<InventoryItem>> watchItems() => _c(FirestoreCollections.inventoryItems)
      .orderBy('name')
      .limit(500)
      .snapshots()
      .map((s) => [for (final d in s.docs) InventoryItem.fromFirestore(d.id, d.data())]);

  /// Low and out-of-stock items. Index: inventory_items (stockStatus, name).
  Stream<List<InventoryItem>> watchLowStock() => _c(FirestoreCollections.inventoryItems)
      .where('stockStatus', whereIn: [for (final s in StockStatus.needsAttention) s.key])
      .orderBy('name')
      .limit(listLimit)
      .snapshots()
      .map((s) => [for (final d in s.docs) InventoryItem.fromFirestore(d.id, d.data())].where((i) => i.active).toList());

  Stream<InventoryItem?> watchItem(String id) => _c(FirestoreCollections.inventoryItems)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? InventoryItem.fromFirestore(s.id, s.data()!) : null);

  /// Index: stock_movements (itemId, createdAt desc).
  Stream<List<StockMovement>> watchItemMovements(String itemId) => _c(FirestoreCollections.stockMovements)
      .where('itemId', isEqualTo: itemId)
      .orderBy('createdAt', descending: true)
      .limit(100)
      .snapshots()
      .map(_moves);

  /// Index: stock_movements (type, createdAt desc).
  Stream<List<StockMovement>> watchMovements({MovementType? type}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.stockMovements);
    if (type != null) q = q.where('type', isEqualTo: type.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_moves);
  }

  Stream<List<Supplier>> watchSuppliers() => _c(FirestoreCollections.suppliers)
      .orderBy('name')
      .limit(300)
      .snapshots()
      .map((s) => [for (final d in s.docs) Supplier.fromFirestore(d.id, d.data())]);

  Stream<Supplier?> watchSupplier(String id) =>
      _c(FirestoreCollections.suppliers).doc(id).snapshots().map((s) => s.exists ? Supplier.fromFirestore(s.id, s.data()!) : null);

  /// Index: inventory_purchases (status, createdAt desc) / (supplierId, createdAt desc).
  Stream<List<InventoryPurchase>> watchPurchases({PurchaseStatus? status, String? supplierId}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.inventoryPurchases);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    if (supplierId != null) q = q.where('supplierId', isEqualTo: supplierId);
    return q
        .orderBy('createdAt', descending: true)
        .limit(100)
        .snapshots()
        .map((s) => [for (final d in s.docs) InventoryPurchase.fromFirestore(d.id, d.data())]);
  }

  Stream<InventoryPurchase?> watchPurchase(String id) => _c(FirestoreCollections.inventoryPurchases)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? InventoryPurchase.fromFirestore(s.id, s.data()!) : null);
}
