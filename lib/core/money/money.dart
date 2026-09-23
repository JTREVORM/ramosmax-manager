import 'package:intl/intl.dart';

/// An exact amount of Ugandan Shillings.
///
/// UGX has no minor unit in circulation (ISO 4217 exponent 0), so amounts are
/// held as a whole-shilling [int]. There is no floating point anywhere in the
/// money path: arithmetic is integer arithmetic and percentages are applied in
/// basis points with explicit rounding. Store in Firestore as an integer
/// field named `...Ugx` (e.g. `amountUgx: 25000`).
class Money implements Comparable<Money> {
  const Money(this.ugx);

  static const Money zero = Money(0);
  static const String currencyCode = 'UGX';

  final int ugx;

  bool get isZero => ugx == 0;
  bool get isPositive => ugx > 0;
  bool get isNegative => ugx < 0;

  Money operator +(Money other) => Money(ugx + other.ugx);
  Money operator -(Money other) => Money(ugx - other.ugx);
  Money operator -() => Money(-ugx);
  Money times(int quantity) => Money(ugx * quantity);

  bool operator >(Money other) => ugx > other.ugx;
  bool operator <(Money other) => ugx < other.ugx;
  bool operator >=(Money other) => ugx >= other.ugx;
  bool operator <=(Money other) => ugx <= other.ugx;

  /// Applies a percentage given in basis points (2500 = 25%), rounding half
  /// away from zero to the nearest shilling. Used for discounts and the
  /// loyalty reward so no double ever touches an amount.
  Money percentage(int basisPoints) {
    final product = ugx * basisPoints;
    final quotient = product ~/ 10000;
    final remainder = product.remainder(10000).abs();
    if (remainder * 2 >= 10000) {
      return Money(product >= 0 ? quotient + 1 : quotient - 1);
    }
    return Money(quotient);
  }

  static Money sum(Iterable<Money> amounts) =>
      amounts.fold(Money.zero, (total, m) => total + m);

  /// Parses user input such as `25,000`, `UGX 25000` or ` 25 000 `.
  /// Returns null for anything that is not a whole number of shillings —
  /// decimals are rejected, not rounded, so input mistakes surface.
  static Money? tryParse(String? input) {
    if (input == null) return null;
    var cleaned = input.trim().toUpperCase();
    if (cleaned.startsWith(currencyCode)) cleaned = cleaned.substring(3);
    cleaned = cleaned.replaceAll(RegExp(r'[\s,]'), '');
    if (!RegExp(r'^-?\d{1,15}$').hasMatch(cleaned)) return null;
    return Money(int.parse(cleaned));
  }

  static final NumberFormat _grouped = NumberFormat.decimalPattern('en_US');

  /// `UGX 25,000` — the standard display format.
  String format() => '$currencyCode ${formatAmount()}';

  /// `25,000` — for table cells where the currency is in the header.
  String formatAmount() => ugx < 0 ? '-${_grouped.format(-ugx)}' : _grouped.format(ugx);

  /// `UGX 1.2M`, `UGX 850K` — for dashboards and charts only; never on
  /// receipts or anywhere an exact figure is expected.
  String formatCompact() {
    final compact = NumberFormat.compact(locale: 'en_US').format(ugx);
    return '$currencyCode $compact';
  }

  @override
  int compareTo(Money other) => ugx.compareTo(other.ugx);

  @override
  bool operator ==(Object other) => other is Money && other.ugx == ugx;

  @override
  int get hashCode => ugx.hashCode;

  @override
  String toString() => format();
}
