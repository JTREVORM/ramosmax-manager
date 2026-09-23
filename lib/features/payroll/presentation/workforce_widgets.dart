import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/money/money.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/app_user.dart';
import '../../../models/attendance.dart';
import '../../../models/finance.dart';
import '../../../models/payroll.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/application/finance_providers.dart';
import '../../finance/presentation/finance_forms.dart' show pickPaymentAccount;
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show allUsersProvider;

// Building blocks shared by the attendance, allowance, payroll and loss screens.

class AttendanceStatusChip extends StatelessWidget {
  const AttendanceStatusChip(this.status, {super.key});
  final AttendanceStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        AttendanceStatus.pendingVerification => const StatusChip('To verify', color: AppColors.warning, icon: Icons.hourglass_top),
        AttendanceStatus.present => const StatusChip('Present', color: AppColors.success, icon: Icons.check_circle_outline),
        AttendanceStatus.late => const StatusChip('Late', color: AppColors.warning, icon: Icons.schedule),
        AttendanceStatus.absent => const StatusChip('Absent', color: AppColors.danger, icon: Icons.person_off_outlined),
        AttendanceStatus.excused => const StatusChip('Excused', color: AppColors.info, icon: Icons.event_busy_outlined),
        AttendanceStatus.rejected => const StatusChip('Rejected', color: AppColors.danger, icon: Icons.block),
      };
}

class AllowanceStatusChip extends StatelessWidget {
  const AllowanceStatusChip(this.status, {super.key});
  final AllowanceStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        AllowanceStatus.calculated => const StatusChip('To decide', color: AppColors.warning, icon: Icons.calculate_outlined),
        AllowanceStatus.pendingApproval => const StatusChip('Pending approval', color: AppColors.warning, icon: Icons.hourglass_top),
        AllowanceStatus.approved => const StatusChip('Approved · unpaid', color: AppColors.info, icon: Icons.thumb_up_alt_outlined),
        AllowanceStatus.rejected => const StatusChip('Rejected', color: AppColors.danger, icon: Icons.block),
        AllowanceStatus.paid => const StatusChip('Paid', color: AppColors.success, icon: Icons.check_circle_outline),
        AllowanceStatus.cancelled => const StatusChip('Cancelled', color: Colors.grey, icon: Icons.cancel_outlined),
      };
}

class PayrollStatusChip extends StatelessWidget {
  const PayrollStatusChip(this.status, {super.key});
  final PayrollStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        PayrollStatus.draft => const StatusChip('Draft', color: Colors.grey, icon: Icons.edit_note),
        PayrollStatus.prepared => const StatusChip('Prepared', color: AppColors.info, icon: Icons.calculate_outlined),
        PayrollStatus.pendingReview => const StatusChip('Pending review', color: AppColors.warning, icon: Icons.hourglass_top),
        PayrollStatus.approved => const StatusChip('Approved · unpaid', color: AppColors.info, icon: Icons.thumb_up_alt_outlined),
        PayrollStatus.paid => const StatusChip('Paid', color: AppColors.success, icon: Icons.check_circle_outline),
        PayrollStatus.locked => const StatusChip('Locked', color: AppColors.success, icon: Icons.lock_outline),
        PayrollStatus.cancelled => const StatusChip('Cancelled', color: Colors.grey, icon: Icons.cancel_outlined),
      };
}

class LossStatusChip extends StatelessWidget {
  const LossStatusChip(this.status, {super.key});
  final LossStatus status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      LossStatus.reported || LossStatus.underReview => AppColors.warning,
      LossStatus.approved || LossStatus.recoveryScheduled || LossStatus.partiallyRecovered => AppColors.info,
      LossStatus.recovered => AppColors.success,
      LossStatus.rejected => AppColors.danger,
      LossStatus.cancelled => Colors.grey,
    };
    return StatusChip(status.label, color: color);
  }
}

