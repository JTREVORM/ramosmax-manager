import 'package:cloud_firestore/cloud_firestore.dart';

import '../../../core/constants/firestore_collections.dart';
import '../../../models/shareholding.dart';
import '../application/shareholder_search.dart';

/// Reads for shareholders, shares and dividends (Phase 7). Bounded and
/// index-backed (firebase/firestore.indexes.json); offline they come from the
/// cache. Writes go through [ShareholdersApi]. A shareholder's own records are
/// never queried here - they come from the getMyShareholding function.
class ShareholdersRepository {
  ShareholdersRepository(this._db);
  final FirebaseFirestore _db;

  static const int listLimit = 100;

  CollectionReference<Map<String, dynamic>> _c(String name) => _db.collection(name);

  // --- shareholders ---

  List<Shareholder> _sh(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) Shareholder.fromFirestore(d.id, d.data())];

  /// Number, phone or name; optionally one status. Index: (status, shareholderNumber).
  Future<List<Shareholder>> searchShareholders(String input, {ShareholderStatus? status}) async {
    final q = ShareholderQuery.parse(input);
    final List<Shareholder> results;
    switch (q) {
      case AllShareholders():
        Query<Map<String, dynamic>> query = _c(FirestoreCollections.shareholders);
        if (status != null) query = query.where('status', isEqualTo: status.key);
        return _sh(await query.orderBy('shareholderNumber').limit(listLimit).get());
      case IncompleteShareholderPhone():
        return const [];
      case ShareholderNumberQuery(:final number):
        results = _sh(await _c(FirestoreCollections.shareholders).where('shareholderNumber', isEqualTo: number).limit(1).get());
      case ShareholderPhoneQuery(:final e164):
        results = _sh(await _c(FirestoreCollections.shareholders).where('phoneNumber', isEqualTo: e164).limit(5).get());
      case ShareholderNameQuery():
        final snap = await _c(FirestoreCollections.shareholders).where('searchTokens', arrayContains: q.token).limit(listLimit).get();
        results = _sh(snap).where(q.matches).toList()..sort((a, b) => a.fullName.toLowerCase().compareTo(b.fullName.toLowerCase()));
    }
    return status == null ? results : results.where((s) => s.status == status).toList();
  }

  /// Active shareholders for pickers (bounded). Index: (status, shareholderNumber).
  Stream<List<Shareholder>> watchActiveShareholders() => _c(FirestoreCollections.shareholders)
      .where('status', isEqualTo: ShareholderStatus.active.key)
      .orderBy('shareholderNumber')
      .limit(200)
      .snapshots()
      .map(_sh);

  Stream<Shareholder?> watchShareholder(String id) =>
      _c(FirestoreCollections.shareholders).doc(id).snapshots().map((s) => s.exists ? Shareholder.fromFirestore(s.id, s.data()!) : null);

  // --- register, classes, holdings ---

  Stream<ShareRegister> watchRegister() => _c(FirestoreCollections.shareRegister)
      .doc(FirestoreDocs.shareRegisterCurrent)
      .snapshots()
      .map((s) => ShareRegister.fromFirestore(s.data()));

  Stream<List<ShareClass>> watchClasses() => _c(FirestoreCollections.shareClasses)
      .orderBy('code')
      .limit(50)
      .snapshots()
      .map((s) => [for (final d in s.docs) ShareClass.fromFirestore(d.id, d.data())]);

  Stream<List<Shareholding>> watchHoldings(String shareholderId) => _c(FirestoreCollections.shareholdings)
      .where('shareholderId', isEqualTo: shareholderId)
      .limit(20)
      .snapshots()
      .map((s) => [for (final d in s.docs) Shareholding.fromFirestore(d.data())]);

  Stream<SharePolicy> watchSharePolicy() =>
      _c(FirestoreCollections.settings).doc(FirestoreDocs.sharePolicy).snapshots().map((s) => SharePolicy.fromFirestore(s.data()));

  Stream<DividendPolicy> watchDividendPolicy() =>
      _c(FirestoreCollections.settings).doc(FirestoreDocs.dividendPolicy).snapshots().map((s) => DividendPolicy.fromFirestore(s.data()));

  // --- share ledger ---

  List<ShareTransaction> _tx(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) ShareTransaction.fromFirestore(d.id, d.data())];

  /// Newest first; by status (index: status, createdAt desc) or type (index: type, createdAt desc).
  Stream<List<ShareTransaction>> watchShareTransactions({ShareTransactionStatus? status, ShareTransactionType? type}) {
    Query<Map<String, dynamic>> q = _c(FirestoreCollections.shareTransactions);
    if (status != null) q = q.where('status', isEqualTo: status.key);
    if (type != null) q = q.where('type', isEqualTo: type.key);
    return q.orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_tx);
  }

  /// One shareholder's history. Index: (shareholderIds array-contains, createdAt desc).
  Stream<List<ShareTransaction>> watchShareholderTransactions(String shareholderId) => _c(FirestoreCollections.shareTransactions)
      .where('shareholderIds', arrayContains: shareholderId)
      .orderBy('createdAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map(_tx);

  Stream<ShareTransaction?> watchShareTransaction(String id) => _c(FirestoreCollections.shareTransactions)
      .doc(id)
      .snapshots()
      .map((s) => s.exists ? ShareTransaction.fromFirestore(s.id, s.data()!) : null);

  // --- contributions ---

  List<ShareContribution> _con(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) ShareContribution.fromFirestore(d.id, d.data())];

  Stream<List<ShareContribution>> watchContributions() =>
      _c(FirestoreCollections.shareContributions).orderBy('createdAt', descending: true).limit(listLimit).snapshots().map(_con);

  /// Index: (shareholderId, createdAt desc).
  Stream<List<ShareContribution>> watchShareholderContributions(String shareholderId) => _c(FirestoreCollections.shareContributions)
      .where('shareholderId', isEqualTo: shareholderId)
      .orderBy('createdAt', descending: true)
      .limit(listLimit)
      .snapshots()
      .map(_con);

  Stream<List<ShareContribution>> watchIssueContributions(String shareTransactionId) => _c(FirestoreCollections.shareContributions)
      .where('shareTransactionId', isEqualTo: shareTransactionId)
      .limit(50)
      .snapshots()
      .map(_con);

  // --- dividends ---

  Stream<List<Dividend>> watchDividends() => _c(FirestoreCollections.dividends)
      .orderBy('createdAt', descending: true)
      .limit(60)
      .snapshots()
      .map((s) => [for (final d in s.docs) Dividend.fromFirestore(d.id, d.data())]);

  Stream<Dividend?> watchDividend(String id) =>
      _c(FirestoreCollections.dividends).doc(id).snapshots().map((s) => s.exists ? Dividend.fromFirestore(s.id, s.data()!) : null);

  List<DividendAllocation> _alloc(QuerySnapshot<Map<String, dynamic>> s) => [for (final d in s.docs) DividendAllocation.fromFirestore(d.id, d.data())];

  /// The current allocations of one dividend. Index: (dividendId, current, shareholderName).
  Stream<List<DividendAllocation>> watchAllocations(String dividendId) => _c(FirestoreCollections.dividendAllocations)
      .where('dividendId', isEqualTo: dividendId)
      .where('current', isEqualTo: true)
      .orderBy('shareholderName')
      .limit(300)
      .snapshots()
      .map(_alloc);

  /// One shareholder's dividend history. Index: (shareholderId, current, createdAt desc).
  Stream<List<DividendAllocation>> watchShareholderAllocations(String shareholderId) => _c(FirestoreCollections.dividendAllocations)
      .where('shareholderId', isEqualTo: shareholderId)
      .where('current', isEqualTo: true)
      .orderBy('createdAt', descending: true)
      .limit(60)
      .snapshots()
      .map(_alloc);
}
