import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/finance.dart';
import '../../../models/shareholding.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/application/finance_providers.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/shareholders_providers.dart';
import '../data/shareholders_api.dart';
import 'shareholder_widgets.dart';

enum _TxnFilter {
  pending('Pending approval'),
  all('All'),
  issues('Issues'),
  transfers('Transfers'),
  adjustments('Adjustments'),
  reversals('Reversals');

  const _TxnFilter(this.label);
  final String label;

  ({ShareTransactionStatus? status, ShareTransactionType? type}) get query => switch (this) {
        pending => (status: ShareTransactionStatus.pendingApproval, type: null),
        all => (status: null, type: null),
        issues => (status: null, type: ShareTransactionType.issued),
        transfers => (status: null, type: ShareTransactionType.transferred),
        adjustments => (status: null, type: ShareTransactionType.adjusted),
        reversals => (status: null, type: ShareTransactionType.reversal),
      };
}

/// Shares: the ownership ledger, classes, contributions and the share policy.
class SharesScreen extends ConsumerWidget {
  const SharesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.sharesView)) return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted');
    const tabs = <(String, Widget)>[
      ('Transactions', _TransactionsTab()),
      ('Share classes', _ClassesTab()),
      ('Contributions', _ContributionsTab()),
      ('Policy', _SharePolicyTab()),
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

class _TransactionsTab extends ConsumerStatefulWidget {
  const _TransactionsTab();

  @override
  ConsumerState<_TransactionsTab> createState() => _TransactionsTabState();
}

class _TransactionsTabState extends ConsumerState<_TransactionsTab> {
  _TxnFilter _filter = _TxnFilter.all;

  Future<void> _new() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          if (canDo(ref, Permission.sharesIssue))
            ListTile(key: const Key('new-issue'), leading: const Icon(Icons.add), title: const Text('Issue shares'), onTap: () => Navigator.pop(context, 'issue')),
          if (canDo(ref, Permission.sharesTransfer))
            ListTile(key: const Key('new-transfer'), leading: const Icon(Icons.swap_horiz), title: const Text('Transfer shares'), onTap: () => Navigator.pop(context, 'transfer')),
          if (canDo(ref, Permission.sharesAdjust))
            ListTile(key: const Key('new-adjustment'), leading: const Icon(Icons.tune), title: const Text('Adjust shares (correction)'), onTap: () => Navigator.pop(context, 'adjust')),
        ]),
      ),
    );
    if (!mounted || choice == null) return;
    await showFormSheet<void>(context, switch (choice) {
      'issue' => const IssueSharesSheet(),
      'transfer' => const TransferSharesSheet(),
      _ => const AdjustSharesSheet(),
    });
  }

  @override
  Widget build(BuildContext context) {
    final canRequest = canDo(ref, Permission.sharesIssue) || canDo(ref, Permission.sharesTransfer) || canDo(ref, Permission.sharesAdjust);
    return Scaffold(
      floatingActionButton: canRequest
          ? FloatingActionButton.extended(key: const Key('new-share-transaction'), onPressed: _new, icon: const Icon(Icons.add), label: const Text('New'))
          : null,
      body: Column(children: [
        FilterChips<_TxnFilter>(
          values: _TxnFilter.values,
          selected: _filter,
          label: (f) => f.label,
          keyPrefix: 'share-txn-filter',
          onSelected: (f) => setState(() => _filter = f),
        ),
        Expanded(
          child: switch (ref.watch(shareTransactionsProvider(_filter.query))) {
            AsyncData(:final value) when value.isEmpty => const EmptyView(icon: Icons.swap_horiz, title: 'No share transactions'),
            AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                for (final t in value) ShareTransactionTile(transaction: t, onTap: () => context.go(AppRoutes.shareTransaction(t.transactionId))),
              ]),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]),
    );
  }
}

