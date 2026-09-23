import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/after_hours.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/after_hours_providers.dart';
import '../data/after_hours_repository.dart';
import 'after_hours_sheets.dart';
import 'after_hours_widgets.dart';

/// The supervisors' After-Hours dashboard (Phase 8). Each tab needs the
/// permission that lets the user read its records; every action checks its
/// own permission, and the Cloud Functions decide.
class AfterHoursScreen extends ConsumerWidget {
  const AfterHoursScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = canDo(ref, Permission.afterHoursView);
    final approve = canDo(ref, Permission.afterHoursApprove);
    final tabs = <(String, Widget)>[
      if (view || approve) ('Overview', const _OverviewTab()),
      if (view || approve) ('Authorisations', const _AuthorizationsTab()),
      if (view || approve) ('Sessions', const _SessionsTab()),
      if (view || canDo(ref, Permission.cashHandoverApprove)) ('Handovers', const _HandoversTab()),
      if (view || canDo(ref, Permission.afterHoursDiscrepancyReview)) ('Discrepancies', const _DiscrepanciesTab()),
      if (view || canDo(ref, Permission.cashHandoverApprove)) ('Reports', const _ReportsTab()),
      ('Policy', const _PolicyTab()),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Column(children: [
        TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final (label, _) in tabs) Tab(key: Key('tab-${label.toLowerCase()}'), text: label)]),
        Expanded(child: TabBarView(children: [for (final (_, view) in tabs) view])),
      ]),
    );
  }
}

Widget _async<T>(AsyncValue<T> value, Widget Function(T) data) => switch (value) {
      AsyncData(:final value) => data(value),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };

class _OverviewTab extends ConsumerWidget {
  const _OverviewTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final auths = ref.watch(authorizationsProvider(AuthorizationStatus.active)).value ?? const <AfterHoursAuthorization>[];
    final open = ref.watch(afterHoursSessionsProvider(SessionStatus.open));
    final canHandovers = canDo(ref, Permission.afterHoursView) || canDo(ref, Permission.cashHandoverApprove);
    final canDiscrepancies = canDo(ref, Permission.afterHoursView) || canDo(ref, Permission.afterHoursDiscrepancyReview);
    final handovers = canHandovers ? ref.watch(handoversProvider(null)).value : null;
    final discrepancies = canDiscrepancies ? ref.watch(discrepanciesProvider(null)).value : null;
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      FigureGrid(children: [
        FigureCard(label: 'Authorisations in force', value: '${auths.where((a) => a.isLive(now)).length}', valueKey: const Key('ah-live-count')),
        FigureCard(label: 'Open sessions', value: '${open.value?.length ?? 0}', valueKey: const Key('ah-open-sessions')),
        if (handovers != null)
          FigureCard(
              label: 'Handovers to receive',
              value: '${handovers.where((h) => h.status.awaitingReceipt).length}',
              valueKey: const Key('ah-to-receive'),
              color: handovers.any((h) => h.status.awaitingReceipt) ? AppColors.warning : null),
        if (discrepancies != null)
          FigureCard(
              label: 'Open discrepancies',
              value: '${discrepancies.where((d) => d.status.isOpen).length}',
              valueKey: const Key('ah-open-discrepancies'),
              color: discrepancies.any((d) => d.status.isOpen) ? AppColors.danger : null),
      ]),
      const SizedBox(height: AppSpacing.sm),
      Text('Open sessions', style: Theme.of(context).textTheme.titleMedium),
      _async(open, (list) => list.isEmpty
          ? const Padding(padding: EdgeInsets.all(AppSpacing.sm), child: Text('Nobody is working after hours right now.'))
          : Column(children: [
              for (final s in list)
                SessionTile(session: s, onTap: () => context.go(AppRoutes.afterHoursSession(s.sessionId))),
            ])),
    ]);
  }
}

class _AuthorizationsTab extends ConsumerStatefulWidget {
  const _AuthorizationsTab();

  @override
  ConsumerState<_AuthorizationsTab> createState() => _AuthorizationsTabState();
}

class _AuthorizationsTabState extends ConsumerState<_AuthorizationsTab> {
  AuthorizationStatus? _status = AuthorizationStatus.active;

  Future<void> _revoke(AfterHoursAuthorization a) async {
    final reason = await showReasonDialog(context,
        title: 'Revoke ${a.authorizationNumber}?',
        message: '${a.staffName} loses the after-hours permissions at once. An open session must still be closed and handed over.',
        confirmLabel: 'Revoke',
        destructive: true);
    if (reason == null || !mounted) return;
    final r = await ref.read(afterHoursActionsProvider).revoke(a.authorizationId, reason: reason);
    if (mounted) reportResult(context, r, 'Authorisation revoked.');
  }

