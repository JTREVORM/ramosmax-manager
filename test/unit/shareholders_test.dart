import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/features/shareholders/application/shareholder_search.dart';
import 'package:ramosmax_auto_manager/features/shareholders/data/shareholders_api.dart';
import 'package:ramosmax_auto_manager/models/finance.dart';
import 'package:ramosmax_auto_manager/models/shareholding.dart';
import 'package:ramosmax_auto_manager/routes/app_routes.dart';

import '../support/fixtures.dart';

void main() {
  final now = DateTime.utc(2026, 12, 15, 9);
  Set<Permission> perms(UserRole r) => RolePermissions.forRole(r);

  group('Phase 7 permissions', () {
    test('admin holds every shareholder, share and dividend permission', () {
      final group = PermissionGroup.shareholders.permissions;
      expect(group, containsAll([Permission.sharesIssue, Permission.sharesApprove, Permission.dividendsPay, Permission.dividendsAdjust]));
      expect(perms(UserRole.admin).containsAll(group), isTrue);
    });

    test('shareholders see only their own records - never the register or other shareholders', () {
      final s = perms(UserRole.shareholder);
      expect(s, contains(Permission.shareholdersViewOwn));
      expect(s.intersection({Permission.shareholdersView, Permission.sharesView, Permission.dividendsView, Permission.shareholdersReportsView}), isEmpty);
    });

    test('auditors read everything and change nothing', () {
      final a = perms(UserRole.auditor);
      expect(a, containsAll([Permission.shareholdersView, Permission.sharesView, Permission.dividendsView, Permission.shareholdersReportsView]));
      expect(a.where((p) => p.group == PermissionGroup.shareholders && !p.isReadOnly), isEmpty);
    });

    test('managers get register-level reports only; cashiers and workers nothing', () {
      final m = perms(UserRole.manager).where((p) => p.group == PermissionGroup.shareholders).toSet();
      expect(m, {Permission.shareholdersReportsView});
      for (final r in [UserRole.cashier, UserRole.worker]) {
        expect(perms(r).where((p) => p.group == PermissionGroup.shareholders), isEmpty, reason: r.key);
      }
    });

    test('Dart catalogue matches functions/src/access_catalog.json', () {
      final catalog = jsonDecode(File('functions/src/access_catalog.json').readAsStringSync()) as Map<String, dynamic>;
      expect((catalog['permissions'] as List).cast<String>().toSet(), Permission.values.map((p) => p.key).toSet());
      for (final r in [UserRole.manager, UserRole.cashier, UserRole.worker, UserRole.shareholder, UserRole.auditor]) {
        expect(((catalog['roles'] as Map)[r.key] as List).cast<String>().toSet(), perms(r).map((p) => p.key).toSet(), reason: r.key);
      }
    });
  });

  group('Phase 7 navigation', () {
    test('admin and auditor get Shareholders, Shares and Dividends; the manager gets the register only', () {
      for (final r in [UserRole.admin, UserRole.auditor]) {
        expect(RoleNavigation.modulesFor(testUser(role: r), now), containsAll([AppModule.shareholders, AppModule.shares, AppModule.dividends]));
      }
      final m = RoleNavigation.modulesFor(testUser(role: UserRole.manager), now);
      expect(m, containsAll([AppModule.shareholders, AppModule.dividends]));
      expect(m, isNot(contains(AppModule.shares)));
    });

    test('a shareholder gets My Shareholding and no register; workers and cashiers get none', () {
      final s = RoleNavigation.modulesFor(testUser(role: UserRole.shareholder), now);
      expect(s, contains(AppModule.myShareholding));
      expect(s.toSet().intersection({AppModule.shareholders, AppModule.shares, AppModule.dividends}), isEmpty);
      for (final r in [UserRole.worker, UserRole.cashier]) {
        expect(RoleNavigation.modulesFor(testUser(role: r), now).toSet().intersection({AppModule.shareholders, AppModule.shares, AppModule.dividends,
          AppModule.myShareholding}), isEmpty, reason: r.key);
      }
    });

    test('a cashier granted dividend payment sees Dividends', () {
      final u = testUser(role: UserRole.cashier, permissions: {Permission.dividendsView, Permission.dividendsPay});
      expect(RoleNavigation.modulesFor(u, now), contains(AppModule.dividends));
    });

    test('routes map to their modules', () {
      expect(AppRoutes.moduleForLocation(AppRoutes.shareholderDetail('x')), AppModule.shareholders);
      expect(AppRoutes.moduleForLocation(AppRoutes.shareTransaction('t')), AppModule.shares);
      expect(AppRoutes.moduleForLocation(AppRoutes.dividendDetail('d')), AppModule.dividends);
      expect(AppRoutes.moduleForLocation(AppRoutes.myShareholding), AppModule.myShareholding);
    });
  });

  group('shareholder search', () {
    test('numbers, phones and names', () {
      expect((ShareholderQuery.parse('shr-12') as ShareholderNumberQuery).number, 'RMX-SHR-000012');
      expect((ShareholderQuery.parse('RMX-SHR-000003') as ShareholderNumberQuery).number, 'RMX-SHR-000003');
      expect((ShareholderQuery.parse('0772 123 456') as ShareholderPhoneQuery).e164, '+256772123456');
      expect(ShareholderQuery.parse('0772'), isA<IncompleteShareholderPhone>());
      expect(ShareholderQuery.parse('  '), isA<AllShareholders>());
      final q = ShareholderQuery.parse('mary nak') as ShareholderNameQuery;
      expect(q.token, 'mary');
      const mary = Shareholder(shareholderId: 'm', shareholderNumber: 'RMX-SHR-000002', fullName: 'Mary Nakato', status: ShareholderStatus.active);
      const john = Shareholder(shareholderId: 'j', shareholderNumber: 'RMX-SHR-000001', fullName: 'John Okello', status: ShareholderStatus.active);
      expect(q.matches(mary), isTrue);
      expect(q.matches(john), isFalse);
    });
  });

  group('models', () {
    test('shareholder totals and ownership come from server fields', () {
      final s = Shareholder.fromFirestore('s1', {
        'shareholderNumber': 'RMX-SHR-000001', 'fullName': 'John Okello', 'status': 'suspended', 'totalShares': 100, 'ownershipPercent': 50,
        'committedUgx': 1000000, 'paidUgx': 600000, 'outstandingUgx': 400000, 'joinDate': Timestamp.fromDate(now),
      });
      expect([s.status, s.totalShares, s.ownershipPercent, s.outstanding, s.canReceiveShares], [ShareholderStatus.suspended, 100, 50.0, const Money(400000), false]);
      expect(formatPercent(33.3333), '33.3333%');
      expect(formatPercent(50), '50%');
      expect(formatShares(1000), '1,000');
    });

    test('share transactions: lines, per-shareholder delta, what can be done next', () {
      final t = ShareTransaction.fromFirestore('t1', {
        'transactionNumber': 'RMX-SHR-TXN-000004', 'type': 'shares_transferred', 'status': 'posted', 'classCode': 'ORDINARY', 'shares': 30,
        'lines': [
          {'shareholderId': 'j', 'shareholderNumber': 'RMX-SHR-000001', 'shareholderName': 'John', 'deltaShares': -30, 'sharesAfter': 70},
          {'shareholderId': 'm', 'shareholderNumber': 'RMX-SHR-000002', 'shareholderName': 'Mary', 'deltaShares': 30, 'sharesAfter': 80},
        ],
      });
      expect([t.deltaFor('j'), t.deltaFor('m'), t.deltaFor('x')], [-30, 30, 0]);
      expect(t.canReverse, isTrue);
      expect(t.canReceivePayment, isFalse);
      final r = ShareTransaction.fromFirestore('t2', {'type': 'reversal', 'reversalOfType': 'shares_issued', 'status': 'posted', 'lines': []});
      expect(r.label, 'Reversal of shares issued');
      expect(r.canReverse, isFalse);
      final issue = ShareTransaction.fromFirestore('t3', {'type': 'shares_issued', 'status': 'posted', 'outstandingUgx': 5000, 'lines': []});
      expect(issue.canReceivePayment, isTrue);
    });

    test('commitment preview uses the class value (the server decides for real)', () {
      final c = ShareClass.fromFirestore('ordinary', {'code': 'ORDINARY', 'name': 'Ordinary', 'valuePerShareUgx': 10000, 'active': true});
      expect(c.commitmentFor(100), const Money(1000000));
    });

    test('dividend totals: declared / approved / paid / outstanding ignore drafts and cancelled', () {
      Dividend d(String status, int allocated, int paid) => Dividend.fromFirestore('d$status', {
            'status': status, 'allocatedUgx': allocated, 'paidUgx': paid, 'outstandingUgx': allocated - paid, 'calculationMethod': 'pool',
          });
      final t = DividendTotals.of([d('draft', 999, 0), d('cancelled', 999, 0), d('declared', 100, 0), d('approved', 200, 0), d('partially_paid', 300, 100)]);
      expect([t.declared, t.approved, t.paid, t.outstanding], [const Money(600), const Money(500), const Money(100), const Money(400)]);
      expect(Dividend.fromFirestore('x', {'dividendPerShareUgx': 10000}).perShareLabel, 'UGX 10,000');
      expect(Dividend.fromFirestore('x', {'dividendPerShareUgx': 333.3333}).perShareLabel, 'UGX 333.3333');
    });

    test('the register and my-shareholding responses parse', () {
      final r = ShareRegister.fromFirestore({
        'totalShares': 200, 'shareholderCount': 3, 'statusCounts': {'active': 2, 'suspended': 1}, 'pendingApprovals': 1, 'totalPaidUgx': 2000000,
        'holders': [{'shareholderId': 'j', 'shareholderNumber': 'RMX-SHR-000001', 'shareholderName': 'John', 'shares': 100, 'ownershipPercent': 50}],
      });
      expect([r.activeShareholders, r.holders.single.ownershipPercent, r.totalPaid], [2, 50.0, const Money(2000000)]);
      final m = MyShareholding.fromMap({
        'linked': true,
        'shareholder': {'shareholderId': 'm', 'shareholderNumber': 'RMX-SHR-000002', 'fullName': 'Mary', 'status': 'active', 'totalShares': 60,
          'ownershipPercent': 30, 'joinDate': now.millisecondsSinceEpoch},
        'transactions': [{'transactionNumber': 'RMX-SHR-TXN-000002', 'type': 'shares_transferred', 'deltaShares': 10, 'classCode': 'ORDINARY'}],
        'dividends': [{'allocationNumber': 'RMX-DIV-PAY-000001', 'netUgx': 3000000, 'paymentStatus': 'paid', 'sharesAtRecordDate': 300}],
      });
      expect([m.shareholder!.totalShares, m.transactions.single.delta, m.dividends.single.net, m.dividends.single.paid], [60, 10, const Money(3000000), true]);
      expect(MyShareholding.fromMap({'linked': false}).linked, isFalse);
    });

    test('requests never carry client-calculated totals, percentages or allocations', () {
      final pay = const SharePayment(source: ContributionSource.account, amount: Money(1000000), accountId: 'cash_at_hand').toJson();
      expect(pay.keys.toSet(), {'source', 'amountUgx', 'accountId'});
      final div = DividendDraft(financialPeriod: 'FY 2026', recordDate: now, declarationDate: now, method: DividendMethod.pool,
          totalDistributable: const Money(10000000)).toJson();
      expect(div.keys.any((k) => k.contains('alloc') || k.contains('paid') || k.contains('ownership')), isFalse);
      expect(div.containsKey('dividendPerShareUgx'), isFalse);
    });
  });

  group('finance integration', () {
    test('share capital and dividends are their own ledger types: never revenue, not reversible from finance', () {
      for (final type in ['share_capital_contribution', 'dividend_payment']) {
        final t = FinancialTransaction.fromFirestore('t', {'type': type, 'amountUgx': 1000, 'status': 'posted'});
        expect(t.isRevenue, isFalse, reason: type);
        expect(t.isOwnership, isTrue, reason: type);
        expect(t.canReverse, isFalse, reason: type);
      }
    });

    test('daily summaries keep owners\' money apart from income and expenses', () {
      final d = DailyFinanceSummary.fromFirestore('2026-12-15', {
        'customerPaymentsUgx': 50000, 'expensesPaidUgx': 20000, 'shareCapitalInUgx': 2000000, 'dividendsPaidUgx': 500000,
        'reversals': {'dividend_paymentUgx': 100000},
      });
      expect([d.netIncome, d.netExpenses, d.netShareCapital, d.netDividends], [const Money(50000), const Money(20000), const Money(2000000), const Money(400000)]);
      final both = DailyFinanceSummary.combine('p', [d, d]);
      expect([both.shareCapitalIn, both.dividendsPaid], [const Money(4000000), const Money(1000000)]);
    });
  });
}
