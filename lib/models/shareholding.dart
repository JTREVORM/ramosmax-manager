import '../core/money/money.dart';
import 'firestore_converters.dart';

// Phase 7: shareholders, share classes, holdings, the share ledger,
// contributions, the register and dividends. Every figure here (shares,
// commitments, ownership %, dividend allocations, payment status) is written
// by the Cloud Functions in functions/src/{shareholders,shares,dividends}.js;
// the app only displays it.

Money _m(Object? v) => Money((v as num?)?.toInt() ?? 0);
int _i(Object? v) => (v as num?)?.toInt() ?? 0;
double _d(Object? v) => (v as num?)?.toDouble() ?? 0;
DateTime? _t(Object? v) => v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : FirestoreConverters.toDateTime(v);

/// `50%`, `33.3333%` - the server's four-decimal ownership percentage.
String formatPercent(double percent) {
  final fixed = percent.toStringAsFixed(4).replaceFirst(RegExp(r'\.?0+$'), '');
  return '$fixed%';
}

/// `1,000` - share counts.
String formatShares(int shares) => Money(shares).formatAmount();

/// The brief's ACTIVE / INACTIVE / SUSPENDED / EXITED. Mirrors SHAREHOLDER_STATUSES.
enum ShareholderStatus {
  active('active', 'Active'),
  inactive('inactive', 'Inactive'),
  suspended('suspended', 'Suspended'),
  exited('exited', 'Exited');

  const ShareholderStatus(this.key, this.label);
  final String key;
  final String label;

  static ShareholderStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => inactive);
}

enum IdentificationType {
  nationalId('national_id', 'National ID'),
  passport('passport', 'Passport'),
  companyRegistration('company_registration', 'Company registration'),
  other('other', 'Other');

  const IdentificationType(this.key, this.label);
  final String key;
  final String label;

  static IdentificationType? tryParse(Object? v) {
    for (final t in values) {
      if (t.key == v) return t;
    }
    return null;
  }
}

/// `shareholders/{id}`. Profile fields plus server-maintained totals.
class Shareholder {
  const Shareholder({
    required this.shareholderId,
    required this.shareholderNumber,
    required this.fullName,
    required this.status,
    this.phoneNumber,
    this.email,
    this.address,
    this.idType,
    this.idNumber,
    this.notes,
    this.statusReason,
    this.joinDate,
    this.linkedUid,
    this.linkedUserName,
    this.totalShares = 0,
    this.ownershipPercent = 0,
    this.committed = Money.zero,
    this.paid = Money.zero,
    this.outstanding = Money.zero,
    this.dividendsPaid = Money.zero,
    this.createdAt,
    this.createdByName,
  });

  final String shareholderId;
  final String shareholderNumber;
  final String fullName;
  final ShareholderStatus status;
  final String? phoneNumber;
  final String? email;
  final String? address;
  final IdentificationType? idType;
  final String? idNumber;
  final String? notes;
  final String? statusReason;
  final DateTime? joinDate;
  final String? linkedUid;
  final String? linkedUserName;
  final int totalShares;
  final double ownershipPercent;

  /// Shares × value per share agreed (the commitment), what has been paid, and the rest.
  final Money committed;
  final Money paid;
  final Money outstanding;
  final Money dividendsPaid;
  final DateTime? createdAt;
  final String? createdByName;

  /// May receive new shares (issue or transfer in).
  bool get canReceiveShares => status == ShareholderStatus.active;

  static Shareholder fromFirestore(String id, Map<String, dynamic> d) => Shareholder(
        shareholderId: id,
        shareholderNumber: d['shareholderNumber'] as String? ?? '',
        fullName: d['fullName'] as String? ?? '',
        status: ShareholderStatus.parse(d['status']),
        phoneNumber: d['phoneNumber'] as String?,
        email: d['email'] as String?,
        address: d['address'] as String?,
        idType: IdentificationType.tryParse(d['idType']),
        idNumber: d['idNumber'] as String?,
        notes: d['notes'] as String?,
        statusReason: d['statusReason'] as String?,
        joinDate: _t(d['joinDate']),
        linkedUid: d['linkedUid'] as String?,
        linkedUserName: d['linkedUserName'] as String?,
        totalShares: _i(d['totalShares']),
        ownershipPercent: _d(d['ownershipPercent']),
        committed: _m(d['committedUgx']),
        paid: _m(d['paidUgx']),
        outstanding: _m(d['outstandingUgx']),
        dividendsPaid: _m(d['dividendsPaidUgx']),
        createdAt: _t(d['createdAt']),
        createdByName: d['createdByName'] as String?,
      );
}