class _ClassesTab extends ConsumerWidget {
  const _ClassesTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manage = canDo(ref, Permission.shareholdersManage);
    return Scaffold(
      floatingActionButton: manage
          ? FloatingActionButton.extended(
              key: const Key('new-share-class'),
              onPressed: () => showFormSheet<void>(context, const ShareClassSheet()),
              icon: const Icon(Icons.add),
              label: const Text('Share class'),
            )
          : null,
      body: switch (ref.watch(shareClassesProvider)) {
        AsyncData(:final value) when value.isEmpty => const EmptyView(
            icon: Icons.category_outlined,
            title: 'No share classes yet',
            message: 'Create the class the business issues (e.g. ORDINARY) with its value per share before issuing shares.',
          ),
        AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
            for (final c in value)
              Card(
                key: Key('class-${c.classId}'),
                child: ListTile(
                  onTap: manage ? () => showFormSheet<void>(context, ShareClassSheet(existing: c)) : null,
                  title: Text('${c.code} · ${c.name}'),
                  subtitle: Text('${c.valuePerShare.format()} a share · ${formatShares(c.issuedShares)} issued · received ${c.paid.format()}'
                      '${c.description == null ? '' : '\n${c.description}'}'),
                  trailing: c.active ? null : const StatusChip('Inactive', color: Colors.grey),
                ),
              ),
            Text('Classes carry business figures only; RamosMAX does not model legal rights of a class.', style: Theme.of(context).textTheme.bodySmall),
          ]),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      },
    );
  }
}

class _ContributionsTab extends ConsumerWidget {
  const _ContributionsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(contributionsProvider)) {
        AsyncData(:final value) when value.isEmpty => const EmptyView(icon: Icons.savings_outlined, title: 'No contributions yet'),
        AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
            MoneyLine('Received (listed, excluding reversed)', Money.sum(value.where((c) => !c.reversed).map((c) => c.amount))),
            for (final c in value) ContributionTile(contribution: c, showName: true),
          ]),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

class _SharePolicyTab extends ConsumerWidget {
  const _SharePolicyTab();

  Future<void> _toggle(BuildContext context, WidgetRef ref, String key, bool value) async {
    final reason = await showReasonDialog(context, title: 'Change the share policy?', message: 'Record the decision behind this change.', confirmLabel: 'Save');
    if (reason == null || !context.mounted) return;
    final r = await ref.read(shareholderActionsProvider).updatePolicy('share', {key: value}, reason: reason);
    if (context.mounted) reportResult(context, r, 'Share policy updated.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(sharePolicyProvider).value ?? const SharePolicy();
    final edit = canDo(ref, Permission.settingsManage);
    SwitchListTile row(String key, String title, String subtitle, bool value) => SwitchListTile(
          key: Key('share-policy-$key'),
          title: Text(title),
          subtitle: Text(subtitle),
          value: value,
          onChanged: edit ? (v) => _toggle(context, ref, key, v) : null,
        );
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      row('requireApproval', 'Second-person approval', 'Issues, transfers and adjustments wait for someone with share approval.', p.requireApproval),
      row('allowPartialPayment', 'Part-paid shares', 'Shares may be issued with part of the money still to come.', p.allowPartialPayment),
      row('allowUnpaidShares', 'Unpaid (committed) shares', 'Shares may be issued before any money is received.', p.allowUnpaidShares),
      Text('Unpaid commitments are never counted as cash. Changes need Settings management and are audited.', style: Theme.of(context).textTheme.bodySmall),
    ]);
  }
}

