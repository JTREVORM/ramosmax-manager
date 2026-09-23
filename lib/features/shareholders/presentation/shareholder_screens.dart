import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/shareholding.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../payroll/presentation/workforce_widgets.dart' show StaffDropdown;
import '../application/shareholders_providers.dart';
import '../data/shareholders_api.dart';
import 'share_screens.dart';
import 'shareholder_widgets.dart';

/// Shareholders: dashboard, the searchable register and ownership reports.
/// Tabs appear only for the permissions held.
class ShareholdersScreen extends ConsumerWidget {
  const ShareholdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reports = canDo(ref, Permission.shareholdersReportsView) || canDo(ref, Permission.sharesView) || canDo(ref, Permission.shareholdersView);
    final tabs = <(String, Widget)>[
      if (reports) ('Dashboard', const ShareholderDashboardTab()),
      if (canDo(ref, Permission.shareholdersView)) ('All shareholders', const ShareholderListTab()),
      if (reports) ('Reports', const OwnershipReportsTab()),
    ];
    if (tabs.isEmpty) return const EmptyView(icon: Icons.groups_outlined, title: 'Nothing to show');
    return DefaultTabController(
      length: tabs.length,
      child: Column(children: [
        TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final (label, _) in tabs) Tab(text: label)]),
        Expanded(child: TabBarView(children: [for (final (_, view) in tabs) view])),
      ]),
    );
  }
}

/// Register-level figures only (no contact or identity details).
class ShareholderDashboardTab extends ConsumerWidget {
  const ShareholderDashboardTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canProfiles = canDo(ref, Permission.shareholdersView);
    final canDividends = canDo(ref, Permission.dividendsView) || canDo(ref, Permission.shareholdersReportsView);
    return switch (ref.watch(shareRegisterProvider)) {
      AsyncData(value: final r) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
          FigureGrid(children: [
            FigureCard(label: 'Shareholders', value: '${r.shareholderCount}', valueKey: const Key('register-shareholders')),
            FigureCard(label: 'Active shareholders', value: '${r.activeShareholders}', valueKey: const Key('register-active')),
            FigureCard(label: 'Total shares', value: formatShares(r.totalShares), valueKey: const Key('register-total-shares')),
            FigureCard(label: 'Share capital received', value: r.totalPaid.format(), valueKey: const Key('register-paid')),
            if (r.outstanding.isPositive) FigureCard(label: 'Share capital outstanding', value: r.outstanding.format(), color: AppColors.warning),
            if (r.pendingApprovals > 0)
              FigureCard(
                label: 'Pending share approvals',
                value: '${r.pendingApprovals}',
                color: AppColors.warning,
                valueKey: const Key('register-pending'),
                onTap: canDo(ref, Permission.sharesView) ? () => context.go(AppRoutes.shares) : null,
              ),
          ]),
          const SizedBox(height: AppSpacing.sm),
          SectionCard(title: 'Ownership distribution', icon: Icons.pie_chart_outline, children: [
            OwnershipDistribution(
              holders: r.holders,
              limit: 10,
              onTap: canProfiles ? (h) => context.go(AppRoutes.shareholderDetail(h.shareholderId)) : null,
            ),
          ]),
          if (canDividends) const _DividendStatusCard(),
          if (canDo(ref, Permission.sharesView)) const _RecentShareTransactions(),
          const SizedBox(height: AppSpacing.sm),
          Text('Share capital is owners\' money: it is never counted as revenue, and dividends are never counted as operating expenses.',
              style: Theme.of(context).textTheme.bodySmall),
        ]),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class _DividendStatusCard extends ConsumerWidget {
  const _DividendStatusCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(dividendsProvider).value;
    if (list == null) return const SizedBox.shrink();
    final t = DividendTotals.of(list);
    return SectionCard(title: 'Dividends', icon: Icons.payments_outlined, trailing: TextButton(onPressed: () => context.go(AppRoutes.dividends), child: const Text('Open')), children: [
      MoneyLine('Declared', t.declared),
      MoneyLine('Approved', t.approved),
      MoneyLine('Paid', t.paid, valueKey: const Key('dividends-paid-total')),
      MoneyLine('Unpaid (approved, not yet paid)', t.outstanding, emphasis: true, valueKey: const Key('dividends-outstanding-total')),
    ]);
  }
}

