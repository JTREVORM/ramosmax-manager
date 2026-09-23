import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions;

import '../../../core/errors/app_failure.dart';
import '../../../core/services/callables.dart';
import '../../../models/business_report.dart';

/// Phase 9: reports are calculated by the getBusinessReport Cloud Function
/// (read-only, permission-checked per report and per section).
abstract class ReportsApi {
  Future<Result<BusinessReport>> getReport(ReportType type, ReportPeriod period);
}

class CallableReportsApi implements ReportsApi {
  CallableReportsApi(this._functions);
  final FirebaseFunctions _functions;

  @override
  Future<Result<BusinessReport>> getReport(ReportType type, ReportPeriod period) async =>
      (await callFunction(_functions, 'getBusinessReport', {'report': type.key, 'from': period.from, 'to': period.to},
              timeout: const Duration(seconds: 60)))
          .when(success: (d) => Success(BusinessReport.fromJson(d)), failure: Failure.new);
}
