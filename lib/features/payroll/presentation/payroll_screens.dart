import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/errors/app_failure.dart';
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
import '../data/workforce_api.dart';
import 'workforce_widgets.dart';

/// Payroll module: payroll runs, salaries, deductions and the pay policy.
class PayrollScreen extends ConsumerWidget {
  const PayrollScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tabs = <(String, Widget)>[
      if (canDo(ref, Permission.payrollView)) ('Payroll runs', const _RunsTab()),
      if (canDo(ref, Permission.salaryView) || canDo(ref, Permission.staffSalaryView)) ('Salaries', const _SalariesTab()),
      if (canDo(ref, Permission.payrollView) || canDo(ref, Permission.deductionsManage) || canDo(ref, Permission.lossesView))
        ('Deductions', const _DeductionsTab()),
      if (canDo(ref, Permission.settingsView) || canDo(ref, Permission.settingsManage)) ('Policy', const PolicyTab()),
    ];
    if (tabs.isEmpty) return const EmptyView(icon: Icons.wallet_outlined, title: 'Nothing to show');
    return DefaultTabController(
      length: tabs.length,
      child: Column(children: [
        TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final (label, _) in tabs) Tab(text: label)]),
        Expanded(child: TabBarView(children: [for (final (_, view) in tabs) view])),
      ]),
    );
  }
}

class _RunsTab extends ConsumerWidget {
  const _RunsTab();

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final now = EastAfricaTime.toEat(ref.read(clockProvider).value ?? DateTime.now());
    final months = [for (var i = 0; i < 6; i++) DateTime.utc(now.year, now.month - i, 1)];
    final picked = await showModalBottomSheet<DateTime>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          const ListTile(title: Text('New monthly payroll'), subtitle: Text('Choose the month to pay.')),
          for (final m in months)
            ListTile(
              key: Key('payroll-month-${m.year}-${m.month}'),
              title: Text(DateTimeFormatter.payrollPeriod(m.add(const Duration(hours: 12)))),
              onTap: () => Navigator.of(context).pop(m),
            ),
        ]),
      ),
    );
    if (picked == null || !context.mounted) return;
    final r = await ref.read(workforceActionsProvider).createPayroll(year: picked.year, month: picked.month);
    if (!context.mounted) return;
    r.when(success: (id) => context.go(AppRoutes.payrollDetail(id)), failure: (f) => AppSnackbar.error(context, f.message));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canCreate = canDo(ref, Permission.payrollPrepare) || canDo(ref, Permission.payrollProcess);
    return switch (ref.watch(payrollsProvider)) {
      AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
          if (canCreate)
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.icon(
                key: const Key('new-payroll-button'),
                icon: const Icon(Icons.add),
                label: const Text('New payroll period'),
                onPressed: () => _create(context, ref),
              ),
            ),
          if (value.isEmpty) const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No payroll yet.')),
          for (final p in value)
            Card(
              key: Key('payroll-${p.payrollId}'),
              child: ListTile(
                onTap: () => context.go(AppRoutes.payrollDetail(p.payrollId)),
                title: Row(children: [
                  Expanded(child: Text('${p.periodLabel} · ${p.payrollNumber}', overflow: TextOverflow.ellipsis)),
                  Text(p.totals.net.format(), style: Theme.of(context).textTheme.titleSmall),
                ]),
                subtitle: Wrap(spacing: AppSpacing.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
                  Text('${p.employeeCount} staff · gross ${p.totals.gross.format()}'),
                  PayrollStatusChip(p.status),
                ]),
              ),
            ),
        ]),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

// ---------------------------------------------------------------------------
// Payroll detail and workflow
// ---------------------------------------------------------------------------

class PayrollDetailScreen extends ConsumerWidget {
  const PayrollDetailScreen({super.key, required this.payrollId});
  final String payrollId;

  static const _permissionFor = {
    PayrollAction.submit: Permission.payrollPrepare,
    PayrollAction.review: Permission.payrollReview,
    PayrollAction.returnForCorrection: Permission.payrollReview,
    PayrollAction.approve: Permission.payrollApprove,
  };

  Future<void> _act(BuildContext context, WidgetRef ref, PayrollRun p, PayrollAction a) async {
    String? reason;
    String? notes;
    if (a == PayrollAction.returnForCorrection) {
      reason = await showReasonDialog(context, title: 'Return ${p.payrollNumber}?', message: 'Say what must be corrected.', confirmLabel: 'Return');
      if (reason == null) return;
    } else if (a == PayrollAction.review) {
      final entered = await showReasonDialog(context,
          title: 'Mark ${p.payrollNumber} reviewed?',
          message: 'Confirm salaries, allowances and deductions match the records.',
          confirmLabel: 'Reviewed',
          reasonRequired: false,
          reasonLabel: 'Review notes');
      if (entered == null) return;
      notes = entered.isEmpty ? null : entered;
    } else {
      final ok = await showConfirmDialog(context,
          title: '${a.label}?',
          message: a == PayrollAction.approve
              ? 'Approving does not pay it. ${p.totals.net.format()} leaves an account only when someone pays it.'
              : 'Send ${p.payrollNumber} for review.',
          confirmLabel: a.label);
      if (!ok) return;
    }
    if (!context.mounted) return;
    final r = await ref.read(workforceActionsProvider).payrollAction(p.payrollId, a, reason: reason, notes: notes);
    if (context.mounted) reportResult(context, r, 'Payroll updated.');
  }

