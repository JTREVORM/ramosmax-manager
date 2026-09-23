import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/attendance.dart';
import '../../../models/payroll.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/workforce_providers.dart';
import 'workforce_widgets.dart';

/// Allowances module. With allowances.view: decide, pay and calculate. For
/// everyone else it is "My pay": their own allowances, payslips, salary and
/// deductions - nobody else's.
class AllowancesScreen extends ConsumerWidget {
  const AllowancesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.allowancesView)) return const MyPayScreen();
    final tabs = <(String, Widget)>[
      ('To decide', const _ToDecideTab()),
      ('Approved · unpaid', const _UnpaidTab()),
      ('History', const _HistoryTab()),
      if (canDo(ref, Permission.allowancesCalculate)) ('Calculate', const _CalculateTab()),
      if (canDo(ref, Permission.allowancesViewOwn)) ('My pay', const MyPayScreen()),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Column(children: [
        TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final (label, _) in tabs) Tab(text: label)]),
        Expanded(child: TabBarView(children: [for (final (_, view) in tabs) view])),
      ]),
    );
  }
}

class _ToDecideTab extends ConsumerStatefulWidget {
  const _ToDecideTab();

  @override
  ConsumerState<_ToDecideTab> createState() => _ToDecideTabState();
}

class _ToDecideTabState extends ConsumerState<_ToDecideTab> {
  final Set<String> _selected = {};

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(currentUserProvider)?.uid;
    final canDecide = canDo(ref, Permission.allowancesApprove) || canDo(ref, Permission.allowancesAdjust);
    return switch (ref.watch(allowancesToDecideProvider)) {
      AsyncData(:final value) when value.isEmpty => const EmptyView(
          icon: Icons.savings_outlined, title: 'Nothing to decide', message: 'Calculated allowances appear here for approval.'),
      AsyncData(:final value) => Column(children: [
          if (canDecide)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: Row(children: [
                Expanded(child: Text('${_selected.length} selected')),
                TextButton(
                  key: const Key('approve-selected-allowances'),
                  onPressed: _selected.isEmpty
                      ? null
                      : () async {
                          final r = await ref.read(workforceActionsProvider).reviewAllowances(_selected.toList(), AllowanceDecision.full);
                          if (context.mounted && reportResult(context, r, 'Allowances approved in full.')) setState(_selected.clear);
                        },
                  child: const Text('Approve in full'),
                ),
              ]),
            ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
              for (final a in value)
                AllowanceTile(
                  allowance: a,
                  onTap: () => showFormSheet<void>(context, AllowanceSheet(allowance: a)),
                  selected: _selected.contains(a.allowanceId),
                  onSelect: !canDecide || a.staffUid == me
                      ? null
                      : (on) => setState(() => on == true ? _selected.add(a.allowanceId) : _selected.remove(a.allowanceId)),
                ),
            ]),
          ),
        ]),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class _UnpaidTab extends ConsumerStatefulWidget {
  const _UnpaidTab();

  @override
  ConsumerState<_UnpaidTab> createState() => _UnpaidTabState();
}