/// `share_classes/{code}`: a configurable class (e.g. ORDINARY). Business
/// fields only - no legal rights are modelled.
class ShareClass {
  const ShareClass({
    required this.classId,
    required this.code,
    required this.name,
    required this.valuePerShare,
    required this.active,
    this.description,
    this.issuedShares = 0,
    this.committed = Money.zero,
    this.paid = Money.zero,
  });

  final String classId;
  final String code;
  final String name;
  final String? description;
  final Money valuePerShare;
  final bool active;
  final int issuedShares;
  final Money committed;
  final Money paid;

  /// Preview only - the server calculates the commitment itself.
  Money commitmentFor(int shares) => valuePerShare.times(shares);

  static ShareClass fromFirestore(String id, Map<String, dynamic> d) => ShareClass(
        classId: id,
        code: d['code'] as String? ?? id.toUpperCase(),
        name: d['name'] as String? ?? id,
        description: d['description'] as String?,
        valuePerShare: _m(d['valuePerShareUgx']),
        active: d['active'] == true,
        issuedShares: _i(d['issuedShares']),
        committed: _m(d['committedUgx']),
        paid: _m(d['paidUgx']),
      );
}

/// `shareholdings/{shareholderId}_{classId}`.
class Shareholding {
  const Shareholding({
    required this.shareholderId,
    required this.classId,
    required this.classCode,
    required this.shares,
    this.committed = Money.zero,
    this.paid = Money.zero,
    this.outstanding = Money.zero,
  });

  final String shareholderId;
  final String classId;
  final String classCode;
  final int shares;
  final Money committed;
  final Money paid;
  final Money outstanding;

  static Shareholding fromFirestore(Map<String, dynamic> d) => Shareholding(
        shareholderId: d['shareholderId'] as String? ?? '',
        classId: d['classId'] as String? ?? '',
        classCode: d['classCode'] as String? ?? '',
        shares: _i(d['shares']),
        committed: _m(d['committedUgx']),
        paid: _m(d['paidUgx']),
        outstanding: _m(d['outstandingUgx']),
      );
}

/// Ownership-ledger entry kinds. Mirrors SHARE_TXN_TYPES in functions/src/shares.js.
enum ShareTransactionType {
  issued('shares_issued', 'Shares issued'),
  transferred('shares_transferred', 'Shares transferred'),
  adjusted('shares_adjusted', 'Share adjustment'),
  reversal('reversal', 'Reversal');

  const ShareTransactionType(this.key, this.label);
  final String key;
  final String label;

  static ShareTransactionType parse(Object? v) => values.firstWhere((t) => t.key == v, orElse: () => adjusted);
}

enum ShareTransactionStatus {
  pendingApproval('pending_approval', 'Pending approval'),
  posted('posted', 'Posted'),
  rejected('rejected', 'Rejected'),
  reversed('reversed', 'Reversed');

  const ShareTransactionStatus(this.key, this.label);
  final String key;
  final String label;

  static ShareTransactionStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => pendingApproval);
}

/// How money for shares came in. Mirrors PAYMENT_SOURCES.
enum ContributionSource {
  none('none', 'Not paid yet'),
  account('account', 'Received into a business account'),
  priorRecord('prior_record', 'Paid before RamosMAX (no balance change)');

  const ContributionSource(this.key, this.label);
  final String key;
  final String label;

  static ContributionSource parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => none);
}

class ShareLine {
  const ShareLine({required this.shareholderId, required this.shareholderNumber, required this.shareholderName, required this.deltaShares, this.sharesAfter});
  final String shareholderId;
  final String shareholderNumber;
  final String shareholderName;
  final int deltaShares;
  final int? sharesAfter;

  static ShareLine fromMap(Map<dynamic, dynamic> m) => ShareLine(
        shareholderId: m['shareholderId'] as String? ?? '',
        shareholderNumber: m['shareholderNumber'] as String? ?? '',
        shareholderName: m['shareholderName'] as String? ?? '',
        deltaShares: _i(m['deltaShares']),
        sharesAfter: (m['sharesAfter'] as num?)?.toInt(),
      );
}

