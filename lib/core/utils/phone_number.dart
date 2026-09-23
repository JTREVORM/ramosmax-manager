/// A dialling country offered on the login screen.
class PhoneCountry {
  const PhoneCountry({
    required this.isoCode,
    required this.name,
    required this.dialCode,
    required this.flag,
    required this.nationalLengths,
    this.example = '',
  });

  final String isoCode;
  final String name;

  /// Digits only, without `+` (e.g. `256`).
  final String dialCode;
  final String flag;

  /// Accepted national-number lengths (without trunk `0`).
  final List<int> nationalLengths;
  final String example;

  String get display => '$flag +$dialCode';
}

/// Phone parsing and formatting. Uganda (+256) is the default and gets the
/// strictest validation; neighbouring countries are available for staff with
/// foreign SIM cards.
abstract final class PhoneNumbers {
  static const PhoneCountry uganda = PhoneCountry(
    isoCode: 'UG',
    name: 'Uganda',
    dialCode: '256',
    flag: '🇺🇬',
    nationalLengths: [9],
    example: '772 123 456',
  );

  static const List<PhoneCountry> countries = [
    uganda,
    PhoneCountry(isoCode: 'KE', name: 'Kenya', dialCode: '254', flag: '🇰🇪', nationalLengths: [9], example: '712 345 678'),
    PhoneCountry(isoCode: 'TZ', name: 'Tanzania', dialCode: '255', flag: '🇹🇿', nationalLengths: [9], example: '712 345 678'),
    PhoneCountry(isoCode: 'RW', name: 'Rwanda', dialCode: '250', flag: '🇷🇼', nationalLengths: [9], example: '781 234 567'),
    PhoneCountry(isoCode: 'SS', name: 'South Sudan', dialCode: '211', flag: '🇸🇸', nationalLengths: [9], example: '977 123 456'),
    PhoneCountry(isoCode: 'CD', name: 'DR Congo', dialCode: '243', flag: '🇨🇩', nationalLengths: [9], example: '812 345 678'),
    PhoneCountry(isoCode: 'BI', name: 'Burundi', dialCode: '257', flag: '🇧🇮', nationalLengths: [8], example: '79 123 456'),
    PhoneCountry(isoCode: 'GB', name: 'United Kingdom', dialCode: '44', flag: '🇬🇧', nationalLengths: [10], example: '7400 123456'),
    PhoneCountry(isoCode: 'US', name: 'United States', dialCode: '1', flag: '🇺🇸', nationalLengths: [10], example: '201 555 0123'),
  ];

  /// Ugandan mobile networks all start with 7 after the trunk prefix
  /// (MTN 77/78/76, Airtel 70/74/75, …); fixed lines start with 3 or 4.
  static final RegExp _ugandaNational = RegExp(r'^[347]\d{8}$');

  /// Strips spaces, dashes, brackets, a leading trunk `0` and a repeated
  /// country code, leaving the national significant number.
  static String nationalDigits(String input, PhoneCountry country) {
    var digits = input.replaceAll(RegExp(r'[^\d+]'), '');
    if (digits.startsWith('+')) digits = digits.substring(1);
    if (digits.startsWith('00')) digits = digits.substring(2);
    if (digits.startsWith(country.dialCode) &&
        digits.length > country.nationalLengths.first) {
      digits = digits.substring(country.dialCode.length);
    }
    if (digits.startsWith('0')) digits = digits.substring(1);
    return digits;
  }

  static bool isValid(String input, PhoneCountry country) {
    final digits = nationalDigits(input, country);
    if (!RegExp(r'^\d+$').hasMatch(digits)) return false;
    if (country.isoCode == 'UG') return _ugandaNational.hasMatch(digits);
    return country.nationalLengths.contains(digits.length);
  }

  /// E.164 form (`+256772123456`) — the only format sent to Firebase Auth and
  /// stored in Firestore. Returns null when the input is invalid.
  static String? toE164(String input, PhoneCountry country) {
    if (!isValid(input, country)) return null;
    return '+${country.dialCode}${nationalDigits(input, country)}';
  }

  /// E.164 for free-typed numbers (customer records, searches): Ugandan
  /// local/national/international forms (`0772…`, `772…`, `+256772…`), or
  /// any other country when typed in full international form (`+254…`).
  /// Mirrors `normalizePhone` in functions/src/access.js. Null when invalid.
  static String? normalize(String input) {
    final compact = input.trim().replaceAll(RegExp(r'[^\d+]'), '');
    if (compact.startsWith('+') && !compact.startsWith('+256')) {
      return RegExp(r'^\+[1-9]\d{7,14}$').hasMatch(compact) ? compact : null;
    }
    return toE164(compact, uganda);
  }

  /// Human-friendly `+256 772 123 456` for display.
  static String formatForDisplay(String e164) {
    final match = RegExp(r'^\+256(\d{3})(\d{3})(\d{3})$').firstMatch(e164);
    if (match != null) {
      return '+256 ${match.group(1)} ${match.group(2)} ${match.group(3)}';
    }
    return e164;
  }

  /// `+256 772 ••• 456` — for screens where the full number isn't needed.
  static String mask(String e164) {
    if (e164.length < 7) return e164;
    final display = formatForDisplay(e164);
    final visibleTail = display.substring(display.length - 3);
    final head = display.substring(0, display.length - 7).trimRight();
    return '$head ••• $visibleTail';
  }
}
