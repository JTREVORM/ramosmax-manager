import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/shareholding.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../payroll/presentation/workforce_widgets.dart' show choosePayFromAccount;
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/shareholders_providers.dart';
import '../data/shareholders_api.dart';
import 'shareholder_widgets.dart';

/// Dividends: declarations (draft → declared → approved → paid), reports and the policy.
class DividendsScreen extends ConsumerWidget {
  const DividendsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    const tabs = <(String, Widget)>[
      ('Declarations', _DeclarationsTab()),
      ('Reports', DividendReportsTab()),
      ('Policy', _DividendPolicyTab()),
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

class _DeclarationsTab extends ConsumerStatefulWidget {
  const _DeclarationsTab();

  @override
  ConsumerState<_DeclarationsTab> createState() => _DeclarationsTabState();
}

class _DeclarationsTabState extends ConsumerState<_DeclarationsTab> {
  DividendStatus? _status;

  @override
  Widget build(BuildContext context) => Scaffold(
        floatingActionButton: canDo(ref, Permission.dividendsCreate)
            ? FloatingActionButton.extended(
                key: const Key('new-dividend-button'),
                onPressed: () => showFormSheet<void>(context, const DividendFormSheet()),
                icon: const Icon(Icons.add),
                label: const Text('New dividend'),
              )
            : null,
        body: Column(children: [
          FilterChips<DividendStatus?>(
            values: const [null, ...DividendStatus.values],
            selected: _status,
            label: (s) => s?.label ?? 'All',
            keyPrefix: 'dividend-status',
            onSelected: (s) => setState(() => _status = s),
          ),
          Expanded(
            child: switch (ref.watch(dividendsProvider)) {
              AsyncData(:final value) => () {
                  final list = value.where((d) => _status == null || d.status == _status).toList();
                  if (list.isEmpty) return const EmptyView(icon: Icons.pie_chart_outline, title: 'No dividends');
                  return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                    for (final d in list) DividendTile(dividend: d),
                  ]);
                }(),
              AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
              _ => const LoadingView(),
            },
          ),
        ]),
      );
}

class DividendTile extends StatelessWidget {
  const DividendTile({super.key, required this.dividend});
  final Dividend dividend;

  @override
  Widget build(BuildContext context) {
    final d = dividend;
    return Card(
      key: Key('dividend-${d.dividendId}'),
      child: ListTile(
        onTap: () => context.go(AppRoutes.dividendDetail(d.dividendId)),
        title: Row(children: [
          Expanded(child: Text('${d.dividendNumber} · ${d.financialPeriod}', overflow: TextOverflow.ellipsis)),
          Text((d.isCalculated ? d.allocated : d.totalDistributable ?? Money.zero).format(), style: Theme.of(context).textTheme.titleSmall),
        ]),
        subtitle: Wrap(spacing: AppSpacing.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text([
            if (d.recordDate != null) 'record ${DateTimeFormatter.date(d.recordDate!)}',
            if (d.paid.isPositive) 'paid ${d.paid.format()}',
          ].join(' · ')),
          DividendStatusChip(d.status),
        ]),
      ),
    );
  }
}

/// Declared / approved / paid / outstanding, by period (record-date year).
class DividendReportsTab extends ConsumerStatefulWidget {
  const DividendReportsTab({super.key});

  @override
  ConsumerState<DividendReportsTab> createState() => _DividendReportsTabState();
}

class _DividendReportsTabState extends ConsumerState<DividendReportsTab> {
  int? _year;