class ContributionTile extends ConsumerWidget {
  const ContributionTile({super.key, required this.contribution, this.showName = false});
  final ShareContribution contribution;
  final bool showName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = contribution;
    return ListTile(
      key: Key('contribution-${c.contributionId}'),
      dense: true,
      contentPadding: EdgeInsets.zero,
      title: Text([c.contributionNumber, if (showName) c.shareholderName].join(' · '),
          style: c.reversed ? const TextStyle(decoration: TextDecoration.lineThrough) : null),
      subtitle: Text([
        c.source == ContributionSource.account ? (c.accountName ?? 'Account') : c.source.label,
        ?c.shareTransactionNumber,
        if (c.paymentDate != null) DateTimeFormatter.date(c.paymentDate!),
        if (c.reversed) 'Reversed: ${c.reversalReason ?? ''}',
      ].join(' · ')),
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        Text(c.amount.format()),
        if (!c.reversed && canDo(ref, Permission.sharesAdjust))
          IconButton(
            key: Key('reverse-contribution-${c.contributionId}'),
            tooltip: 'Reverse',
            icon: const Icon(Icons.undo),
            onPressed: () async {
              final reason = await showReasonDialog(context,
                  title: 'Reverse ${c.contributionNumber}?',
                  message: c.source == ContributionSource.account
                      ? 'The ${c.amount.format()} leaves ${c.accountName ?? 'the account'} again and becomes outstanding. The record stays.'
                      : 'The amount becomes outstanding again. The record stays.',
                  confirmLabel: 'Reverse',
                  destructive: true);
              if (reason == null || !context.mounted) return;
              final r = await ref.read(shareholderActionsProvider).reverseContribution(c.contributionId, reason: reason);
              if (context.mounted) reportResult(context, r, 'Contribution reversed.');
            },
          ),
      ]),
    );
  }
}

/// Create or edit a share class.
class ShareClassSheet extends ConsumerStatefulWidget {
  const ShareClassSheet({super.key, this.existing});
  final ShareClass? existing;

  @override
  ConsumerState<ShareClassSheet> createState() => _ShareClassSheetState();
}

class _ShareClassSheetState extends ConsumerState<ShareClassSheet> {
  late final _code = TextEditingController(text: widget.existing?.code ?? '');
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _value = TextEditingController(text: widget.existing?.valuePerShare.formatAmount() ?? '');
  late final _description = TextEditingController(text: widget.existing?.description ?? '');
  final _reason = TextEditingController();
  late bool _active = widget.existing?.active ?? true;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_code, _name, _value, _description, _reason]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.existing;
    final value = MoneyField.parse(_value.text);
    final changedMoney = e != null && (value != e.valuePerShare || _active != e.active);
    final ready = value != null && _name.text.trim().isNotEmpty && (e != null || _code.text.trim().length >= 2) &&
        (!changedMoney || _reason.text.trim().length >= 3);
    return FormSheet(
      title: e == null ? 'New share class' : 'Share class ${e.code}',
      subtitle: 'A new value per share applies to future issues only; past issues keep theirs.',
      submitLabel: 'Save',
      submitKey: const Key('submit-share-class'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final actions = ref.read(shareholderActionsProvider);
              final desc = _description.text.trim().isEmpty ? null : _description.text.trim();
              final r = e == null
                  ? await actions.createShareClass(code: _code.text.trim().toUpperCase(), name: _name.text.trim(), valuePerShare: value, description: desc)
                  : await actions.updateShareClass(e.classId,
                      name: _name.text.trim() == e.name ? null : _name.text.trim(),
                      valuePerShare: value == e.valuePerShare ? null : value,
                      active: _active == e.active ? null : _active,
                      reason: _reason.text.trim().isEmpty ? null : _reason.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        if (e == null)
          TextField(key: const Key('class-code'), controller: _code, textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Code (e.g. ORDINARY)'), onChanged: (_) => setState(() {})),
        TextField(key: const Key('class-name'), controller: _name, decoration: const InputDecoration(labelText: 'Name'), onChanged: (_) => setState(() {})),
        MoneyField(controller: _value, label: 'Value per share', fieldKey: const Key('class-value'), onChanged: (_) => setState(() {})),
        TextField(controller: _description, maxLength: 300, decoration: const InputDecoration(labelText: 'Description (optional)')),
        if (e != null) SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Active'), value: _active, onChanged: (v) => setState(() => _active = v)),
        if (changedMoney)
          TextField(key: const Key('class-reason'), controller: _reason, decoration: const InputDecoration(labelText: 'Reason'), onChanged: (_) => setState(() {})),
      ],
    );
  }
}