class DeductionStatusChip extends StatelessWidget {
  const DeductionStatusChip(this.status, {super.key});
  final DeductionStatus status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      DeductionStatus.pendingApproval => AppColors.warning,
      DeductionStatus.active => AppColors.info,
      DeductionStatus.completed => AppColors.success,
      DeductionStatus.rejected => AppColors.danger,
      DeductionStatus.cancelled => Colors.grey,
    };
    return StatusChip(status.label, color: color);
  }
}

/// `08:14 → 17:30 · 14 min late` for an attendance row.
String attendanceTimes(AttendanceRecord a) {
  if (a.clockInAt == null) return a.arrivalStatus.label;
  final times = [DateTimeFormatter.time(a.clockInAt!), if (a.clockOutAt != null) DateTimeFormatter.time(a.clockOutAt!)].join(' → ');
  return a.minutesLate > 0 ? '$times · ${a.minutesLate} min after ${a.reportingTime ?? 'reporting time'}' : times;
}

class AttendanceTile extends StatelessWidget {
  const AttendanceTile({super.key, required this.record, this.onTap, this.showName = true, this.selected, this.onSelect});
  final AttendanceRecord record;
  final VoidCallback? onTap;
  final bool showName;
  final bool? selected;
  final ValueChanged<bool?>? onSelect;

  @override
  Widget build(BuildContext context) {
    final a = record;
    return Card(
      key: Key('attendance-${a.attendanceId}'),
      child: ListTile(
        onTap: onTap,
        leading: onSelect == null ? null : Checkbox(key: Key('select-attendance-${a.attendanceId}'), value: selected ?? false, onChanged: onSelect),
        title: Text(showName ? a.staffName : DateTimeFormatter.attendanceDay(a.date ?? DateTime.now()), overflow: TextOverflow.ellipsis),
        subtitle: Text([if (showName) a.dayKey, attendanceTimes(a), if (!a.workingDay) 'Non-working day', if (a.correctionCount > 0) 'Corrected'].join(' · ')),
        trailing: AttendanceStatusChip(a.status),
      ),
    );
  }
}

class AllowanceTile extends StatelessWidget {
  const AllowanceTile({super.key, required this.allowance, this.onTap, this.showName = true, this.selected, this.onSelect});
  final WorkerAllowance allowance;
  final VoidCallback? onTap;
  final bool showName;
  final bool? selected;
  final ValueChanged<bool?>? onSelect;

  @override
  Widget build(BuildContext context) {
    final a = allowance;
    final theme = Theme.of(context);
    return Card(
      key: Key('allowance-${a.allowanceId}'),
      child: ListTile(
        onTap: onTap,
        leading: onSelect == null ? null : Checkbox(key: Key('select-allowance-${a.allowanceId}'), value: selected ?? false, onChanged: onSelect),
        title: Row(children: [
          Expanded(child: Text(showName ? a.staffName : a.dayKey, overflow: TextOverflow.ellipsis)),
          Text(a.amount.format(), style: theme.textTheme.titleSmall),
        ]),
        subtitle: Wrap(spacing: AppSpacing.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text([a.allowanceNumber, if (showName) a.dayKey, if (a.late) 'Late ${a.minutesLate} min', if (a.deduction.isPositive) '− ${a.deduction.format()}']
              .join(' · ')),
          AllowanceStatusChip(a.status),
        ]),
      ),
    );
  }
}

/// Earnings − deductions = net, as on a payslip.
class PayslipCard extends StatelessWidget {
  const PayslipCard({super.key, required this.item, this.title});
  final PayrollItem item;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final i = item;
    return SectionCard(
      key: Key('payslip-${i.itemId}'),
      title: title ?? '${i.periodLabel} · ${i.itemNumber}',
      icon: Icons.receipt_long_outlined,
      children: [
        MoneyLine('Basic salary', i.basicSalary),
        MoneyLine('Approved allowances (${i.allowanceDays} day${i.allowanceDays == 1 ? '' : 's'})', i.allowances),
        for (final e in i.otherEarningLines) MoneyLine(e.description, e.amount),
        MoneyLine('Gross pay', i.gross, emphasis: true, valueKey: Key('gross-${i.itemId}')),
        for (final d in i.deductionLines)
          if (d.amount.isPositive)
            MoneyLine([d.type.label, ?d.lossNumber, d.deductionNumber].join(' · '), d.amount, negative: true),
        MoneyLine('Total deductions', i.totalDeductions, negative: true, valueKey: Key('deductions-${i.itemId}')),
        const Divider(),
        MoneyLine('Net pay', i.net, emphasis: true, valueKey: Key('net-${i.itemId}')),
        if (i.deductionCapped)
          Text('Some deductions were limited so they stay within the allowed share of gross pay; the rest carries forward.',
              style: Theme.of(context).textTheme.bodySmall),
        InfoRow('Payment', i.paymentStatus == 'paid' ? 'Paid${i.paidAt == null ? '' : ' ${DateTimeFormatter.date(i.paidAt!)}'}' : i.status.replaceAll('_', ' ')),
      ],
    );
  }
}