class _RecentShareTransactions extends ConsumerWidget {
  const _RecentShareTransactions();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(shareTransactionsProvider((status: null, type: null))).value;
    if (list == null || list.isEmpty) return const SizedBox.shrink();
    return SectionCard(title: 'Recent share transactions', icon: Icons.swap_horiz, children: [
      for (final t in list.take(5)) ShareTransactionTile(transaction: t, onTap: () => context.go(AppRoutes.shareTransaction(t.transactionId))),
    ]);
  }
}

/// Search by number, name or phone, filter by status. Bounded queries only.
class ShareholderListTab extends ConsumerStatefulWidget {
  const ShareholderListTab({super.key});

  @override
  ConsumerState<ShareholderListTab> createState() => _ShareholderListTabState();
}

class _ShareholderListTabState extends ConsumerState<ShareholderListTab> {
  final _search = TextEditingController();
  Timer? _debounce;
  int _req = 0;
  ShareholderStatus? _status;
  List<Shareholder>? _results;
  String? _error;

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    _debounce?.cancel();
    final id = ++_req;
    setState(() => _error = null);
    try {
      final r = await ref.read(shareholdersRepositoryProvider).searchShareholders(_search.text, status: _status);
      if (mounted && id == _req) setState(() => _results = r);
    } catch (e) {
      if (mounted && id == _req) setState(() => _error = ErrorMapper.map(e).message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        floatingActionButton: canDo(ref, Permission.shareholdersCreate)
            ? FloatingActionButton.extended(
                key: const Key('add-shareholder-button'),
                onPressed: () => context.go(AppRoutes.newShareholder),
                icon: const Icon(Icons.person_add_alt_1),
                label: const Text('Add shareholder'),
              )
            : null,
        body: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 0),
            child: TextField(
              key: const Key('shareholder-search'),
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Name, phone or RMX-SHR number'),
              onChanged: (_) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 350), _run);
              },
              onSubmitted: (_) => _run(),
            ),
          ),
          FilterChips<ShareholderStatus?>(
            values: const [null, ...ShareholderStatus.values],
            selected: _status,
            label: (s) => s?.label ?? 'All',
            keyPrefix: 'shareholder-status',
            onSelected: (s) {
              setState(() => _status = s);
              _run();
            },
          ),
          Expanded(
            child: _error != null
                ? ErrorView(message: _error!, onRetry: _run)
                : _results == null
                    ? const LoadingView()
                    : _results!.isEmpty
                        ? const EmptyView(icon: Icons.groups_outlined, title: 'No shareholders found')
                        : RefreshIndicator(
                            onRefresh: _run,
                            child: ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                              for (final s in _results!)
                                ShareholderTile(shareholder: s, onTap: () => context.go(AppRoutes.shareholderDetail(s.shareholderId))),
                              if (_results!.length >= 100) const Text('Showing the first 100. Search to narrow the list.'),
                            ]),
                          ),
          ),
        ]),
      );
}

/// Ownership on any date (from the immutable ledger) and share capital figures.
class OwnershipReportsTab extends ConsumerStatefulWidget {
  const OwnershipReportsTab({super.key});

  @override
  ConsumerState<OwnershipReportsTab> createState() => _OwnershipReportsTabState();
}