/// `share_transactions/{id}` - immutable; corrected by adjustment or reversal.
class ShareTransaction {
  const ShareTransaction({
    required this.transactionId,
    required this.transactionNumber,
    required this.type,
    required this.status,
    required this.classCode,
    required this.shares,
    required this.lines,
    this.classId,
    this.reversalOfType,
    this.valuePerShare,
    this.committed,
    this.paid,
    this.outstanding,
    this.paymentStatus,
    this.paymentSource,
    this.paymentAmount,
    this.paymentAccountId,
    this.effectiveDate,
    this.acquisitionDate,
    this.reason,
    this.reference,
    this.notes,
    this.requestedBy,
    this.requestedByName,
    this.approvedByName,
    this.decisionReason,
    this.reversalOfTransactionNumber,
    this.reversedByTransactionNumber,
    this.reversalReason,
    this.createdAt,
  });

  final String transactionId;
  final String transactionNumber;
  final ShareTransactionType type;
  final ShareTransactionType? reversalOfType;
  final ShareTransactionStatus status;
  final String? classId;
  final String classCode;
  final int shares;
  final List<ShareLine> lines;
  final Money? valuePerShare;
  final Money? committed;
  final Money? paid;
  final Money? outstanding;
  final String? paymentStatus;
  final ContributionSource? paymentSource;
  final Money? paymentAmount;
  final String? paymentAccountId;
  final DateTime? effectiveDate;
  final DateTime? acquisitionDate;
  final String? reason;
  final String? reference;
  final String? notes;
  final String? requestedBy;
  final String? requestedByName;
  final String? approvedByName;
  final String? decisionReason;
  final String? reversalOfTransactionNumber;
  final String? reversedByTransactionNumber;
  final String? reversalReason;
  final DateTime? createdAt;

  bool get isPending => status == ShareTransactionStatus.pendingApproval;
  bool get canReverse => status == ShareTransactionStatus.posted && type != ShareTransactionType.reversal;

  /// A posted issue with money still to come.
  bool get canReceivePayment =>
      type == ShareTransactionType.issued && status == ShareTransactionStatus.posted && (outstanding?.isPositive ?? false);

  String get label => type == ShareTransactionType.reversal && reversalOfType != null ? 'Reversal of ${reversalOfType!.label.toLowerCase()}' : type.label;

  /// The change this entry made to [shareholderId]'s shares.
  int deltaFor(String shareholderId) => lines.where((l) => l.shareholderId == shareholderId).fold(0, (s, l) => s + l.deltaShares);

  String get parties => lines.map((l) => '${l.shareholderName} ${l.deltaShares > 0 ? '+' : '−'}${formatShares(l.deltaShares.abs())}').join(' · ');

  static ShareTransaction fromFirestore(String id, Map<String, dynamic> d) {
    final payment = d['payment'] is Map ? d['payment'] as Map : null;
    Money? om(Object? v) => v == null ? null : _m(v);
    return ShareTransaction(
      transactionId: id,
      transactionNumber: d['transactionNumber'] as String? ?? '',
      type: ShareTransactionType.parse(d['type']),
      reversalOfType: d['reversalOfType'] == null ? null : ShareTransactionType.parse(d['reversalOfType']),
      status: ShareTransactionStatus.parse(d['status']),
      classId: d['classId'] as String?,
      classCode: d['classCode'] as String? ?? '',
      shares: _i(d['shares']),
      lines: [for (final l in (d['lines'] as List? ?? const [])) if (l is Map) ShareLine.fromMap(l)],
      valuePerShare: om(d['valuePerShareUgx']),
      committed: om(d['committedUgx']),
      paid: om(d['paidUgx']),
      outstanding: om(d['outstandingUgx']),
      paymentStatus: d['paymentStatus'] as String?,
      paymentSource: payment == null ? null : ContributionSource.parse(payment['source']),
      paymentAmount: payment == null ? null : _m(payment['amountUgx']),
      paymentAccountId: payment?['accountId'] as String?,
      effectiveDate: _t(d['effectiveDate']),
      acquisitionDate: _t(d['acquisitionDate']),
      reason: d['reason'] as String?,
      reference: d['reference'] as String?,
      notes: d['notes'] as String?,
      requestedBy: d['requestedBy'] as String?,
      requestedByName: d['requestedByName'] as String?,
      approvedByName: d['approvedByName'] as String?,
      decisionReason: d['decisionReason'] as String?,
      reversalOfTransactionNumber: d['reversalOfTransactionNumber'] as String?,
      reversedByTransactionNumber: d['reversedByTransactionNumber'] as String?,
      reversalReason: d['reversalReason'] as String?,
      createdAt: _t(d['createdAt']),
    );
  }
}