/// Where the money for shares came from, and how much.
class _PaymentFields extends StatelessWidget {
  const _PaymentFields({required this.source, required this.amount, required this.onSource, required this.onChanged, this.allowNone = true});
  final ContributionSource source;
  final TextEditingController amount;
  final ValueChanged<ContributionSource> onSource;
  final VoidCallback onChanged;
  final bool allowNone;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DropdownButtonFormField<ContributionSource>(
          key: const Key('payment-source'),
          initialValue: source,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Payment'),
          items: [
            for (final s in ContributionSource.values)
              if (allowNone || s != ContributionSource.none) DropdownMenuItem(value: s, child: Text(s.label, overflow: TextOverflow.ellipsis)),
          ],
          onChanged: (v) => onSource(v ?? source),
        ),
        if (source != ContributionSource.none) ...[
          const SizedBox(height: AppSpacing.sm),
          MoneyField(controller: amount, label: 'Amount paid', fieldKey: const Key('payment-amount'), onChanged: (_) => onChanged()),
        ],
      ]);
}

/// Issue (sell / allot) shares. The server calculates the commitment.
class IssueSharesSheet extends ConsumerStatefulWidget {
  const IssueSharesSheet({super.key, this.shareholderId});
  final String? shareholderId;

  @override
  ConsumerState<IssueSharesSheet> createState() => _IssueSharesSheetState();
}

