import '../../../core/utils/phone_number.dart';
import '../../../models/customer.dart';

/// How a typed customer search is run against Firestore. Pure, so it is
/// unit-tested without Firebase.
sealed class CustomerQuery {
  const CustomerQuery();

  static final RegExp _customerNumber = RegExp(r'^(RMX-)?CUS-?\d+$', caseSensitive: false);

  /// `0772 123 456`, `+256772123456` → phone (E.164, the stored form);
  /// `RMX-CUS-000012` / `cus-12` → customer number; anything else → name.
  static CustomerQuery parse(String input) {
    final text = input.trim();
    if (text.isEmpty) return const RecentCustomers();
    if (_customerNumber.hasMatch(text)) {
      final digits = text.replaceAll(RegExp(r'\D'), '');
      return CustomerNumberQuery('RMX-CUS-${digits.padLeft(6, '0')}');
    }
    final digitsOnly = RegExp(r'^[\d\s+()-]+$').hasMatch(text);
    if (digitsOnly) {
      final e164 = PhoneNumbers.normalize(text);
      return e164 == null ? IncompletePhone(text) : PhoneQuery(e164);
    }
    final words = text.toLowerCase().split(RegExp(r'[^a-z0-9]+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return const RecentCustomers();
    // The longest word is the most selective token; the rest filter locally.
    words.sort((a, b) => b.length.compareTo(a.length));
    final token = words.first.length > 15 ? words.first.substring(0, 15) : words.first;
    return NameQuery(token, words);
  }
}

final class RecentCustomers extends CustomerQuery {
  const RecentCustomers();
}

final class PhoneQuery extends CustomerQuery {
  const PhoneQuery(this.e164);
  final String e164;
}

/// Digits that are not (yet) a full phone number — nothing to query.
final class IncompletePhone extends CustomerQuery {
  const IncompletePhone(this.text);
  final String text;
}

final class CustomerNumberQuery extends CustomerQuery {
  const CustomerNumberQuery(this.customerNumber);
  final String customerNumber;
}

final class NameQuery extends CustomerQuery {
  const NameQuery(this.token, this.words);

  /// Matched on the server via `searchTokens array-contains`.
  final String token;

  /// Every word must prefix a word of the name (checked on the device).
  final List<String> words;

  bool matches(Customer c) {
    final nameWords = c.fullName.toLowerCase().split(RegExp(r'[^a-z0-9]+'));
    return words.every((w) => nameWords.any((n) => n.startsWith(w)));
  }
}