/// `share_contributions/{id}`: money received for shares.
class ShareContribution {
  const ShareContribution({
    required this.contributionId,
    required this.contributionNumber,
    required this.shareholderId,
    required this.shareholderName,
    required this.amount,
    required this.source,
    required this.reversed,
    this.classCode,
    this.shareTransactionNumber,
    this.accountName,
    this.financialTransactionNumber,
    this.paymentDate,
    this.reference,
    this.reversalReason,
  });

  final String contributionId;
  final String contributionNumber;
  final String shareholderId;
  final String shareholderName;
  final Money amount;
  final ContributionSource source;
  final bool reversed;
  final String? classCode;
  final String? shareTransactionNumber;
  final String? accountName;
  final String? financialTransactionNumber;
  final DateTime? paymentDate;
  final String? reference;
  final String? reversalReason;

  static ShareContribution fromFirestore(String id, Map<String, dynamic> d) => ShareContribution(
        contributionId: id,
        contributionNumber: d['contributionNumber'] as String? ?? '',
        shareholderId: d['shareholderId'] as String? ?? '',
        shareholderName: d['shareholderName'] as String? ?? '',
        amount: _m(d['amountUgx']),
        source: ContributionSource.parse(d['source']),
        reversed: d['status'] == 'reversed',
        classCode: d['classCode'] as String?,
        shareTransactionNumber: d['shareTransactionNumber'] as String?,
        accountName: d['accountName'] as String?,
        financialTransactionNumber: d['financialTransactionNumber'] as String?,
        paymentDate: _t(d['paymentDate']),
        reference: d['reference'] as String?,
        reversalReason: d['reversalReason'] as String?,
      );
}

class RegisterHolder {
  const RegisterHolder({required this.shareholderId, required this.shareholderNumber, required this.shareholderName, required this.shares, required this.ownershipPercent});
  final String shareholderId;
  final String shareholderNumber;
  final String shareholderName;
  final int shares;
  final double ownershipPercent;

  static RegisterHolder fromMap(Map<dynamic, dynamic> m) => RegisterHolder(
        shareholderId: m['shareholderId'] as String? ?? '',
        shareholderNumber: m['shareholderNumber'] as String? ?? '',
        shareholderName: m['shareholderName'] as String? ?? '',
        shares: _i(m['shares']),
        ownershipPercent: _d(m['ownershipPercent']),
      );
}

/// `share_register/current`: register totals and the ownership distribution.
class ShareRegister {
  const ShareRegister({
    this.totalShares = 0,
    this.shareholderCount = 0,
    this.statusCounts = const {},
    this.holderCount = 0,
    this.holders = const [],
    this.totalCommitted = Money.zero,
    this.totalPaid = Money.zero,
    this.outstanding = Money.zero,
    this.pendingApprovals = 0,
  });

  final int totalShares;
  final int shareholderCount;
  final Map<ShareholderStatus, int> statusCounts;
  final int holderCount;
  final List<RegisterHolder> holders;

  /// Share capital: agreed, received and still owed. Not revenue.
  final Money totalCommitted;
  final Money totalPaid;
  final Money outstanding;
  final int pendingApprovals;

  int get activeShareholders => statusCounts[ShareholderStatus.active] ?? 0;

  static const ShareRegister empty = ShareRegister();

  static ShareRegister fromFirestore(Map<String, dynamic>? d) {
    if (d == null) return empty;
    final counts = <ShareholderStatus, int>{};
    if (d['statusCounts'] is Map) {
      for (final e in (d['statusCounts'] as Map).entries) {
        counts[ShareholderStatus.parse(e.key)] = _i(e.value);
      }
    }
    return ShareRegister(
      totalShares: _i(d['totalShares']),
      shareholderCount: _i(d['shareholderCount']),
      statusCounts: counts,
      holderCount: _i(d['holderCount']),
      holders: [for (final h in (d['holders'] as List? ?? const [])) if (h is Map) RegisterHolder.fromMap(h)],
      totalCommitted: _m(d['totalCommittedUgx']),
      totalPaid: _m(d['totalPaidUgx']),
      outstanding: _m(d['outstandingUgx']),
      pendingApprovals: _i(d['pendingApprovals']),
    );
  }
}