class _IssueSharesSheetState extends ConsumerState<IssueSharesSheet> {
  late String? _shareholder = widget.shareholderId;
  String? _classId;
  final _shares = TextEditingController();
  final _amount = TextEditingController();
  final _reference = TextEditingController();
  final _reason = TextEditingController();
  ContributionSource _source = ContributionSource.account;
  DateTime _effective = DateTime.now();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_shares, _amount, _reference, _reason]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit(Money commitment) async {
    final shares = SharesField.parse(_shares.text)!;
    final amount = _source == ContributionSource.none ? Money.zero : MoneyField.parse(_amount.text)!;
    String? accountId;
    if (_source == ContributionSource.account) {
      accountId = await choosePayFromAccountIn(context, ref, amount: amount);
      if (accountId == null || !mounted) return;
    }
    setState(() => _saving = true);
    final r = await ref.read(shareholderActionsProvider).issueShares(
          shareholderId: _shareholder!,
          classId: _classId!,
          shares: shares,
          payment: SharePayment(source: _source, amount: amount, accountId: accountId),
          effectiveDate: _effective,
          requestId: _requestId,
          reference: _reference.text.trim().isEmpty ? null : _reference.text.trim(),
          reason: _reason.text.trim().isEmpty ? null : _reason.text.trim(),
        );
    if (!mounted) return;
    setState(() => _saving = false);
    r.when(
      success: (_) {
        final policy = ref.read(sharePolicyProvider).value ?? const SharePolicy();
        AppSnackbar.success(context, policy.requireApproval ? 'Share issue sent for approval.' : 'Shares issued.');
        Navigator.of(context).pop();
      },
      failure: (f) => setState(() => _error = f.message),
    );
  }

  @override
  Widget build(BuildContext context) {
    final classes = ref.watch(shareClassesProvider).value ?? const <ShareClass>[];
    final cls = classes.where((c) => c.classId == _classId).firstOrNull;
    final shares = SharesField.parse(_shares.text);
    final commitment = cls == null || shares == null ? null : cls.commitmentFor(shares);
    final amount = _source == ContributionSource.none ? Money.zero : MoneyField.parse(_amount.text);
    final amountError = amount != null && commitment != null && amount > commitment ? 'At most ${commitment.format()}' : null;
    final ready = _shareholder != null && commitment != null && amount != null && amountError == null &&
        (_source != ContributionSource.priorRecord || _reason.text.trim().length >= 3);
    return FormSheet(
      title: 'Issue shares',
      subtitle: 'Contribution = shares × value per share, worked out by the server. Share capital is never revenue.',
      submitLabel: 'Issue',
      submitKey: const Key('submit-issue'),
      saving: _saving,
      error: _error,
      onSubmit: !ready ? null : () => _submit(commitment),
      children: [
        if (widget.shareholderId == null)
          ShareholderDropdown(fieldKey: const Key('issue-shareholder'), value: _shareholder, onChanged: (v) => setState(() => _shareholder = v)),
        ShareClassDropdown(fieldKey: const Key('issue-class'), value: _classId, onChanged: (v) => setState(() => _classId = v)),
        SharesField(controller: _shares, label: 'Number of shares', fieldKey: const Key('issue-shares'), onChanged: (_) => setState(() {})),
        if (commitment != null)
          MoneyLine('Contribution (${sharesAndValueText(shares!, cls!.valuePerShare)})', commitment, emphasis: true, valueKey: const Key('issue-commitment')),
        _PaymentFields(
          source: _source,
          amount: _amount,
          onSource: (s) => setState(() {
            _source = s;
            if (commitment != null && _amount.text.isEmpty) _amount.text = commitment.formatAmount();
          }),
          onChanged: () => setState(() {}),
        ),
        if (amountError != null) Text(amountError, style: const TextStyle(color: AppColors.danger)),
        DateField(label: 'Effective date', value: _effective, onChanged: (d) => setState(() => _effective = d)),
        TextField(controller: _reference, maxLength: 60, decoration: const InputDecoration(labelText: 'Reference (certificate, receipt…)')),
        TextField(
          key: const Key('issue-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: InputDecoration(labelText: _source == ContributionSource.priorRecord ? 'Reason / evidence of the earlier payment' : 'Notes / reason (optional)'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}

/// `100 × UGX 10,000`.
String sharesAndValueText(int shares, Money value) => '${formatShares(shares)} × ${value.format()}';

/// Picks the account money for shares ARRIVES in. No balance check (money
/// comes in); with finance.view every active account is listed, otherwise the
/// fixed accounts and the bank list (names only). The server validates it.
Future<String?> choosePayFromAccountIn(BuildContext context, WidgetRef ref, {required Money amount}) {
  final options = <(String, String)>[];
  if (canDo(ref, Permission.financeView)) {
    final accounts = FinancialAccount.withDefaults(ref.read(financialAccountsProvider).value ?? const <FinancialAccount>[]);
    for (final a in accounts) {
      if (a.active) options.add((a.accountId, '${a.name} · ${a.type.label}'));
    }
  } else {
    for (final id in [DefaultAccounts.cashAtHand, DefaultAccounts.mtnMerchant, DefaultAccounts.airtelMerchant]) {
      options.add((id, DefaultAccounts.all[id]!.$1));
    }
    for (final b in ref.read(paymentAccountOptionsProvider).value ?? const <PaymentAccountOption>[]) {
      options.add((b.accountId, b.label));
    }
  }
  return showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: ListView(shrinkWrap: true, children: [
        ListTile(title: Text('${amount.format()} received into'), subtitle: const Text('Posted as share capital - never revenue.')),
        for (final (id, name) in options)
          ListTile(key: Key('receive-into-$id'), leading: const Icon(Icons.account_balance_wallet_outlined), title: Text(name), onTap: () => Navigator.of(context).pop(id)),
      ]),
    ),
  );
}

/// Move shares between two shareholders. No shares are created.
class TransferSharesSheet extends ConsumerStatefulWidget {
  const TransferSharesSheet({super.key, this.fromShareholderId});
  final String? fromShareholderId;

  @override
  ConsumerState<TransferSharesSheet> createState() => _TransferSharesSheetState();
}

class _TransferSharesSheetState extends ConsumerState<TransferSharesSheet> {
  late String? _from = widget.fromShareholderId;
  String? _to;
  String? _classId;
  final _shares = TextEditingController();
  final _reason = TextEditingController();
  final _reference = TextEditingController();
  DateTime _effective = DateTime.now();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_shares, _reason, _reference]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final shares = SharesField.parse(_shares.text);
    final holdings = _from == null ? const <Shareholding>[] : ref.watch(holdingsProvider(_from!)).value ?? const <Shareholding>[];
    final held = holdings.where((h) => h.classId == _classId).firstOrNull?.shares;
    final over = shares != null && held != null && shares > held;
    final ready = _from != null && _to != null && _from != _to && _classId != null && shares != null && !over && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Transfer shares',
      subtitle: 'Moves shares between shareholders; the total stays the same. Contributions stay with whoever paid them.',
      submitLabel: 'Transfer',
      submitKey: const Key('submit-transfer'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(shareholderActionsProvider).transferShares(
                    fromShareholderId: _from!, toShareholderId: _to!, classId: _classId!, shares: shares, effectiveDate: _effective,
                    reason: _reason.text.trim(), requestId: _requestId,
                    reference: _reference.text.trim().isEmpty ? null : _reference.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        if (widget.fromShareholderId == null)
          ShareholderDropdown(fieldKey: const Key('transfer-from'), label: 'From', value: _from, onChanged: (v) => setState(() => _from = v)),
        ShareholderDropdown(fieldKey: const Key('transfer-to'), label: 'To', value: _to, exclude: _from, onChanged: (v) => setState(() => _to = v)),
        ShareClassDropdown(fieldKey: const Key('transfer-class'), value: _classId, includeInactive: true, onChanged: (v) => setState(() => _classId = v)),
        SharesField(
          controller: _shares,
          label: 'Number of shares',
          fieldKey: const Key('transfer-shares'),
          errorText: over ? 'Only ${formatShares(held)} held' : null,
          onChanged: (_) => setState(() {}),
        ),
        DateField(label: 'Effective date', value: _effective, onChanged: (d) => setState(() => _effective = d)),
        TextField(key: const Key('transfer-reason'), controller: _reason, maxLength: 500,
            decoration: const InputDecoration(labelText: 'Reason'), onChanged: (_) => setState(() {})),
        TextField(controller: _reference, maxLength: 60, decoration: const InputDecoration(labelText: 'Reference (transfer form…)')),
      ],
    );
  }
}

/// A ± correction entry. The earlier records are never overwritten.
class AdjustSharesSheet extends ConsumerStatefulWidget {
  const AdjustSharesSheet({super.key, this.shareholderId});
  final String? shareholderId;

  @override
  ConsumerState<AdjustSharesSheet> createState() => _AdjustSharesSheetState();
}

class _AdjustSharesSheetState extends ConsumerState<AdjustSharesSheet> {
  late String? _shareholder = widget.shareholderId;
  String? _classId;
  final _delta = TextEditingController();
  final _reason = TextEditingController();
  bool _commitment = false;
  DateTime _effective = DateTime.now();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _delta.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final delta = SharesField.parse(_delta.text, signed: true);
    final ready = _shareholder != null && _classId != null && delta != null && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Adjust shares',
      subtitle: 'Enter the correction, e.g. −5 when 100 were recorded but 95 are verified. The original entry stays visible.',
      submitLabel: 'Record adjustment',
      submitKey: const Key('submit-adjust'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(shareholderActionsProvider).adjustShares(
                    shareholderId: _shareholder!, classId: _classId!, deltaShares: delta, adjustCommitment: _commitment,
                    effectiveDate: _effective, reason: _reason.text.trim(), requestId: _requestId);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        if (widget.shareholderId == null)
          ShareholderDropdown(fieldKey: const Key('adjust-shareholder'), value: _shareholder, onChanged: (v) => setState(() => _shareholder = v)),
        ShareClassDropdown(fieldKey: const Key('adjust-class'), value: _classId, includeInactive: true, onChanged: (v) => setState(() => _classId = v)),
        SharesField(controller: _delta, label: 'Correction (+ or −)', signed: true, fieldKey: const Key('adjust-delta'), onChanged: (_) => setState(() {})),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Adjust the commitment too'),
          subtitle: const Text('By the correction × the current value per share (never below what was paid).'),
          value: _commitment,
          onChanged: (v) => setState(() => _commitment = v),
        ),
        DateField(label: 'Effective date', value: _effective, onChanged: (d) => setState(() => _effective = d)),
        TextField(key: const Key('adjust-reason'), controller: _reason, maxLength: 500,
            decoration: const InputDecoration(labelText: 'Reason (e.g. verified historical correction)'), onChanged: (_) => setState(() {})),
      ],
    );
  }
}

