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
import '../../../models/after_hours.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../application/after_hours_providers.dart';
import 'after_hours_sheets.dart';
import 'after_hours_widgets.dart';

/// A worker's own after-hours work (after_hours.request): the authorisation,
/// the open session and its expected cash, handovers still to make, and
/// history. Only the worker's own records are queried.
class MyAfterHoursScreen extends ConsumerStatefulWidget {
  const MyAfterHoursScreen({super.key});

  @override
  ConsumerState<MyAfterHoursScreen> createState() => _MyAfterHoursScreenState();
}

class _MyAfterHoursScreenState extends ConsumerState<MyAfterHoursScreen> {
  /// One key per attempt: a retried "open" after a lost response opens once.
  String _openRequestId = newRequestId();
  bool _busy = false;

  Future<void> _open() async {
    setState(() => _busy = true);
    final r = await ref.read(afterHoursActionsProvider).openSession(requestId: _openRequestId);
    if (!mounted) return;
    setState(() => _busy = false);
    r.when(
      success: (_) {
        _openRequestId = newRequestId();
        AppSnackbar.success(context, 'After-hours session opened.');
      },
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  Future<void> _close(AfterHoursSession s) async {
    final ok = await showConfirmDialog(context,
        title: 'Close ${s.sessionNumber}?',
        message: 'The expected cash is worked out from your recorded payments and fixed. Then hand the cash to a manager.',
        confirmLabel: 'Close session');
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    final r = await ref.read(afterHoursActionsProvider).closeSession(s.sessionId);
    if (!mounted) return;
    setState(() => _busy = false);
    r.when(
      success: (v) => AppSnackbar.success(
          context, v.handoverNumber == null ? 'Session closed. Nothing to hand over.' : 'Session closed. Hand over ${v.expectedCash.format()}.'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  @override
  Widget build(BuildContext context) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final auths = ref.watch(myAuthorizationsProvider);
    final sessions = ref.watch(mySessionsProvider);
    final handovers = ref.watch(myHandoversProvider).value ?? const <CashHandover>[];
    final discrepancies = ref.watch(myDiscrepanciesProvider).value ?? const <CashDiscrepancy>[];
    if (auths is AsyncError) return ErrorView.failure(ErrorMapper.map(auths.error!));
    if (auths is! AsyncData || sessions is! AsyncData) return const LoadingView();

    final all = auths.value!;
    final live = all.where((a) => a.isLive(now)).toList();
    final upcoming = all.where((a) => a.phaseAt(now) == AuthorizationPhase.scheduled).toList();
    final open = ref.watch(myOpenSessionProvider);
    final toHandOver = handovers.where((h) => h.status == HandoverStatus.pending).toList();
    final canOpen = open == null && live.isNotEmpty && canDo(ref, Permission.afterHoursOperate);

    return ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
      // --- authorisation ---
      if (live.isEmpty)
        SectionCard(title: 'After-hours authorisation', icon: Icons.nightlight_outlined, children: [
          const Text('You have no after-hours authorisation in force now.', key: Key('my-ah-none')),
          for (final a in upcoming) InfoRow(a.authorizationNumber, 'Starts ${windowText(a.startsAt, a.expiresAt)}'),
        ])
      else
        for (final a in live)
          SectionCard(
            key: Key('my-ah-authorization-${a.authorizationId}'),
            title: 'Authorised: ${a.authorizationNumber}',
            icon: Icons.nightlight_outlined,
            trailing: AuthorizationPhaseChip(a.phaseAt(now)),
            children: [
              InfoRow('Until', DateTimeFormatter.dateTime(a.expiresAt)),
              if (a.grantedByName != null) InfoRow('Authorised by', a.grantedByName),
              InfoRow('You may', a.permissions.map((p) => p.label).join(', ')),
              if (a.openingFloat.isPositive) MoneyLine('Opening float', a.openingFloat),
            ],
          ),
      if (canOpen)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
          child: FilledButton.icon(
            key: const Key('open-session-button'),
            onPressed: _busy ? null : _open,
            icon: const Icon(Icons.play_circle_outline),
            label: const Text('Start after-hours session'),
          ),
        ),
      // --- open session ---
      if (open != null) ...[
        if (open.authorizationEndedAt(now))
          const Padding(
            padding: EdgeInsets.only(bottom: AppSpacing.xs),
            child: InlineError('Your authorisation has ended. Close the session and hand over the cash.'),
          ),
        SectionCard(
          key: const Key('my-open-session'),
          title: 'Session ${open.sessionNumber}',
          icon: Icons.play_circle_outline,
          trailing: SessionStatusChip(open.status),
          children: [
            if (open.openedAt != null) InfoRow('Started', DateTimeFormatter.dateTime(open.openedAt!)),
            InfoRow('Activity', '${open.intakesCreated} job(s) · ${open.invoicesCreated} invoice(s) · ${open.paymentCount} payment(s)'),
            const SizedBox(height: AppSpacing.xs),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              FilledButton.icon(
                key: const Key('my-close-session'),
                onPressed: _busy ? null : () => _close(open),
                icon: const Icon(Icons.stop_circle_outlined),
                label: const Text('Close session'),
              ),
              OutlinedButton(onPressed: () => context.go(AppRoutes.mySession(open.sessionId)), child: const Text('Details')),
            ]),
          ],
        ),
        ExpectedCashCard(
          title: 'Cash you are holding',
          openingFloat: open.openingFloat,
          cashCollected: open.cashCollected,
          cashReversed: open.cashReversed,
          nonCash: open.nonCashCollected,
          expected: open.expectedCash,
          footer: 'Worked out by the system from the payments you record. You cannot change it.',
        ),
        CustodyList(staffUid: open.staffUid, sessionId: open.sessionId),
      ],
      // --- handovers to make ---
      for (final h in toHandOver)
        Card(
          key: Key('my-handover-due-${h.handoverId}'),
          color: Theme.of(context).colorScheme.tertiaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.sm),
            child: Row(children: [
              const Icon(Icons.outbox_outlined),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Hand over ${h.expectedCash.format()}', style: Theme.of(context).textTheme.titleSmall),
                  Text('${h.handoverNumber} · session ${h.sessionNumber ?? ''}', style: Theme.of(context).textTheme.bodySmall),
                ]),
              ),
              FilledButton(
                key: Key('my-submit-${h.handoverId}'),
                style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                onPressed: () => showFormSheet<void>(context, SubmitHandoverSheet(handover: h)),
                child: const Text('Submit'),
              ),
            ]),
          ),
        ),
      // --- history ---
      if (handovers.isNotEmpty) ...[
        const SizedBox(height: AppSpacing.sm),
        Text('Handovers', style: Theme.of(context).textTheme.titleMedium),
        for (final h in handovers) HandoverTile(handover: h, onTap: () => context.go(AppRoutes.myHandover(h.handoverId))),
      ],
      if (discrepancies.isNotEmpty) ...[
        const SizedBox(height: AppSpacing.sm),
        Text('Discrepancies', style: Theme.of(context).textTheme.titleMedium),
        for (final d in discrepancies) DiscrepancyTile(discrepancy: d, onTap: () => context.go(AppRoutes.myDiscrepancy(d.discrepancyId))),
      ],
      if (sessions.value!.isNotEmpty) ...[
        const SizedBox(height: AppSpacing.sm),
        Text('Sessions', style: Theme.of(context).textTheme.titleMedium),
        for (final s in sessions.value!) SessionTile(session: s, onTap: () => context.go(AppRoutes.mySession(s.sessionId))),
      ],
    ]);
  }
}