class _UnpaidTabState extends ConsumerState<_UnpaidTab> {
  final Set<String> _selected = {};

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(currentUserProvider)?.uid;
    final canPay = canDo(ref, Permission.allowancesPay);
    return switch (ref.watch(allowancesByStatusProvider(AllowanceStatus.approved))) {
      AsyncData(:final value) when value.isEmpty =>
        const EmptyView(icon: Icons.savings_outlined, title: 'Nothing unpaid', message: 'Approved allowances not yet paid appear here.'),
      AsyncData(:final value) => () {
          final chosen = value.where((a) => _selected.contains(a.allowanceId)).toList();
          final total = AllowanceTotals.of(chosen);
          return Column(children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: MoneyLine('${value.length} approved, unpaid', AllowanceTotals.of(value), valueKey: const Key('unpaid-allowances-total')),
            ),
            if (canPay)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                child: FilledButton.icon(
                  key: const Key('pay-allowances-button'),
                  icon: const Icon(Icons.payments_outlined),
                  label: Text(chosen.isEmpty ? 'Select allowances to pay' : 'Pay ${chosen.length} · ${total.format()}'),
                  onPressed: chosen.isEmpty
                      ? null
                      : () async {
                          final accountId = await choosePayFromAccount(context, ref, amount: total, title: 'Pay allowances');
                          if (accountId == null || !context.mounted) return;
                          final r = await ref.read(workforceActionsProvider).payAllowances([for (final a in chosen) a.allowanceId],
                              accountId: accountId, requestId: newRequestId());
                          if (context.mounted && reportResult(context, r, 'Paid ${total.format()}.')) setState(_selected.clear);
                        },
                ),
              ),
            Expanded(
              child: ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96), children: [
                for (final a in value)
                  AllowanceTile(
                    allowance: a,
                    onTap: () => showFormSheet<void>(context, AllowanceSheet(allowance: a)),
                    selected: _selected.contains(a.allowanceId),
                    // Someone else pays your own allowance.
                    onSelect: !canPay || a.staffUid == me
                        ? null
                        : (on) => setState(() => on == true ? _selected.add(a.allowanceId) : _selected.remove(a.allowanceId)),
                  ),
              ]),
            ),
          ]);
        }(),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class _HistoryTab extends ConsumerStatefulWidget {
  const _HistoryTab();

  @override
  ConsumerState<_HistoryTab> createState() => _HistoryTabState();
}

class _HistoryTabState extends ConsumerState<_HistoryTab> {
  AllowanceStatus _status = AllowanceStatus.paid;

  @override
  Widget build(BuildContext context) => Column(children: [
        FilterChips<AllowanceStatus>(
          values: AllowanceStatus.values,
          selected: _status,
          label: (s) => s.label,
          keyPrefix: 'allowance-status',
          onSelected: (s) => setState(() => _status = s),
        ),
        Expanded(
          child: switch (ref.watch(allowancesByStatusProvider(_status))) {
            AsyncData(:final value) when value.isEmpty => const EmptyView(icon: Icons.savings_outlined, title: 'None'),
            AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                MoneyLine('${value.length} shown', AllowanceTotals.of(value)),
                for (final a in value) AllowanceTile(allowance: a, onTap: () => showFormSheet<void>(context, AllowanceSheet(allowance: a))),
              ]),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]);
}

class _CalculateTab extends ConsumerStatefulWidget {
  const _CalculateTab();

  @override
  ConsumerState<_CalculateTab> createState() => _CalculateTabState();
}

class _CalculateTabState extends ConsumerState<_CalculateTab> {
  DateTime? _day;
  bool _busy = false;
  String? _summary;

  @override
  Widget build(BuildContext context) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final day = _day ?? now;
    final policy = ref.watch(workforcePolicyProvider).value ?? WorkforcePolicy.defaults;
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      Text('Allowances are calculated only for APPROVED attendance of staff whose salary profile makes them eligible. '
          'The default is ${policy.defaultDailyAllowance.format()} a day; late arrivals wait for your decision.'),
      const SizedBox(height: AppSpacing.sm),
      DateField(fieldKey: const Key('allowance-day'), label: 'Day', value: day, last: now, onChanged: (d) => setState(() => _day = d)),
      const SizedBox(height: AppSpacing.sm),
      FilledButton.icon(
        key: const Key('calculate-allowances-button'),
        icon: const Icon(Icons.calculate_outlined),
        label: Text('Calculate for ${DateTimeFormatter.date(day)}'),
        onPressed: _busy
            ? null
            : () async {
                setState(() => _busy = true);
                final r = await ref.read(workforceActionsProvider).calculateAllowances(day);
                if (!mounted) return;
                setState(() => _busy = false);
                r.when(
                  success: (v) => setState(() => _summary = [
                        '${v.created} allowance${v.created == 1 ? '' : 's'} calculated.',
                        if (v.skipped.isNotEmpty) 'Not eligible / skipped:',
                        ...v.skipped,
                      ].join('\n')),
                  failure: (f) => AppSnackbar.error(context, f.message),
                );
              },
      ),
      if (_summary != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(_summary!, key: const Key('calculate-summary'))),
    ]);
  }
}