/// `settings/share_policy` (defaults mirror DEFAULT_SHARE_POLICY).
class SharePolicy {
  const SharePolicy({this.requireApproval = true, this.allowUnpaidShares = false, this.allowPartialPayment = false});
  final bool requireApproval;
  final bool allowUnpaidShares;
  final bool allowPartialPayment;

  static SharePolicy fromFirestore(Map<String, dynamic>? d) => SharePolicy(
        requireApproval: d?['requireApproval'] as bool? ?? true,
        allowUnpaidShares: d?['allowUnpaidShares'] as bool? ?? false,
        allowPartialPayment: d?['allowPartialPayment'] as bool? ?? false,
      );
}

/// `settings/dividend_policy` (defaults mirror DEFAULT_DIVIDEND_POLICY).
class DividendPolicy {
  const DividendPolicy({this.requireAdminApproval = true});
  final bool requireAdminApproval;

  static DividendPolicy fromFirestore(Map<String, dynamic>? d) => DividendPolicy(requireAdminApproval: d?['requireAdminApproval'] as bool? ?? true);
}

/// Mirrors DIVIDEND_STATUSES in functions/src/dividends.js.
enum DividendStatus {
  draft('draft', 'Draft'),
  declared('declared', 'Declared'),
  approved('approved', 'Approved · unpaid'),
  partiallyPaid('partially_paid', 'Partially paid'),
  paid('paid', 'Paid'),
  cancelled('cancelled', 'Cancelled');

  const DividendStatus(this.key, this.label);
  final String key;
  final String label;

  bool get isPayable => this == approved || this == partiallyPaid;

  static DividendStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => draft);
}

enum DividendMethod {
  pool('pool', 'Total amount to distribute'),
  perShare('per_share', 'Amount per share');

  const DividendMethod(this.key, this.label);
  final String key;
  final String label;

  static DividendMethod parse(Object? v) => values.firstWhere((m) => m.key == v, orElse: () => pool);
}

/// `dividends/{id}`.
class Dividend {
  const Dividend({
    required this.dividendId,
    required this.dividendNumber,
    required this.financialPeriod,
    required this.status,
    required this.method,
    this.declarationDate,
    this.recordDate,
    this.paymentDate,
    this.classId,
    this.classCode,
    this.totalDistributable,
    this.dividendPerShare,
    this.eligibleShares = 0,
    this.eligibleShareholderCount = 0,
    this.allocated = Money.zero,
    this.unallocated = Money.zero,
    this.paid = Money.zero,
    this.outstanding = Money.zero,
    this.allocationCount = 0,
    this.payableCount = 0,
    this.paidCount = 0,
    this.calculatedAt,
    this.declaredByName,
    this.approvedByName,
    this.createdByName,
    this.notes,
    this.cancelReason,
    this.returnedReason,
    this.createdAt,
  });

  final String dividendId;
  final String dividendNumber;
  final String financialPeriod;
  final DividendStatus status;
  final DividendMethod method;
  final DateTime? declarationDate;
  final DateTime? recordDate;
  final DateTime? paymentDate;
  final String? classId;
  final String? classCode;

  /// The approved pool entered by the business (pool method) or pool = per share × shares.
  final Money? totalDistributable;

  /// UGX per eligible share (may have decimals for the pool method).
  final double? dividendPerShare;
  final int eligibleShares;
  final int eligibleShareholderCount;
  final Money allocated;

  /// Shillings lost to rounding the pool down per shareholder - never paid.
  final Money unallocated;
  final Money paid;
  final Money outstanding;
  final int allocationCount;
  final int payableCount;
  final int paidCount;
  final DateTime? calculatedAt;
  final String? declaredByName;
  final String? approvedByName;
  final String? createdByName;
  final String? notes;
  final String? cancelReason;
  final String? returnedReason;
  final DateTime? createdAt;

  bool get isCalculated => calculatedAt != null && allocationCount > 0;