  Future<void> _withReason(BuildContext context, WidgetRef ref, {required String title, required String message, required String confirm,
      required Future<Result<void>> Function(String reason) run, required String done, bool destructive = false}) async {
    final reason = await showReasonDialog(context, title: title, message: message, confirmLabel: confirm, destructive: destructive);
    if (reason == null || !context.mounted) return;
    final r = await run(reason);
    if (context.mounted) reportResult(context, r, done);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final actions = ref.read(workforceActionsProvider);
    final user = ref.watch(currentUserProvider);
    return switch (ref.watch(payrollProvider(payrollId))) {
      AsyncData(value: final PayrollRun p) => () {
          final items = ref.watch(payrollItemsProvider(payrollId)).value ?? const <PayrollItem>[];
          final includesMe = items.any((i) => i.staffUid == user?.uid);
          bool allowed(PayrollAction a) {
            final perm = _permissionFor[a]!;
            if (a == PayrollAction.submit) return canDo(ref, Permission.payrollPrepare) || canDo(ref, Permission.payrollProcess);
            if (a == PayrollAction.returnForCorrection) return canDo(ref, Permission.payrollReview) || canDo(ref, Permission.payrollApprove);
            if ((a == PayrollAction.approve || a == PayrollAction.review) && includesMe && user?.role != UserRole.admin) return false;
            return canDo(ref, perm);
          }

          final t = p.totals;
          return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
            ScreenHeader('${p.periodLabel} payroll', subtitle: p.payrollNumber, onBack: () => context.go(AppRoutes.payroll)),
            Align(alignment: Alignment.centerLeft, child: PayrollStatusChip(p.status)),
            MoneyCard(title: 'Totals (${p.employeeCount} staff)', lines: [
              MoneyLine('Basic salaries', t.basic),
              MoneyLine('Approved allowances', t.allowances),
              MoneyLine('Other authorised earnings', t.otherEarnings),
              MoneyLine('Gross pay', t.gross, emphasis: true, valueKey: const Key('payroll-gross')),
              MoneyLine('Salary deductions', t.salaryDeductions, negative: true),
              MoneyLine('Loss recoveries', t.lossRecoveries, negative: true),
              MoneyLine('Other deductions', t.otherDeductions, negative: true),
              MoneyLine('Total deductions', t.deductions, negative: true, valueKey: const Key('payroll-deductions')),
              const Divider(),
              MoneyLine('Net pay', t.net, emphasis: true, valueKey: const Key('payroll-net')),
            ], footer: 'Calculated by the server from salary profiles, approved allowances and approved deductions.'),
            SectionCard(title: 'History', icon: Icons.timeline, children: [
              if (p.preparedAt != null) InfoRow('Prepared', [?p.preparedByName, DateTimeFormatter.dateTime(p.preparedAt!), 'version ${p.version}'].join(' · ')),
              if (p.returnedReason != null) InfoRow('Returned', p.returnedReason),
              if (p.reviewedAt != null) InfoRow('Reviewed', [?p.reviewedByName, DateTimeFormatter.dateTime(p.reviewedAt!), ?p.reviewNotes].join(' · ')),
              if (p.approvedAt != null) InfoRow('Approved', [?p.approvedByName, DateTimeFormatter.dateTime(p.approvedAt!)].join(' · ')),
              if (p.paidAt != null)
                InfoRow('Paid', [?p.paidByName, ?p.paidFromAccountName, DateTimeFormatter.date(p.paidAt!), ?p.financialTransactionNumber].join(' · ')),
              if (p.lockedAt != null) InfoRow('Locked', DateTimeFormatter.dateTime(p.lockedAt!)),
              if (p.correctionCount > 0) InfoRow('Corrections', '${p.correctionCount} · ${p.lastCorrectionReason ?? ''}'),
              if (p.paymentReversalReason != null) InfoRow('Payment reversed', p.paymentReversalReason),
              if (p.cancelReason != null) InfoRow('Cancelled', p.cancelReason),
            ]),
            const SizedBox(height: AppSpacing.sm),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              if (p.canPrepare && (canDo(ref, Permission.payrollPrepare) || canDo(ref, Permission.payrollProcess)))
                FilledButton.icon(
                  key: const Key('prepare-payroll-button'),
                  icon: const Icon(Icons.calculate_outlined),
                  label: Text(p.status == PayrollStatus.draft ? 'Calculate payroll' : 'Recalculate'),
                  onPressed: () async {
                    final r = await actions.preparePayroll(p.payrollId);
                    if (context.mounted) reportResult(context, r, 'Payroll calculated.');
                  },
                ),
              for (final a in p.availableActions)
                if (allowed(a))
                  OutlinedButton(key: Key('payroll-action-${a.key}'), onPressed: () => _act(context, ref, p, a), child: Text(a.label)),
              if (p.canPay && canDo(ref, Permission.payrollPay))
                FilledButton.icon(
                  key: const Key('pay-payroll-button'),
                  icon: const Icon(Icons.payments_outlined),
                  label: Text('Pay ${t.net.format()}'),
                  onPressed: () async {
                    final accountId = t.net.isZero ? null : await choosePayFromAccount(context, ref, amount: t.net, title: 'Pay ${p.payrollNumber}');
                    if ((accountId == null && !t.net.isZero) || !context.mounted) return;
                    final r = await actions.payPayroll(p.payrollId, accountId: accountId ?? '', requestId: newRequestId());
                    if (context.mounted) reportResult(context, r, 'Payroll paid.');
                  },
                ),
              if (p.canLock && canDo(ref, Permission.payrollApprove))
                OutlinedButton(
                  key: const Key('lock-payroll-button'),
                  onPressed: () async {
                    final ok = await showConfirmDialog(context,
                        title: 'Lock ${p.payrollNumber}?', message: 'A locked payroll can no longer be reversed. Later changes go into the next payroll.', confirmLabel: 'Lock');
                    if (!ok || !context.mounted) return;
                    final r = await actions.lockPayroll(p.payrollId);
                    if (context.mounted) reportResult(context, r, 'Payroll locked.');
                  },
                  child: const Text('Lock'),
                ),
              if (p.canCorrect && canDo(ref, Permission.payrollAdjust))
                OutlinedButton(
                  key: const Key('correct-payroll-button'),
                  onPressed: () => _withReason(context, ref,
                      title: 'Correct ${p.payrollNumber}?',
                      message: 'It is recalculated and must be reviewed and approved again. The current version is kept as history.',
                      confirm: 'Correct',
                      run: (reason) => actions.correctPayroll(p.payrollId, reason: reason),
                      done: 'Payroll recalculated.'),
                  child: const Text('Correct'),
                ),
              if (p.canEditEarnings && canDo(ref, Permission.payrollAdjust))
                OutlinedButton(
                  key: const Key('add-earning-button'),
                  onPressed: () => showFormSheet<void>(context, EarningSheet(payroll: p, items: items)),
                  child: const Text('Add earning'),
                ),
              if (p.canReversePayment && canDo(ref, Permission.payrollAdjust))
                OutlinedButton(
                  key: const Key('reverse-payroll-button'),
                  onPressed: () => _withReason(context, ref,
                      title: 'Reverse payment of ${p.payrollNumber}?',
                      message: 'The money returns to the account; allowances and recoveries are undone. The payroll goes back to approved.',
                      confirm: 'Reverse',
                      destructive: true,
                      run: (reason) => actions.reversePayrollPayment(p.payrollId, reason: reason),
                      done: 'Payment reversed.'),
                  child: const Text('Reverse payment'),
                ),
              if (p.canCancel && canDo(ref, Permission.payrollAdjust))
                TextButton(
                  key: const Key('cancel-payroll-button'),
                  onPressed: () => _withReason(context, ref,
                      title: 'Cancel ${p.payrollNumber}?',
                      message: 'The record is kept. The period can then be prepared again.',
                      confirm: 'Cancel payroll',
                      destructive: true,
                      run: (reason) => actions.cancelPayroll(p.payrollId, reason: reason),
                      done: 'Payroll cancelled.'),
                  child: const Text('Cancel payroll'),
                ),
              if (p.financialTransactionId != null && canDo(ref, Permission.financeTransactionsView))
                TextButton(onPressed: () => context.go(AppRoutes.financeTransaction(p.financialTransactionId!)), child: const Text('Open payment')),
            ]),
            if (p.earningEntries.isNotEmpty)
              SectionCard(title: 'Other earnings', icon: Icons.add_card_outlined, children: [
                for (final e in p.earningEntries)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('${e.description} · ${e.amount.format()}'),
                    subtitle: Text([items.where((i) => i.staffUid == e.staffUid).firstOrNull?.staffName ?? e.staffUid, ?e.reason].join(' · ')),
                    trailing: p.canEditEarnings && canDo(ref, Permission.payrollAdjust)
                        ? IconButton(
                            tooltip: 'Remove',
                            icon: const Icon(Icons.close),
                            onPressed: () => _withReason(context, ref,
                                title: 'Remove ${e.description}?',
                                message: 'The payroll is recalculated.',
                                confirm: 'Remove',
                                run: (reason) => actions.removeEarning(p.payrollId, e.entryId, reason: reason),
                                done: 'Earning removed.'),
                          )
                        : null,
                  ),
              ]),
            const SizedBox(height: AppSpacing.sm),
            Text('Employees', style: Theme.of(context).textTheme.titleMedium),
            if (items.isEmpty) const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('Calculate the payroll to see each employee.')),
            for (final i in items)
              Card(
                key: Key('payroll-item-${i.staffUid}'),
                child: ExpansionTile(
                  title: Row(children: [
                    Expanded(child: Text(i.staffName, overflow: TextOverflow.ellipsis)),
                    Text(i.net.format(), key: Key('item-net-${i.staffUid}')),
                  ]),
                  subtitle: Text('${i.itemNumber} · gross ${i.gross.format()} · deductions ${i.totalDeductions.format()}'),
                  children: [Padding(padding: const EdgeInsets.all(AppSpacing.xs), child: PayslipCard(item: i, title: i.staffName))],
                ),
              ),
          ]);
        }(),
      AsyncData() => const EmptyView(icon: Icons.wallet_outlined, title: 'Payroll not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

/// Other authorised earnings (payroll.adjust), with a reason.
class EarningSheet extends ConsumerStatefulWidget {
  const EarningSheet({super.key, required this.payroll, required this.items});
  final PayrollRun payroll;
  final List<PayrollItem> items;

  @override
  ConsumerState<EarningSheet> createState() => _EarningSheetState();
}

class _EarningSheetState extends ConsumerState<EarningSheet> {
  String? _staff;
  final _description = TextEditingController();
  final _amount = TextEditingController();
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_description, _amount, _reason]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(currentUserProvider)?.uid;
    final amount = MoneyField.parse(_amount.text);
    final ready = _staff != null && amount != null && _description.text.trim().isNotEmpty && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Add an earning',
      subtitle: 'Bonus, overtime or another authorised earning. The payroll is recalculated.',
      submitLabel: 'Add',
      submitKey: const Key('submit-earning'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).addEarning(widget.payroll.payrollId,
                  staffUid: _staff!, description: _description.text.trim(), amount: amount, reason: _reason.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        DropdownButtonFormField<String>(
          key: const Key('earning-staff'),
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Employee'),
          items: [for (final i in widget.items) if (i.staffUid != me) DropdownMenuItem(value: i.staffUid, child: Text(i.staffName))],
          onChanged: (v) => setState(() => _staff = v),
        ),
        TextField(key: const Key('earning-description'), controller: _description, maxLength: 120, decoration: const InputDecoration(labelText: 'Description'), onChanged: (_) => setState(() {})),
        MoneyField(controller: _amount, label: 'Amount', fieldKey: const Key('earning-amount'), onChanged: (_) => setState(() {})),
        TextField(key: const Key('earning-reason'), controller: _reason, maxLength: 500, decoration: const InputDecoration(labelText: 'Reason'), onChanged: (_) => setState(() {})),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Salaries
// ---------------------------------------------------------------------------

class _SalariesTab extends ConsumerWidget {
  const _SalariesTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(salaryProfilesProvider)) {
        AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
            if (canDo(ref, Permission.salaryManage))
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.icon(
                  key: const Key('new-salary-button'),
                  icon: const Icon(Icons.add),
                  label: const Text('Set a salary'),
                  onPressed: () => showFormSheet<void>(context, const SalarySheet()),
                ),
              ),
            if (value.isEmpty) const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No salary profiles yet.')),
            for (final s in value)
              Card(
                key: Key('salary-${s.staffUid}'),
                child: ListTile(
                  onTap: () => context.go(AppRoutes.salaryDetail(s.staffUid)),
                  title: Row(children: [
                    Expanded(child: Text(s.staffName, overflow: TextOverflow.ellipsis)),
                    Text(s.basicSalary.format(), style: Theme.of(context).textTheme.titleSmall),
                  ]),
                  subtitle: Text([
                    s.frequency.label,
                    s.allowanceEligible ? 'Allowance ${s.allowanceAmount?.format() ?? 'standard'}' : 'No allowance',
                    if (!s.active) 'Inactive',
                    if (s.effectiveFrom != null) 'from ${DateTimeFormatter.date(s.effectiveFrom!)}',
                  ].join(' · ')),
                ),
              ),
          ]),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

