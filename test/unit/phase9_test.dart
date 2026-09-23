import 'dart:async';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctionsException;
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/services/callables.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/features/notifications/application/notifications_providers.dart';
import 'package:ramosmax_auto_manager/features/reports/application/reports_providers.dart';
import 'package:ramosmax_auto_manager/models/app_notification.dart';
import 'package:ramosmax_auto_manager/models/app_user.dart';
import 'package:ramosmax_auto_manager/models/business_report.dart';

import '../support/fake_phase9_apis.dart';
import '../support/fixtures.dart';

void main() {
  // 2026-10-01 01:30 in Kampala is still 30 September in UTC.
  final now = DateTime.utc(2026, 9, 30, 22, 30);

  group('report periods (East Africa Time)', () {
    ReportPeriod p(ReportPeriodPreset preset) => ReportPeriod.forPreset(preset, now);

    test('today and yesterday follow the Kampala date, not UTC', () {
      expect(p(ReportPeriodPreset.today), const ReportPeriod('2026-10-01', '2026-10-01'));
      expect(p(ReportPeriodPreset.yesterday), const ReportPeriod('2026-09-30', '2026-09-30'));
    });

    test('this week starts on Monday; this and previous month', () {
      expect(p(ReportPeriodPreset.thisWeek), const ReportPeriod('2026-09-28', '2026-10-01'));
      expect(p(ReportPeriodPreset.thisMonth), const ReportPeriod('2026-10-01', '2026-10-01'));
      expect(p(ReportPeriodPreset.previousMonth), const ReportPeriod('2026-09-01', '2026-09-30'));
      expect(ReportPeriod.forPreset(ReportPeriodPreset.previousMonth, DateTime.utc(2026, 1, 15, 9)), const ReportPeriod('2025-12-01', '2025-12-31'));
    });
  });

  group('report model and export', () {
    final report = FakeReportsApi.build(ReportType.revenue, const ReportPeriod('2026-09-01', '2026-09-30'));

    test('parses sections, figures and tables; formats UGX', () {
      final s = report.sections.single;
      expect(s.figures.first.formatted, 'UGX 1,250,000');
      expect(s.figures.last.formatted, '42');
      expect(s.tables.single.rows.length, 2);
      expect(formatReportValue(50.1234, ReportValueKind.percent), '50.1234%');
      expect(formatReportValue(25, ReportValueKind.percent), '25%');
    });

    test('CSV keeps whole-shilling amounts, quotes commas and neutralises formulas', () {
      final csv = report.toCsv();
      expect(csv, contains('Operating revenue,UGX 1250000'));
      expect(csv, contains('Method,Net (UGX)'));
      expect(csv, contains('Cash,1000000'));
      expect(csvCell('A, B'), '"A, B"');
      expect(csvCell('say "hi"'), '"say ""hi"""');
      expect(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
      expect(csvCell('-5000'), '-5000');
      expect(csvCell(-5000), '-5000');
    });
  });

  group('who sees which report (mirrors functions/src/reports.js)', () {
    Set<ReportType> of(UserRole role, {Set<Permission> extra = const {}}) =>
        reportsFor(testUser(role: role, permissions: extra), now).toSet();

    test('workers none; cashiers operational, credit and expenses; shareholders financial summaries', () {
      expect(of(UserRole.worker), isEmpty);
      expect(of(UserRole.cashier), {ReportType.executive, ReportType.outstanding, ReportType.expenses});
      expect(of(UserRole.shareholder), {ReportType.executive, ReportType.financial, ReportType.revenue, ReportType.paymentMethods});
      expect(of(UserRole.manager), containsAll([ReportType.workforce, ReportType.afterHours, ReportType.shareholders, ReportType.inventory]));
      expect(of(UserRole.admin), ReportType.values.toSet());
    });

    test('the Dart list matches REPORTS in functions/src/reports.js', () {
      final src = File('functions/src/reports.js').readAsStringSync();
      final block = RegExp(r'export const REPORTS = Object\.freeze\(\{(.*?)\}\);', dotAll: true).firstMatch(src)!.group(1)!;
      final server = {
        for (final m in RegExp(r'(\w+): \[([^\]]*)\]').allMatches(block))
          m.group(1)!: {for (final q in RegExp(r"'([^']+)'").allMatches(m.group(2)!)) q.group(1)!},
      };
      expect(server.keys.toSet(), ReportType.values.map((t) => t.key).toSet());
      for (final t in ReportType.values) {
        expect(t.requires.map((p) => p.key).toSet(), server[t.key], reason: t.key);
      }
    });
  });

  group('navigation (Phase 9)', () {
    test('Reports, Audit Logs and Settings open; placeholders are gone from the menus', () {
      expect(AppModule.reports.available && AppModule.auditLogs.available && AppModule.settings.available && AppModule.businessPerformance.available, isTrue);
      final auditor = RoleNavigation.modulesFor(testUser(role: UserRole.auditor), now);
      expect(auditor, containsAll([AppModule.auditLogs, AppModule.reports, AppModule.settings]));
      expect(auditor, isNot(contains(AppModule.discrepancies)));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.admin), now), isNot(contains(AppModule.staff)));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.cashier), now), contains(AppModule.reports));
      for (final role in UserRole.values) {
        for (final m in RoleNavigation.modulesFor(testUser(role: role), now)) {
          expect(m.available, isTrue, reason: '${role.key}: ${m.key} would open a "not available" screen');
        }
      }
    });

    test('everyone with notifications.view can open Notifications; it is not a menu entry', () {
      for (final role in UserRole.values) {
        final u = testUser(role: role);
        expect(RoleNavigation.canOpen(u, AppModule.notifications, now), isTrue, reason: role.key);
        expect(RoleNavigation.modulesFor(u, now), isNot(contains(AppModule.notifications)));
      }
      expect(RoleNavigation.canOpen(testUser(role: UserRole.worker, denied: {Permission.notificationsView}), AppModule.notifications, now), isFalse);
    });
  });

  group('notifications', () {
    AppNotification n(String type, [String? id]) => AppNotification(id: 'n1', type: type, title: 't', body: 'b', read: false, recordId: id);
    final worker = testUser(role: UserRole.worker);
    final manager = testUser(role: UserRole.manager);

    test('each notice opens its record; handovers open the supervisor or the worker view', () {
      expect(notificationRoute(n('job_assigned', 'wo1'), worker, now), '/app/my-jobs');
      expect(notificationRoute(n('job_ready_to_invoice', 'i1'), manager, now), '/app/jobs/i1');
      expect(notificationRoute(n('expense_decided', 'e1'), manager, now), '/app/expenses/e1');
      expect(notificationRoute(n('inventory_low_stock', 'it1'), manager, now), '/app/inventory/items/it1');
      expect(notificationRoute(n('payroll_paid', 'p1'), worker, now), '/app/allowances');
      expect(notificationRoute(n('cash_handover_reminder', 'h1'), manager, now), '/app/after-hours/handover/h1');
      expect(notificationRoute(n('cash_handover_reminder', 'h1'), worker, now), '/app/my-after-hours/handover/h1');
      expect(notificationRoute(n('password_reset', 'u1'), worker, now), '/app/profile');
      expect(notificationRoute(n('something_new'), worker, now), '/app/notifications');
    });

    test('model parses category and critical flags; preferences parse on the profile', () {
      final a = AppNotification.fromFirestore('x', {'type': 'job_assigned', 'category': 'jobs', 'critical': false, 'title': 'T', 'body': 'B',
        'read': false, 'recordId': 'wo1', 'createdAt': Timestamp.fromDate(now)});
      expect([a.category, a.critical, a.recordId], [NotificationCategory.jobs, false, 'wo1']);
      expect(NotificationCategory.access.mutable || NotificationCategory.pay.mutable, isFalse);
      final u = AppUser.fromFirestore('u', {'role': 'worker', 'phoneNumber': testPhone, 'active': true,
        'notificationPreferences': {'jobs': false, 'bogus': 'x'}})!;
      expect(u.notificationPreferences, {'jobs': false});
    });
  });

  group('errors (Phase 9)', () {
    test('a lost answer is "unconfirmed", never "failed"; server messages pass through; internals never do', () {
      for (final e in [TimeoutException('slow'), FirebaseFunctionsException(code: 'deadline-exceeded', message: 'x'),
        FirebaseFunctionsException(code: 'unavailable', message: 'x')]) {
        final f = callFailure(e);
        expect(f.code, 'unconfirmed');
        expect(f.message, contains('may already have been saved'));
        expect(f.retryable, isTrue);
      }
      final ours = callFailure(FirebaseFunctionsException(code: 'failed-precondition', message: 'This handover has already been received.',
          details: {'reason': 'already_received'}));
      expect([ours.code, ours.message], ['already_received', 'This handover has already been received.']);
      final internal = callFailure(FirebaseFunctionsException(code: 'internal', message: 'TypeError: cannot read x of undefined at /workspace/index.js:42'));
      expect(internal.message, 'Something went wrong. Please try again.');
      expect(internal.message, isNot(contains('index.js')));
    });
  });
}
