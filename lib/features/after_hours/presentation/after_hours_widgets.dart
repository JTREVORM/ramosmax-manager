import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/after_hours.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../application/after_hours_providers.dart';

// Building blocks shared by the After-Hours dashboard and My After-Hours.

class AuthorizationPhaseChip extends StatelessWidget {
  const AuthorizationPhaseChip(this.phase, {super.key});
  final AuthorizationPhase phase;

  @override
  Widget build(BuildContext context) => switch (phase) {
        AuthorizationPhase.scheduled => const StatusChip('Scheduled', color: AppColors.info, icon: Icons.schedule),
        AuthorizationPhase.live => const StatusChip('In force', color: AppColors.success, icon: Icons.check_circle_outline),
        AuthorizationPhase.ended => const StatusChip('Ended', color: Colors.grey, icon: Icons.timer_off_outlined),
        AuthorizationPhase.revoked => const StatusChip('Revoked', color: AppColors.danger, icon: Icons.block),
      };
}

class SessionStatusChip extends StatelessWidget {
  const SessionStatusChip(this.status, {super.key});
  final SessionStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        SessionStatus.open => const StatusChip('Open', color: AppColors.success, icon: Icons.play_circle_outline),
        SessionStatus.closed => const StatusChip('Closed', color: Colors.grey, icon: Icons.stop_circle_outlined),
        SessionStatus.handoverPending => const StatusChip('Handover pending', color: AppColors.warning, icon: Icons.hourglass_top),
        SessionStatus.reconciled => const StatusChip('Reconciled', color: AppColors.info, icon: Icons.fact_check_outlined),
        SessionStatus.cancelled => const StatusChip('Cancelled', color: Colors.grey, icon: Icons.cancel_outlined),
      };
}

class HandoverStatusChip extends StatelessWidget {
  const HandoverStatusChip(this.status, {super.key});
  final HandoverStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        HandoverStatus.pending => const StatusChip('Waiting for the worker', color: AppColors.warning, icon: Icons.hourglass_top),
        HandoverStatus.submitted => const StatusChip('To receive', color: AppColors.warning, icon: Icons.inbox_outlined),
        HandoverStatus.received => const StatusChip('Received', color: AppColors.success, icon: Icons.check_circle_outline),
        HandoverStatus.discrepancy => const StatusChip('Discrepancy', color: AppColors.danger, icon: Icons.report_problem_outlined),
        HandoverStatus.reconciled => const StatusChip('Reconciled', color: AppColors.info, icon: Icons.fact_check_outlined),
      };
}

class DiscrepancyStatusChip extends StatelessWidget {
  const DiscrepancyStatusChip(this.status, {super.key});
  final DiscrepancyStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        DiscrepancyStatus.open => const StatusChip('Open', color: AppColors.danger, icon: Icons.report_problem_outlined),
        DiscrepancyStatus.underReview => const StatusChip('Under review', color: AppColors.warning, icon: Icons.manage_search),
        DiscrepancyStatus.resolved => const StatusChip('Resolved', color: AppColors.success, icon: Icons.check_circle_outline),
        DiscrepancyStatus.waived => const StatusChip('Waived', color: AppColors.info, icon: Icons.do_not_disturb_on_outlined),
      };
}

/// `− UGX 5,000 shortage` / `+ UGX 5,000 excess` / `Balanced`.
String describeDifference(Money? difference) {
  if (difference == null) return '—';
  if (difference.isZero) return 'Balanced';
  return difference.isNegative ? '− ${(-difference).format()} shortage' : '+ ${difference.format()} excess';
}

Color differenceColor(Money? difference) => difference == null || difference.isZero
    ? AppColors.success
    : (difference.isNegative ? AppColors.danger : AppColors.warning);

String windowText(DateTime start, DateTime end) => '${DateTimeFormatter.dateTime(start)} – ${DateTimeFormatter.dateTime(end)}';

class AuthorizationTile extends StatelessWidget {
  const AuthorizationTile({super.key, required this.authorization, required this.now, this.trailing});
  final AfterHoursAuthorization authorization;
  final DateTime now;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final a = authorization;
    return Card(
      key: Key('authorization-${a.authorizationId}'),
      child: ListTile(
        title: Text('${a.authorizationNumber} · ${a.staffName}', overflow: TextOverflow.ellipsis),
        subtitle: Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xxs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text([
            windowText(a.startsAt, a.expiresAt),
            if (a.openingFloat.isPositive) 'float ${a.openingFloat.format()}',
            if (a.grantedByName != null) 'by ${a.grantedByName}',
            if (a.revokeReason != null) 'revoked: ${a.revokeReason}',
          ].join(' · ')),
          AuthorizationPhaseChip(a.phaseAt(now)),
        ]),
        trailing: trailing,
      ),
    );
  }
}