  String get perShareLabel {
    final v = dividendPerShare;
    if (v == null) return '—';
    return v == v.roundToDouble() ? Money(v.round()).format() : 'UGX ${v.toStringAsFixed(4).replaceFirst(RegExp(r'0+$'), '')}';
  }

  static Dividend fromFirestore(String id, Map<String, dynamic> d) => Dividend(
        dividendId: id,
        dividendNumber: d['dividendNumber'] as String? ?? '',
        financialPeriod: d['financialPeriod'] as String? ?? '',
        status: DividendStatus.parse(d['status']),
        method: DividendMethod.parse(d['calculationMethod']),
        declarationDate: _t(d['declarationDate']),
        recordDate: _t(d['recordDate']),
        paymentDate: _t(d['paymentDate']),
        classId: d['classId'] as String?,
        classCode: d['classCode'] as String?,
        totalDistributable: d['totalDistributableUgx'] == null ? null : _m(d['totalDistributableUgx']),
        dividendPerShare: (d['dividendPerShareUgx'] as num?)?.toDouble(),
        eligibleShares: _i(d['eligibleShares']),
        eligibleShareholderCount: _i(d['eligibleShareholderCount']),
        allocated: _m(d['allocatedUgx']),
        unallocated: _m(d['unallocatedUgx']),
        paid: _m(d['paidUgx']),
        outstanding: _m(d['outstandingUgx']),
        allocationCount: _i(d['allocationCount']),
        payableCount: _i(d['payableCount']),
        paidCount: _i(d['paidCount']),
        calculatedAt: _t(d['calculatedAt']),
        declaredByName: d['declaredByName'] as String?,
        approvedByName: d['approvedByName'] as String?,
        createdByName: d['createdByName'] as String?,
        notes: d['notes'] as String?,
        cancelReason: d['cancelReason'] as String?,
        returnedReason: d['returnedReason'] as String?,
        createdAt: _t(d['createdAt']),
      );
}

/// Declared / approved / paid / outstanding across dividends (server figures).
class DividendTotals {
  const DividendTotals({required this.declared, required this.approved, required this.paid, required this.outstanding});
  final Money declared;
  final Money approved;
  final Money paid;
  final Money outstanding;

  static DividendTotals of(Iterable<Dividend> list) {
    var declared = Money.zero;
    var approved = Money.zero;
    var paid = Money.zero;
    var outstanding = Money.zero;
    for (final d in list) {
      if (d.status == DividendStatus.cancelled || d.status == DividendStatus.draft) continue;
      declared += d.allocated;
      if (d.status != DividendStatus.declared) {
        approved += d.allocated;
        paid += d.paid;
        outstanding += d.outstanding;
      }
    }
    return DividendTotals(declared: declared, approved: approved, paid: paid, outstanding: outstanding);
  }
}

/// `dividend_allocations/{id}`: one shareholder's entitlement on the record date.
class DividendAllocation {
  const DividendAllocation({
    required this.allocationId,
    required this.allocationNumber,
    required this.dividendId,
    required this.dividendNumber,
    required this.shareholderId,
    required this.shareholderNumber,
    required this.shareholderName,
    required this.sharesAtRecordDate,
    required this.gross,
    required this.deductions,
    required this.net,
    required this.paymentStatus,
    this.ownershipPercentAtRecordDate = 0,
    this.dividendPerShare,
    this.current = true,
    this.paidAt,
    this.paymentReference,
    this.accountName,
    this.financialTransactionId,
    this.financialTransactionNumber,
    this.reversalCount = 0,
  });

  final String allocationId;
  final String allocationNumber;
  final String dividendId;
  final String dividendNumber;
  final String shareholderId;
  final String shareholderNumber;
  final String shareholderName;
  final int sharesAtRecordDate;
  final double ownershipPercentAtRecordDate;
  final double? dividendPerShare;
  final Money gross;
  final Money deductions;
  final Money net;

  /// unpaid / paid / not_payable.
  final String paymentStatus;
  final bool current;
  final DateTime? paidAt;
  final String? paymentReference;
  final String? accountName;
  final String? financialTransactionId;
  final String? financialTransactionNumber;
  final int reversalCount;

  bool get isPaid => paymentStatus == 'paid';
  bool get isUnpaid => paymentStatus == 'unpaid';