  @override
  Widget build(BuildContext context) => switch (ref.watch(dividendsProvider)) {
        AsyncData(:final value) => () {
            final years = {for (final d in value) if (d.recordDate != null) EastAfricaTime.toEat(d.recordDate!).year}.toList()..sort((a, b) => b - a);
            final list = value.where((d) => _year == null || (d.recordDate != null && EastAfricaTime.toEat(d.recordDate!).year == _year)).toList();
            final t = DividendTotals.of(list);
            return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96), children: [
              FilterChips<int?>(
                values: [null, ...years],
                selected: _year,
                label: (y) => y?.toString() ?? 'All years',
                keyPrefix: 'dividend-year',
                onSelected: (y) => setState(() => _year = y),
              ),
              MoneyCard(title: 'Dividend distribution', lines: [
                MoneyLine('Declared', t.declared, valueKey: const Key('div-report-declared')),
                MoneyLine('Approved', t.approved),
                MoneyLine('Paid', t.paid, valueKey: const Key('div-report-paid')),
                MoneyLine('Outstanding (approved, unpaid)', t.outstanding, emphasis: true, valueKey: const Key('div-report-outstanding')),
              ], footer: 'Distributions to shareholders - not operating expenses. Amounts are what the business approved; RamosMAX does not '
                  'calculate profit, tax or deductions.'),
              SectionCard(title: 'Dividend history', icon: Icons.history, children: [
                if (list.isEmpty) const Text('No dividends in this period.'),
                for (final d in list)
                  InfoRow(d.dividendNumber, [
                    d.financialPeriod,
                    d.status.label,
                    'pool ${(d.totalDistributable ?? Money.zero).format()}',
                    'per share ${d.perShareLabel}',
                    'paid ${d.paid.format()} of ${d.allocated.format()}',
                  ].join(' · ')),
              ]),
            ]);
          }(),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

class _DividendPolicyTab extends ConsumerWidget {
  const _DividendPolicyTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(dividendPolicyProvider).value ?? const DividendPolicy();
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      SwitchListTile(
        key: const Key('dividend-policy-admin'),
        title: const Text('Administrator approval'),
        subtitle: const Text('Only an Administrator approves dividends. Otherwise any holder of dividend approval other than the declarer.'),
        value: p.requireAdminApproval,
        onChanged: canDo(ref, Permission.settingsManage)
            ? (v) async {
                final reason = await showReasonDialog(context, title: 'Change the dividend policy?', message: 'Record the decision.', confirmLabel: 'Save');
                if (reason == null || !context.mounted) return;
                final r = await ref.read(shareholderActionsProvider).updatePolicy('dividend', {'requireAdminApproval': v}, reason: reason);
                if (context.mounted) reportResult(context, r, 'Dividend policy updated.');
              }
            : null,
      ),
      Text('Eligibility is ownership at the end of the record date. No withholding tax or other deduction is applied unless the business '
          'configures one after legal review.', style: Theme.of(context).textTheme.bodySmall),
    ]);
  }
}

/// Create or edit a draft declaration.
class DividendFormSheet extends ConsumerStatefulWidget {
  const DividendFormSheet({super.key, this.existing});
  final Dividend? existing;

  @override
  ConsumerState<DividendFormSheet> createState() => _DividendFormSheetState();
}

