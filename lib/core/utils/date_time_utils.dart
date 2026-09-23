import 'package:intl/intl.dart';

/// Date and time handling in East Africa Time.
///
/// RamosMAX operates in Uganda: EAT is UTC+03:00 all year (no daylight
/// saving). Firestore stores UTC instants; everything shown to users or used
/// to decide a *business day* (attendance, daily allowance, payroll period,
/// reports) is computed in EAT here — independent of the handset's own time
/// zone setting, so a phone set to the wrong zone cannot move a transaction
/// into a different day.
abstract final class EastAfricaTime {
  static const Duration offset = Duration(hours: 3);
  static const String label = 'EAT';

  /// Wall-clock EAT fields for [instant]. The returned value is flagged UTC
  /// purely as a carrier — read its fields, don't treat it as an instant.
  static DateTime toEat(DateTime instant) => instant.toUtc().add(offset);

  /// The UTC instant for a wall-clock EAT time.
  static DateTime fromEatWallClock(int year, int month, int day,
          [int hour = 0, int minute = 0, int second = 0]) =>
      DateTime.utc(year, month, day, hour, minute, second).subtract(offset);

  /// `2026-09-21` — stable key for "which business day did this happen on".
  /// Use for attendance and allowance document IDs and daily report grouping.
  static String businessDayKey(DateTime instant) =>
      DateFormat('yyyy-MM-dd').format(toEat(instant));

  /// UTC instants bounding the EAT calendar day containing [instant],
  /// as [start, end). Use for day-range queries.
  static (DateTime start, DateTime end) dayBounds(DateTime instant) {
    final eat = toEat(instant);
    final start = fromEatWallClock(eat.year, eat.month, eat.day);
    return (start, start.add(const Duration(days: 1)));
  }

  /// UTC bounds of the EAT calendar month containing [instant] — the default
  /// payroll period.
  static (DateTime start, DateTime end) monthBounds(DateTime instant) {
    final eat = toEat(instant);
    final start = fromEatWallClock(eat.year, eat.month, 1);
    final end = eat.month == 12
        ? fromEatWallClock(eat.year + 1, 1, 1)
        : fromEatWallClock(eat.year, eat.month + 1, 1);
    return (start, end);
  }
}

/// Central formatting so every screen shows dates the same way.
abstract final class DateTimeFormatter {
  static final _date = DateFormat('d MMM yyyy');
  static final _time = DateFormat('HH:mm');
  static final _dateTime = DateFormat('d MMM yyyy, HH:mm');
  static final _transaction = DateFormat('d MMM yyyy, HH:mm:ss');
  static final _period = DateFormat('MMMM yyyy');
  static final _weekday = DateFormat('EEE d MMM');

  /// `21 Sep 2026`
  static String date(DateTime instant) => _date.format(EastAfricaTime.toEat(instant));

  /// `14:05` (24-hour, EAT)
  static String time(DateTime instant) => _time.format(EastAfricaTime.toEat(instant));

  /// `21 Sep 2026, 14:05`
  static String dateTime(DateTime instant) => _dateTime.format(EastAfricaTime.toEat(instant));

  /// `21 Sep 2026, 14:05:09 EAT` — receipts, audit trails, transactions.
  static String transaction(DateTime instant) =>
      '${_transaction.format(EastAfricaTime.toEat(instant))} ${EastAfricaTime.label}';

  /// `September 2026` — payroll periods and monthly reports.
  static String payrollPeriod(DateTime instant) =>
      _period.format(EastAfricaTime.toEat(instant));

  /// `Mon 21 Sep` — attendance rows.
  static String attendanceDay(DateTime instant) =>
      _weekday.format(EastAfricaTime.toEat(instant));

  /// `mm:ss` countdown, e.g. time left on a lock-out or timer.
  static String countdown(Duration remaining) {
    final s = remaining.inSeconds.clamp(0, 5999);
    final minutes = (s ~/ 60).toString().padLeft(2, '0');
    final seconds = (s % 60).toString().padLeft(2, '0');
    return '$minutes:$seconds';
  }
}