/// Dropdown of active staff (needs users.view).
class StaffDropdown extends ConsumerWidget {
  const StaffDropdown({super.key, required this.value, required this.onChanged, this.label = 'Staff member', this.fieldKey, this.exclude});
  final String? value;
  final ValueChanged<String?> onChanged;
  final String label;
  final Key? fieldKey;
  final String? exclude;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = (ref.watch(allUsersProvider).value ?? const <AppUser>[]).where((u) => u.active && u.uid != exclude).toList()
      ..sort((a, b) => a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()));
    return DropdownButtonFormField<String>(
      key: fieldKey,
      initialValue: users.any((u) => u.uid == value) ? value : null,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final u in users)
          DropdownMenuItem(value: u.uid, child: Text([u.displayName, u.role.label, ?u.staffId].join(' · '), overflow: TextOverflow.ellipsis)),
      ],
      onChanged: onChanged,
    );
  }
}

/// An EAT wall-clock time on [day]; returns the UTC instant.
class TimeField extends StatelessWidget {
  const TimeField({super.key, required this.label, required this.day, required this.value, required this.onChanged, this.fieldKey});
  final String label;
  final DateTime day;
  final DateTime? value;
  final ValueChanged<DateTime?> onChanged;
  final Key? fieldKey;

  @override
  Widget build(BuildContext context) => InkWell(
        key: fieldKey,
        onTap: () async {
          final eat = value == null ? null : EastAfricaTime.toEat(value!);
          final picked = await showTimePicker(
            context: context,
            initialTime: eat == null ? const TimeOfDay(hour: 8, minute: 0) : TimeOfDay(hour: eat.hour, minute: eat.minute),
          );
          if (picked == null) return;
          final d = EastAfricaTime.toEat(day);
          onChanged(EastAfricaTime.fromEatWallClock(d.year, d.month, d.day, picked.hour, picked.minute));
        },
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, suffixIcon: const Icon(Icons.access_time, size: 18)),
          child: Text(value == null ? '—' : DateTimeFormatter.time(value!)),
        ),
      );
}

/// The account money leaves from. With finance.view: balances and a check;
/// without it (e.g. a cashier granted allowances.pay): the account names only,
/// and the server checks the balance.
Future<String?> choosePayFromAccount(BuildContext context, WidgetRef ref, {required Money amount, required String title}) async {
  if (canDo(ref, Permission.financeView)) return pickPaymentAccount(context, amount: amount, title: title);
  final banks = ref.read(paymentAccountOptionsProvider).value ?? const <PaymentAccountOption>[];
  final options = <(String, String)>[
    for (final id in [DefaultAccounts.cashAtHand, DefaultAccounts.mtnMerchant, DefaultAccounts.airtelMerchant]) (id, DefaultAccounts.all[id]!.$1),
    for (final b in banks) (b.accountId, b.label),
  ];
  return showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: ListView(shrinkWrap: true, children: [
        ListTile(title: Text('$title: ${amount.format()}'), subtitle: const Text('Money leaves this account only now, when you choose it.')),
        for (final (id, name) in options)
          ListTile(key: Key('pay-from-$id'), leading: const Icon(Icons.account_balance_wallet_outlined), title: Text(name), onTap: () => Navigator.of(context).pop(id)),
      ]),
    ),
  );
}