class _DividendFormSheetState extends ConsumerState<DividendFormSheet> {
  late final _period = TextEditingController(text: widget.existing?.financialPeriod ?? '');
  late final _amount = TextEditingController(text: widget.existing?.totalDistributable?.formatAmount() ?? '');
  late final _perShare = TextEditingController(
      text: widget.existing?.method == DividendMethod.perShare ? widget.existing?.dividendPerShare?.round().toString() ?? '' : '');
  late final _notes = TextEditingController(text: widget.existing?.notes ?? '');
  late DividendMethod _method = widget.existing?.method ?? DividendMethod.pool;
  late DateTime _declaration = widget.existing?.declarationDate ?? DateTime.now();
  late DateTime _record = widget.existing?.recordDate ?? DateTime.now();
  late DateTime? _payment = widget.existing?.paymentDate;
  late String? _classId = widget.existing?.classId;
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_period, _amount, _perShare, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pool = MoneyField.parse(_amount.text);
    final perShare = MoneyField.parse(_perShare.text);
    final ready = _period.text.trim().isNotEmpty && (_method == DividendMethod.pool ? pool != null : perShare != null);
    final later = DateTime.now().add(const Duration(days: 366));
    return FormSheet(
      title: widget.existing == null ? 'New dividend' : 'Edit ${widget.existing!.dividendNumber}',
      subtitle: 'Enter the amount the business has approved for distribution. Allocations are calculated by the server from ownership '
          'at the end of the record date.',
      submitLabel: 'Save draft',
      submitKey: const Key('submit-dividend'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final draft = DividendDraft(
                financialPeriod: _period.text.trim(),
                recordDate: _record,
                declarationDate: _declaration,
                paymentDate: _payment,
                method: _method,
                totalDistributable: pool,
                perShare: perShare,
                classId: _classId,
                notes: _notes.text.trim().isEmpty ? null : _notes.text.trim(),
              );
              final actions = ref.read(shareholderActionsProvider);
              final Result<Object?> r = widget.existing == null
                  ? await actions.createDividend(draft, requestId: _requestId)
                  : await actions.updateDividend(widget.existing!.dividendId, draft);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (id) {
                  Navigator.of(context).pop();
                  if (id is String) context.go(AppRoutes.dividendDetail(id));
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        TextField(key: const Key('dividend-period'), controller: _period, maxLength: 60,
            decoration: const InputDecoration(labelText: 'Financial period (e.g. FY 2026)'), onChanged: (_) => setState(() {})),
        SegmentedButton<DividendMethod>(
          segments: [for (final m in DividendMethod.values) ButtonSegment(value: m, label: Text(m == DividendMethod.pool ? 'Total amount' : 'Per share'))],
          selected: {_method},
          onSelectionChanged: (v) => setState(() => _method = v.first),
        ),
        if (_method == DividendMethod.pool)
          MoneyField(controller: _amount, label: 'Total distributable amount', fieldKey: const Key('dividend-pool'), onChanged: (_) => setState(() {}))
        else
          MoneyField(controller: _perShare, label: 'Dividend per share', fieldKey: const Key('dividend-per-share'), onChanged: (_) => setState(() {})),
        ShareClassDropdown(value: _classId, includeInactive: true, allowAll: true, onChanged: (v) => setState(() => _classId = v)),
        DateField(label: 'Declaration date', value: _declaration, last: later, onChanged: (d) => setState(() => _declaration = d)),
        DateField(fieldKey: const Key('dividend-record-date'), label: 'Record date (eligibility)', value: _record, last: later,
            onChanged: (d) => setState(() => _record = d)),
        DateField(label: 'Planned payment date', value: _payment ?? _record, first: _record, last: later, onChanged: (d) => setState(() => _payment = d)),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes (e.g. board resolution)')),
      ],
    );
  }
}

/// One dividend: figures, workflow actions, allocations and payments.
class DividendDetailScreen extends ConsumerStatefulWidget {
  const DividendDetailScreen({super.key, required this.dividendId});
  final String dividendId;

  @override
  ConsumerState<DividendDetailScreen> createState() => _DividendDetailScreenState();
}

class _DividendDetailScreenState extends ConsumerState<DividendDetailScreen> {
  final Set<String> _selected = {};

  Future<void> _act(Future<Result<void>> Function() call, String done) async {
    final r = await call();
    if (mounted) reportResult(context, r, done);
  }

  Future<void> _pay(Dividend d, List<DividendAllocation> allocations) async {
    final chosen = allocations.where((a) => _selected.contains(a.allocationId)).toList();
    final total = Money.sum(chosen.map((a) => a.net));
    final accountId = await choosePayFromAccount(context, ref, amount: total, title: 'Pay dividends');
    if (accountId == null || !mounted) return;
    final r = await ref.read(shareholderActionsProvider).payDividend(d.dividendId, [for (final a in chosen) a.allocationId],
        accountId: accountId, requestId: newRequestId(), paymentDate: DateTime.now());
    if (!mounted) return;
    if (reportResult(context, r, 'Paid ${total.format()}.')) setState(_selected.clear);
  }

