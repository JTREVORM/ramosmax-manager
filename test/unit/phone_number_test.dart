import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/utils/phone_number.dart';
import 'package:ramosmax_auto_manager/core/utils/validators.dart';

void main() {
  const ug = PhoneNumbers.uganda;
  final kenya = PhoneNumbers.countries.firstWhere((c) => c.isoCode == 'KE');

  group('Uganda phone numbers', () {
    test('accepts local, trunk-prefixed and international formats', () {
      for (final input in [
        '772123456',
        '0772123456',
        '0772 123 456',
        '+256772123456',
        '256 772 123 456',
        '00256772123456',
        '(0772) 123-456',
      ]) {
        expect(PhoneNumbers.toE164(input, ug), '+256772123456', reason: input);
      }
    });

    test('accepts Airtel and landline prefixes', () {
      expect(PhoneNumbers.toE164('0701234567', ug), '+256701234567');
      expect(PhoneNumbers.toE164('0414123456', ug), '+256414123456');
    });

    test('rejects wrong lengths and invalid leading digits', () {
      for (final input in ['', '77212345', '07721234567', '0872123456', 'abc', '0172123456']) {
        expect(PhoneNumbers.isValid(input, ug), isFalse, reason: input);
        expect(PhoneNumbers.toE164(input, ug), isNull, reason: input);
      }
    });

    test('formats and masks for display', () {
      expect(PhoneNumbers.formatForDisplay('+256772123456'), '+256 772 123 456');
      expect(PhoneNumbers.mask('+256772123456'), '+256 772 ••• 456');
    });

    test('Uganda is the default and first country', () {
      expect(PhoneNumbers.countries.first.dialCode, '256');
    });
  });

  group('other countries', () {
    test('Kenya numbers normalise to E.164', () {
      expect(PhoneNumbers.toE164('0712345678', kenya), '+254712345678');
      expect(PhoneNumbers.toE164('+254712345678', kenya), '+254712345678');
    });

    test('a Ugandan number is not valid as Kenyan when the code differs', () {
      expect(PhoneNumbers.toE164('+256772123456', kenya), isNull);
    });
  });

  group('Validators.phone', () {
    test('returns a helpful message for Uganda', () {
      expect(Validators.phone(''), 'Enter your phone number');
      expect(Validators.phone('123'), contains('valid Ugandan number'));
      expect(Validators.phone('0772123456'), isNull);
    });
  });
}
