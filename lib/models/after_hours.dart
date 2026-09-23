import '../core/auth/permissions.dart';
import '../core/money/money.dart';
import 'firestore_converters.dart';
import 'payment.dart';

// Phase 8: after-hours authorisations, sessions, cash custody, handovers and
// discrepancies. Every amount and status here is written by the Cloud
// Functions in functions/src/after_hours.js (and billing.js for payments);
// the app only displays it. The expected cash in particular is calculated on
// the server from the session's payments and can never be typed in.

Money _m(Object? v) => Money((v as num?)?.toInt() ?? 0);
Money? _mOrNull(Object? v) => v is num ? Money(v.toInt()) : null;
int _i(Object? v) => (v as num?)?.toInt() ?? 0;
DateTime? _t(Object? v) => FirestoreConverters.toDateTime(v);

/// `after_hours_access/{id}` status as stored. Mirrors the server.
enum AuthorizationStatus {
  active('active', 'Active'),
  revoked('revoked', 'Revoked'),
  expired('expired', 'Expired');

  const AuthorizationStatus(this.key, this.label);
  final String key;
  final String label;

  static AuthorizationStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => expired);
}

/// What an authorisation looks like at a given moment.
enum AuthorizationPhase {
  scheduled('Scheduled'),
  live('In force'),
  ended('Ended'),
  revoked('Revoked');

  const AuthorizationPhase(this.label);
  final String label;
}

/// `after_hours_access/{id}` (`RMX-AH-000001`): a supervisor's authorisation
/// for one worker, carried by Phase 2 temporary permission grants.
class AfterHoursAuthorization {
  const AfterHoursAuthorization({
    required this.authorizationId,
    required this.authorizationNumber,
    required this.staffUid,
    required this.staffName,
    required this.startsAt,
    required this.expiresAt,
    required this.status,
    this.reason,
    this.permissions = const [],
    this.openingFloat = Money.zero,
    this.floatSessionId,
    this.sessionIds = const [],
    this.grantedByName,
    this.revokedByName,
    this.revokeReason,
    this.createdAt,
  });

  final String authorizationId;
  final String authorizationNumber;
  final String staffUid;
  final String staffName;
  final DateTime startsAt;
  final DateTime expiresAt;
  final AuthorizationStatus status;
  final String? reason;
  final List<Permission> permissions;
  final Money openingFloat;
  final String? floatSessionId;
  final List<String> sessionIds;
  final String? grantedByName;
  final String? revokedByName;
  final String? revokeReason;
  final DateTime? createdAt;

  /// The server clock decides; this is for display only.
  AuthorizationPhase phaseAt(DateTime now) {
    if (status == AuthorizationStatus.revoked) return AuthorizationPhase.revoked;
    if (status == AuthorizationStatus.expired || !now.isBefore(expiresAt)) return AuthorizationPhase.ended;
    if (now.isBefore(startsAt)) return AuthorizationPhase.scheduled;
    return AuthorizationPhase.live;
  }

  bool isLive(DateTime now) => phaseAt(now) == AuthorizationPhase.live;

  /// Still to run or running: the only authorisations that can be revoked.
  bool canRevoke(DateTime now) {
    final p = phaseAt(now);
    return p == AuthorizationPhase.live || p == AuthorizationPhase.scheduled;
  }

  static AfterHoursAuthorization fromFirestore(String id, Map<String, dynamic> d) => AfterHoursAuthorization(
        authorizationId: id,
        authorizationNumber: d['authorizationNumber'] as String? ?? '',
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        startsAt: _t(d['startsAt']) ?? DateTime.fromMillisecondsSinceEpoch(0),
        expiresAt: _t(d['expiresAt']) ?? DateTime.fromMillisecondsSinceEpoch(0),
        status: AuthorizationStatus.parse(d['status']),
        reason: d['reason'] as String?,
        permissions: [
          for (final p in (d['permissions'] as List?) ?? const [])
            if (Permission.tryParse(p as String? ?? '') case final Permission perm) perm,
        ],
        openingFloat: _m(d['openingFloatUgx']),
        floatSessionId: d['floatSessionId'] as String?,
        sessionIds: [for (final s in (d['sessionIds'] as List?) ?? const []) s as String],
        grantedByName: d['grantedByName'] as String?,
        revokedByName: d['revokedByName'] as String?,
        revokeReason: d['revokeReason'] as String?,
        createdAt: _t(d['createdAt']),
      );
}

