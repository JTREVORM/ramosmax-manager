import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/app_user.dart';
import '../../../models/work_order.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/jobs_providers.dart';

class WorkOrderStatusChip extends StatelessWidget {
  const WorkOrderStatusChip(this.status, {super.key});
  final WorkOrderStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        WorkOrderStatus.pending => const StatusChip('Pending', color: AppColors.warning, icon: Icons.hourglass_empty),
        WorkOrderStatus.assigned => const StatusChip('Assigned', color: AppColors.info, icon: Icons.person_pin_outlined),
        WorkOrderStatus.accepted => const StatusChip('Accepted', color: AppColors.info, icon: Icons.thumb_up_alt_outlined),
        WorkOrderStatus.inProgress => const StatusChip('In progress', color: AppColors.success, icon: Icons.play_circle_outline),
        WorkOrderStatus.paused => const StatusChip('Paused', color: AppColors.warning, icon: Icons.pause_circle_outline),
        WorkOrderStatus.completed => const StatusChip('Completed', color: AppColors.success, icon: Icons.check_circle_outline),
        WorkOrderStatus.cancelled => const StatusChip('Cancelled', color: AppColors.danger, icon: Icons.cancel_outlined),
      };
}

String formatWorked(Duration d) {
  final h = d.inHours;
  final m = d.inMinutes.remainder(60);
  return h > 0 ? '${h}h ${m}m' : '${m}m';
}

void _show(BuildContext context, Result<void> r, String ok) {
  if (!context.mounted) return;
  r.when(success: (_) => AppSnackbar.success(context, ok), failure: (f) => AppSnackbar.error(context, f.message));
}

/// Runs a worker action, asking for what it needs first: a reason to pause,
/// a confirmation (with optional notes) to complete.
Future<void> runWorkerAction(BuildContext context, WidgetRef ref, WorkOrder o, WorkerAction action) async {
  String? reason;
  String? notes;
  switch (action) {
    case WorkerAction.pause:
      reason = await showReasonDialog(context,
          title: 'Pause ${o.serviceName}?', message: 'Say why the work is stopping, e.g. waiting for water.', confirmLabel: 'Pause');
      if (reason == null) return;
    case WorkerAction.complete:
      final entered = await showReasonDialog(context,
          title: 'Complete ${o.serviceName} on ${o.numberPlate}?',
          message: 'Only mark it complete when the work is finished and checked. This cannot be undone.',
          confirmLabel: 'Complete',
          reasonRequired: false,
          reasonLabel: 'Completion notes');
      if (entered == null) return;
      notes = entered.isEmpty ? null : entered;
    case WorkerAction.accept || WorkerAction.start || WorkerAction.resume:
      break;
  }
  if (!context.mounted) return;
  final r = await ref.read(jobsActionsProvider).act(o.workerOrderId, action, reason: reason, completionNotes: notes);
  if (context.mounted) _show(context, r, '${o.serviceName}: ${action.done}.');
}

/// Picks an active person who can carry out jobs.
Future<AppUser?> pickWorker(BuildContext context, {String? exclude}) => showModalBottomSheet<AppUser>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.6,
          child: Consumer(
            builder: (context, ref, _) => switch (ref.watch(assignableWorkersProvider)) {
              AsyncData(:final value) when value.where((u) => u.uid != exclude).isEmpty =>
                const EmptyView(icon: Icons.person_off_outlined, title: 'No one available',
                    message: 'No other active staff member can carry out jobs.'),
              AsyncData(:final value) => ListView(children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                    child: Text('Assign to', style: Theme.of(context).textTheme.titleMedium),
                  ),
                  for (final u in value)
                    if (u.uid != exclude)
                      ListTile(
                        key: Key('pick-worker-${u.uid}'),
                        leading: CircleAvatar(child: Text(u.initials)),
                        title: Text(u.displayName),
                        subtitle: Text([u.role.label, ?u.specialization?.label].join(' · ')),
                        onTap: () => Navigator.of(sheet).pop(u),
                      ),
                ]),
              AsyncError() => const EmptyView(icon: Icons.lock_outline, title: 'Cannot load staff',
                  message: 'You need permission to view staff to assign work.'),
              _ => const LoadingView(),
            },
          ),
        ),
      ),
    );

/// A work order as a worker sees it: vehicle, service, status and the
/// actions they can take next.
class WorkOrderCard extends ConsumerWidget {
  const WorkOrderCard({super.key, required this.order, required this.now, this.showActions = true});
  final WorkOrder order;
  final DateTime now;
  final bool showActions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final o = order;
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    return Card(
      key: Key('work-order-${o.workerOrderId}'),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Flexible(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: PlateBadge(o.numberPlate))),
            const SizedBox(width: AppSpacing.xs),
            const Spacer(),
            WorkOrderStatusChip(o.status),
          ]),
          const SizedBox(height: AppSpacing.xs),
          Text(o.serviceName, style: theme.textTheme.titleMedium),
          Text([o.orderNumber, ?o.vehicleSummary].join(' · '), style: muted),
          if (o.notes != null) Text('Notes: ${o.notes}', style: theme.textTheme.bodySmall),
          if (o.status == WorkOrderStatus.paused && o.pauseReason != null)
            Text('Paused: ${o.pauseReason}', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.warning)),
          if (o.startedAt != null)
            Text('Worked: ${formatWorked(o.workedTime(now))}', style: muted),
          if (o.completedAt != null) Text('Completed ${DateTimeFormatter.dateTime(o.completedAt!)}', style: muted),
          if (showActions && o.workerActions.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.xs),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              for (final a in o.workerActions)
                a == WorkerAction.pause
                    ? OutlinedButton.icon(
                        key: Key('order-${a.key}-${o.workerOrderId}'),
                        onPressed: () => runWorkerAction(context, ref, o, a),
                        icon: const Icon(Icons.pause),
                        label: Text(a.label),
                      )
                    : FilledButton.icon(
                        key: Key('order-${a.key}-${o.workerOrderId}'),
                        onPressed: () => runWorkerAction(context, ref, o, a),
                        icon: Icon(switch (a) {
                          WorkerAction.accept => Icons.thumb_up_alt_outlined,
                          WorkerAction.start || WorkerAction.resume => Icons.play_arrow,
                          WorkerAction.complete => Icons.check,
                          WorkerAction.pause => Icons.pause,
                        }),
                        label: Text(a.label),
                      ),
            ]),
          ],
        ]),
      ),
    );
  }
}
