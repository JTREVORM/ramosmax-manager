import '../../../core/utils/phone_number.dart';
import '../../../models/shareholding.dart';

/// How a typed shareholder search is run against Firestore. Pure, so it is
/// unit-tested without Firebase. Every query is bounded - the register is
/// never downloaded whole.
sealed class ShareholderQuery {
  const ShareholderQuery();

  static final RegExp _number = RegExp(r'^(RMX-)?SHR-?\d+$', caseSensitive: false);

  /// `RMX-SHR-000012` / `shr-12` → shareholder number; `0772 123 456` →
  /// phone (E.164); anything else → name words.
  static ShareholderQuery parse(String input) {
    final text = input.trim();
    if (text.isEmpty) return const AllShareholders();
    if (_number.hasMatch(text)) {
      final digits = text.replaceAll(RegExp(r'\D'), '');
      return ShareholderNumberQuery('RMX-SHR-${digits.padLeft(6, '0')}');
    }
    if (RegExp(r'^[\d\s+()-]+$').hasMatch(text)) {
      final e164 = PhoneNumbers.normalize(text);
      return e164 == null ? IncompleteShareholderPhone(text) : ShareholderPhoneQuery(e164);
    }
    final words = text.toLowerCase().split(RegExp(r'[^a-z0-9]+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return const AllShareholders();
    words.sort((a, b) => b.length.compareTo(a.length));
    final token = words.first.length > 15 ? words.first.substring(0, 15) : words.first;
    return ShareholderNameQuery(token, words);
  }
}

final class AllShareholders extends ShareholderQuery {
  const AllShareholders();
}

final class ShareholderNumberQuery extends ShareholderQuery {
  const ShareholderNumberQuery(this.number);
  final String number;
}

final class ShareholderPhoneQuery extends ShareholderQuery {
  const ShareholderPhoneQuery(this.e164);
  final String e164;
}

final class IncompleteShareholderPhone extends ShareholderQuery {
  const IncompleteShareholderPhone(this.text);
  final String text;
}

final class ShareholderNameQuery extends ShareholderQuery {
  const ShareholderNameQuery(this.token, this.words);

  /// Matched on the server via `searchTokens array-contains`.
  final String token;

  /// Every word must prefix a word of the name (checked on the device).
  final List<String> words;

  bool matches(Shareholder s) {
    final nameWords = s.fullName.toLowerCase().split(RegExp(r'[^a-z0-9]+'));
    return words.every((w) => nameWords.any((n) => n.startsWith(w)));
  }
}