  @override
  Widget build(BuildContext context) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final approve = canDo(ref, Permission.afterHoursApprove);
    return Scaffold(
      floatingActionButton: approve
          ? FloatingActionButton.extended(
              key: const Key('authorize-button'),
              onPressed: () => showFormSheet<void>(context, const AuthorizeSheet()),
              icon: const Icon(Icons.nightlight_outlined),
              label: const Text('Authorise'),
            )
          : null,
      body: Column(children: [
        FilterChips<AuthorizationStatus?>(
          values: const [AuthorizationStatus.active, null, AuthorizationStatus.revoked, AuthorizationStatus.expired],
          selected: _status,
          label: (s) => s?.label ?? 'All',
          keyPrefix: 'auth-status',
          onSelected: (s) => setState(() => _status = s),
        ),
        Expanded(
          child: _async(ref.watch(authorizationsProvider(_status)), (list) => list.isEmpty
              ? const EmptyView(icon: Icons.nightlight_outlined, title: 'No authorisations', message: 'Authorise a worker for after-hours work.')
              : ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                  for (final a in list)
                    AuthorizationTile(
                      authorization: a,
                      now: now,
                      trailing: approve && a.canRevoke(now)
                          ? IconButton(key: Key('revoke-${a.authorizationId}'), tooltip: 'Revoke', icon: const Icon(Icons.block), onPressed: () => _revoke(a))
                          : null,
                    ),
                ])),
        ),
      ]),
    );
  }
}

class _SessionsTab extends ConsumerStatefulWidget {
  const _SessionsTab();

  @override
  ConsumerState<_SessionsTab> createState() => _SessionsTabState();
}

class _SessionsTabState extends ConsumerState<_SessionsTab> {
  SessionStatus? _status;

  @override
  Widget build(BuildContext context) => Column(children: [
        FilterChips<SessionStatus?>(
          values: const [null, ...SessionStatus.values],
          selected: _status,
          label: (s) => s?.label ?? 'All',
          keyPrefix: 'session-status',
          onSelected: (s) => setState(() => _status = s),
        ),
        Expanded(
          child: _async(ref.watch(afterHoursSessionsProvider(_status)), (list) => list.isEmpty
              ? const EmptyView(icon: Icons.nightlight_outlined, title: 'No sessions')
              : ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                  for (final s in list) SessionTile(session: s, onTap: () => context.go(AppRoutes.afterHoursSession(s.sessionId))),
                ])),
        ),
      ]);
}

class _HandoversTab extends ConsumerStatefulWidget {
  const _HandoversTab();

  @override
  ConsumerState<_HandoversTab> createState() => _HandoversTabState();
}

class _HandoversTabState extends ConsumerState<_HandoversTab> {
  HandoverStatus? _status = HandoverStatus.submitted;

  @override
  Widget build(BuildContext context) => Column(children: [
        FilterChips<HandoverStatus?>(
          values: const [HandoverStatus.submitted, HandoverStatus.pending, null, HandoverStatus.discrepancy, HandoverStatus.received, HandoverStatus.reconciled],
          selected: _status,
          label: (s) => s?.label ?? 'All',
          keyPrefix: 'handover-status',
          onSelected: (s) => setState(() => _status = s),
        ),
        Expanded(
          child: _async(ref.watch(handoversProvider(_status)), (list) => list.isEmpty
              ? const EmptyView(icon: Icons.handshake_outlined, title: 'No handovers')
              : ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                  for (final h in list) HandoverTile(handover: h, onTap: () => context.go(AppRoutes.afterHoursHandover(h.handoverId))),
                ])),
        ),
      ]);
}

class _DiscrepanciesTab extends ConsumerStatefulWidget {
  const _DiscrepanciesTab();

  @override
  ConsumerState<_DiscrepanciesTab> createState() => _DiscrepanciesTabState();
}

class _DiscrepanciesTabState extends ConsumerState<_DiscrepanciesTab> {
  DiscrepancyStatus? _status;

