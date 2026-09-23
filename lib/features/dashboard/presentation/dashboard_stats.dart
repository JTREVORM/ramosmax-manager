import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../models/app_user.dart';
import '../../../models/service_intake.dart';
import '../../../models/work_order.dart';
import '../../../routes/app_routes.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../models/attendance.dart';
import '../../../models/expense.dart';
import '../../../models/finance.dart';
import '../../../models/payroll.dart';
import '../../billing/application/billing_providers.dart';
import '../../expenses/application/expenses_providers.dart';
import '../../finance/application/finance_providers.dart';
import '../../inventory/application/inventory_providers.dart';
import '../../jobs/application/jobs_providers.dart';
import '../../operations/application/operations_providers.dart';
import '../../payroll/application/workforce_providers.dart';
import '../../shareholders/application/shareholders_providers.dart';
import '../../../models/shareholding.dart';
import '../../../models/after_hours.dart';
import '../../after_hours/application/after_hours_providers.dart';

/// Live figures for the signed-in role, each from data the user may read.
/// Nothing is shown for data the user has no permission to see.
class DashboardStats extends ConsumerWidget {
  const DashboardStats({super.key, required this.user});
  final AppUser user;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    bool can(Permission p) => user.can(p, now);
    final tiles = <Widget>[];

    if (can(Permission.jobsViewOwn) && !can(Permission.jobsView)) {
      final mine = ref.watch(myOrdersProvider(user.uid)).value;
      if (mine != null) {
        tiles
          ..add(_Stat(keyName: 'stat-my-new', label: 'New jobs', value: '${mine.where((o) => o.status == WorkOrderStatus.assigned).length}',
              route: AppRoutes.myJobs))
          ..add(_Stat(keyName: 'stat-my-active', label: 'In hand', value: '${mine.where((o) => o.status.isActive).length}',
              route: AppRoutes.myJobs));
      }
    }
    if (can(Permission.jobsView)) {
      final open = ref.watch(intakesProvider(IntakeStatus.open)).value;
      final completed = ref.watch(intakesProvider(IntakeStatus.completed)).value;
      if (open != null) tiles.add(_Stat(keyName: 'stat-open-jobs', label: 'Open jobs', value: '${open.length}', route: AppRoutes.jobs));
      if (completed != null && can(Permission.invoicesCreate)) {
        tiles.add(_Stat(keyName: 'stat-to-invoice', label: 'Ready to invoice', value: '${completed.where((i) => !i.isInvoiced).length}',
            route: AppRoutes.jobs));
      }
    }
    if (can(Permission.paymentsView)) {
      final today = ref.watch(paymentsProvider((period: PaymentPeriod.today, method: null))).value;
      if (today != null) {
        tiles.add(_Stat(
          keyName: 'stat-today-payments',
          label: 'Received today',
          value: Money.sum(today.where((p) => !p.reversed).map((p) => p.amount)).format(),
          route: AppRoutes.payments,
        ));
      }
    }
    if (can(Permission.creditView)) {
      final owed = ref.watch(outstandingInvoicesProvider).value;
      if (owed != null) {
        final s = CreditSummary.of(owed, now);
        tiles.add(_Stat(keyName: 'stat-outstanding', label: 'Outstanding (${s.count})', value: s.total.format(), route: AppRoutes.credit));
      }
    }
    // Phase 5: balances and daily totals kept by the server; nothing is
    // recomputed from raw records here.
    if (can(Permission.financeView)) {
      final accounts = ref.watch(financialAccountsProvider).value;
      if (accounts != null) {
        final funds = FundsSummary.of(accounts);
        tiles
          ..add(_Stat(keyName: 'stat-total-funds', label: 'Total funds', value: funds.total.format(), route: AppRoutes.finance))
          ..add(_Stat(keyName: 'stat-cash', label: 'Cash at Hand', value: (funds.byType[AccountType.cash] ?? Money.zero).format(), route: AppRoutes.finance))
          ..add(_Stat(keyName: 'stat-mobile-money', label: 'MTN + Airtel', value: (funds.byType[AccountType.mobileMoney] ?? Money.zero).format(), route: AppRoutes.financeAccounts))
          ..add(_Stat(keyName: 'stat-bank', label: 'Bank', value: (funds.byType[AccountType.bank] ?? Money.zero).format(), route: AppRoutes.financeAccounts))
          ..add(_Stat(keyName: 'stat-awaiting-banking', label: 'Cash awaiting banking', value: funds.awaitingBanking.format(), route: AppRoutes.financeBanking));
      }
      final today = ref.watch(todayFinanceProvider).value;
      if (today != null) {
        tiles.add(_Stat(keyName: 'stat-today-expenses', label: "Today's expenses", value: today.netExpenses.format(), route: AppRoutes.financeReports));
      }
    }
    if (can(Permission.expensesApprove) || can(Permission.expensesReview)) {
      final pending = ref.watch(expensesProvider(ExpenseStatus.pendingReview)).value;
      if (pending != null) {
        tiles.add(_Stat(keyName: 'stat-pending-expenses', label: 'Expenses to approve', value: '${pending.length}', route: AppRoutes.expenses));
      }
    }
    if (can(Permission.inventoryView)) {
      final low = ref.watch(lowStockProvider).value;
      if (low != null) tiles.add(_Stat(keyName: 'stat-low-stock', label: 'Low / out of stock', value: '${low.length}', route: AppRoutes.inventory));
    }
    // Phase 6: attendance, allowances, payroll and losses - server-written
    // records only; each figure needs the permission for its data.
    tiles.addAll(_workforceTiles(ref, can, now));
    // Phase 7: register-level shareholder figures (no contact or identity
    // data) and dividend status, only with the matching permission.
    tiles.addAll(_shareholderTiles(ref, can));
    // Phase 8: after-hours work - the worker's own session and handovers, or
    // the supervisors' queue, only with the matching permission.
    tiles.addAll(_afterHoursTiles(ref, can));
    if (tiles.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.md),
      child: LayoutBuilder(
        builder: (context, c) {
          final width = (c.maxWidth - AppSpacing.sm) / 2;
          return Wrap(
            key: const Key('dashboard-stats'),
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [for (final t in tiles) SizedBox(width: width, child: t)],
          );
        },
      ),
    );
  }
}

