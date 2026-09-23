import 'dart:math';

/// The RamosMAX password policy and a secure temporary-password generator.
///
/// A UX mirror of `functions/src/passwords.js`: the Cloud Functions enforce
/// the same rules, so a modified app cannot set a weak password. Passwords
/// are never stored, logged or sent anywhere except to those functions over
/// HTTPS — Firebase Authentication holds them.
abstract final class PasswordPolicy {
  static const int minLength = 8;
  static const int maxLength = 128;
  static const int generatedLength = 12;

  /// Shown next to password fields.
  static const List<String> requirements = [
    'At least 8 characters',
    'An uppercase and a lowercase letter',
    'A number',
    'A symbol, e.g. ! @ # \$ %',
    'Not your name, phone number or staff ID',
  ];

  // No look-alikes (0/O/o, 1/l/I) so a temporary password can be read out or
  // copied from a screen without mistakes.
  static const String _upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  static const String _lower = 'abcdefghijkmnpqrstuvwxyz';
  static const String _digits = '23456789';
  static const String _special = r'!@#$%*?-+=';

  static const Set<String> _common = {
    'password', 'password1', 'passw0rd', 'qwerty', 'qwerty123', '12345678', '123456789', 'abc12345',
    'letmein', 'welcome', 'welcome1', 'admin123', 'ramosmax', 'ramos123', 'ramosmax1', 'changeme',
  };

  /// Unmet requirements (empty = acceptable).
  static List<String> problems(String password, {String? phoneNumber, String? staffId, String? fullName}) {
    final problems = <String>[];
    if (password.length < minLength) problems.add('Use at least $minLength characters.');
    if (password.length > maxLength) problems.add('Use at most $maxLength characters.');
    if (!RegExp('[A-Z]').hasMatch(password)) problems.add('Add an uppercase letter.');
    if (!RegExp('[a-z]').hasMatch(password)) problems.add('Add a lowercase letter.');
    if (!RegExp(r'\d').hasMatch(password)) problems.add('Add a number.');
    if (!RegExp('[^A-Za-z0-9]').hasMatch(password)) problems.add('Add a symbol, e.g. ! @ # \$ %.');

    final lower = password.toLowerCase();
    final compact = lower.replaceAll(RegExp('[^a-z0-9]'), '');
    if (_common.contains(lower) || _common.contains(compact) || RegExp('^(ramos|password|qwerty)').hasMatch(compact)) {
      problems.add('This password is too easy to guess.');
    }
    final phoneDigits = (phoneNumber ?? '').replaceAll(RegExp(r'\D'), '');
    if (phoneDigits.length >= 6 &&
        password.replaceAll(RegExp(r'\D'), '').contains(phoneDigits.substring(phoneDigits.length - 6))) {
      problems.add('Do not use your phone number.');
    }
    final staff = (staffId ?? '').toLowerCase().replaceAll(RegExp('[^a-z0-9]'), '');
    if (staff.isNotEmpty && compact.contains(staff)) problems.add('Do not use your staff ID.');
    for (final part in (fullName ?? '').toLowerCase().split(RegExp(r'\s+'))) {
      if (part.length >= 4 && lower.contains(part)) {
        problems.add('Do not use your name.');
        break;
      }
    }
    return problems;
  }

  /// A cryptographically random password that always meets the policy.
  static String generate({int length = generatedLength, Random? random}) {
    final rng = random ?? Random.secure();
    String pick(String chars) => chars[rng.nextInt(chars.length)];
    const all = _upper + _lower + _digits + _special;
    while (true) {
      final chars = [pick(_upper), pick(_lower), pick(_digits), pick(_special)];
      while (chars.length < length) {
        chars.add(pick(all));
      }
      chars.shuffle(rng);
      final password = chars.join();
      if (problems(password).isEmpty) return password;
    }
  }
}
