import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/core/utils/validators.dart';

void main() {
  group('number plates', () {
    test('accepts common Ugandan formats', () {
      for (final plate in ['UBA 123A', 'uba123a', 'UAA 123', 'UEA 456B', 'UG 1234', 'UG 1234A', 'UPDF 1234', 'CD 123 45']) {
        expect(Validators.numberPlate(plate), isNull, reason: plate);
      }
    });

    test('normalises spacing and case so the plate is a stable identifier', () {
      expect(Validators.normalizePlate(' uba123a '), 'UBA 123A');
      expect(Validators.normalizePlate('UBA  123A'), 'UBA 123A');
      expect(Validators.normalizePlate('uba-123a'), 'UBA 123A');
    });

    test('rejects malformed plates', () {
      for (final plate in ['', 'ABC 123A', '123 UBA', 'UBA 12', 'UBA 12345']) {
        expect(Validators.numberPlate(plate), isNotNull, reason: plate);
      }
    });
  });

  group('amounts', () {
    test('amount allows zero, rejects negatives and decimals', () {
      expect(Validators.amount('0'), isNull);
      expect(Validators.amount('25,000'), isNull);
      expect(Validators.amount('-1'), isNotNull);
      expect(Validators.amount('10.5'), isNotNull);
      expect(Validators.amount(''), isNotNull);
      expect(Validators.amount('', isRequired: false), isNull);
    });

    test('positive amount rejects zero and enforces a maximum', () {
      expect(Validators.positiveAmount('0'), 'Amount must be greater than zero');
      expect(Validators.positiveAmount('5000'), isNull);
      expect(Validators.positiveAmount('6000', max: const Money(5000)), contains('UGX 5,000'));
    });
  });

  group('other validators', () {
    test('email is optional unless required', () {
      expect(Validators.email(''), isNull);
      expect(Validators.email('', isRequired: true), isNotNull);
      expect(Validators.email('ops@ramosmax.com'), isNull);
      expect(Validators.email('not-an-email'), isNotNull);
    });

    test('required', () {
      expect(Validators.required('  ', field: 'Name'), 'Name is required');
      expect(Validators.required('x'), isNull);
    });

    test('bank account and merchant codes', () {
      expect(Validators.bankAccountNumber('9030 0123 4567'), isNull);
      expect(Validators.bankAccountNumber('1234'), isNotNull);
      expect(Validators.merchantCode('123456'), isNull);
      expect(Validators.merchantCode('12a'), isNotNull);
    });

    test('dates', () {
      final now = DateTime(2026, 9, 21);
      expect(Validators.date(null), 'Select a date');
      expect(Validators.date(now.add(const Duration(days: 1)), notAfter: now), isNotNull);
      expect(Validators.date(now, notAfter: now), isNull);
    });

    test('sign-in password only needs to be present; new passwords follow the policy', () {
      expect(Validators.signInPassword(''), isNotNull);
      expect(Validators.signInPassword('x'), isNull);
      expect(Validators.newPassword('Fresh!Pass42'), isNull);
      expect(Validators.newPassword('fresh!pass42'), isNotNull);
      expect(Validators.newPassword(''), isNotNull);
      expect(Validators.newPassword('Xy!772123456', phoneNumber: '+256772123456'), 'Do not use your phone number.');
    });
  });
}