  @override
  Widget build(BuildContext context) => Column(children: [
        FilterChips<DiscrepancyStatus?>(
          values: const [null, ...DiscrepancyStatus.values],
          selected: _status,
          label: (s) => s?.label ?? 'All',
          keyPrefix: 'discrepancy-status',
          onSelected: (s) => setState(() => _status = s),
        ),
        Expanded(
          child: _async(ref.watch(discrepanciesProvider(_status)), (list) => list.isEmpty
              ? const EmptyView(icon: Icons.report_problem_outlined, title: 'No discrepancies')
              : ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                  for (final d in list) DiscrepancyTile(discrepancy: d, onTap: () => context.go(AppRoutes.afterHoursDiscrepancy(d.discrepancyId))),
                ])),
        ),
      ]);
}

enum ReportPeriod {
  today('Today', 1),
  week('7 days', 7),
  month('30 days', 30),
  all('All loaded', null);

  const ReportPeriod(this.label, this.days);
  final String label;
  final int? days;

  bool includes(DateTime? at, DateTime now) {
    if (days == null) return true;
    if (at == null) return false;
    final today = EastAfricaTime.toEat(now);
    final start = EastAfricaTime.fromEatWallClock(today.year, today.month, today.day, 0, 0).subtract(Duration(days: days! - 1));
    return !at.isBefore(start);
  }
}

class _ReportsTab extends ConsumerStatefulWidget {
  const _ReportsTab();

  @override
  ConsumerState<_ReportsTab> createState() => _ReportsTabState();
}

class _ReportsTabState extends ConsumerState<_ReportsTab> {
  ReportPeriod _period = ReportPeriod.week;
  String? _worker;

  @override
  Widget build(BuildContext context) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    return Column(children: [
      FilterChips<ReportPeriod>(
        values: ReportPeriod.values,
        selected: _period,
        label: (p) => p.label,
        keyPrefix: 'ah-period',
        onSelected: (p) => setState(() => _period = p),
      ),
      Expanded(
        child: _async(ref.watch(handoversProvider(null)), (all) {
          final inPeriod = all.where((h) => _period.includes(h.createdAt, now)).toList();
          final workers = {for (final h in inPeriod) h.staffUid: h.staffName};
          final list = _worker == null ? inPeriod : inPeriod.where((h) => h.staffUid == _worker).toList();
          final t = HandoverTotals.of(list);
          final byWorker = <String, List<CashHandover>>{};
          for (final h in list) {
            byWorker.putIfAbsent(h.staffName, () => []).add(h);
          }
          return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
            if (workers.length > 1)
              DropdownButtonFormField<String?>(
                key: const Key('ah-report-worker'),
                initialValue: workers.containsKey(_worker) ? _worker : null,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Worker'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('Everyone')),
                  for (final e in workers.entries) DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: (v) => setState(() => _worker = v),
              ),
            const SizedBox(height: AppSpacing.sm),
            FigureGrid(children: [
              FigureCard(label: 'Handovers', value: '${t.count}', valueKey: const Key('ah-report-count')),
              FigureCard(label: 'Expected cash', value: t.expected.format(), valueKey: const Key('ah-report-expected')),
              FigureCard(label: 'Cash received', value: t.received.format(), valueKey: const Key('ah-report-received')),
              FigureCard(label: 'Waiting to be received', value: '${t.awaiting}'),
              FigureCard(label: 'Shortages', value: t.shortages.format(), color: t.shortages.isPositive ? AppColors.danger : null, valueKey: const Key('ah-report-shortages')),
              FigureCard(label: 'Excesses', value: t.excesses.format(), color: t.excesses.isPositive ? AppColors.warning : null, valueKey: const Key('ah-report-excesses')),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(title: 'By worker', icon: Icons.people_outline, children: [
              if (byWorker.isEmpty) const Text('No handovers in this period.'),
              for (final e in byWorker.entries)
                Builder(builder: (context) {
                  final w = HandoverTotals.of(e.value);
                  return InfoRow(e.key, [
                    '${w.count} handover(s)',
                    'expected ${w.expected.format()}',
                    if (w.shortages.isPositive) 'short ${w.shortages.format()}',
                    if (w.excesses.isPositive) 'over ${w.excesses.format()}',
                  ].join(' · '));
                }),
            ]),
            Text('Figures come from the last ${AfterHoursRepository.listLimit} handovers loaded.', style: Theme.of(context).textTheme.bodySmall),
          ]);
        }),
      ),
    ]);
  }
}