/// Details and the actions allowed on one allowance.
class AllowanceSheet extends ConsumerStatefulWidget {
  const AllowanceSheet({super.key, required this.allowance});
  final WorkerAllowance allowance;

  @override
  ConsumerState<AllowanceSheet> createState() => _AllowanceSheetState();
}

class _AllowanceSheetState extends ConsumerState<AllowanceSheet> {
  late AllowanceDecision _decision = widget.allowance.proposedDecision ?? widget.allowance.suggestedDecision ?? AllowanceDecision.full;
  late final _deduction = TextEditingController(
      text: (widget.allowance.proposedDeduction ?? (widget.allowance.suggestedDeduction.isPositive ? widget.allowance.suggestedDeduction : null))
          ?.formatAmount());
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _deduction.dispose();
    _reason.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _saving = true);
    final r = await ref.read(workforceActionsProvider).reviewAllowances(
          [widget.allowance.allowanceId],
          _decision,
          deduction: _decision == AllowanceDecision.deduct ? MoneyField.parse(_deduction.text) : null,
          reason: _reason.text.trim().isEmpty ? null : _reason.text.trim(),
        );
    if (!mounted) return;
    setState(() => _saving = false);
    r.when(
      success: (_) {
        AppSnackbar.success(context, canDo(ref, Permission.allowancesApprove) ? 'Decision saved.' : 'Sent for approval.');
        Navigator.of(context).pop();
      },
      failure: (f) => setState(() => _error = f.message),
    );
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.allowance;
    final me = ref.watch(currentUserProvider)?.uid;
    final policy = ref.watch(workforcePolicyProvider).value ?? WorkforcePolicy.defaults;
    final decide = a.status.awaitsDecision && a.staffUid != me && (canDo(ref, Permission.allowancesApprove) || canDo(ref, Permission.allowancesAdjust));
    final deduction = MoneyField.parse(_deduction.text);
    final deductionError = _decision != AllowanceDecision.deduct
        ? null
        : deduction == null
            ? 'Enter the deduction'
            : deduction > policy.maxLateDeduction
                ? 'At most ${policy.maxLateDeduction.format()}'
                : deduction >= a.calculatedAmount
                    ? 'Use reject to pay nothing'
                    : null;
    final needsReason = _decision != AllowanceDecision.full;
    final ready = !_saving && deductionError == null && (!needsReason || _reason.text.trim().length >= 3);
    final info = [
      MoneyLine('Calculated', a.calculatedAmount),
      if (a.deduction.isPositive) MoneyLine('Deducted', a.deduction, negative: true),
      if (a.approvedAmount != null) MoneyLine('Approved', a.approvedAmount!, emphasis: true),
      InfoRow('Day', a.dayKey),
      InfoRow('Arrival', a.late ? 'Late by ${a.minutesLate} minutes' : 'On time'),
      if (a.suggestedDecision != null && a.late) InfoRow('Policy suggests', a.suggestedDecision!.label),
      if (a.proposedDecision != null) InfoRow('Proposed', [a.proposedDecision!.label, ?a.proposedByName, ?a.proposalReason].join(' · ')),
      if (a.deductionReason != null) InfoRow('Reason', a.deductionReason),
      if (a.rejectionReason != null) InfoRow('Rejected', a.rejectionReason),
      if (a.paidAt != null)
        InfoRow('Paid', [
          if (a.paidVia == 'payroll') 'with payroll ${a.payrollNumber ?? ''}' else ?a.paidFromAccountName,
          DateTimeFormatter.date(a.paidAt!),
          ?a.financialTransactionNumber,
        ].join(' · ')),
      if (a.cancelReason != null) InfoRow('Cancelled', a.cancelReason),
    ];
    return FormSheet(
      title: '${a.allowanceNumber} · ${a.staffName}',
      subtitle: a.status.label,
      submitLabel: decide ? (canDo(ref, Permission.allowancesApprove) ? 'Save decision' : 'Send for approval') : 'Close',
      submitKey: const Key('submit-allowance-decision'),
      saving: _saving,
      error: _error,
      onSubmit: decide ? (ready ? _submit : null) : () => Navigator.of(context).pop(),
      children: [
        ...info,
        if (decide) ...[
          SegmentedButton<AllowanceDecision>(
            key: const Key('allowance-decision'),
            segments: [for (final d in AllowanceDecision.values) ButtonSegment(value: d, label: Text(d.label))],
            selected: {_decision},
            onSelectionChanged: (s) => setState(() => _decision = s.first),
          ),
          if (_decision == AllowanceDecision.deduct)
            MoneyField(
              controller: _deduction,
              label: 'Deduction (policy: ${policy.lateDeduction.format()}, max ${policy.maxLateDeduction.format()})',
              fieldKey: const Key('allowance-deduction'),
              errorText: deductionError,
              onChanged: (_) => setState(() {}),
            ),
          if (_decision == AllowanceDecision.deduct && deduction != null && deductionError == null)
            MoneyLine('Will be paid', a.calculatedAmount - deduction, valueKey: const Key('allowance-after-deduction')),
          TextField(
            key: const Key('allowance-reason'),
            controller: _reason,
            maxLength: 500,
            decoration: InputDecoration(labelText: needsReason ? 'Reason (required)' : 'Reason (optional)'),
            onChanged: (_) => setState(() {}),
          ),
        ],
        Wrap(spacing: AppSpacing.xs, children: [
          if ({AllowanceStatus.calculated, AllowanceStatus.pendingApproval, AllowanceStatus.approved}.contains(a.status) &&
              a.staffUid != me &&
              canDo(ref, Permission.allowancesAdjust))
            TextButton(
              key: const Key('cancel-allowance-button'),
              onPressed: () async {
                final reason = await showReasonDialog(context,
                    title: 'Cancel ${a.allowanceNumber}?', message: 'The day can then be recalculated.', confirmLabel: 'Cancel allowance', destructive: true);
                if (reason == null || !context.mounted) return;
                final r = await ref.read(workforceActionsProvider).cancelAllowances([a.allowanceId], reason: reason);
                if (context.mounted && reportResult(context, r, 'Allowance cancelled.')) Navigator.of(context).pop();
              },
              child: const Text('Cancel allowance'),
            ),
          if (a.status == AllowanceStatus.paid && a.paidVia == 'direct' && a.financialTransactionId != null && canDo(ref, Permission.allowancesAdjust))
            TextButton(
              key: const Key('reverse-allowance-payment-button'),
              onPressed: () async {
                final reason = await showReasonDialog(context,
                    title: 'Reverse payment ${a.financialTransactionNumber}?',
                    message: 'Every allowance paid in that payment goes back to approved and the money returns to the account.',
                    confirmLabel: 'Reverse',
                    destructive: true);
                if (reason == null || !context.mounted) return;
                final r = await ref.read(workforceActionsProvider).reverseAllowancePayment(a.financialTransactionId!, reason: reason);
                if (context.mounted && reportResult(context, r, 'Payment reversed.')) Navigator.of(context).pop();
              },
              child: const Text('Reverse payment'),
            ),
        ]),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// My pay (own records only)
// ---------------------------------------------------------------------------

class MyPayScreen extends ConsumerWidget {
  const MyPayScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tabs = <(String, Widget)>[
      if (canDo(ref, Permission.allowancesViewOwn)) ('My allowances', const _MyAllowancesTab()),
      if (canDo(ref, Permission.payrollViewOwn)) ('Payslips', const _MyPayslipsTab()),
      if (canDo(ref, Permission.payrollViewOwn)) ('Salary & deductions', const _MySalaryTab()),
    ];
    if (tabs.isEmpty) return const EmptyView(icon: Icons.savings_outlined, title: 'Nothing to show');
    return DefaultTabController(
      length: tabs.length,
      child: Column(children: [
        TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final (label, _) in tabs) Tab(text: label)]),
        Expanded(child: TabBarView(children: [for (final (_, view) in tabs) view])),
      ]),
    );
  }
}