List<Widget> _workforceTiles(WidgetRef ref, bool Function(Permission) can, DateTime now) {
  final tiles = <Widget>[];
  final today = EastAfricaTime.businessDayKey(now);
  if (can(Permission.attendanceView)) {
    final day = ref.watch(attendanceDayProvider(today)).value;
    if (day != null) {
      final inToday = day.where((a) => a.clockInAt != null && a.status != AttendanceStatus.rejected).length;
      tiles
        ..add(_Stat(keyName: 'stat-attendance-today', label: "Today's attendance", value: '$inToday', route: AppRoutes.attendance))
        ..add(_Stat(keyName: 'stat-late-today', label: 'Late today', value: '${day.where((a) => a.late).length}', route: AppRoutes.attendance))
        ..add(_Stat(
            keyName: 'stat-absent-today',
            label: 'Absent today',
            value: '${day.where((a) => a.arrivalStatus == ArrivalStatus.absent).length}',
            route: AppRoutes.attendance));
    }
  } else if (can(Permission.attendanceViewOwn)) {
    final mine = ref.watch(myTodayAttendanceProvider).value;
    tiles.add(_Stat(
        keyName: 'stat-my-attendance',
        label: "Today's attendance",
        value: mine == null ? 'Not clocked in' : mine.status == AttendanceStatus.pendingVerification ? mine.arrivalStatus.label : mine.status.label,
        route: AppRoutes.attendance));
  }
  if (can(Permission.attendanceApprove) || can(Permission.attendanceReview)) {
    final pending = ref.watch(pendingAttendanceProvider).value;
    if (pending != null) {
      tiles.add(_Stat(keyName: 'stat-attendance-to-verify', label: 'Attendance to verify', value: '${pending.length}', route: AppRoutes.attendance));
    }
  }
  if (can(Permission.allowancesView)) {
    final toDecide = ref.watch(allowancesToDecideProvider).value;
    final unpaid = ref.watch(allowancesByStatusProvider(AllowanceStatus.approved)).value;
    if (toDecide != null) {
      tiles.add(_Stat(keyName: 'stat-allowances-to-decide', label: 'Allowances to approve', value: '${toDecide.length}', route: AppRoutes.allowances));
    }
    if (unpaid != null) {
      tiles.add(_Stat(
          keyName: 'stat-allowances-unpaid', label: 'Allowances unpaid', value: AllowanceTotals.of(unpaid).format(), route: AppRoutes.allowances));
    }
  } else if (can(Permission.allowancesViewOwn)) {
    final mine = ref.watch(myAllowancesProvider).value;
    if (mine != null) {
      tiles.add(_Stat(
          keyName: 'stat-my-allowances',
          label: 'My allowances unpaid',
          value: AllowanceTotals.of(mine.where((a) => a.status == AllowanceStatus.approved)).format(),
          route: AppRoutes.allowances));
    }
  }
  if (can(Permission.payrollView)) {
    final runs = ref.watch(payrollsProvider).value;
    final latest = runs?.where((p) => p.status != PayrollStatus.cancelled).firstOrNull;
    if (latest != null) {
      tiles
        ..add(_Stat(keyName: 'stat-payroll-status', label: '${latest.periodLabel} payroll', value: latest.status.label, route: AppRoutes.payrollDetail(latest.payrollId)))
        ..add(_Stat(keyName: 'stat-payroll-total', label: 'Payroll net total', value: latest.totals.net.format(), route: AppRoutes.payrollDetail(latest.payrollId)));
    }
    final pendingDeductions = ref.watch(deductionsProvider(DeductionStatus.pendingApproval)).value;
    if (pendingDeductions != null) {
      tiles.add(_Stat(keyName: 'stat-pending-deductions', label: 'Deductions to approve', value: '${pendingDeductions.length}', route: AppRoutes.payroll));
    }
  } else if (can(Permission.payrollViewOwn)) {
    final slips = ref.watch(myPayslipsProvider).value;
    if (slips != null && slips.isNotEmpty) {
      tiles.add(_Stat(keyName: 'stat-my-net-pay', label: 'Last net pay (${slips.first.periodLabel})', value: slips.first.net.format(), route: AppRoutes.allowances));
    }
  }
  if (can(Permission.lossesView)) {
    final losses = ref.watch(lossesProvider(null)).value;
    if (losses != null) {
      tiles
        ..add(_Stat(keyName: 'stat-open-losses', label: 'Loss incidents to decide', value: '${losses.where((l) => l.status.isOpen).length}', route: AppRoutes.losses))
        ..add(_Stat(
            keyName: 'stat-loss-outstanding',
            label: 'Outstanding loss recoveries',
            value: Money.sum(losses.map((l) => l.outstanding)).format(),
            route: AppRoutes.losses));
    }
  }
  return tiles;
}