class _PolicyTab extends ConsumerWidget {
  const _PolicyTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) => _async(
      ref.watch(afterHoursPolicyProvider),
      (p) => ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
            SectionCard(title: 'After-hours policy', icon: Icons.tune, children: [
              InfoRow('Payment methods', p.allowedPaymentMethods.map((m) => m.label).join(', ')),
              InfoRow('Longest authorisation', '${p.maxAuthorizationHours} hours'),
              InfoRow('Largest float', p.maxOpeningFloat.format()),
              const SizedBox(height: AppSpacing.xs),
              Text(
                'An authorisation only ever carries after-hours operation, cash collection, jobs, invoices, customers and '
                'vehicles. Payroll, users, settings, finance set-up, reversals, prices and discounts are never included, '
                'and nothing becomes permanent.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (canDo(ref, Permission.settingsManage))
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    key: const Key('edit-after-hours-policy'),
                    onPressed: () => showFormSheet<void>(context, AfterHoursPolicySheet(policy: p)),
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('Edit'),
                  ),
                ),
            ]),
          ]));
}

// ---------------------------------------------------------------------------
// Detail screens, shared by the dashboard and My After-Hours ([mine]).
// ---------------------------------------------------------------------------

class AfterHoursSessionScreen extends ConsumerWidget {
  const AfterHoursSessionScreen({super.key, required this.sessionId, this.mine = false});
  final String sessionId;
  final bool mine;

  Future<void> _close(BuildContext context, WidgetRef ref, AfterHoursSession s) async {
    final ok = await showConfirmDialog(context,
        title: 'Close ${s.sessionNumber}?',
        message: 'The expected cash is worked out from the recorded payments and fixed. '
            'You then hand the cash to a manager.',
        confirmLabel: 'Close session');
    if (!ok || !context.mounted) return;
    final r = await ref.read(afterHoursActionsProvider).closeSession(s.sessionId);
    if (!context.mounted) return;
    r.when(
      success: (v) => AppSnackbar.success(
          context, v.handoverNumber == null ? 'Session closed. Nothing to hand over.' : 'Session closed. Hand over ${v.expectedCash.format()} (${v.handoverNumber}).'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref, AfterHoursSession s) async {
    final reason = await showReasonDialog(context,
        title: 'Cancel ${s.sessionNumber}?', message: 'Only for a session opened by mistake, with nothing collected.', confirmLabel: 'Cancel session', destructive: true);
    if (reason == null || !context.mounted) return;
    final r = await ref.read(afterHoursActionsProvider).cancelSession(s.sessionId, reason: reason);
    if (context.mounted) reportResult(context, r, 'Session cancelled.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => _async(ref.watch(afterHoursSessionProvider(sessionId)), (s) {
        if (s == null) return const EmptyView(icon: Icons.nightlight_outlined, title: 'Session not found');
        final now = ref.watch(clockProvider).value ?? DateTime.now();
        final me = ref.watch(currentUserProvider)?.uid;
        final own = s.staffUid == me;
        final canAct = own || canDo(ref, Permission.afterHoursApprove);
        return ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
          ScreenHeader(s.sessionNumber, subtitle: s.staffName, onBack: () => context.go(mine ? AppRoutes.myAfterHours : AppRoutes.afterHours)),
          SectionCard(title: 'Session', icon: Icons.nightlight_outlined, trailing: SessionStatusChip(s.status), children: [
            InfoRow('Authorisation', s.authorizationNumber),
            if (s.supervisorName != null) InfoRow('Authorised by', s.supervisorName),
            if (s.openedAt != null) InfoRow('Opened', DateTimeFormatter.dateTime(s.openedAt!)),
            if (s.closedAt != null) InfoRow('Closed', '${DateTimeFormatter.dateTime(s.closedAt!)}${s.closedByName == null ? '' : ' by ${s.closedByName}'}'),
            InfoRow('Activity', '${s.intakesCreated} job(s) · ${s.invoicesCreated} invoice(s) · ${s.jobsCompleted} completed · ${s.paymentCount} payment(s)'),
            if (s.isOpen && s.authorizationEndedAt(now))
              const InlineError('The authorisation has ended. Close the session and hand over the cash.'),
          ]),
          ExpectedCashCard(
            title: 'Cash',
            openingFloat: s.openingFloat,
            cashCollected: s.cashCollected,
            cashReversed: s.cashReversed,
            nonCash: s.nonCashCollected,
            expected: s.expectedCash,
            footer: s.isOpen
                ? 'Worked out by the system from the payments recorded in this session.'
                : 'Fixed when the session closed.${s.postCloseReversals.isPositive ? ' ${s.postCloseReversals.format()} was reversed after closing; that refund came from Cash at Hand, not from this handover.' : ''}',
          ),
          if (s.handoverId != null)
            Card(
              child: ListTile(
                key: const Key('session-handover-link'),
                leading: const Icon(Icons.handshake_outlined),
                title: Text('Handover ${s.handoverNumber}'),
                subtitle: Text([s.handoverStatus?.label ?? '', if (s.difference != null) describeDifference(s.difference)].join(' · ')),
                onTap: () => context.go(mine ? AppRoutes.myHandover(s.handoverId!) : AppRoutes.afterHoursHandover(s.handoverId!)),
              ),
            ),
          if (own || canDo(ref, Permission.afterHoursView)) CustodyList(staffUid: s.staffUid, sessionId: s.sessionId),
          if (s.isOpen && canAct)
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              FilledButton.icon(
                key: const Key('close-session-button'),
                onPressed: () => _close(context, ref, s),
                icon: const Icon(Icons.stop_circle_outlined),
                label: const Text('Close session'),
              ),
              if (s.paymentCount == 0 && s.openingFloat.isZero)
                OutlinedButton.icon(
                  key: const Key('cancel-session-button'),
                  onPressed: () => _cancel(context, ref, s),
                  icon: const Icon(Icons.cancel_outlined),
                  label: const Text('Cancel'),
                ),
            ]),
        ]);
      });
}