class _MyAllowancesTab extends ConsumerWidget {
  const _MyAllowancesTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(myAllowancesProvider)) {
        AsyncData(:final value) when value.isEmpty =>
          const EmptyView(icon: Icons.savings_outlined, title: 'No allowances yet', message: 'They appear after your attendance is approved.'),
        AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
            MoneyCard(title: 'Summary', lines: [
              MoneyLine('Approved, not yet paid', AllowanceTotals.of(value.where((a) => a.status == AllowanceStatus.approved)),
                  valueKey: const Key('my-unpaid-allowances')),
              MoneyLine('Paid', AllowanceTotals.of(value.where((a) => a.status == AllowanceStatus.paid)), valueKey: const Key('my-paid-allowances')),
            ]),
            for (final a in value) AllowanceTile(allowance: a, showName: false, onTap: () => showFormSheet<void>(context, AllowanceSheet(allowance: a))),
          ]),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

class _MyPayslipsTab extends ConsumerWidget {
  const _MyPayslipsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(myPayslipsProvider)) {
        AsyncData(:final value) when value.isEmpty =>
          const EmptyView(icon: Icons.receipt_long_outlined, title: 'No payslips yet', message: 'Your payslip appears here once your pay is processed.'),
        AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
            for (final i in value) PayslipCard(item: i),
          ]),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