/// Mirrors SESSION_STATUSES in functions/src/after_hours.js.
enum SessionStatus {
  open('open', 'Open'),
  closed('closed', 'Closed'),
  handoverPending('handover_pending', 'Handover pending'),
  reconciled('reconciled', 'Reconciled'),
  cancelled('cancelled', 'Cancelled');

  const SessionStatus(this.key, this.label);
  final String key;
  final String label;

  static SessionStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => closed);
}

/// `after_hours_sessions/{id}` (`RMX-AHS-000001`): one stretch of after-hours
/// work and the cash the worker holds for it.
class AfterHoursSession {
  const AfterHoursSession({
    required this.sessionId,
    required this.sessionNumber,
    required this.staffUid,
    required this.staffName,
    required this.status,
    this.authorizationId,
    this.authorizationNumber,
    this.authorizationExpiresAt,
    this.supervisorName,
    this.openedAt,
    this.closedAt,
    this.closedByName,
    this.openingFloat = Money.zero,
    this.cashCollected = Money.zero,
    this.nonCashCollected = Money.zero,
    this.cashReversed = Money.zero,
    this.expectedCash = Money.zero,
    this.postCloseReversals = Money.zero,
    this.paymentCount = 0,
    this.intakesCreated = 0,
    this.invoicesCreated = 0,
    this.jobsCompleted = 0,
    this.handoverId,
    this.handoverNumber,
    this.handoverStatus,
    this.actualReceived,
    this.difference,
    this.notes,
  });

  final String sessionId;
  final String sessionNumber;
  final String staffUid;
  final String staffName;
  final SessionStatus status;
  final String? authorizationId;
  final String? authorizationNumber;
  final DateTime? authorizationExpiresAt;
  final String? supervisorName;
  final DateTime? openedAt;
  final DateTime? closedAt;
  final String? closedByName;
  final Money openingFloat;
  final Money cashCollected;
  final Money nonCashCollected;
  final Money cashReversed;

  /// Server-maintained: float + cash collected − cash reversed. Frozen at close.
  final Money expectedCash;
  final Money postCloseReversals;
  final int paymentCount;
  final int intakesCreated;
  final int invoicesCreated;
  final int jobsCompleted;
  final String? handoverId;
  final String? handoverNumber;
  final HandoverStatus? handoverStatus;
  final Money? actualReceived;
  final Money? difference;
  final String? notes;

  bool get isOpen => status == SessionStatus.open;

  /// The authorisation behind this session has ended (display only).
  bool authorizationEndedAt(DateTime now) => authorizationExpiresAt != null && !now.isBefore(authorizationExpiresAt!);

  static AfterHoursSession fromFirestore(String id, Map<String, dynamic> d) => AfterHoursSession(
        sessionId: id,
        sessionNumber: d['sessionNumber'] as String? ?? '',
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        status: SessionStatus.parse(d['status']),
        authorizationId: d['authorizationId'] as String?,
        authorizationNumber: d['authorizationNumber'] as String?,
        authorizationExpiresAt: _t(d['authorizationExpiresAt']),
        supervisorName: d['supervisorName'] as String?,
        openedAt: _t(d['openedAt']),
        closedAt: _t(d['closedAt']),
        closedByName: d['closedByName'] as String?,
        openingFloat: _m(d['openingFloatUgx']),
        cashCollected: _m(d['cashCollectedUgx']),
        nonCashCollected: _m(d['nonCashCollectedUgx']),
        cashReversed: _m(d['cashReversedUgx']),
        expectedCash: _m(d['expectedCashUgx']),
        postCloseReversals: _m(d['postCloseReversalsUgx']),
        paymentCount: _i(d['paymentCount']),
        intakesCreated: _i(d['intakesCreated']),
        invoicesCreated: _i(d['invoicesCreated']),
        jobsCompleted: _i(d['jobsCompleted']),
        handoverId: d['handoverId'] as String?,
        handoverNumber: d['handoverNumber'] as String?,
        handoverStatus: HandoverStatus.tryParse(d['handoverStatus']),
        actualReceived: _mOrNull(d['actualReceivedUgx']),
        difference: _mOrNull(d['differenceUgx']),
        notes: d['notes'] as String?,
      );
}

enum CustodyKind {
  openingFloat('opening_float', 'Opening float'),
  payment('payment', 'Payment'),
  paymentReversal('payment_reversal', 'Payment reversed');

  const CustodyKind(this.key, this.label);
  final String key;
  final String label;

  static CustodyKind parse(Object? v) => values.firstWhere((k) => k.key == v, orElse: () => payment);
}