class _OwnershipReportsTabState extends ConsumerState<OwnershipReportsTab> {
  DateTime _date = DateTime.now();
  OwnershipSnapshot? _snapshot;
  String? _error;
  bool _loading = false;

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final r = await ref.read(shareholderActionsProvider).ownershipAsOf(_date);
    if (!mounted) return;
    setState(() {
      _loading = false;
      r.when(success: (s) => _snapshot = s, failure: (f) => _error = f.message);
    });
  }

  @override
  Widget build(BuildContext context) {
    final register = ref.watch(shareRegisterProvider).value ?? ShareRegister.empty;
    final classes = ref.watch(shareClassesProvider).value ?? const <ShareClass>[];
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      MoneyCard(title: 'Share capital / contributions', lines: [
        InfoRow('Issued shares', formatShares(register.totalShares)),
        MoneyLine('Committed (shares × value per share)', register.totalCommitted),
        MoneyLine('Received', register.totalPaid, valueKey: const Key('report-capital-paid')),
        MoneyLine('Outstanding', register.outstanding, emphasis: true),
      ], footer: 'Owners\' capital. Revenue, expenses and dividends are reported separately (Finance → Reports); '
          'RamosMAX does not calculate profit.'),
      if (classes.isNotEmpty)
        SectionCard(title: 'By share class', icon: Icons.category_outlined, children: [
          for (final c in classes)
            InfoRow(c.code, '${formatShares(c.issuedShares)} shares · ${c.valuePerShare.format()} each · received ${c.paid.format()}${c.active ? '' : ' · inactive'}'),
        ]),
      SectionCard(title: 'Ownership on a date', icon: Icons.history, children: [
        Text('Worked out from every share transaction effective on or before the end of that day. Later changes never rewrite earlier ownership.',
            style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: AppSpacing.xs),
        DateField(fieldKey: const Key('ownership-date'), label: 'As at', value: _date, onChanged: (d) => setState(() => _date = d)),
        const SizedBox(height: AppSpacing.xs),
        FilledButton(key: const Key('ownership-load'), onPressed: _loading ? null : _load, child: const Text('Show ownership')),
        if (_loading) const LinearProgressIndicator(),
        if (_error != null) InlineError(_error!),
        if (_snapshot != null) ...[
          InfoRow('Total shares', formatShares(_snapshot!.totalShares)),
          OwnershipDistribution(holders: _snapshot!.holders),
        ],
      ]),
      const SectionCard(title: 'More reports', icon: Icons.bar_chart_outlined, children: [
        Text('Share transactions, transfers and adjustments: Shares → Transactions (filter by type). '
            'Dividend declarations, allocations and payments: Dividends → Reports.'),
      ]),
    ]);
  }
}

/// Add or edit a shareholder's profile.
class ShareholderFormScreen extends ConsumerStatefulWidget {
  const ShareholderFormScreen({super.key, this.shareholderId});
  final String? shareholderId;

  @override
  ConsumerState<ShareholderFormScreen> createState() => _ShareholderFormScreenState();
}

