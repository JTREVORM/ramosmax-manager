import '../core/auth/permissions.dart';
import '../core/money/money.dart';
import '../core/utils/date_time_utils.dart';

// Phase 9 reports. Every figure is calculated by the getBusinessReport Cloud
// Function (functions/src/reports.js) from authoritative records; the app
// only displays and exports what it receives.

/// Mirrors REPORTS in functions/src/reports.js (the server re-checks).
enum ReportType {
  executive('executive', 'Executive summary', 'Operations, revenue, finance, workforce, stock, ownership and after-hours at a glance',
      {Permission.reportsOperationalView, Permission.reportsFinancialView}),
  financial('financial', 'Money in and out', 'Daily payments, expenses, transfers, deposits, adjustments, capital and dividends',
      {Permission.reportsFinancialView, Permission.financeView}),
  revenue('revenue', 'Revenue', 'Operating revenue, kept apart from owners\' money and transfers',
      {Permission.reportsFinancialView, Permission.financeView}),
  paymentMethods('payment_methods', 'Payment methods', 'Cash, MTN, Airtel and bank: count, gross, reversed and net',
      {Permission.reportsFinancialView, Permission.financeView}),
  outstanding('outstanding', 'Outstanding and credit', 'Open invoices with age and payment history', {Permission.creditView}),
  expenses('expenses', 'Expenses', 'By status and category, and money paid out by kind', {Permission.expensesView}),
  inventory('inventory', 'Inventory', 'Stock, low stock, movements, purchases and suppliers',
      {Permission.inventoryReportsView, Permission.inventoryView}),
  workforce('workforce', 'Workforce', 'Attendance, allowances, payroll and losses (as permitted)',
      {Permission.attendanceView, Permission.payrollView, Permission.reportsPayrollView}),
  shareholders('shareholders', 'Shareholders', 'Register, ownership, classes, contributions and dividends (as permitted)',
      {Permission.shareholdersReportsView, Permission.sharesView, Permission.shareholdersView}),
  afterHours('after_hours', 'After-hours', 'Sessions, workers, expected cash, handovers and discrepancies', {Permission.afterHoursView});

  const ReportType(this.key, this.label, this.description, this.requires);
  final String key;
  final String label;
  final String description;
  final Set<Permission> requires;

  static ReportType? tryParse(String? key) {
    for (final t in values) {
      if (t.key == key) return t;
    }
    return null;
  }
}

/// Period presets in East Africa Time. Weeks start on Monday.
enum ReportPeriodPreset {
  today('Today'),
  yesterday('Yesterday'),
  thisWeek('This week'),
  thisMonth('This month'),
  previousMonth('Previous month'),
  custom('Custom');

  const ReportPeriodPreset(this.label);
  final String label;
}

/// An inclusive range of EAT business days (`2026-09-01` … `2026-09-30`).
class ReportPeriod {
  const ReportPeriod(this.from, this.to);
  final String from;
  final String to;

  static String dayKey(DateTime eatDate) =>
      '${eatDate.year.toString().padLeft(4, '0')}-${eatDate.month.toString().padLeft(2, '0')}-${eatDate.day.toString().padLeft(2, '0')}';

  /// The period [preset] means at [now] (an instant). Custom → today.
  static ReportPeriod forPreset(ReportPeriodPreset preset, DateTime now) {
    final e = EastAfricaTime.toEat(now);
    final today = DateTime.utc(e.year, e.month, e.day);
    switch (preset) {
      case ReportPeriodPreset.today || ReportPeriodPreset.custom:
        return ReportPeriod(dayKey(today), dayKey(today));
      case ReportPeriodPreset.yesterday:
        final y = today.subtract(const Duration(days: 1));
        return ReportPeriod(dayKey(y), dayKey(y));
      case ReportPeriodPreset.thisWeek:
        return ReportPeriod(dayKey(today.subtract(Duration(days: today.weekday - DateTime.monday))), dayKey(today));
      case ReportPeriodPreset.thisMonth:
        return ReportPeriod(dayKey(DateTime.utc(today.year, today.month, 1)), dayKey(today));
      case ReportPeriodPreset.previousMonth:
        final first = DateTime.utc(today.year, today.month - 1, 1);
        final last = DateTime.utc(today.year, today.month, 0);
        return ReportPeriod(dayKey(first), dayKey(last));
    }
  }

  String get label => from == to ? from : '$from – $to';

  @override
  bool operator ==(Object other) => other is ReportPeriod && other.from == from && other.to == to;

  @override
  int get hashCode => Object.hash(from, to);
}

enum ReportValueKind { money, count, percent, date, text }

ReportValueKind _kind(Object? v) => switch (v) {
      'money' => ReportValueKind.money,
      'count' => ReportValueKind.count,
      'percent' => ReportValueKind.percent,
      'date' => ReportValueKind.date,
      _ => ReportValueKind.text,
    };

/// Formats a report value for the screen (UGX amounts with separators).
String formatReportValue(Object? value, ReportValueKind kind) {
  switch (kind) {
    case ReportValueKind.money:
      return value is num ? Money(value.toInt()).format() : '';
    case ReportValueKind.count:
      return value is num ? Money(value.toInt()).formatAmount() : '';
    case ReportValueKind.percent:
      if (value is! num) return '';
      return '${value.toStringAsFixed(4).replaceFirst(RegExp(r'\.?0+$'), '')}%';
    case ReportValueKind.date || ReportValueKind.text:
      return value?.toString() ?? '';
  }
}