  @override
  Widget build(BuildContext context) {
    final actions = ref.read(shareholderActionsProvider);
    return switch (ref.watch(dividendProvider(widget.dividendId))) {
      AsyncData(value: final Dividend d) => () {
          final allocations = canDo(ref, Permission.dividendsView)
              ? ref.watch(allocationsProvider(d.dividendId)).value ?? const <DividendAllocation>[]
              : const <DividendAllocation>[];
          final canPay = d.status.isPayable && canDo(ref, Permission.dividendsPay);
          final unpaid = allocations.where((a) => a.isUnpaid).toList();
          return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
            ScreenHeader(d.dividendNumber, subtitle: d.financialPeriod, onBack: () => context.go(AppRoutes.dividends)),
            Align(alignment: Alignment.centerLeft, child: DividendStatusChip(d.status)),
            SectionCard(title: 'Declaration', icon: Icons.gavel_outlined, children: [
              InfoRow('Method', d.method.label),
              if (d.totalDistributable != null) MoneyLine('Distributable amount', d.totalDistributable!),
              InfoRow('Per share', d.perShareLabel),
              InfoRow('Share class', d.classCode ?? 'All classes'),
              if (d.declarationDate != null) InfoRow('Declared on', DateTimeFormatter.date(d.declarationDate!)),
              if (d.recordDate != null) InfoRow('Record date', DateTimeFormatter.date(d.recordDate!)),
              if (d.paymentDate != null) InfoRow('Planned payment', DateTimeFormatter.date(d.paymentDate!)),
              InfoRow('Created by', d.createdByName),
              InfoRow('Declared by', d.declaredByName),
              InfoRow('Approved by', d.approvedByName),
              if (d.returnedReason != null) InfoRow('Returned', d.returnedReason),
              if (d.cancelReason != null) InfoRow('Cancelled', d.cancelReason),
              InfoRow('Notes', d.notes),
            ]),
            SectionCard(title: 'Allocation', icon: Icons.pie_chart_outline, children: [
              if (!d.isCalculated) const Text('Not calculated yet. Calculate once the record date has passed.')
              else ...[
                InfoRow('Eligible shares', formatShares(d.eligibleShares)),
                InfoRow('Shareholders', '${d.eligibleShareholderCount}'),
                MoneyLine('Allocated', d.allocated, valueKey: const Key('dividend-allocated')),
                if (d.unallocated.isPositive) MoneyLine('Not allocated (rounding)', d.unallocated),
                MoneyLine('Paid', d.paid, valueKey: const Key('dividend-paid')),
                MoneyLine('Outstanding', d.outstanding, emphasis: true, valueKey: const Key('dividend-outstanding')),
              ],
            ]),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              if (d.status == DividendStatus.draft && canDo(ref, Permission.dividendsCreate))
                OutlinedButton(key: const Key('edit-dividend'), onPressed: () => showFormSheet<void>(context, DividendFormSheet(existing: d)), child: const Text('Edit')),
              if (d.status == DividendStatus.draft && canDo(ref, Permission.dividendsCalculate))
                FilledButton(
                  key: const Key('calculate-dividend'),
                  onPressed: () => _act(() => actions.calculateDividend(d.dividendId), 'Allocations calculated.'),
                  child: Text(d.isCalculated ? 'Recalculate' : 'Calculate allocations'),
                ),
              if (d.status == DividendStatus.draft && d.isCalculated && canDo(ref, Permission.dividendsDeclare))
                FilledButton(
                  key: const Key('declare-dividend'),
                  onPressed: () async {
                    final ok = await showConfirmDialog(context, title: 'Declare ${d.dividendNumber}?',
                        message: '${d.allocated.format()} to ${d.eligibleShareholderCount} shareholders. It then needs approval.', confirmLabel: 'Declare');
                    if (ok) await _act(() => actions.dividendAction(d.dividendId, DividendAction.declare), 'Declared.');
                  },
                  child: const Text('Declare'),
                ),
              if (d.status == DividendStatus.declared && canDo(ref, Permission.dividendsApprove)) ...[
                FilledButton(
                  key: const Key('approve-dividend'),
                  onPressed: () async {
                    final ok = await showConfirmDialog(context, title: 'Approve ${d.dividendNumber}?', message: 'It can then be paid.', confirmLabel: 'Approve');
                    if (ok) await _act(() => actions.dividendAction(d.dividendId, DividendAction.approve), 'Approved.');
                  },
                  child: const Text('Approve'),
                ),
                OutlinedButton(
                  key: const Key('return-dividend'),
                  onPressed: () async {
                    final reason = await showReasonDialog(context, title: 'Return to draft?', message: 'Say what needs changing.', confirmLabel: 'Return');
                    if (reason != null) await _act(() => actions.dividendAction(d.dividendId, DividendAction.returnToDraft, reason: reason), 'Returned to draft.');
                  },
                  child: const Text('Return'),
                ),
              ],
              if (canPay && unpaid.isNotEmpty)
                OutlinedButton(
                  key: const Key('select-all-unpaid'),
                  onPressed: () => setState(() => _selected
                    ..clear()
                    ..addAll(unpaid.map((a) => a.allocationId))),
                  child: const Text('Select all unpaid'),
                ),
              if (canPay && _selected.isNotEmpty)
                FilledButton(
                  key: const Key('pay-dividend'),
                  onPressed: () => _pay(d, allocations),
                  child: Text('Pay ${_selected.length} selected'),
                ),
              if ({DividendStatus.draft, DividendStatus.declared, DividendStatus.approved}.contains(d.status) && canDo(ref, Permission.dividendsAdjust))
                TextButton(
                  key: const Key('cancel-dividend'),
                  onPressed: () async {
                    final reason = await showReasonDialog(context, title: 'Cancel ${d.dividendNumber}?',
                        message: 'Nothing has been paid. The declaration and allocations are kept, marked cancelled.', confirmLabel: 'Cancel dividend', destructive: true);
                    if (reason != null) await _act(() => actions.cancelDividend(d.dividendId, reason: reason), 'Dividend cancelled.');
                  },
                  child: const Text('Cancel dividend'),
                ),
            ]),
            if (canDo(ref, Permission.dividendsView))
              SectionCard(title: 'Allocations (ownership at the record date)', icon: Icons.people_outline, children: [
                if (allocations.isEmpty) const Text('No allocations.'),
                for (final a in allocations)
                  _AllocationRow(
                    allocation: a,
                    selectable: canPay && a.isUnpaid,
                    selected: _selected.contains(a.allocationId),
                    onSelect: (v) => setState(() => v ? _selected.add(a.allocationId) : _selected.remove(a.allocationId)),
                    canReverse: a.isPaid && canDo(ref, Permission.dividendsAdjust),
                  ),
              ]),
          ]);
        }(),
      AsyncData() => const EmptyView(icon: Icons.pie_chart_outline, title: 'Dividend not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class _AllocationRow extends ConsumerWidget {
  const _AllocationRow({required this.allocation, required this.selectable, required this.selected, required this.onSelect, required this.canReverse});
  final DividendAllocation allocation;
  final bool selectable;
  final bool selected;
  final ValueChanged<bool> onSelect;
  final bool canReverse;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = allocation;
    return ListTile(
      key: Key('allocation-${a.allocationId}'),
      contentPadding: EdgeInsets.zero,
      leading: selectable ? Checkbox(key: Key('select-allocation-${a.allocationId}'), value: selected, onChanged: (v) => onSelect(v ?? false)) : null,
      title: Row(children: [
        Expanded(child: Text(a.shareholderName, overflow: TextOverflow.ellipsis)),
        Text(a.net.format(), key: Key('allocation-net-${a.allocationId}'), style: Theme.of(context).textTheme.titleSmall),
      ]),
      subtitle: Text([
        a.allocationNumber,
        '${formatShares(a.sharesAtRecordDate)} shares (${formatPercent(a.ownershipPercentAtRecordDate)})',
        if (a.deductions.isPositive) 'deductions ${a.deductions.format()}',
        if (a.isPaid) 'Paid${a.paidAt == null ? '' : ' ${DateTimeFormatter.date(a.paidAt!)}'} · ${a.accountName ?? ''}'
        else if (a.paymentStatus == 'not_payable') 'Nothing to pay'
        else 'Unpaid',
        if (a.reversalCount > 0) '${a.reversalCount} payment reversal(s)',
      ].join(' · ')),
      trailing: canReverse
          ? IconButton(
              key: Key('reverse-allocation-${a.allocationId}'),
              tooltip: 'Reverse payment',
              icon: const Icon(Icons.undo),
              onPressed: () async {
                final reason = await showReasonDialog(context,
                    title: 'Reverse the payment to ${a.shareholderName}?',
                    message: '${a.net.format()} returns to ${a.accountName ?? 'the account'}; the original entry stays, marked reversed.',
                    confirmLabel: 'Reverse',
                    destructive: true);
                if (reason == null || !context.mounted) return;
                final r = await ref.read(shareholderActionsProvider).reverseDividendPayment(a.allocationId, reason: reason);
                if (context.mounted) reportResult(context, r, 'Payment reversed.');
              },
            )
          : null,
    );
  }
}