/// `after_hours_cash/{id}` (`RMX-AHC-000001`): one movement of money in a
/// worker's custody during a session. Written only by the server.
class CustodyEntry {
  const CustodyEntry({
    required this.entryId,
    required this.entryNumber,
    required this.kind,
    required this.sessionId,
    required this.method,
    required this.amount,
    required this.cashDelta,
    this.affectsExpected = false,
    this.afterSessionClosed = false,
    this.receiptNumber,
    this.invoiceNumber,
    this.numberPlate,
    this.createdAt,
  });

  final String entryId;
  final String entryNumber;
  final CustodyKind kind;
  final String sessionId;
  final PaymentMethod method;

  /// Signed: a reversal is negative.
  final Money amount;

  /// The change to the cash the worker must hand over (0 for mobile money).
  final Money cashDelta;
  final bool affectsExpected;
  final bool afterSessionClosed;
  final String? receiptNumber;
  final String? invoiceNumber;
  final String? numberPlate;
  final DateTime? createdAt;

  static CustodyEntry fromFirestore(String id, Map<String, dynamic> d) => CustodyEntry(
        entryId: id,
        entryNumber: d['entryNumber'] as String? ?? '',
        kind: CustodyKind.parse(d['kind']),
        sessionId: d['sessionId'] as String? ?? '',
        method: PaymentMethod.parse(d['method']),
        amount: _m(d['amountUgx']),
        cashDelta: _m(d['cashDeltaUgx']),
        affectsExpected: d['affectsExpected'] == true,
        afterSessionClosed: d['afterSessionClosed'] == true,
        receiptNumber: d['receiptNumber'] as String?,
        invoiceNumber: d['invoiceNumber'] as String?,
        numberPlate: d['numberPlate'] as String?,
        createdAt: _t(d['createdAt']),
      );
}

/// Mirrors HANDOVER_STATUSES. A handover is never cancelled: any difference
/// goes through a discrepancy.
enum HandoverStatus {
  pending('pending', 'Waiting for the worker'),
  submitted('submitted', 'Submitted'),
  received('received', 'Received'),
  discrepancy('discrepancy', 'Discrepancy'),
  reconciled('reconciled', 'Reconciled');

  const HandoverStatus(this.key, this.label);
  final String key;
  final String label;

  /// Still waiting for the manager's count.
  bool get awaitingReceipt => this == pending || this == submitted;

  static HandoverStatus parse(Object? v) => tryParse(v) ?? pending;

  static HandoverStatus? tryParse(Object? v) {
    for (final s in values) {
      if (s.key == v) return s;
    }
    return null;
  }
}

/// `cash_handovers/{id}` (`RMX-HO-000001`). The expected cash is frozen by the
/// server when the session closes and is never edited afterwards.
class CashHandover {
  const CashHandover({
    required this.handoverId,
    required this.handoverNumber,
    required this.sessionId,
    required this.staffUid,
    required this.staffName,
    required this.status,
    required this.expectedCash,
    this.sessionNumber,
    this.openingFloat = Money.zero,
    this.cashCollected = Money.zero,
    this.cashReversed = Money.zero,
    this.nonCashCollected = Money.zero,
    this.paymentCount = 0,
    this.declaredAmount,
    this.actualAmount,
    this.difference,
    this.explanation,
    this.submittedAt,
    this.submittedByName,
    this.submitNotes,
    this.receivedAt,
    this.receivedByName,
    this.receiveNotes,
    this.discrepancyId,
    this.discrepancyNumber,
    this.reconciledAt,
    this.createdAt,
  });

  final String handoverId;
  final String handoverNumber;
  final String sessionId;
  final String? sessionNumber;
  final String staffUid;
  final String staffName;
  final HandoverStatus status;
  final Money openingFloat;
  final Money cashCollected;
  final Money cashReversed;
  final Money nonCashCollected;
  final int paymentCount;
  final Money expectedCash;
  final Money? declaredAmount;
  final Money? actualAmount;

  /// actual − expected: negative is a shortage, positive an excess.
  final Money? difference;
  final String? explanation;
  final DateTime? submittedAt;
  final String? submittedByName;
  final String? submitNotes;
  final DateTime? receivedAt;
  final String? receivedByName;
  final String? receiveNotes;
  final String? discrepancyId;
  final String? discrepancyNumber;
  final DateTime? reconciledAt;
  final DateTime? createdAt;