class ReportFigure {
  const ReportFigure({required this.key, required this.label, required this.value, required this.kind});
  final String key;
  final String label;
  final Object? value;
  final ReportValueKind kind;

  String get formatted => formatReportValue(value, kind);

  static ReportFigure fromJson(Map<String, dynamic> j) =>
      ReportFigure(key: j['key'] as String? ?? '', label: j['label'] as String? ?? '', value: j['value'], kind: _kind(j['kind']));
}

class ReportColumn {
  const ReportColumn({required this.key, required this.label, required this.kind});
  final String key;
  final String label;
  final ReportValueKind kind;

  bool get numeric => kind == ReportValueKind.money || kind == ReportValueKind.count || kind == ReportValueKind.percent;

  static ReportColumn fromJson(Map<String, dynamic> j) =>
      ReportColumn(key: j['key'] as String? ?? '', label: j['label'] as String? ?? '', kind: _kind(j['kind']));
}

class ReportTable {
  const ReportTable({required this.key, required this.title, required this.columns, required this.rows});
  final String key;
  final String title;
  final List<ReportColumn> columns;
  final List<Map<String, Object?>> rows;

  static ReportTable fromJson(Map<String, dynamic> j) => ReportTable(
        key: j['key'] as String? ?? '',
        title: j['title'] as String? ?? '',
        columns: [for (final c in (j['columns'] as List?) ?? const []) ReportColumn.fromJson(_m(c))],
        rows: [for (final r in (j['rows'] as List?) ?? const []) _m(r)],
      );
}

class ReportSection {
  const ReportSection({required this.key, required this.title, this.note, this.figures = const [], this.tables = const []});
  final String key;
  final String title;
  final String? note;
  final List<ReportFigure> figures;
  final List<ReportTable> tables;

  static ReportSection fromJson(Map<String, dynamic> j) => ReportSection(
        key: j['key'] as String? ?? '',
        title: j['title'] as String? ?? '',
        note: j['note'] as String?,
        figures: [for (final f in (j['figures'] as List?) ?? const []) ReportFigure.fromJson(_m(f))],
        tables: [for (final t in (j['tables'] as List?) ?? const []) ReportTable.fromJson(_m(t))],
      );
}

class BusinessReport {
  const BusinessReport({
    required this.type,
    required this.period,
    required this.sections,
    this.truncated = false,
    this.generatedAt,
  });

  final ReportType type;
  final ReportPeriod period;
  final List<ReportSection> sections;

  /// A query hit its limit on the server: figures may be incomplete.
  final bool truncated;
  final DateTime? generatedAt;

  static BusinessReport fromJson(Map<String, dynamic> j) => BusinessReport(
        type: ReportType.tryParse(j['report'] as String?) ?? ReportType.executive,
        period: ReportPeriod(j['from'] as String? ?? '', j['to'] as String? ?? ''),
        truncated: j['truncated'] == true,
        generatedAt: j['generatedAt'] is num ? DateTime.fromMillisecondsSinceEpoch((j['generatedAt'] as num).toInt()) : null,
        sections: [for (final s in (j['sections'] as List?) ?? const []) ReportSection.fromJson(_m(s))],
      );

  /// CSV (RFC 4180) of every figure and table, amounts as plain whole
  /// shillings so spreadsheets can add them up.
  String toCsv() {
    final out = StringBuffer();
    void line(List<Object?> cells) => out.writeln(cells.map(csvCell).join(','));
    line(['RamosMAX report', type.label]);
    line(['Period (EAT)', period.from, period.to]);
    if (generatedAt != null) line(['Generated', generatedAt!.toUtc().toIso8601String()]);
    if (truncated) line(['Note', 'Some figures hit a server limit and may be incomplete']);
    for (final s in sections) {
      out.writeln();
      line([s.title]);
      if (s.note != null) line([s.note]);
      for (final f in s.figures) {
        line([f.label, f.kind == ReportValueKind.money ? 'UGX ${f.value}' : f.value]);
      }
      for (final t in s.tables) {
        out.writeln();
        line([t.title]);
        line([for (final c in t.columns) c.kind == ReportValueKind.money ? '${c.label} (UGX)' : c.label]);
        for (final r in t.rows) {
          line([for (final c in t.columns) r[c.key]]);
        }
      }
    }
    return out.toString();
  }
}

/// One CSV cell: quoted when needed; formula-like text is neutralised so a
/// spreadsheet never executes it.
String csvCell(Object? v) {
  var s = v?.toString() ?? '';
  if (v is String && s.isNotEmpty && '=+-@'.contains(s[0]) && num.tryParse(s) == null) s = "'$s";
  if (s.contains(RegExp('[",\n\r]'))) s = '"${s.replaceAll('"', '""')}"';
  return s;
}

Map<String, Object?> _m(Object? v) => v is Map ? v.map((k, val) => MapEntry(k.toString(), val)) : const {};