/// One ledger entry: its lines, payment state, approval and reversal.
class ShareTransactionDetailScreen extends ConsumerWidget {
  const ShareTransactionDetailScreen({super.key, required this.transactionId});
  final String transactionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.sharesView)) return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted');
    final actions = ref.read(shareholderActionsProvider);
    return switch (ref.watch(shareTransactionProvider(transactionId))) {
      AsyncData(value: final ShareTransaction t) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
          ScreenHeader(t.transactionNumber, subtitle: t.label, onBack: () => context.go(AppRoutes.shares)),
          Align(alignment: Alignment.centerLeft, child: ShareTransactionStatusChip(t.status)),
          SectionCard(title: '${formatShares(t.shares)} ${t.classCode} shares', icon: Icons.donut_small_outlined, children: [
            for (final l in t.lines)
              InfoRow(l.shareholderName, '${l.deltaShares > 0 ? '+' : '−'}${formatShares(l.deltaShares.abs())}'
                  '${l.sharesAfter == null ? '' : ' → ${formatShares(l.sharesAfter!)}'} · ${l.shareholderNumber}'),
            if (t.effectiveDate != null) InfoRow('Effective', DateTimeFormatter.date(t.effectiveDate!)),
            InfoRow('Reason', t.reason),
            InfoRow('Reference', t.reference),
            InfoRow('Notes', t.notes),
            InfoRow('Requested by', t.requestedByName),
            InfoRow('Decided by', t.approvedByName),
            if (t.decisionReason != null) InfoRow('Decision note', t.decisionReason),
            if (t.reversalOfTransactionNumber != null) InfoRow('Reverses', t.reversalOfTransactionNumber),
            if (t.reversedByTransactionNumber != null) InfoRow('Reversed by', '${t.reversedByTransactionNumber} · ${t.reversalReason ?? ''}'),
          ]),
          if (t.type == ShareTransactionType.issued)
            SectionCard(title: 'Contribution', icon: Icons.savings_outlined, children: [
              if (t.valuePerShare != null) InfoRow('Value per share', t.valuePerShare!.format()),
              MoneyLine('Committed', t.committed ?? Money.zero, valueKey: const Key('txn-committed')),
              MoneyLine('Paid', t.paid ?? Money.zero),
              MoneyLine('Outstanding', t.outstanding ?? Money.zero, emphasis: true),
              if (t.isPending && t.paymentAmount != null && t.paymentAmount!.isPositive)
                InfoRow('On approval', '${t.paymentAmount!.format()} · ${t.paymentSource?.label ?? ''}'),
              ..._contributions(ref, t),
            ]),
          const SizedBox(height: AppSpacing.sm),
          Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
            if (t.isPending && canDo(ref, Permission.sharesApprove)) ...[
              FilledButton(
                key: const Key('approve-share-txn'),
                onPressed: () async {
                  final ok = await showConfirmDialog(context,
                      title: 'Approve ${t.transactionNumber}?', message: 'Ownership changes now, and any payment is posted to its account.', confirmLabel: 'Approve');
                  if (!ok || !context.mounted) return;
                  final r = await actions.decideShareTransaction(t.transactionId, ShareDecision.approve);
                  if (context.mounted) reportResult(context, r, 'Approved and posted.');
                },
                child: const Text('Approve'),
              ),
              OutlinedButton(
                key: const Key('reject-share-txn'),
                onPressed: () async {
                  final reason = await showReasonDialog(context, title: 'Reject ${t.transactionNumber}?', message: 'Nothing changes. Say why.',
                      confirmLabel: 'Reject', destructive: true);
                  if (reason == null || !context.mounted) return;
                  final r = await actions.decideShareTransaction(t.transactionId, ShareDecision.reject, reason: reason);
                  if (context.mounted) reportResult(context, r, 'Rejected.');
                },
                child: const Text('Reject'),
              ),
            ],
            if (t.canReceivePayment && canDo(ref, Permission.sharesIssue))
              FilledButton(
                key: const Key('record-contribution'),
                onPressed: () => showFormSheet<void>(context, ContributionSheet(transaction: t)),
                child: const Text('Record payment'),
              ),
            if (t.canReverse && canDo(ref, Permission.sharesAdjust))
              TextButton(
                key: const Key('reverse-share-txn'),
                onPressed: () async {
                  final reason = await showReasonDialog(context,
                      title: 'Reverse ${t.transactionNumber}?',
                      message: 'A mirror entry is posted today; this one stays in the history.'
                          '${t.type == ShareTransactionType.issued ? ' Money received for it is reversed from its account too.' : ''}',
                      confirmLabel: 'Reverse',
                      destructive: true);
                  if (reason == null || !context.mounted) return;
                  final r = await actions.reverseShareTransaction(t.transactionId, reason: reason, requestId: newRequestId());
                  if (context.mounted) reportResult(context, r, 'Reversed.');
                },
                child: const Text('Reverse'),
              ),
          ]),
        ]),
      AsyncData() => const EmptyView(icon: Icons.swap_horiz, title: 'Transaction not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }

  List<Widget> _contributions(WidgetRef ref, ShareTransaction t) {
    final list = ref.watch(issueContributionsProvider(t.transactionId)).value ?? const <ShareContribution>[];
    return [for (final c in list) ContributionTile(contribution: c)];
  }
}