class _MySalaryTab extends ConsumerWidget {
  const _MySalaryTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final salary = ref.watch(mySalaryProvider).value;
    final deductions = ref.watch(myDeductionsProvider).value ?? const <SalaryDeduction>[];
    final losses = ref.watch(myLossesProvider).value ?? const <LossIncident>[];
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      SectionCard(title: 'My salary', icon: Icons.badge_outlined, children: [
        if (salary == null)
          const Text('No salary profile yet.')
        else ...[
          MoneyLine('Basic salary (${salary.frequency.label.toLowerCase()})', salary.basicSalary, emphasis: true, valueKey: const Key('my-basic-salary')),
          InfoRow('Daily allowance', !salary.allowanceEligible ? 'Not eligible' : salary.allowanceAmount?.format() ?? 'Standard rate'),
          if (salary.effectiveFrom != null) InfoRow('Effective from', DateTimeFormatter.date(salary.effectiveFrom!)),
          if (!salary.active) const InfoRow('Status', 'Inactive'),
        ],
      ]),
      SectionCard(title: 'My deductions', icon: Icons.remove_circle_outline, children: [
        if (deductions.isEmpty) const Text('No deductions.'),
        for (final d in deductions)
          ListTile(
            key: Key('my-deduction-${d.deductionId}'),
            contentPadding: EdgeInsets.zero,
            title: Text('${d.type.label} · ${d.deductionNumber}'),
            subtitle: Text([?d.reason, 'Remaining ${d.remaining.format()} of ${d.total.format()}', '${d.instalment.format()} per payroll'].join('\n')),
            trailing: DeductionStatusChip(d.status),
          ),
      ]),
      if (losses.isNotEmpty)
        SectionCard(title: 'Loss incidents about me', icon: Icons.report_problem_outlined, children: [
          for (final l in losses)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${l.lossNumber} · ${l.type.label}'),
              subtitle: Text([l.description, 'Recovery approved ${l.approvedRecovery.format()} · outstanding ${l.outstanding.format()}'].join('\n')),
              trailing: LossStatusChip(l.status),
            ),
        ]),
      const SizedBox(height: AppSpacing.sm),
      TextButton(onPressed: () => context.go(AppRoutes.attendance), child: const Text('My attendance')),
    ]);
  }
}
