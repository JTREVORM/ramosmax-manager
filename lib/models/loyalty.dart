import '../core/money/money.dart';
import 'firestore_converters.dart';
import 'invoice.dart' show percentOf;

/// The loyalty rules. Defaults match functions/src/loyalty.js; the live
/// values come from `settings/loyalty` (written only server-side).
class LoyaltyConfig {
  const LoyaltyConfig({
    this.pointsPerQualifyingService = 20,
    this.rewardThreshold = 200,
    this.rewardDiscountPercent = 25,
    this.pointsConsumedOnRedemption = 200,
    this.nearThresholdPoints = 160,
  });

  final int pointsPerQualifyingService;
  final int rewardThreshold;
  final int rewardDiscountPercent;
  final int pointsConsumedOnRedemption;
  final int nearThresholdPoints;

  static const LoyaltyConfig defaults = LoyaltyConfig();

  static LoyaltyConfig fromMap(Map<String, dynamic>? m) {
    int pick(String key, int fallback) {
      final v = m?[key];
      return v is int && v > 0 && v <= 100000 ? v : fallback;
    }

    const d = defaults;
    final percent = pick('rewardDiscountPercent', d.rewardDiscountPercent);
    return LoyaltyConfig(
      pointsPerQualifyingService: pick('pointsPerQualifyingService', d.pointsPerQualifyingService),
      rewardThreshold: pick('rewardThreshold', d.rewardThreshold),
      rewardDiscountPercent: percent > 100 ? 100 : percent,
      pointsConsumedOnRedemption: pick('pointsConsumedOnRedemption', d.pointsConsumedOnRedemption),
      nearThresholdPoints: pick('nearThresholdPoints', d.nearThresholdPoints),
    );
  }

  /// Points still needed for the next reward (0 when one is due).
  int pointsToNextReward(int balance) => balance >= rewardThreshold ? 0 : rewardThreshold - balance;
}

/// `loyalty_accounts/{vehicleId}`: loyalty belongs to the vehicle.
class LoyaltyAccount {
  const LoyaltyAccount({
    required this.vehicleId,
    required this.pointsBalance,
    this.numberPlate,
    this.lifetimePoints = 0,
    this.rewardsUnlocked = 0,
    this.rewardsRedeemed = 0,
    this.lastEarnedAt,
  });

  final String vehicleId;
  final String? numberPlate;
  final int pointsBalance;
  final int lifetimePoints;
  final int rewardsUnlocked;
  final int rewardsRedeemed;
  final DateTime? lastEarnedAt;

  /// A vehicle that has not earned anything yet has no account document.
  static LoyaltyAccount none(String vehicleId) => LoyaltyAccount(vehicleId: vehicleId, pointsBalance: 0);

  static LoyaltyAccount fromFirestore(String id, Map<String, dynamic> d) => LoyaltyAccount(
        vehicleId: id,
        numberPlate: d['numberPlate'] as String?,
        pointsBalance: (d['pointsBalance'] as num?)?.toInt() ?? 0,
        lifetimePoints: (d['lifetimePoints'] as num?)?.toInt() ?? 0,
        rewardsUnlocked: (d['rewardsUnlocked'] as num?)?.toInt() ?? 0,
        rewardsRedeemed: (d['rewardsRedeemed'] as num?)?.toInt() ?? 0,
        lastEarnedAt: FirestoreConverters.toDateTime(d['lastEarnedAt']),
      );
}

enum LoyaltyTransactionType {
  earned('earned', 'Earned'),
  redeemed('redeemed', 'Redeemed'),
  adjustment('adjustment', 'Adjustment'),
  reversal('reversal', 'Reversal'),
  expiry('expiry', 'Expiry');

  const LoyaltyTransactionType(this.key, this.label);
  final String key;
  final String label;

  static LoyaltyTransactionType parse(Object? v) => values.firstWhere((t) => t.key == v, orElse: () => adjustment);

  /// Redemptions are undone by cancelling their invoice; reversals are final.
  bool get isReversible => this != redeemed && this != reversal;
}

/// One immutable ledger entry.
class LoyaltyTransaction {
  const LoyaltyTransaction({
    required this.transactionId,
    required this.vehicleId,
    required this.type,
    required this.points,
    required this.balanceBefore,
    required this.balanceAfter,
    this.referenceType,
    this.referenceId,
    this.reason,
    this.createdByName,
    this.createdAt,
  });

  final String transactionId;
  final String vehicleId;
  final LoyaltyTransactionType type;
  final int points;
  final int balanceBefore;
  final int balanceAfter;
  final String? referenceType;
  final String? referenceId;
  final String? reason;
  final String? createdByName;
  final DateTime? createdAt;

  String get signedPoints => points > 0 ? '+$points' : '$points';

  static LoyaltyTransaction fromFirestore(String id, Map<String, dynamic> d) => LoyaltyTransaction(
        transactionId: id,
        vehicleId: d['vehicleId'] as String? ?? '',
        type: LoyaltyTransactionType.parse(d['type']),
        points: (d['points'] as num?)?.toInt() ?? 0,
        balanceBefore: (d['balanceBefore'] as num?)?.toInt() ?? 0,
        balanceAfter: (d['balanceAfter'] as num?)?.toInt() ?? 0,
        referenceType: d['referenceType'] as String?,
        referenceId: d['referenceId'] as String?,
        reason: d['reason'] as String?,
        createdByName: d['createdByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
      );
}

enum RewardStatus {
  available('available', 'Available'),
  redeemed('redeemed', 'Redeemed'),
  revoked('revoked', 'Revoked'),
  reversed('reversed', 'Returned');

  const RewardStatus(this.key, this.label);
  final String key;
  final String label;

  static RewardStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => revoked);
}

/// `loyalty_rewards/{id}`: an unlocked reward (e.g. 25% off one invoice).
class LoyaltyReward {
  const LoyaltyReward({
    required this.rewardId,
    required this.vehicleId,
    required this.discountPercent,
    required this.pointsCost,
    required this.status,
    this.unlockedAt,
    this.redeemedAt,
    this.redemptionInvoiceId,
    this.discount,
  });

  final String rewardId;
  final String vehicleId;
  final int discountPercent;
  final int pointsCost;
  final RewardStatus status;
  final DateTime? unlockedAt;
  final DateTime? redeemedAt;
  final String? redemptionInvoiceId;
  final Money? discount;

  bool get isAvailable => status == RewardStatus.available;

  /// Exactly what the server will take off [subtotal] (same rounding).
  Money previewFor(Money subtotal) => percentOf(subtotal, discountPercent);

  static LoyaltyReward fromFirestore(String id, Map<String, dynamic> d) => LoyaltyReward(
        rewardId: id,
        vehicleId: d['vehicleId'] as String? ?? '',
        discountPercent: (d['discountPercent'] as num?)?.toInt() ?? 0,
        pointsCost: (d['pointsCost'] as num?)?.toInt() ?? 0,
        status: RewardStatus.parse(d['status']),
        unlockedAt: FirestoreConverters.toDateTime(d['unlockedAt']),
        redeemedAt: FirestoreConverters.toDateTime(d['redeemedAt']),
        redemptionInvoiceId: d['redemptionInvoiceId'] as String?,
        discount: d['discountUgx'] is num ? Money((d['discountUgx'] as num).toInt()) : null,
      );
}