  static DividendAllocation fromFirestore(String id, Map<String, dynamic> d) => DividendAllocation(
        allocationId: id,
        allocationNumber: d['allocationNumber'] as String? ?? '',
        dividendId: d['dividendId'] as String? ?? '',
        dividendNumber: d['dividendNumber'] as String? ?? '',
        shareholderId: d['shareholderId'] as String? ?? '',
        shareholderNumber: d['shareholderNumber'] as String? ?? '',
        shareholderName: d['shareholderName'] as String? ?? '',
        sharesAtRecordDate: _i(d['sharesAtRecordDate']),
        ownershipPercentAtRecordDate: _d(d['ownershipPercentAtRecordDate']),
        dividendPerShare: (d['dividendPerShareUgx'] as num?)?.toDouble(),
        gross: _m(d['grossUgx']),
        deductions: _m(d['deductionsUgx']),
        net: _m(d['netUgx']),
        paymentStatus: d['paymentStatus'] as String? ?? 'unpaid',
        current: d['current'] != false,
        paidAt: _t(d['paidAt']),
        paymentReference: d['paymentReference'] as String?,
        accountName: d['accountName'] as String?,
        financialTransactionId: d['financialTransactionId'] as String?,
        financialTransactionNumber: d['financialTransactionNumber'] as String?,
        reversalCount: (d['reversals'] as List?)?.length ?? 0,
      );
}

/// Ownership on a date, from getOwnershipAsOf (the immutable ledger).
class OwnershipSnapshot {
  const OwnershipSnapshot({required this.asOf, required this.totalShares, required this.holders});
  final String asOf;
  final int totalShares;
  final List<RegisterHolder> holders;

  static OwnershipSnapshot fromMap(Map<String, dynamic> d) => OwnershipSnapshot(
        asOf: d['asOf'] as String? ?? '',
        totalShares: _i(d['totalShares']),
        holders: [for (final h in (d['holders'] as List? ?? const [])) if (h is Map) RegisterHolder.fromMap(h)],
      );
}

/// The signed-in shareholder's own records, from getMyShareholding.
class MyShareholding {
  const MyShareholding({
    required this.linked,
    this.shareholder,
    this.holdings = const [],
    this.transactions = const [],
    this.contributions = const [],
    this.dividends = const [],
  });

  final bool linked;
  final Shareholder? shareholder;
  final List<Shareholding> holdings;
  final List<({String number, String label, int delta, String classCode, DateTime? effectiveDate})> transactions;
  final List<({String number, Money amount, bool reversed, DateTime? paymentDate})> contributions;
  final List<({String number, String dividendNumber, String period, DateTime? recordDate, int shares, Money net, bool paid, DateTime? paidAt})> dividends;

  static MyShareholding fromMap(Map<String, dynamic> d) {
    if (d['linked'] != true) return const MyShareholding(linked: false);
    final s = (d['shareholder'] as Map).cast<String, dynamic>();
    List<Map<String, dynamic>> list(String k) => [for (final x in (d[k] as List? ?? const [])) if (x is Map) x.cast<String, dynamic>()];
    return MyShareholding(
      linked: true,
      shareholder: Shareholder.fromFirestore(s['shareholderId'] as String? ?? '', s),
      holdings: [for (final h in list('holdings')) Shareholding.fromFirestore(h)],
      transactions: [
        for (final t in list('transactions'))
          (
            number: t['transactionNumber'] as String? ?? '',
            label: ShareTransactionType.parse(t['type']).label,
            delta: _i(t['deltaShares']),
            classCode: t['classCode'] as String? ?? '',
            effectiveDate: _t(t['effectiveDate']),
          ),
      ],
      contributions: [
        for (final c in list('contributions'))
          (number: c['contributionNumber'] as String? ?? '', amount: _m(c['amountUgx']), reversed: c['status'] == 'reversed', paymentDate: _t(c['paymentDate'])),
      ],
      dividends: [
        for (final a in list('dividends'))
          (
            number: a['allocationNumber'] as String? ?? '',
            dividendNumber: a['dividendNumber'] as String? ?? '',
            period: a['financialPeriod'] as String? ?? '',
            recordDate: _t(a['recordDate']),
            shares: _i(a['sharesAtRecordDate']),
            net: _m(a['netUgx']),
            paid: a['paymentStatus'] == 'paid',
            paidAt: _t(a['paidAt']),
          ),
      ],
    );
  }
}
