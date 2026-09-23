import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/access_policy.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/core/providers/core_providers.dart';
import 'package:ramosmax_auto_manager/core/services/analytics_service.dart';
import 'package:ramosmax_auto_manager/features/after_hours/application/after_hours_providers.dart';
import 'package:ramosmax_auto_manager/features/after_hours/data/after_hours_api.dart';
import 'package:ramosmax_auto_manager/features/after_hours/presentation/after_hours_sheets.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/models/after_hours.dart';
import 'package:ramosmax_auto_manager/models/app_user.dart';
import 'package:ramosmax_auto_manager/models/payment.dart';

import '../support/fake_phase8_apis.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';

List<String> _jsList(String source, String name) {
  final m = RegExp('$name = Object\\.freeze\\(\\[(.*?)\\]\\)', dotAll: true).firstMatch(source)!;
  return [for (final q in RegExp(r"'([^']+)'").allMatches(m.group(1)!)) q.group(1)!];
}

void main() {
  final now = DateTime.utc(2026, 9, 23, 18);
  Timestamp ts(DateTime d) => Timestamp.fromDate(d);

  group('Phase 8 catalogue matches the server', () {
    final catalog = jsonDecode(File('functions/src/access_catalog.json').readAsStringSync()) as Map<String, dynamic>;
    final source = File('functions/src/after_hours.js').readAsStringSync();

    test('authorisation-only permissions', () {
      expect((catalog['authorizationOnlyPermissions'] as List).cast<String>().toSet(),
          Permission.values.where((p) => p.isAuthorizationOnly).map((p) => p.key).toSet());
    });

    test('grantable and default lists mirror AFTER_HOURS_GRANTABLE and DEFAULT_GRANTS', () {
      expect(afterHoursGrantable.map((p) => p.key).toList(), _jsList(source, 'AFTER_HOURS_GRANTABLE'));
      expect(afterHoursDefaultGrants.map((p) => p.key).toList(), _jsList(source, 'DEFAULT_GRANTS'));
      final methods = RegExp(r'allowedPaymentMethods: Object\.freeze\(\[(.*?)\]\)').firstMatch(source)!.group(1)!;
      expect(const AfterHoursPolicy().allowedPaymentMethods.map((m) => m.key).toList(),
          [for (final q in RegExp(r"'([^']+)'").allMatches(methods)) q.group(1)!]);
      expect(RegExp(r'maxAuthorizationHours: (\d+)').firstMatch(source)!.group(1), '${const AfterHoursPolicy().maxAuthorizationHours}');
    });

    test('statuses mirror the server', () {
      expect(SessionStatus.values.map((s) => s.key).toList(), _jsList(source, 'SESSION_STATUSES'));
      expect(HandoverStatus.values.map((s) => s.key).toList(), _jsList(source, 'HANDOVER_STATUSES'));
      expect(DiscrepancyStatus.values.map((s) => s.key).toList(), _jsList(source, 'DISCREPANCY_STATUSES'));
    });

    test('nothing an authorisation can carry reaches administration, payroll, users, settings or finance configuration', () {
      const forbidden = ['users.', 'payroll.', 'salary.', 'settings.', 'finance.', 'shareholders.', 'shares.', 'dividends.', 'audit.',
        'attendance.', 'discounts.', 'services.', 'inventory.', 'allowances.', 'losses.', 'expenses.'];
      for (final p in afterHoursGrantable) {
        for (final prefix in forbidden) {
          expect(p.key.startsWith(prefix), isFalse, reason: p.key);
        }
      }
      expect(afterHoursGrantable, isNot(contains(Permission.paymentsReverse)));
      expect(afterHoursGrantable, isNot(contains(Permission.paymentsRecord)));
    });
  });

  group('models', () {
    test('an authorisation is scheduled, in force, ended or revoked by the clock and the stored status', () {
      AfterHoursAuthorization a(String status, DateTime start, DateTime end) => AfterHoursAuthorization.fromFirestore('a1', {
            'authorizationNumber': 'RMX-AH-000001', 'staffUid': 'w1', 'staffName': 'Worker', 'status': status,
            'startsAt': ts(start), 'expiresAt': ts(end), 'permissions': ['after_hours.operate', 'jobs.view', 'not.real'], 'openingFloatUgx': 20000,
          });
      final live = a('active', now.subtract(const Duration(hours: 1)), now.add(const Duration(hours: 3)));
      expect(live.phaseAt(now), AuthorizationPhase.live);
      expect(live.canRevoke(now), isTrue);
      expect(live.permissions, [Permission.afterHoursOperate, Permission.jobsView]);
      expect(live.openingFloat, const Money(20000));
      expect(a('active', now.add(const Duration(hours: 1)), now.add(const Duration(hours: 3))).phaseAt(now), AuthorizationPhase.scheduled);
      // Past its end before the sweep marks it: already ended.
      final ended = a('active', now.subtract(const Duration(hours: 5)), now.subtract(const Duration(minutes: 1)));
      expect(ended.phaseAt(now), AuthorizationPhase.ended);
      expect(ended.canRevoke(now), isFalse);
      expect(a('revoked', now.subtract(const Duration(hours: 1)), now.add(const Duration(hours: 3))).phaseAt(now), AuthorizationPhase.revoked);
    });

    test('session, handover, custody and discrepancy parse the server figures', () {
      final s = AfterHoursSession.fromFirestore('s1', {
        'sessionNumber': 'RMX-AHS-000001', 'staffUid': 'w1', 'staffName': 'Worker', 'status': 'open', 'openingFloatUgx': 20000,
        'cashCollectedUgx': 35000, 'nonCashCollectedUgx': 15000, 'expectedCashUgx': 55000, 'paymentCount': 2,
        'authorizationExpiresAt': ts(now.subtract(const Duration(minutes: 5))),
      });
      expect(s.isOpen, isTrue);
      expect(s.expectedCash, const Money(55000));
      expect(s.authorizationEndedAt(now), isTrue);
      final h = CashHandover.fromFirestore('h1', {
        'handoverNumber': 'RMX-HO-000001', 'sessionId': 's1', 'staffUid': 'w1', 'staffName': 'Worker', 'status': 'discrepancy',
        'expectedCashUgx': 55000, 'actualAmountUgx': 50000, 'differenceUgx': -5000, 'declaredAmountUgx': null,
      });
      expect(h.status, HandoverStatus.discrepancy);
      expect(h.difference, const Money(-5000));
      expect(h.declaredAmount, isNull);
      final c = CustodyEntry.fromFirestore('c1', {
        'entryNumber': 'RMX-AHC-000002', 'kind': 'payment_reversal', 'sessionId': 's1', 'method': 'cash', 'amountUgx': -10000,
        'cashDeltaUgx': 0, 'afterSessionClosed': true,
      });
      expect(c.kind, CustodyKind.paymentReversal);
      expect(c.afterSessionClosed, isTrue);
      final d = CashDiscrepancy.fromFirestore('d1', {
        'discrepancyNumber': 'RMX-AHD-000001', 'handoverId': 'h1', 'staffUid': 'w1', 'staffName': 'Worker', 'expectedCashUgx': 55000,
        'actualAmountUgx': 60000, 'differenceUgx': 5000, 'kind': 'excess', 'status': 'under_review',
      });
      expect(d.kind, DiscrepancyKind.excess);
      expect(d.status.isOpen, isTrue);
    });

    test('a payment tagged by the server shows as after hours', () {
      final p = Payment.fromFirestore('p1', {'invoiceId': 'i1', 'amountUgx': 1000, 'method': 'cash', 'isAfterHours': true, 'afterHoursSessionNumber': 'RMX-AHS-000003'});
      expect(p.isAfterHours, isTrue);
      expect(p.afterHoursSessionNumber, 'RMX-AHS-000003');
      expect(Payment.fromFirestore('p2', {'invoiceId': 'i1', 'amountUgx': 1000, 'method': 'cash'}).isAfterHours, isFalse);
    });

    test('policy defaults mirror the server (bank off after hours) and parse saved values', () {
      const d = AfterHoursPolicy();
      expect(d.allowedPaymentMethods, [PaymentMethod.cash, PaymentMethod.mtnMerchant, PaymentMethod.airtelMerchant]);
      expect(AfterHoursPolicy.fromFirestore(null).maxAuthorizationHours, 16);
      final p = AfterHoursPolicy.fromFirestore({'allowedPaymentMethods': ['cash'], 'maxAuthorizationHours': 10, 'maxOpeningFloatUgx': 50000});
      expect(p.allowedPaymentMethods, [PaymentMethod.cash]);
      expect(p.maxAuthorizationHours, 10);
      expect(p.maxOpeningFloat, const Money(50000));
    });

    test('difference preview: shortage, excess, balanced', () {
      expect(previewDifference(const Money(55000), const Money(50000)), (difference: const Money(-5000), kind: DiscrepancyKind.shortage));
      expect(previewDifference(const Money(55000), const Money(60000)), (difference: const Money(5000), kind: DiscrepancyKind.excess));
      expect(previewDifference(const Money(55000), const Money(55000)).kind, isNull);
    });

    test('handover totals', () {
      CashHandover h(String id, int expected, int? actual, String status) => CashHandover.fromFirestore(id, {
            'handoverNumber': id, 'sessionId': 's', 'staffUid': 'w', 'staffName': 'W', 'status': status, 'expectedCashUgx': expected,
            'actualAmountUgx': actual, 'differenceUgx': actual == null ? null : actual - expected,
          });
      final t = HandoverTotals.of([h('a', 55000, 50000, 'discrepancy'), h('b', 10000, 12000, 'discrepancy'), h('c', 5000, null, 'submitted')]);
      expect(t.count, 3);
      expect(t.expected, const Money(70000));
      expect(t.received, const Money(62000));
      expect(t.shortages, const Money(5000));
      expect(t.excesses, const Money(2000));
      expect(t.awaiting, 1);
    });
  });

  group('authorisation form', () {
    const policy = AfterHoursPolicy(maxAuthorizationHours: 8, maxOpeningFloat: Money(100000));
    String? check({String? staff = 'w1', Duration length = const Duration(hours: 4), Money? float = Money.zero, String reason = 'Evening cover', DateTime? start}) =>
        validateAuthorizationDraft(
            staffUid: staff, startsAt: start ?? now, expiresAt: (start ?? now).add(length), now: now, openingFloat: float, reason: reason, policy: policy);

    test('valid draft', () => expect(check(), isNull));
    test('refuses what the server refuses', () {
      expect(check(staff: null), contains('worker'));
      expect(check(length: const Duration(hours: 9)), contains('at most 8 hours'));
      expect(check(length: Duration.zero), contains('after the start'));
      expect(check(float: const Money(100001)), contains('opening float'));
      expect(check(float: null), contains('whole shillings'));
      expect(check(reason: 'x'), contains('reason'));
      expect(check(start: now.subtract(const Duration(hours: 1))), contains('past'));
    });

    test('the draft sends permissions and float only - never a total', () {
      final json = AuthorizationDraft(
        staffUid: 'w1', startsAt: now, expiresAt: now.add(const Duration(hours: 4)), reason: 'Cover',
        permissions: afterHoursDefaultGrants, openingFloat: const Money(20000),
      ).toJson();
      expect(json['permissions'], afterHoursDefaultGrants.map((p) => p.key).toList());
      expect(json['openingFloatUgx'], 20000);
      expect(json.keys.where((k) => k.toLowerCase().contains('expected')), isEmpty);
    });
  });

  group('access', () {
    test('the permission editor never offers the authorisation-only permissions, even to an admin', () {
      final admin = testUser(role: UserRole.admin);
      final options = AccessPolicy.grantablePermissions(admin, now);
      expect(options, isNot(contains(Permission.afterHoursOperate)));
      expect(options, isNot(contains(Permission.afterHoursCashCollect)));
      expect(options, contains(Permission.afterHoursRequest));
    });

    test('a worker sees New Service, Jobs, Invoices and Receipts only while the after-hours grants are live', () {
      final base = testUser(role: UserRole.worker);
      final menu = RoleNavigation.modulesFor(base, now);
      expect(menu, contains(AppModule.myAfterHours));
      expect(menu.toSet().intersection({AppModule.newService, AppModule.jobs, AppModule.invoices, AppModule.receipts, AppModule.payments}), isEmpty);
      final window = TemporaryWindow(startsAt: now.subtract(const Duration(hours: 1)), expiresAt: now.add(const Duration(hours: 2)));
      final authorised = testUser(role: UserRole.worker, temporaryWindows: {
        for (final p in afterHoursDefaultGrants) p: window,
      });
      final live = RoleNavigation.modulesFor(authorised, now);
      expect(live, containsAll([AppModule.newService, AppModule.jobs, AppModule.invoices, AppModule.receipts, AppModule.myAfterHours]));
      expect(live.toSet().intersection({AppModule.payroll, AppModule.users, AppModule.settings, AppModule.finance, AppModule.payments,
        AppModule.afterHours}), isEmpty);
      expect(authorised.can(Permission.afterHoursCashCollect, now), isTrue);
      // After the window, everything is gone again - nothing became permanent.
      final later = now.add(const Duration(hours: 3));
      expect(RoleNavigation.modulesFor(authorised, later).toSet().intersection({AppModule.newService, AppModule.jobs, AppModule.invoices}), isEmpty);
      expect(authorised.can(Permission.afterHoursCashCollect, later), isFalse);
      expect(authorised.permissions, isEmpty);
    });

    test('supervisors get the After-Hours dashboard; cashiers, workers and shareholders do not', () {
      for (final r in [UserRole.admin, UserRole.manager, UserRole.auditor]) {
        expect(RoleNavigation.modulesFor(testUser(role: r), now), contains(AppModule.afterHours), reason: r.key);
      }
      for (final r in [UserRole.cashier, UserRole.worker, UserRole.shareholder]) {
        expect(RoleNavigation.modulesFor(testUser(role: r), now), isNot(contains(AppModule.afterHours)), reason: r.key);
      }
      // Denying the manager's after-hours permissions removes the dashboard.
      final denied = testUser(role: UserRole.manager, denied: {
        Permission.afterHoursView, Permission.afterHoursApprove, Permission.cashHandoverApprove, Permission.afterHoursDiscrepancyReview,
      });
      expect(RoleNavigation.modulesFor(denied, now), isNot(contains(AppModule.afterHours)));
    });
  });

  group('online only', () {
    test('offline, no after-hours command reaches the server', () async {
      final api = FakeAfterHoursApi();
      final container = ProviderContainer(overrides: [
        afterHoursApiProvider.overrideWithValue(api),
        connectivityServiceProvider.overrideWithValue(FakeConnectivityService(online: false)),
        analyticsProvider.overrideWithValue(AnalyticsService(enabled: false)),
      ]);
      addTearDown(container.dispose);
      final actions = container.read(afterHoursActionsProvider);
      final results = [
        await actions.openSession(requestId: 'r1'),
        await actions.closeSession('s1'),
        await actions.submitHandover('h1', declared: const Money(1000), requestId: 'r2'),
        await actions.receiveHandover('h1', actual: const Money(1000), requestId: 'r3'),
        await actions.resolveDiscrepancy('d1', outcome: DiscrepancyOutcome.waived, resolution: 'ok', requestId: 'r4'),
      ];
      for (final r in results) {
        expect(r, isA<Failure<Object?>>());
        expect((r as Failure).error.code, 'offline');
      }
      expect(api.calls, isEmpty);
    });
  });
}
