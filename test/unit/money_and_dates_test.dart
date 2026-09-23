import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/core/utils/date_time_utils.dart';

void main() {
  group('Money (UGX)', () {
    test('formats with grouping and currency code', () {
      expect(const Money(25000).format(), 'UGX 25,000');
      expect(const Money(0).format(), 'UGX 0');
      expect(const Money(1234567).formatAmount(), '1,234,567');
      expect(const Money(-5000).format(), 'UGX -5,000');
    });

    test('daily allowance of UGX 5,000 over 26 working days is exact', () {
      expect(const Money(5000).times(26), const Money(130000));
    });

    test('25% loyalty reward is computed in basis points without floats', () {
      expect(const Money(30000).percentage(2500), const Money(7500));
      // 25% of 10,001 = 2,500.25 → rounds to 2,500.
      expect(const Money(10001).percentage(2500), const Money(2500));
      // 25% of 10,002 = 2,500.5 → rounds half away from zero to 2,501.
      expect(const Money(10002).percentage(2500), const Money(2501));
    });

    test('sums precisely where doubles would drift', () {
      final many = List.filled(1000, const Money(333));
      expect(Money.sum(many), const Money(333000));
    });

    test('parses user input and rejects decimals and junk', () {
      expect(Money.tryParse('25,000'), const Money(25000));
      expect(Money.tryParse('UGX 25000'), const Money(25000));
      expect(Money.tryParse(' 25 000 '), const Money(25000));
      expect(Money.tryParse('25000.50'), isNull);
      expect(Money.tryParse('abc'), isNull);
      expect(Money.tryParse(''), isNull);
    });

    test('comparison and equality', () {
      expect(const Money(100) > const Money(50), isTrue);
      expect(const Money(100) == const Money(100), isTrue);
      expect(const Money(100) - const Money(150), const Money(-50));
    });
  });

  group('East Africa Time', () {
    test('business day is computed in EAT regardless of UTC date', () {
      // 22:30 UTC on 20 Sep is 01:30 EAT on 21 Sep.
      final instant = DateTime.utc(2026, 9, 20, 22, 30);
      expect(EastAfricaTime.businessDayKey(instant), '2026-09-21');
      // 20:59 UTC is still 23:59 EAT on the 20th.
      expect(EastAfricaTime.businessDayKey(DateTime.utc(2026, 9, 20, 20, 59)), '2026-09-20');
    });

    test('day bounds span exactly one EAT calendar day', () {
      final (start, end) = EastAfricaTime.dayBounds(DateTime.utc(2026, 9, 21, 10));
      expect(start, DateTime.utc(2026, 9, 20, 21));
      expect(end, DateTime.utc(2026, 9, 21, 21));
    });

    test('month bounds handle December rollover', () {
      final (start, end) = EastAfricaTime.monthBounds(DateTime.utc(2026, 12, 15));
      expect(start, DateTime.utc(2026, 11, 30, 21));
      expect(end, DateTime.utc(2026, 12, 31, 21));
    });

    test('formatters render EAT wall-clock time', () {
      final instant = DateTime.utc(2026, 9, 21, 11, 5, 9);
      expect(DateTimeFormatter.date(instant), '21 Sep 2026');
      expect(DateTimeFormatter.time(instant), '14:05');
      expect(DateTimeFormatter.dateTime(instant), '21 Sep 2026, 14:05');
      expect(DateTimeFormatter.transaction(instant), '21 Sep 2026, 14:05:09 EAT');
      expect(DateTimeFormatter.payrollPeriod(instant), 'September 2026');
    });

    test('countdown formats minutes and seconds', () {
      expect(DateTimeFormatter.countdown(const Duration(seconds: 59)), '00:59');
      expect(DateTimeFormatter.countdown(const Duration(seconds: 61)), '01:01');
      expect(DateTimeFormatter.countdown(const Duration(seconds: -3)), '00:00');
    });
  });
}