class _ShareholderFormScreenState extends ConsumerState<ShareholderFormScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  final _address = TextEditingController();
  final _idNumber = TextEditingController();
  final _notes = TextEditingController();
  IdentificationType? _idType;
  DateTime _joinDate = DateTime.now();
  Shareholder? _original;
  bool _loaded = false;
  bool _saving = false;
  String? _error;
  final String _requestId = newRequestId();

  bool get _editing => widget.shareholderId != null;

  @override
  void dispose() {
    for (final c in [_name, _phone, _email, _address, _idNumber, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  void _fill(Shareholder s) {
    _original = s;
    _name.text = s.fullName;
    _phone.text = s.phoneNumber == null ? '' : PhoneNumbers.formatForDisplay(s.phoneNumber!);
    _email.text = s.email ?? '';
    _address.text = s.address ?? '';
    _idType = s.idType;
    _idNumber.text = s.idNumber ?? '';
    _notes.text = s.notes ?? '';
    _joinDate = s.joinDate ?? _joinDate;
    _loaded = true;
  }

  String? _text(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final actions = ref.read(shareholderActionsProvider);
    final draft = ShareholderDraft(
      fullName: _name.text.trim(),
      phoneNumber: _text(_phone),
      email: _text(_email),
      address: _text(_address),
      idType: _idType,
      idNumber: _text(_idNumber),
      notes: _text(_notes),
      joinDate: _joinDate,
    );
    final String? id;
    if (_editing) {
      // The server compares every field and records only what changed.
      final r = await actions.updateShareholder(widget.shareholderId!, draft.toJson());
      id = r.when(success: (_) => widget.shareholderId, failure: (f) {
        _error = f.message;
        return null;
      });
    } else {
      final r = await actions.createShareholder(draft, requestId: _requestId);
      id = r.when(success: (v) => v, failure: (f) {
        _error = f.message;
        return null;
      });
    }
    if (!mounted) return;
    setState(() => _saving = false);
    if (id != null) {
      AppSnackbar.success(context, _editing ? 'Shareholder updated.' : 'Shareholder added.');
      context.go(AppRoutes.shareholderDetail(id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final allowed = _editing ? canDo(ref, Permission.shareholdersUpdate) : canDo(ref, Permission.shareholdersCreate);
    if (!allowed) return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted');
    if (_editing && !_loaded) {
      final s = ref.watch(shareholderProvider(widget.shareholderId!));
      if (s is AsyncData<Shareholder?> && s.value != null) {
        _fill(s.value!);
      } else if (s is AsyncError) {
        return ErrorView.failure(ErrorMapper.map(s.error!));
      } else {
        return const LoadingView();
      }
    }
    final ready = _name.text.trim().length >= 2 && ((_idType == null) == (_idNumber.text.trim().isEmpty));
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
      ScreenHeader(_editing ? 'Edit shareholder' : 'Add shareholder',
          subtitle: _editing ? _original?.shareholderNumber : 'The RMX-SHR number is issued by the server.',
          onBack: () => context.go(_editing ? AppRoutes.shareholderDetail(widget.shareholderId!) : AppRoutes.shareholders)),
      TextField(key: const Key('shareholder-name'), controller: _name, maxLength: 80, textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(labelText: 'Full name (person or company)'), onChanged: (_) => setState(() {})),
      TextField(key: const Key('shareholder-phone'), controller: _phone, keyboardType: TextInputType.phone,
          decoration: const InputDecoration(labelText: 'Phone (optional)', hintText: '0772 123 456')),
      const SizedBox(height: AppSpacing.sm),
      TextField(key: const Key('shareholder-email'), controller: _email, keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'Email (optional)')),
      const SizedBox(height: AppSpacing.sm),
      TextField(controller: _address, maxLength: 200, decoration: const InputDecoration(labelText: 'Address (optional)')),
      DropdownButtonFormField<IdentificationType?>(
        key: const Key('shareholder-id-type'),
        initialValue: _idType,
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'Identification (optional)'),
        items: [
          const DropdownMenuItem<IdentificationType?>(value: null, child: Text('None')),
          for (final t in IdentificationType.values) DropdownMenuItem<IdentificationType?>(value: t, child: Text(t.label)),
        ],
        onChanged: (v) => setState(() => _idType = v),
      ),
      if (_idType != null) ...[
        const SizedBox(height: AppSpacing.sm),
        TextField(key: const Key('shareholder-id-number'), controller: _idNumber, maxLength: 40,
            decoration: const InputDecoration(labelText: 'Identification number'), onChanged: (_) => setState(() {})),
      ],
      const SizedBox(height: AppSpacing.sm),
      DateField(label: 'Joined', value: _joinDate, onChanged: (d) => setState(() => _joinDate = d)),
      const SizedBox(height: AppSpacing.sm),
      TextField(controller: _notes, maxLength: 500, maxLines: 3, minLines: 1, decoration: const InputDecoration(labelText: 'Notes')),
      if (_error != null) ...[InlineError(_error!), const SizedBox(height: AppSpacing.sm)],
      FilledButton(
        key: const Key('save-shareholder'),
        onPressed: !ready || _saving ? null : _save,
        child: _saving
            ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
            : Text(_editing ? 'Save changes' : 'Add shareholder'),
      ),
    ]);
  }
}

/// One shareholder: profile, ownership, holdings, history, contributions and dividends.
class ShareholderDetailScreen extends ConsumerWidget {
  const ShareholderDetailScreen({super.key, required this.shareholderId});
  final String shareholderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.shareholdersView)) return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted');
    return switch (ref.watch(shareholderProvider(shareholderId))) {
      AsyncData(value: final Shareholder s) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
          ScreenHeader(s.fullName, subtitle: s.shareholderNumber, onBack: () => context.go(AppRoutes.shareholders)),
          Align(alignment: Alignment.centerLeft, child: ShareholderStatusChip(s.status)),
          SectionCard(title: 'Ownership', icon: Icons.pie_chart_outline, children: [
            InfoRow('Shares owned', formatShares(s.totalShares), valueWidget: Text(formatShares(s.totalShares), key: const Key('detail-shares'))),
            InfoRow('Ownership', formatPercent(s.ownershipPercent), valueWidget: Text(formatPercent(s.ownershipPercent), key: const Key('detail-ownership'))),
            MoneyLine('Committed', s.committed),
            MoneyLine('Contributions received', s.paid, valueKey: const Key('detail-paid')),
            if (s.outstanding.isPositive) MoneyLine('Outstanding', s.outstanding, color: AppColors.warning),
            MoneyLine('Dividends paid', s.dividendsPaid),
            Text('Calculated by the server from the share ledger.', style: Theme.of(context).textTheme.bodySmall),
          ]),
          SectionCard(title: 'Details', icon: Icons.person_outline, children: [
            InfoRow('Phone', s.phoneNumber == null ? null : PhoneNumbers.formatForDisplay(s.phoneNumber!)),
            InfoRow('Email', s.email),
            InfoRow('Address', s.address),
            InfoRow('Identification', s.idType == null ? null : '${s.idType!.label} · ${s.idNumber}'),
            InfoRow('Joined', s.joinDate == null ? null : DateTimeFormatter.date(s.joinDate!)),
            InfoRow('Sign-in linked', s.linkedUid == null ? 'No' : (s.linkedUserName ?? 'Yes')),
            if (s.statusReason != null) InfoRow('Status reason', s.statusReason),
            InfoRow('Notes', s.notes),
          ]),
          _Actions(shareholder: s),
          if (canDo(ref, Permission.sharesView)) ...[
            _HoldingsCard(shareholderId: s.shareholderId),
            _HistoryCard(shareholderId: s.shareholderId),
            _ContributionsCard(shareholderId: s.shareholderId),
          ],
          if (canDo(ref, Permission.dividendsView)) _DividendHistoryCard(shareholderId: s.shareholderId),
        ]),
      AsyncData() => const EmptyView(icon: Icons.groups_outlined, title: 'Shareholder not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class _Actions extends ConsumerWidget {
  const _Actions({required this.shareholder});
  final Shareholder shareholder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = shareholder;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
        if (canDo(ref, Permission.shareholdersUpdate))
          OutlinedButton.icon(
            key: const Key('edit-shareholder-button'),
            onPressed: () => context.go(AppRoutes.editShareholder(s.shareholderId)),
            icon: const Icon(Icons.edit_outlined),
            label: const Text('Edit'),
          ),
        if (canDo(ref, Permission.sharesIssue) && s.canReceiveShares)
          FilledButton.icon(
            key: const Key('issue-to-shareholder-button'),
            onPressed: () => showFormSheet<void>(context, IssueSharesSheet(shareholderId: s.shareholderId)),
            icon: const Icon(Icons.add),
            label: const Text('Issue shares'),
          ),
        if (canDo(ref, Permission.sharesTransfer) && s.totalShares > 0)
          OutlinedButton.icon(
            key: const Key('transfer-from-shareholder-button'),
            onPressed: () => showFormSheet<void>(context, TransferSharesSheet(fromShareholderId: s.shareholderId)),
            icon: const Icon(Icons.swap_horiz),
            label: const Text('Transfer'),
          ),
        if (canDo(ref, Permission.shareholdersManage)) ...[
          OutlinedButton(
            key: const Key('shareholder-status-button'),
            onPressed: () => showFormSheet<void>(context, _StatusSheet(shareholder: s)),
            child: const Text('Change status'),
          ),
          if (canDo(ref, Permission.usersView))
            OutlinedButton(
              key: const Key('link-account-button'),
              onPressed: () => showFormSheet<void>(context, _LinkSheet(shareholder: s)),
              child: Text(s.linkedUid == null ? 'Link sign-in' : 'Change sign-in link'),
            ),
        ],
      ]),
    );
  }
}