List<Widget> _shareholderTiles(WidgetRef ref, bool Function(Permission) can) {
  final tiles = <Widget>[];
  if (can(Permission.shareholdersReportsView) || can(Permission.sharesView) || can(Permission.shareholdersView)) {
    final r = ref.watch(shareRegisterProvider).value;
    if (r != null) {
      tiles
        ..add(_Stat(keyName: 'stat-shareholders', label: 'Shareholders (${r.activeShareholders} active)', value: '${r.shareholderCount}',
            route: AppRoutes.shareholders))
        ..add(_Stat(keyName: 'stat-total-shares', label: 'Total shares', value: formatShares(r.totalShares), route: AppRoutes.shareholders))
        ..add(_Stat(keyName: 'stat-share-capital', label: 'Share capital received', value: r.totalPaid.format(), route: AppRoutes.shareholders));
      if (r.pendingApprovals > 0 && (can(Permission.sharesApprove) || can(Permission.sharesView))) {
        tiles.add(_Stat(keyName: 'stat-share-approvals', label: 'Share approvals pending', value: '${r.pendingApprovals}', route: AppRoutes.shares));
      }
    }
  }
  if (can(Permission.dividendsView) || can(Permission.shareholdersReportsView)) {
    final list = ref.watch(dividendsProvider).value;
    if (list != null) {
      final t = DividendTotals.of(list);
      tiles.add(_Stat(keyName: 'stat-dividends-unpaid', label: 'Dividends unpaid', value: t.outstanding.format(), route: AppRoutes.dividends));
    }
  }
  return tiles;
}

List<Widget> _afterHoursTiles(WidgetRef ref, bool Function(Permission) can) {
  final tiles = <Widget>[];
  final view = can(Permission.afterHoursView);
  if (can(Permission.afterHoursRequest) && !view) {
    final open = ref.watch(myOpenSessionProvider);
    if (open != null) {
      tiles.add(_Stat(keyName: 'stat-my-expected-cash', label: 'Cash to hand over', value: open.expectedCash.format(), route: AppRoutes.myAfterHours));
    }
    final due = (ref.watch(myHandoversProvider).value ?? const <CashHandover>[]).where((h) => h.status == HandoverStatus.pending).length;
    if (due > 0) tiles.add(_Stat(keyName: 'stat-my-handovers-due', label: 'Handovers to submit', value: '$due', route: AppRoutes.myAfterHours));
  }
  if (view || can(Permission.afterHoursApprove)) {
    final open = ref.watch(afterHoursSessionsProvider(SessionStatus.open)).value;
    if (open != null) tiles.add(_Stat(keyName: 'stat-ah-open', label: 'After-hours sessions open', value: '${open.length}', route: AppRoutes.afterHours));
  }
  if (view || can(Permission.cashHandoverApprove)) {
    final list = ref.watch(handoversProvider(null)).value;
    if (list != null) {
      tiles.add(_Stat(
          keyName: 'stat-ah-to-receive', label: 'Cash handovers to receive', value: '${list.where((h) => h.status.awaitingReceipt).length}', route: AppRoutes.afterHours));
    }
  }
  if (view || can(Permission.afterHoursDiscrepancyReview)) {
    final list = ref.watch(discrepanciesProvider(null)).value;
    if (list != null) {
      tiles.add(_Stat(
          keyName: 'stat-ah-discrepancies', label: 'Open cash discrepancies', value: '${list.where((d) => d.status.isOpen).length}', route: AppRoutes.afterHours));
    }
  }
  return tiles;
}

class _Stat extends StatelessWidget {
  const _Stat({required this.keyName, required this.label, required this.value, required this.route});
  final String keyName;
  final String label;
  final String value;
  final String route;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      key: Key(keyName),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: () => context.go(route),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            FittedBox(fit: BoxFit.scaleDown, child: Text(value, style: theme.textTheme.titleLarge)),
            Text(label, style: theme.textTheme.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
          ]),
        ),
      ),
    );
  }
}
