import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/services/callables.dart';
import '../../../models/app_user.dart';
import '../../../models/business_report.dart';
import '../data/reports_api.dart';

final reportsApiProvider = Provider<ReportsApi>((ref) => CallableReportsApi(ref.watch(firebaseFunctionsProvider)));

typedef ReportRequest = ({ReportType type, ReportPeriod period});

/// One report fetch per (type, period); disposed when the screen closes, so
/// nothing keeps re-reading in the background. Needs a connection: reports
/// are calculated on the server.
final businessReportProvider = FutureProvider.autoDispose.family<BusinessReport, ReportRequest>((ref, req) async {
  final r = await runOnline(ref, () => ref.read(reportsApiProvider).getReport(req.type, req.period),
      event: AnalyticsEvents.reportViewed, params: {'outcome': req.type.key});
  return r.when(success: (v) => v, failure: (f) => throw f);
});

/// Reports [user] may open at [now] (the server re-checks every request).
List<ReportType> reportsFor(AppUser user, DateTime now) =>
    [for (final t in ReportType.values) if (t.requires.any((p) => user.can(p, now))) t];