class CashHandoverScreen extends ConsumerWidget {
  const CashHandoverScreen({super.key, required this.handoverId, this.mine = false});
  final String handoverId;
  final bool mine;

  @override
  Widget build(BuildContext context, WidgetRef ref) => _async(ref.watch(handoverProvider(handoverId)), (h) {
        if (h == null) return const EmptyView(icon: Icons.handshake_outlined, title: 'Handover not found');
        final me = ref.watch(currentUserProvider)?.uid;
        final own = h.staffUid == me;
        final canSubmit = h.status == HandoverStatus.pending && (own || canDo(ref, Permission.cashHandoverSubmit));
        final canReceive = h.status.awaitingReceipt && !own && canDo(ref, Permission.cashHandoverApprove);
        return ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
          ScreenHeader(h.handoverNumber, subtitle: h.staffName, onBack: () => context.go(mine ? AppRoutes.myAfterHours : AppRoutes.afterHours)),
          ExpectedCashCard(
            title: 'Expected cash',
            openingFloat: h.openingFloat,
            cashCollected: h.cashCollected,
            cashReversed: h.cashReversed,
            nonCash: h.nonCashCollected,
            expected: h.expectedCash,
            footer: 'Fixed by the system when session ${h.sessionNumber ?? ''} closed. It cannot be edited.',
          ),
          SectionCard(title: 'Handover', icon: Icons.handshake_outlined, trailing: HandoverStatusChip(h.status), children: [
            InfoRow('Session', h.sessionNumber),
            if (h.declaredAmount != null)
              InfoRow('Worker says', '${h.declaredAmount!.format()}'
                  '${h.submittedAt == null ? '' : ' · ${DateTimeFormatter.dateTime(h.submittedAt!)}'}'),
            if (h.submitNotes != null) InfoRow('Worker notes', h.submitNotes),
            if (h.actualAmount != null)
              InfoRow('Counted', '${h.actualAmount!.format()}${h.receivedByName == null ? '' : ' by ${h.receivedByName}'}',
                  valueWidget: Text('${h.actualAmount!.format()}${h.receivedByName == null ? '' : ' by ${h.receivedByName}'}', key: const Key('handover-actual'))),
            if (h.difference != null)
              InfoRow('Difference', describeDifference(h.difference),
                  valueWidget: Text(describeDifference(h.difference),
                      key: const Key('handover-difference'), style: TextStyle(color: differenceColor(h.difference), fontWeight: FontWeight.w600))),
            if (h.explanation != null) InfoRow('Explanation', h.explanation),
            if (h.receiveNotes != null) InfoRow('Notes', h.receiveNotes),
            const InfoRow('Destination', 'Cash at Hand (already recorded with each payment)'),
          ]),
          if (h.discrepancyId != null)
            Card(
              child: ListTile(
                key: const Key('handover-discrepancy-link'),
                leading: const Icon(Icons.report_problem_outlined, color: AppColors.danger),
                title: Text('Discrepancy ${h.discrepancyNumber}'),
                onTap: () => context.go(mine ? AppRoutes.myDiscrepancy(h.discrepancyId!) : AppRoutes.afterHoursDiscrepancy(h.discrepancyId!)),
              ),
            ),
          Card(
            child: ListTile(
              leading: const Icon(Icons.nightlight_outlined),
              title: Text('Session ${h.sessionNumber ?? ''}'),
              onTap: () => context.go(mine ? AppRoutes.mySession(h.sessionId) : AppRoutes.afterHoursSession(h.sessionId)),
            ),
          ),
          Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
            if (canSubmit)
              FilledButton.icon(
                key: const Key('submit-handover-button'),
                onPressed: () => showFormSheet<void>(context, SubmitHandoverSheet(handover: h)),
                icon: const Icon(Icons.outbox_outlined),
                label: const Text('Submit handover'),
              ),
            if (canReceive)
              FilledButton.icon(
                key: const Key('receive-handover-button'),
                onPressed: () => showFormSheet<void>(context, ReceiveHandoverSheet(handover: h)),
                icon: const Icon(Icons.move_to_inbox_outlined),
                label: const Text('Receive cash'),
              ),
          ]),
        ]);
      });
}