class _HoldingsCard extends ConsumerWidget {
  const _HoldingsCard({required this.shareholderId});
  final String shareholderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = (ref.watch(holdingsProvider(shareholderId)).value ?? const <Shareholding>[]).where((h) => h.shares != 0 || h.committed.isPositive).toList();
    return SectionCard(title: 'Holdings by class', icon: Icons.category_outlined, children: [
      if (list.isEmpty) const Text('No shares held.'),
      for (final h in list)
        InfoRow(h.classCode, '${formatShares(h.shares)} shares · paid ${h.paid.format()}${h.outstanding.isPositive ? ' · owes ${h.outstanding.format()}' : ''}'),
    ]);
  }
}

class _HistoryCard extends ConsumerWidget {
  const _HistoryCard({required this.shareholderId});
  final String shareholderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => SectionCard(title: 'Share history (issues, transfers, adjustments)', icon: Icons.history, children: [
        switch (ref.watch(shareholderTransactionsProvider(shareholderId))) {
          AsyncData(:final value) when value.isEmpty => const Text('No share transactions yet.'),
          AsyncData(:final value) => Column(children: [
              for (final t in value)
                ShareTransactionTile(transaction: t, forShareholder: shareholderId, onTap: () => context.go(AppRoutes.shareTransaction(t.transactionId))),
            ]),
          AsyncError(:final error) => Text(ErrorMapper.map(error).message),
          _ => const LinearProgressIndicator(),
        },
      ]);
}