/// Money received later for issued shares.
class ContributionSheet extends ConsumerStatefulWidget {
  const ContributionSheet({super.key, required this.transaction});
  final ShareTransaction transaction;

  @override
  ConsumerState<ContributionSheet> createState() => _ContributionSheetState();
}

class _ContributionSheetState extends ConsumerState<ContributionSheet> {
  late final _amount = TextEditingController(text: widget.transaction.outstanding?.formatAmount() ?? '');
  final _reason = TextEditingController();
  final _reference = TextEditingController();
  ContributionSource _source = ContributionSource.account;
  DateTime _date = DateTime.now();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_amount, _reason, _reference]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.transaction;
    final amount = MoneyField.parse(_amount.text);
    final over = amount != null && amount > (t.outstanding ?? Money.zero);
    final ready = amount != null && !over && (_source != ContributionSource.priorRecord || _reason.text.trim().length >= 3);
    return FormSheet(
      title: 'Payment for ${t.transactionNumber}',
      subtitle: 'Outstanding ${t.outstanding?.format() ?? ''}. Recorded as share capital, never revenue.',
      submitLabel: 'Record payment',
      submitKey: const Key('submit-contribution'),
      saving: _saving,
      error: over ? 'At most ${t.outstanding!.format()}' : _error,
      onSubmit: !ready
          ? null
          : () async {
              String? accountId;
              if (_source == ContributionSource.account) {
                accountId = await choosePayFromAccountIn(context, ref, amount: amount);
                if (accountId == null || !mounted) return;
              }
              setState(() => _saving = true);
              final r = await ref.read(shareholderActionsProvider).recordContribution(t.transactionId,
                  payment: SharePayment(source: _source, amount: amount, accountId: accountId),
                  paymentDate: _date,
                  requestId: _requestId,
                  reference: _reference.text.trim().isEmpty ? null : _reference.text.trim(),
                  reason: _reason.text.trim().isEmpty ? null : _reason.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        _PaymentFields(source: _source, amount: _amount, allowNone: false, onSource: (s) => setState(() => _source = s), onChanged: () => setState(() {})),
        DateField(label: 'Payment date', value: _date, onChanged: (d) => setState(() => _date = d)),
        TextField(controller: _reference, maxLength: 60, decoration: const InputDecoration(labelText: 'Reference')),
        if (_source == ContributionSource.priorRecord)
          TextField(controller: _reason, maxLength: 500, decoration: const InputDecoration(labelText: 'Reason / evidence'), onChanged: (_) => setState(() {})),
      ],
    );
  }
}