  static CashHandover fromFirestore(String id, Map<String, dynamic> d) => CashHandover(
        handoverId: id,
        handoverNumber: d['handoverNumber'] as String? ?? '',
        sessionId: d['sessionId'] as String? ?? '',
        sessionNumber: d['sessionNumber'] as String?,
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        status: HandoverStatus.parse(d['status']),
        openingFloat: _m(d['openingFloatUgx']),
        cashCollected: _m(d['cashCollectedUgx']),
        cashReversed: _m(d['cashReversedUgx']),
        nonCashCollected: _m(d['nonCashCollectedUgx']),
        paymentCount: _i(d['paymentCount']),
        expectedCash: _m(d['expectedCashUgx']),
        declaredAmount: _mOrNull(d['declaredAmountUgx']),
        actualAmount: _mOrNull(d['actualAmountUgx']),
        difference: _mOrNull(d['differenceUgx']),
        explanation: d['explanation'] as String?,
        submittedAt: _t(d['submittedAt']),
        submittedByName: d['submittedByName'] as String?,
        submitNotes: d['submitNotes'] as String?,
        receivedAt: _t(d['receivedAt']),
        receivedByName: d['receivedByName'] as String?,
        receiveNotes: d['receiveNotes'] as String?,
        discrepancyId: d['discrepancyId'] as String?,
        discrepancyNumber: d['discrepancyNumber'] as String?,
        reconciledAt: _t(d['reconciledAt']),
        createdAt: _t(d['createdAt']),
      );
}

/// Display-only preview of what the server will record on receipt
/// (`compareCash` in after_hours.js). The server recalculates it.
({Money difference, DiscrepancyKind? kind}) previewDifference(Money expected, Money actual) {
  final diff = actual - expected;
  return (
    difference: diff,
    kind: diff.ugx == 0 ? null : (diff.ugx < 0 ? DiscrepancyKind.shortage : DiscrepancyKind.excess),
  );
}

enum DiscrepancyKind {
  shortage('shortage', 'Shortage'),
  excess('excess', 'Excess');

  const DiscrepancyKind(this.key, this.label);
  final String key;
  final String label;

  static DiscrepancyKind parse(Object? v) => values.firstWhere((k) => k.key == v, orElse: () => shortage);
}

/// Mirrors DISCREPANCY_STATUSES.
enum DiscrepancyStatus {
  open('open', 'Open'),
  underReview('under_review', 'Under review'),
  resolved('resolved', 'Resolved'),
  waived('waived', 'Waived');

  const DiscrepancyStatus(this.key, this.label);
  final String key;
  final String label;

  bool get isOpen => this == open || this == underReview;

  static DiscrepancyStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => open);
}

/// `cash_discrepancies/{id}` (`RMX-AHD-000001`). Expected, actual and the
/// difference are the originals and never change; the resolution is added.
class CashDiscrepancy {
  const CashDiscrepancy({
    required this.discrepancyId,
    required this.discrepancyNumber,
    required this.handoverId,
    required this.staffUid,
    required this.staffName,
    required this.expectedCash,
    required this.actualAmount,
    required this.difference,
    required this.kind,
    required this.status,
    this.handoverNumber,
    this.sessionId,
    this.sessionNumber,
    this.declaredAmount,
    this.reason,
    this.reportedByName,
    this.reportedAt,
    this.reviewedByName,
    this.reviewNotes,
    this.resolution,
    this.resolvedByName,
    this.resolvedAt,
    this.lossIncidentId,
    this.lossNumber,
    this.adjustmentTransactionId,
    this.adjustmentTransactionNumber,
    this.createdAt,
  });

  final String discrepancyId;
  final String discrepancyNumber;
  final String handoverId;
  final String? handoverNumber;
  final String? sessionId;
  final String? sessionNumber;
  final String staffUid;
  final String staffName;
  final Money expectedCash;
  final Money? declaredAmount;
  final Money actualAmount;
  final Money difference;
  final DiscrepancyKind kind;
  final DiscrepancyStatus status;
  final String? reason;
  final String? reportedByName;
  final DateTime? reportedAt;
  final String? reviewedByName;
  final String? reviewNotes;
  final String? resolution;
  final String? resolvedByName;
  final DateTime? resolvedAt;
  final String? lossIncidentId;
  final String? lossNumber;
  final String? adjustmentTransactionId;
  final String? adjustmentTransactionNumber;
  final DateTime? createdAt;