class _ContributionsCard extends ConsumerWidget {
  const _ContributionsCard({required this.shareholderId});
  final String shareholderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(shareholderContributionsProvider(shareholderId)).value ?? const <ShareContribution>[];
    return SectionCard(title: 'Contributions', icon: Icons.savings_outlined, children: [
      if (list.isEmpty) const Text('No contributions recorded.'),
      for (final c in list) ContributionTile(contribution: c),
    ]);
  }
}

class _DividendHistoryCard extends ConsumerWidget {
  const _DividendHistoryCard({required this.shareholderId});
  final String shareholderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(shareholderAllocationsProvider(shareholderId)).value ?? const <DividendAllocation>[];
    return SectionCard(title: 'Dividend history', icon: Icons.payments_outlined, children: [
      if (list.isEmpty) const Text('No dividends allocated.'),
      for (final a in list)
        ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          onTap: () => context.go(AppRoutes.dividendDetail(a.dividendId)),
          title: Text('${a.dividendNumber} · ${formatShares(a.sharesAtRecordDate)} shares'),
          subtitle: Text('${a.allocationNumber} · ${a.isPaid ? 'Paid' : a.paymentStatus.replaceAll('_', ' ')}'),
          trailing: Text(a.net.format()),
        ),
    ]);
  }
}

class _StatusSheet extends ConsumerStatefulWidget {
  const _StatusSheet({required this.shareholder});
  final Shareholder shareholder;

  @override
  ConsumerState<_StatusSheet> createState() => _StatusSheetState();
}

class _StatusSheetState extends ConsumerState<_StatusSheet> {
  late ShareholderStatus _status = widget.shareholder.status;
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.shareholder;
    final ready = _status != s.status && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Status of ${s.fullName}',
      subtitle: 'Only active shareholders receive new shares. Exited needs no shares and nothing outstanding. Nothing is deleted.',
      submitLabel: 'Save status',
      submitKey: const Key('submit-shareholder-status'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(shareholderActionsProvider).setStatus(s.shareholderId, _status, reason: _reason.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        SegmentedButton<ShareholderStatus>(
          segments: [for (final st in ShareholderStatus.values) ButtonSegment(value: st, label: Text(st.label))],
          selected: {_status},
          onSelectionChanged: (v) => setState(() => _status = v.first),
        ),
        TextField(key: const Key('shareholder-status-reason'), controller: _reason, maxLength: 500,
            decoration: const InputDecoration(labelText: 'Reason'), onChanged: (_) => setState(() {})),
      ],
    );
  }
}

class _LinkSheet extends ConsumerStatefulWidget {
  const _LinkSheet({required this.shareholder});
  final Shareholder shareholder;

  @override
  ConsumerState<_LinkSheet> createState() => _LinkSheetState();
}

class _LinkSheetState extends ConsumerState<_LinkSheet> {
  late String? _uid = widget.shareholder.linkedUid;
  bool _saving = false;
  String? _error;

  Future<void> _save(String? uid) async {
    setState(() => _saving = true);
    final r = await ref.read(shareholderActionsProvider).linkAccount(widget.shareholder.shareholderId, uid);
    if (!mounted) return;
    setState(() => _saving = false);
    r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
  }

  @override
  Widget build(BuildContext context) => FormSheet(
        title: 'Sign-in for ${widget.shareholder.fullName}',
        subtitle: 'The linked person can see this shareholding - and only this one - under My Shareholding.',
        submitLabel: 'Link',
        submitKey: const Key('submit-link'),
        saving: _saving,
        error: _error,
        onSubmit: _uid == null || _uid == widget.shareholder.linkedUid ? null : () => _save(_uid),
        children: [
          StaffDropdown(fieldKey: const Key('link-user'), label: 'RamosMAX user', value: _uid, onChanged: (v) => setState(() => _uid = v)),
          if (widget.shareholder.linkedUid != null)
            TextButton(key: const Key('unlink-button'), onPressed: _saving ? null : () => _save(null), child: const Text('Remove the link')),
        ],
      );
}
