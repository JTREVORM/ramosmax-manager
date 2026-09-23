import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/features/notifications/data/notifications_repository.dart';
import 'package:ramosmax_auto_manager/features/reports/data/reports_api.dart';
import 'package:ramosmax_auto_manager/models/business_report.dart';

/// Records report requests; answers with [build] (server behaviour is tested
/// against the emulator in functions/test/reports.test.js).
class FakeReportsApi implements ReportsApi {
  final List<({ReportType type, ReportPeriod period})> calls = [];
  AppFailure? nextFailure;

  static BusinessReport build(ReportType type, ReportPeriod period) => BusinessReport.fromJson({
        'report': type.key,
        'from': period.from,
        'to': period.to,
        'truncated': false,
        'sections': [
          {
            'key': 'revenue',
            'title': 'Revenue',
            'note': 'Only customer payments are operating revenue.',
            'figures': [
              {'key': 'operating_revenue', 'label': 'Operating revenue', 'value': 1250000, 'kind': 'money'},
              {'key': 'payments', 'label': 'Payments', 'value': 42, 'kind': 'count'},
            ],
            'tables': [
              {
                'key': 'by_method',
                'title': 'By method',
                'columns': [
                  {'key': 'method', 'label': 'Method', 'kind': 'text'},
                  {'key': 'netUgx', 'label': 'Net', 'kind': 'money'},
                ],
                'rows': [
                  {'method': 'Cash', 'netUgx': 1000000},
                  {'method': 'MTN Merchant', 'netUgx': 250000},
                ],
              },
            ],
          },
        ],
      });

  @override
  Future<Result<BusinessReport>> getReport(ReportType type, ReportPeriod period) async {
    calls.add((type: type, period: period));
    final f = nextFailure;
    if (f != null) {
      nextFailure = null;
      return Failure(f);
    }
    return Success(build(type, period));
  }
}

class FakeNotificationsApi implements NotificationsApi {
  final List<Map<String, bool>> calls = [];

  @override
  Future<Result<Map<String, bool>>> updatePreferences(Map<String, bool> preferences) async {
    calls.add(preferences);
    return Success(preferences);
  }
}
