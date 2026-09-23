import '../auth/password_policy.dart';
import '../money/money.dart';
import 'phone_number.dart';

/// Reusable form validators. Each returns an error message, or null when the
/// value is valid, so they plug straight into `TextFormField.validator`.
abstract final class Validators {
  static String? required(String? value, {String field = 'This field'}) =>
      (value == null || value.trim().isEmpty) ? '$field is required' : null;

  static String? phone(String? value, {PhoneCountry country = PhoneNumbers.uganda}) {
    if (value == null || value.trim().isEmpty) return 'Enter your phone number';
    if (!PhoneNumbers.isValid(value, country)) {
      return country.isoCode == 'UG'
          ? 'Enter a valid Ugandan number, e.g. ${country.example}'
          : 'Enter a valid ${country.name} phone number';
    }
    return null;
  }

  static final RegExp _email =
      RegExp(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$");

  /// Optional by default: empty is accepted, malformed is not.
  static String? email(String? value, {bool isRequired = false}) {
    if (value == null || value.trim().isEmpty) {
      return isRequired ? 'Email is required' : null;
    }
    return _email.hasMatch(value.trim()) ? null : 'Enter a valid email address';
  }

  /// Password being typed at sign-in: only presence is checked here — the
  /// server decides whether it is right.
  static String? signInPassword(String? value) =>
      (value == null || value.isEmpty) ? 'Enter your password' : null;

  /// A NEW password: must meet [PasswordPolicy]. Never trimmed — spaces are
  /// part of a password.
  static String? newPassword(String? value, {String? phoneNumber, String? staffId, String? fullName}) {
    if (value == null || value.isEmpty) return 'Enter a new password';
    final problems = PasswordPolicy.problems(value,
        phoneNumber: phoneNumber, staffId: staffId, fullName: fullName);
    return problems.isEmpty ? null : problems.first;
  }

  /// A whole-shilling amount (zero allowed).
  static String? amount(String? value, {bool isRequired = true}) {
    if (value == null || value.trim().isEmpty) {
      return isRequired ? 'Enter an amount' : null;
    }
    final money = Money.tryParse(value);
    if (money == null) return 'Enter a whole amount in UGX, e.g. 25,000';
    if (money.isNegative) return 'Amount cannot be negative';
    return null;
  }

  /// A strictly positive amount — payments, expenses, transfers.
  static String? positiveAmount(String? value, {Money? max}) {
    final basic = amount(value);
    if (basic != null) return basic;
    final money = Money.tryParse(value)!;
    if (!money.isPositive) return 'Amount must be greater than zero';
    if (max != null && money > max) return 'Amount cannot exceed ${max.format()}';
    return null;
  }

  /// Rejects missing dates and, optionally, dates outside [notBefore, notAfter].
  static String? date(DateTime? value, {DateTime? notBefore, DateTime? notAfter}) {
    if (value == null) return 'Select a date';
    if (notBefore != null && value.isBefore(notBefore)) return 'Date is too early';
    if (notAfter != null && value.isAfter(notAfter)) return 'Date cannot be in the future';
    return null;
  }

  /// Ugandan number plates. The plate is the primary vehicle identifier, so
  /// it is normalised (upper case, single spaces) before validation and
  /// storage — see [normalizePlate].
  ///   Private/commercial: `UAA 123A`, `UBA 123B`, legacy `UAA 123`
  ///   Motorcycles:        `UEA 123A`, `UDA 123A`
  ///   Government / army:  `UG 1234`, `UG 1234A`, `UP 1234`, `UPDF 1234`
  ///   Diplomatic:         `CD 123 45`, `UN 123 45`
  static final List<RegExp> _plates = [
    RegExp(r'^U[A-Z]{2} \d{3}[A-Z]?$'),
    RegExp(r'^(UG|UP|UPDF|UPF|UA) \d{3,4}[A-Z]?$'),
    RegExp(r'^(CD|UN|DC) \d{2,3} \d{2,3}$'),
  ];

  static String normalizePlate(String input) {
    final upper = input.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9 ]'), ' ');
    final spaced = upper.trim().replaceAll(RegExp(r'\s+'), ' ');
    // Already canonical (including multi-group diplomatic plates): keep it.
    if (_plates.any((p) => p.hasMatch(spaced))) return spaced;
    final compact = upper.replaceAll(RegExp(r'\s+'), '');
    // Insert the canonical space between the letter prefix and the digits.
    final m = RegExp(r'^([A-Z]+)(\d+)([A-Z]?)$').firstMatch(compact);
    if (m != null) return '${m.group(1)} ${m.group(2)}${m.group(3)}';
    return upper.trim().replaceAll(RegExp(r'\s+'), ' ');
  }

  static String? numberPlate(String? value) {
    if (value == null || value.trim().isEmpty) return 'Enter the number plate';
    final plate = normalizePlate(value);
    return _plates.any((p) => p.hasMatch(plate))
        ? null
        : 'Enter a valid plate, e.g. UBA 123A';
  }

  /// Bank account numbers: 8–20 digits, spaces and dashes ignored.
  static String? bankAccountNumber(String? value) {
    if (value == null || value.trim().isEmpty) return 'Enter the account number';
    final digits = value.replaceAll(RegExp(r'[\s-]'), '');
    if (!RegExp(r'^\d{8,20}$').hasMatch(digits)) {
      return 'Account number must be 8–20 digits';
    }
    return null;
  }

  /// Mobile-money merchant / till codes: 4–12 digits.
  static String? merchantCode(String? value) {
    if (value == null || value.trim().isEmpty) return 'Enter the merchant code';
    return RegExp(r'^\d{4,12}$').hasMatch(value.trim())
        ? null
        : 'Merchant code must be 4–12 digits';
  }
}