  static CashDiscrepancy fromFirestore(String id, Map<String, dynamic> d) => CashDiscrepancy(
        discrepancyId: id,
        discrepancyNumber: d['discrepancyNumber'] as String? ?? '',
        handoverId: d['handoverId'] as String? ?? '',
        handoverNumber: d['handoverNumber'] as String?,
        sessionId: d['sessionId'] as String?,
        sessionNumber: d['sessionNumber'] as String?,
        staffUid: d['staffUid'] as String? ?? '',
        staffName: d['staffName'] as String? ?? '',
        expectedCash: _m(d['expectedCashUgx']),
        declaredAmount: _mOrNull(d['declaredAmountUgx']),
        actualAmount: _m(d['actualAmountUgx']),
        difference: _m(d['differenceUgx']),
        kind: DiscrepancyKind.parse(d['kind']),
        status: DiscrepancyStatus.parse(d['status']),
        reason: d['reason'] as String?,
        reportedByName: d['reportedByName'] as String?,
        reportedAt: _t(d['reportedAt']),
        reviewedByName: d['reviewedByName'] as String?,
        reviewNotes: d['reviewNotes'] as String?,
        resolution: d['resolution'] as String?,
        resolvedByName: d['resolvedByName'] as String?,
        resolvedAt: _t(d['resolvedAt']),
        lossIncidentId: d['lossIncidentId'] as String?,
        lossNumber: d['lossNumber'] as String?,
        adjustmentTransactionId: d['adjustmentTransactionId'] as String?,
        adjustmentTransactionNumber: d['adjustmentTransactionNumber'] as String?,
        createdAt: _t(d['createdAt']),
      );
}

/// `settings/after_hours_policy`. Defaults mirror DEFAULT_POLICY.
class AfterHoursPolicy {
  const AfterHoursPolicy({
    this.allowedPaymentMethods = const [PaymentMethod.cash, PaymentMethod.mtnMerchant, PaymentMethod.airtelMerchant],
    this.maxAuthorizationHours = 16,
    this.maxOpeningFloat = const Money(1000000),
  });

  final List<PaymentMethod> allowedPaymentMethods;
  final int maxAuthorizationHours;
  final Money maxOpeningFloat;

  static AfterHoursPolicy fromFirestore(Map<String, dynamic>? d) {
    if (d == null) return const AfterHoursPolicy();
    const defaults = AfterHoursPolicy();
    final raw = d['allowedPaymentMethods'];
    return AfterHoursPolicy(
      allowedPaymentMethods: raw is List
          ? [for (final m in PaymentMethod.values) if (raw.contains(m.key)) m]
          : defaults.allowedPaymentMethods,
      maxAuthorizationHours: (d['maxAuthorizationHours'] as num?)?.toInt() ?? defaults.maxAuthorizationHours,
      maxOpeningFloat: d['maxOpeningFloatUgx'] is num ? Money((d['maxOpeningFloatUgx'] as num).toInt()) : defaults.maxOpeningFloat,
    );
  }
}

/// Permissions a supervisor may include in an authorisation. Mirrors
/// AFTER_HOURS_GRANTABLE; the server refuses anything else (payroll, users,
/// settings, finance configuration, reversals, prices, discounts...).
const List<Permission> afterHoursGrantable = [
  Permission.afterHoursOperate,
  Permission.afterHoursCashCollect,
  Permission.jobsView,
  Permission.jobsCreate,
  Permission.jobsAssign,
  Permission.invoicesView,
  Permission.invoicesCreate,
  Permission.customersView,
  Permission.customersManage,
  Permission.vehiclesManage,
];

/// Mirrors DEFAULT_GRANTS.
const List<Permission> afterHoursDefaultGrants = [
  Permission.afterHoursOperate,
  Permission.afterHoursCashCollect,
  Permission.jobsView,
  Permission.jobsCreate,
  Permission.jobsAssign,
  Permission.invoicesView,
  Permission.invoicesCreate,
];

/// Report totals over a list of handovers (display; figures are server-written).
class HandoverTotals {
  const HandoverTotals({
    required this.expected,
    required this.received,
    required this.shortages,
    required this.excesses,
    required this.awaiting,
    required this.count,
  });

  final Money expected;
  final Money received;
  final Money shortages;
  final Money excesses;
  final int awaiting;
  final int count;

  static HandoverTotals of(Iterable<CashHandover> list) {
    var expected = 0, received = 0, short = 0, excess = 0, awaiting = 0, count = 0;
    for (final h in list) {
      count++;
      expected += h.expectedCash.ugx;
      if (h.actualAmount != null) received += h.actualAmount!.ugx;
      final d = h.difference?.ugx ?? 0;
      if (d < 0) short += -d;
      if (d > 0) excess += d;
      if (h.status.awaitingReceipt) awaiting++;
    }
    return HandoverTotals(
      expected: Money(expected),
      received: Money(received),
      shortages: Money(short),
      excesses: Money(excess),
      awaiting: awaiting,
      count: count,
    );
  }
}