class CashDiscrepancyScreen extends ConsumerWidget {
  const CashDiscrepancyScreen({super.key, required this.discrepancyId, this.mine = false});
  final String discrepancyId;
  final bool mine;

  Future<void> _review(BuildContext context, WidgetRef ref, CashDiscrepancy d) async {
    final notes = await showReasonDialog(context,
        title: 'Review ${d.discrepancyNumber}', message: 'Record what you are checking.', confirmLabel: 'Start review', reasonLabel: 'Review notes');
    if (notes == null || !context.mounted) return;
    final r = await ref.read(afterHoursActionsProvider).reviewDiscrepancy(d.discrepancyId, notes: notes);
    if (context.mounted) reportResult(context, r, 'Discrepancy under review.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => _async(ref.watch(discrepancyProvider(discrepancyId)), (d) {
        if (d == null) return const EmptyView(icon: Icons.report_problem_outlined, title: 'Discrepancy not found');
        final me = ref.watch(currentUserProvider)?.uid;
        final canDecide = d.status.isOpen && d.staffUid != me && canDo(ref, Permission.afterHoursDiscrepancyReview);
        return ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
          ScreenHeader(d.discrepancyNumber, subtitle: d.staffName, onBack: () => context.go(mine ? AppRoutes.myAfterHours : AppRoutes.afterHours)),
          SectionCard(title: d.kind.label, icon: Icons.report_problem_outlined, trailing: DiscrepancyStatusChip(d.status), children: [
            InfoRow('Handover', d.handoverNumber),
            MoneyLine('Expected cash', d.expectedCash),
            if (d.declaredAmount != null) MoneyLine('Worker said', d.declaredAmount!),
            MoneyLine('Counted', d.actualAmount),
            InfoRow('Difference', describeDifference(d.difference),
                valueWidget: Text(describeDifference(d.difference),
                    key: const Key('discrepancy-difference'), style: TextStyle(color: differenceColor(d.difference), fontWeight: FontWeight.w600))),
            InfoRow('Explanation', d.reason),
            if (d.reportedByName != null)
              InfoRow('Recorded by', '${d.reportedByName}${d.reportedAt == null ? '' : ' · ${DateTimeFormatter.dateTime(d.reportedAt!)}'}'),
            if (d.reviewNotes != null) InfoRow('Review', '${d.reviewNotes}${d.reviewedByName == null ? '' : ' (${d.reviewedByName})'}'),
            if (d.resolution != null) InfoRow('Resolution', '${d.resolution}${d.resolvedByName == null ? '' : ' (${d.resolvedByName})'}'),
            if (d.lossNumber != null) InfoRow('Loss incident', '${d.lossNumber} (awaiting its own decision)'),
            if (d.adjustmentTransactionNumber != null) InfoRow('Adjustment', d.adjustmentTransactionNumber),
          ]),
          if (canDecide)
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              if (d.status == DiscrepancyStatus.open)
                OutlinedButton.icon(
                  key: const Key('review-discrepancy-button'),
                  onPressed: () => _review(context, ref, d),
                  icon: const Icon(Icons.manage_search),
                  label: const Text('Review'),
                ),
              FilledButton.icon(
                key: const Key('resolve-discrepancy-button'),
                onPressed: () => showFormSheet<void>(context, ResolveDiscrepancySheet(discrepancy: d)),
                icon: const Icon(Icons.task_alt),
                label: const Text('Resolve or waive'),
              ),
            ]),
        ]);
      });
}