class SessionTile extends StatelessWidget {
  const SessionTile({super.key, required this.session, this.onTap});
  final AfterHoursSession session;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = session;
    return Card(
      key: Key('session-${s.sessionId}'),
      child: ListTile(
        onTap: onTap,
        title: Row(children: [
          Expanded(child: Text('${s.sessionNumber} · ${s.staffName}', overflow: TextOverflow.ellipsis)),
          Text(s.expectedCash.format(), style: Theme.of(context).textTheme.titleSmall),
        ]),
        subtitle: Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xxs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text([
            if (s.openedAt != null) DateTimeFormatter.dateTime(s.openedAt!),
            '${s.paymentCount} payment(s)',
            if (s.difference != null && !s.difference!.isZero) describeDifference(s.difference),
          ].join(' · ')),
          SessionStatusChip(s.status),
        ]),
      ),
    );
  }
}

class HandoverTile extends StatelessWidget {
  const HandoverTile({super.key, required this.handover, this.onTap});
  final CashHandover handover;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final h = handover;
    return Card(
      key: Key('handover-${h.handoverId}'),
      child: ListTile(
        onTap: onTap,
        title: Row(children: [
          Expanded(child: Text('${h.handoverNumber} · ${h.staffName}', overflow: TextOverflow.ellipsis)),
          Text(h.expectedCash.format(), style: Theme.of(context).textTheme.titleSmall),
        ]),
        subtitle: Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xxs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text([
            ?h.sessionNumber,
            if (h.createdAt != null) DateTimeFormatter.dateTime(h.createdAt!),
            if (h.difference != null) describeDifference(h.difference),
          ].join(' · ')),
          HandoverStatusChip(h.status),
        ]),
      ),
    );
  }
}

class DiscrepancyTile extends StatelessWidget {
  const DiscrepancyTile({super.key, required this.discrepancy, this.onTap});
  final CashDiscrepancy discrepancy;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final d = discrepancy;
    return Card(
      key: Key('discrepancy-${d.discrepancyId}'),
      child: ListTile(
        onTap: onTap,
        title: Row(children: [
          Expanded(child: Text('${d.discrepancyNumber} · ${d.staffName}', overflow: TextOverflow.ellipsis)),
          Text(describeDifference(d.difference), style: Theme.of(context).textTheme.titleSmall?.copyWith(color: differenceColor(d.difference))),
        ]),
        subtitle: Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xxs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text([?d.handoverNumber, if (d.createdAt != null) DateTimeFormatter.dateTime(d.createdAt!)].join(' · ')),
          DiscrepancyStatusChip(d.status),
        ]),
      ),
    );
  }
}

/// How the expected cash is made up. Every figure is server-written.
class ExpectedCashCard extends StatelessWidget {
  const ExpectedCashCard({
    super.key,
    required this.title,
    required this.openingFloat,
    required this.cashCollected,
    required this.cashReversed,
    required this.nonCash,
    required this.expected,
    this.footer,
  });

  final String title;
  final Money openingFloat;
  final Money cashCollected;
  final Money cashReversed;
  final Money nonCash;
  final Money expected;
  final String? footer;

  @override
  Widget build(BuildContext context) => SectionCard(title: title, icon: Icons.payments_outlined, children: [
        MoneyLine('Opening float', openingFloat),
        MoneyLine('Cash collected', cashCollected),
        if (cashReversed.isPositive) MoneyLine('Cash reversed', cashReversed, negative: true),
        MoneyLine('Expected cash', expected, emphasis: true, valueKey: const Key('expected-cash')),
        MoneyLine('Mobile money (not handed over)', nonCash),
        if (footer != null) Text(footer!, style: Theme.of(context).textTheme.bodySmall),
      ]);
}

/// The custody entries of one session (float, payments, reversals).
class CustodyList extends ConsumerWidget {
  const CustodyList({super.key, required this.staffUid, required this.sessionId});
  final String staffUid;
  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => SectionCard(
        title: 'Money in custody',
        icon: Icons.receipt_long_outlined,
        children: [
          switch (ref.watch(custodyProvider((staffUid: staffUid, sessionId: sessionId)))) {
            AsyncData(:final value) when value.isEmpty => const Text('Nothing collected yet.'),
            AsyncData(:final value) => Column(children: [
                for (final e in value)
                  ListTile(
                    key: Key('custody-${e.entryId}'),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text([e.kind.label, e.method.label, ?e.receiptNumber].join(' · ')),
                    subtitle: Text([
                      ?e.numberPlate,
                      if (e.createdAt != null) DateTimeFormatter.dateTime(e.createdAt!),
                      if (e.afterSessionClosed) 'after the session closed: not in the handover',
                      if (!e.affectsExpected && !e.afterSessionClosed && e.kind != CustodyKind.openingFloat) 'not cash',
                    ].join(' · ')),
                    trailing: Text(e.amount.format()),
                  ),
              ]),
            AsyncError(:final error) => Text(ErrorMapper.map(error).message),
            _ => const LoadingView(),
          },
        ],
      );
}