class SalaryDetailScreen extends ConsumerWidget {
  const SalaryDetailScreen({super.key, required this.staffUid});
  final String staffUid;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(salaryProfileProvider(staffUid));
    final me = ref.watch(currentUserProvider)?.uid;
    final history = canDo(ref, Permission.salaryHistoryView) ? ref.watch(salaryHistoryProvider(staffUid)) : null;
    return switch (profile) {
      AsyncData(value: final SalaryVersion s) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
          ScreenHeader(s.staffName, subtitle: 'Salary profile · version ${s.version}', onBack: () => context.go(AppRoutes.payroll)),
          SectionCard(title: 'Current', icon: Icons.badge_outlined, children: [
            MoneyLine('Basic salary', s.basicSalary, emphasis: true, valueKey: const Key('salary-basic')),
            InfoRow('Frequency', s.frequency.label),
            InfoRow('Daily allowance', s.allowanceEligible ? (s.allowanceAmount?.format() ?? 'Standard rate') : 'Not eligible'),
            InfoRow('Status', s.active ? 'Active' : 'Inactive'),
            if (s.effectiveFrom != null) InfoRow('Effective from', DateTimeFormatter.date(s.effectiveFrom!)),
            InfoRow('Notes', s.notes),
          ]),
          if (canDo(ref, Permission.salaryManage) && s.staffUid != me)
            FilledButton.icon(
              key: const Key('change-salary-button'),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('Change salary'),
              onPressed: () => showFormSheet<void>(context, SalarySheet(existing: s)),
            ),
          if (history != null)
            SectionCard(title: 'History', icon: Icons.history, children: [
              switch (history) {
                AsyncData(:final value) => Column(children: [
                    for (final v in value)
                      ListTile(
                        key: Key('salary-version-${v.version}'),
                        contentPadding: EdgeInsets.zero,
                        title: Text('v${v.version} · ${v.basicSalary.format()}${v.active ? '' : ' (inactive)'}'),
                        subtitle: Text([
                          if (v.effectiveFrom != null) 'From ${DateTimeFormatter.date(v.effectiveFrom!)}',
                          if (v.previousBasicSalary != null) 'was ${v.previousBasicSalary!.format()}',
                          ?v.reason,
                          ?v.changedByName,
                        ].join(' · ')),
                      ),
                  ]),
                AsyncError(:final error) => InlineError(ErrorMapper.map(error).message),
                _ => const LinearProgressIndicator(),
              },
            ]),
        ]),
      AsyncData() => const EmptyView(icon: Icons.badge_outlined, title: 'No salary profile'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

/// Sets or changes a salary (salary.manage): always a new effective-dated version.
class SalarySheet extends ConsumerStatefulWidget {
  const SalarySheet({super.key, this.existing});
  final SalaryVersion? existing;

  @override
  ConsumerState<SalarySheet> createState() => _SalarySheetState();
}

class _SalarySheetState extends ConsumerState<SalarySheet> {
  late String? _staff = widget.existing?.staffUid;
  late final _basic = TextEditingController(text: widget.existing?.basicSalary.formatAmount());
  late final _allowance = TextEditingController(text: widget.existing?.allowanceAmount?.formatAmount());
  late PaymentFrequency _frequency = widget.existing?.frequency ?? PaymentFrequency.monthly;
  late bool _eligible = widget.existing?.allowanceEligible ?? true;
  late bool _active = widget.existing?.active ?? true;
  DateTime _from = DateTime.now();
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_basic, _allowance, _reason]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(currentUserProvider)?.uid;
    final basic = MoneyField.parse(_basic.text, allowZero: true);
    final allowance = _allowance.text.trim().isEmpty ? null : MoneyField.parse(_allowance.text);
    final allowanceOk = _allowance.text.trim().isEmpty || allowance != null;
    final change = widget.existing != null;
    final ready = _staff != null && basic != null && allowanceOk && (!change || _reason.text.trim().length >= 3);
    return FormSheet(
      title: change ? 'Change ${widget.existing!.staffName}' : 'Set a salary',
      subtitle: 'Saved as a new version from the effective date. Earlier payrolls are never changed.',
      submitLabel: 'Save',
      submitKey: const Key('submit-salary'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).setSalary(SalaryDraft(
                    staffUid: _staff!,
                    basicSalary: basic,
                    frequency: _frequency,
                    allowanceEligible: _eligible,
                    allowanceAmount: _eligible ? allowance : null,
                    effectiveFrom: _from,
                    active: _active,
                    reason: _reason.text.trim().isEmpty ? null : _reason.text.trim(),
                  ));
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Salary saved.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        if (!change) StaffDropdown(fieldKey: const Key('salary-staff'), value: _staff, exclude: me, onChanged: (v) => setState(() => _staff = v)),
        MoneyField(controller: _basic, label: 'Basic salary', allowZero: true, fieldKey: const Key('salary-basic-field'), onChanged: (_) => setState(() {})),
        SegmentedButton<PaymentFrequency>(
          segments: [for (final f in PaymentFrequency.values) ButtonSegment(value: f, label: Text(f.label))],
          selected: {_frequency},
          onSelectionChanged: (s) => setState(() => _frequency = s.first),
        ),
        SwitchListTile(
          key: const Key('salary-eligible'),
          contentPadding: EdgeInsets.zero,
          title: const Text('Receives the daily allowance'),
          value: _eligible,
          onChanged: (v) => setState(() => _eligible = v),
        ),
        if (_eligible)
          MoneyField(controller: _allowance, label: 'Own daily allowance (blank = standard rate)', fieldKey: const Key('salary-allowance'), onChanged: (_) => setState(() {})),
        SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Active'), value: _active, onChanged: (v) => setState(() => _active = v)),
        DateField(label: 'Effective from', value: _from, first: DateTime(2020), last: DateTime.now().add(const Duration(days: 366)), onChanged: (d) => setState(() => _from = d)),
        TextField(
          key: const Key('salary-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: InputDecoration(labelText: change ? 'Reason for the change' : 'Reason (optional)'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------------

class _DeductionsTab extends ConsumerStatefulWidget {
  const _DeductionsTab();

  @override
  ConsumerState<_DeductionsTab> createState() => _DeductionsTabState();
}

class _DeductionsTabState extends ConsumerState<_DeductionsTab> {
  DeductionStatus? _status;

  @override
  Widget build(BuildContext context) => Column(children: [
        FilterChips<DeductionStatus?>(
          values: const [null, ...DeductionStatus.values],
          selected: _status,
          label: (s) => s?.label ?? 'All',
          keyPrefix: 'deduction-status',
          onSelected: (s) => setState(() => _status = s),
        ),
        if (canDo(ref, Permission.deductionsManage))
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const Key('new-deduction-button'),
                icon: const Icon(Icons.add),
                label: const Text('New salary deduction'),
                onPressed: () => showFormSheet<void>(context, const DeductionSheet()),
              ),
            ),
          ),
        Expanded(
          child: switch (ref.watch(deductionsProvider(_status))) {
            AsyncData(:final value) when value.isEmpty => const EmptyView(icon: Icons.remove_circle_outline, title: 'No deductions'),
            AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                for (final d in value)
                  Card(
                    key: Key('deduction-${d.deductionId}'),
                    child: ListTile(
                      onTap: () => context.go(AppRoutes.deductionDetail(d.deductionId)),
                      title: Text('${d.staffName} · ${d.deductionNumber}'),
                      subtitle: Text('${d.type.label} · remaining ${d.remaining.format()} of ${d.total.format()}'),
                      trailing: DeductionStatusChip(d.status),
                    ),
                  ),
              ]),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]);
}

class DeductionDetailScreen extends ConsumerWidget {
  const DeductionDetailScreen({super.key, required this.deductionId});
  final String deductionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(currentUserProvider)?.uid;
    final actions = ref.read(workforceActionsProvider);
    return switch (ref.watch(deductionProvider(deductionId))) {
      AsyncData(value: final SalaryDeduction d) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
          ScreenHeader(d.deductionNumber, subtitle: '${d.staffName} · ${d.type.label}', onBack: () => context.go(AppRoutes.payroll)),
          Align(alignment: Alignment.centerLeft, child: DeductionStatusChip(d.status)),
          MoneyCard(title: 'Balance', lines: [
            MoneyLine('Total', d.total),
            MoneyLine('Per payroll', d.instalment),
            MoneyLine('Recovered', d.recovered),
            MoneyLine('Remaining', d.remaining, emphasis: true, valueKey: const Key('deduction-remaining')),
          ]),
          SectionCard(title: 'Source and approval', icon: Icons.fact_check_outlined, children: [
            InfoRow('Reason', d.reason),
            InfoRow('Source', d.lossNumber ?? d.reference),
            if (d.startsFrom != null) InfoRow('From', DateTimeFormatter.date(d.startsFrom!)),
            InfoRow('Created by', d.createdByName),
            InfoRow('Approved by', d.approvedByName),
            if (d.rejectionReason != null) InfoRow('Rejected', d.rejectionReason),
            if (d.cancelReason != null) InfoRow('Cancelled', d.cancelReason),
          ]),
          SectionCard(title: 'Applied in payroll', icon: Icons.history, children: [
            if (d.applications.isEmpty) const Text('Not applied yet.'),
            for (final a in d.applications) MoneyLine('${a.payrollNumber} · ${a.periodKey}${a.reversed ? ' (reversed)' : ''}', a.amount),
          ]),
          Wrap(spacing: AppSpacing.xs, children: [
            if (d.status == DeductionStatus.pendingApproval && d.staffUid != me && canDo(ref, Permission.payrollApprove)) ...[
              FilledButton(
                key: const Key('approve-deduction-button'),
                onPressed: () async {
                  final r = await actions.decideDeduction(d.deductionId, approve: true);
                  if (context.mounted) reportResult(context, r, 'Deduction approved.');
                },
                child: const Text('Approve'),
              ),
              OutlinedButton(
                key: const Key('reject-deduction-button'),
                onPressed: () async {
                  final reason = await showReasonDialog(context, title: 'Reject ${d.deductionNumber}?', message: 'Say why.', confirmLabel: 'Reject', destructive: true);
                  if (reason == null || !context.mounted) return;
                  final r = await actions.decideDeduction(d.deductionId, approve: false, reason: reason);
                  if (context.mounted) reportResult(context, r, 'Deduction rejected.');
                },
                child: const Text('Reject'),
              ),
            ],
            if ((d.status == DeductionStatus.active || d.status == DeductionStatus.pendingApproval) &&
                canDo(ref, d.type == DeductionType.lossRecovery ? Permission.lossesAdjust : Permission.deductionsManage))
              TextButton(
                key: const Key('cancel-deduction-button'),
                onPressed: () async {
                  final reason = await showReasonDialog(context,
                      title: 'Stop ${d.deductionNumber}?', message: 'Nothing more is deducted. What was recovered stays recorded.', confirmLabel: 'Stop', destructive: true);
                  if (reason == null || !context.mounted) return;
                  final r = await actions.cancelDeduction(d.deductionId, reason: reason);
                  if (context.mounted) reportResult(context, r, 'Deduction stopped.');
                },
                child: const Text('Stop deduction'),
              ),
          ]),
        ]),
      AsyncData() => const EmptyView(icon: Icons.remove_circle_outline, title: 'Deduction not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

/// An authorised salary deduction (deductions.manage), with its source; it
/// applies only after approval (payroll.approve).
class DeductionSheet extends ConsumerStatefulWidget {
  const DeductionSheet({super.key});

  @override
  ConsumerState<DeductionSheet> createState() => _DeductionSheetState();
}

class _DeductionSheetState extends ConsumerState<DeductionSheet> {
  String? _staff;
  DeductionType _type = DeductionType.authorizedDeduction;
  final _total = TextEditingController();
  final _instalment = TextEditingController();
  final _reason = TextEditingController();
  final _reference = TextEditingController();
  DateTime _start = DateTime.now();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_total, _instalment, _reason, _reference]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(currentUserProvider)?.uid;
    final total = MoneyField.parse(_total.text);
    final instalment = _instalment.text.trim().isEmpty ? total : MoneyField.parse(_instalment.text);
    final instalmentError = instalment != null && total != null && instalment > total ? 'Cannot exceed the total' : null;
    final ready = _staff != null && total != null && instalment != null && instalmentError == null &&
        _reason.text.trim().length >= 3 && _reference.text.trim().isNotEmpty;
    return FormSheet(
      title: 'New salary deduction',
      subtitle: 'Takes effect only once approved. Loss recoveries are scheduled from their incident.',
      submitLabel: 'Submit for approval',
      submitKey: const Key('submit-deduction'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).createDeduction(
                    staffUid: _staff!, type: _type, total: total, instalment: instalment, reason: _reason.text.trim(),
                    reference: _reference.text.trim(), startDate: _start, requestId: _requestId);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Deduction submitted for approval.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        StaffDropdown(fieldKey: const Key('deduction-staff'), value: _staff, exclude: me, onChanged: (v) => setState(() => _staff = v)),
        SegmentedButton<DeductionType>(
          segments: [
            for (final t in [DeductionType.authorizedDeduction, DeductionType.other]) ButtonSegment(value: t, label: Text(t.label)),
          ],
          selected: {_type},
          onSelectionChanged: (s) => setState(() => _type = s.first),
        ),
        MoneyField(controller: _total, label: 'Total amount', fieldKey: const Key('deduction-total'), onChanged: (_) => setState(() {})),
        MoneyField(
          controller: _instalment,
          label: 'Per payroll (blank = all at once)',
          fieldKey: const Key('deduction-instalment'),
          errorText: instalmentError,
          onChanged: (_) => setState(() {}),
        ),
        DateField(label: 'First payroll from', value: _start, last: DateTime.now().add(const Duration(days: 400)), onChanged: (d) => setState(() => _start = d)),
        TextField(key: const Key('deduction-reason'), controller: _reason, maxLength: 500, decoration: const InputDecoration(labelText: 'Reason'), onChanged: (_) => setState(() {})),
        TextField(
          key: const Key('deduction-reference'),
          controller: _reference,
          maxLength: 80,
          decoration: const InputDecoration(labelText: 'Source (e.g. signed agreement number)'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

class PolicyTab extends ConsumerWidget {
  const PolicyTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(workforcePolicyProvider).value ?? WorkforcePolicy.defaults;
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      SectionCard(title: 'Attendance', icon: Icons.how_to_reg_outlined, children: [
        InfoRow('Reporting time', p.reportingTime),
        InfoRow('Grace period', '${p.gracePeriodMinutes} minutes'),
        InfoRow('Late threshold', '${p.lateThresholdMinutes} minutes (severely late beyond)'),
        InfoRow('Working days', [for (final d in p.workingDays) WorkforcePolicy.weekdayNames[d - 1]].join(', ')),
        InfoRow('Clock-out required', p.requireClockOut ? 'Yes' : 'No'),
      ]),
      SectionCard(title: 'Daily allowance', icon: Icons.savings_outlined, children: [
        MoneyLine('Default per eligible day', p.defaultDailyAllowance, valueKey: const Key('policy-allowance')),
        InfoRow('Eligible by default', p.allowanceEligibleRoles.join(', ')),
        InfoRow('Late arrivals', p.lateAllowancePolicy.label),
        MoneyLine('Late deduction', p.lateDeduction),
        MoneyLine('Maximum deduction', p.maxLateDeduction),
        InfoRow('Approval required', p.allowanceApprovalRequired ? 'Yes' : 'No (on-time days approve automatically)'),
        InfoRow('Non-working days', p.allowanceOnNonWorkingDays ? 'Earn an allowance' : 'No allowance'),
      ]),
      SectionCard(title: 'Payroll', icon: Icons.wallet_outlined, children: [
        InfoRow('Deduction limit', '${p.maxDeductionPercentOfGross}% of gross pay'),
        InfoRow('Approval', p.payrollRequiresAdminApproval ? 'Administrator only' : 'Any holder of payroll approval'),
      ]),
      if (canDo(ref, Permission.settingsManage))
        FilledButton.icon(
          key: const Key('edit-policy-button'),
          icon: const Icon(Icons.edit_outlined),
          label: const Text('Change policy'),
          onPressed: () => showFormSheet<void>(context, PolicySheet(policy: p)),
        ),
    ]);
  }
}

class PolicySheet extends ConsumerStatefulWidget {
  const PolicySheet({super.key, required this.policy});
  final WorkforcePolicy policy;

  @override
  ConsumerState<PolicySheet> createState() => _PolicySheetState();
}

class _PolicySheetState extends ConsumerState<PolicySheet> {
  late final _time = TextEditingController(text: widget.policy.reportingTime);
  late final _grace = TextEditingController(text: '${widget.policy.gracePeriodMinutes}');
  late final _allowance = TextEditingController(text: widget.policy.defaultDailyAllowance.formatAmount());
  late final _lateDeduction = TextEditingController(text: widget.policy.lateDeduction.formatAmount());
  late final _maxDeduction = TextEditingController(text: widget.policy.maxLateDeduction.formatAmount());
  late final _cap = TextEditingController(text: '${widget.policy.maxDeductionPercentOfGross}');
  late LatePolicy _late = widget.policy.lateAllowancePolicy;
  late bool _approval = widget.policy.allowanceApprovalRequired;
  late bool _adminApproval = widget.policy.payrollRequiresAdminApproval;
  late final Set<int> _days = {...widget.policy.workingDays};
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_time, _grace, _allowance, _lateDeduction, _maxDeduction, _cap, _reason]) {
      c.dispose();
    }
    super.dispose();
  }

  Map<String, Object?> _changes() {
    final p = widget.policy;
    final out = <String, Object?>{};
    void put(String key, Object? now, Object? was) {
      if (now != null && now != was) out[key] = now;
    }

    put('reportingTime', _time.text.trim(), p.reportingTime);
    put('gracePeriodMinutes', int.tryParse(_grace.text.trim()), p.gracePeriodMinutes);
    put('defaultDailyAllowanceUgx', MoneyField.parse(_allowance.text, allowZero: true)?.ugx, p.defaultDailyAllowance.ugx);
    put('lateDeductionUgx', MoneyField.parse(_lateDeduction.text, allowZero: true)?.ugx, p.lateDeduction.ugx);
    put('maxLateDeductionUgx', MoneyField.parse(_maxDeduction.text, allowZero: true)?.ugx, p.maxLateDeduction.ugx);
    put('maxDeductionPercentOfGross', int.tryParse(_cap.text.trim()), p.maxDeductionPercentOfGross);
    put('lateAllowancePolicy', _late.key, p.lateAllowancePolicy.key);
    put('allowanceApprovalRequired', _approval, p.allowanceApprovalRequired);
    put('payrollRequiresAdminApproval', _adminApproval, p.payrollRequiresAdminApproval);
    final days = (_days.toList()..sort());
    if (days.join(',') != p.workingDays.join(',')) out['workingDays'] = days;
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final changes = _changes();
    final ready = changes.isNotEmpty && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Attendance, allowance and payroll policy',
      subtitle: 'Applies to new records. Existing records keep the rules they were made with.',
      submitLabel: 'Save policy',
      submitKey: const Key('submit-policy'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).updatePolicy(changes, reason: _reason.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Policy saved.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        TextField(key: const Key('policy-time'), controller: _time, decoration: const InputDecoration(labelText: 'Reporting time (HH:MM)'), onChanged: (_) => setState(() {})),
        TextField(key: const Key('policy-grace'), controller: _grace, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Grace period (minutes)'), onChanged: (_) => setState(() {})),
        Wrap(spacing: AppSpacing.xxs, children: [
          for (var d = 1; d <= 7; d++)
            FilterChip(
              label: Text(WorkforcePolicy.weekdayNames[d - 1]),
              selected: _days.contains(d),
              onSelected: (on) => setState(() => on ? _days.add(d) : _days.remove(d)),
            ),
        ]),
        MoneyField(controller: _allowance, allowZero: true, label: 'Default daily allowance', fieldKey: const Key('policy-allowance-field'), onChanged: (_) => setState(() {})),
        SegmentedButton<LatePolicy>(
          segments: [for (final l in LatePolicy.values) ButtonSegment(value: l, label: Text(l.label))],
          selected: {_late},
          onSelectionChanged: (s) => setState(() => _late = s.first),
        ),
        MoneyField(controller: _lateDeduction, allowZero: true, label: 'Late deduction', onChanged: (_) => setState(() {})),
        MoneyField(controller: _maxDeduction, allowZero: true, label: 'Maximum late deduction', onChanged: (_) => setState(() {})),
        SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Allowances need approval'), value: _approval, onChanged: (v) => setState(() => _approval = v)),
        TextField(controller: _cap, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Deductions limited to % of gross pay'), onChanged: (_) => setState(() {})),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Only an Administrator approves payroll'),
          value: _adminApproval,
          onChanged: (v) => setState(() => _adminApproval = v),
        ),
        TextField(key: const Key('policy-reason'), controller: _reason, maxLength: 500, decoration: const InputDecoration(labelText: 'Reason for the change'), onChanged: (_) => setState(() {})),
      ],
    );
  }
}
