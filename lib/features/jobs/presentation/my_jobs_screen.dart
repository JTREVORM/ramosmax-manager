import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/work_order.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../application/jobs_providers.dart';
import 'job_widgets.dart';

enum MyJobsFilter {
  todo('To do'),
  done('Done'),
  all('All');

  const MyJobsFilter(this.label);
  final String label;

  bool matches(WorkOrder o) => switch (this) {
        todo => !o.status.isFinished,
        done => o.status.isFinished,
        all => true,
      };
}

/// The worker dashboard: only the orders assigned to the signed-in worker
/// (the rules enforce this), with the next action on each one.
class MyJobsScreen extends ConsumerStatefulWidget {
  const MyJobsScreen({super.key});

  @override
  ConsumerState<MyJobsScreen> createState() => _MyJobsScreenState();
}

class _MyJobsScreenState extends ConsumerState<MyJobsScreen> {
  MyJobsFilter _filter = MyJobsFilter.todo;

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(currentUserProvider);
    if (user == null) return const LoadingView();
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final theme = Theme.of(context);
    final orders = ref.watch(myOrdersProvider(user.uid));
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
        child: Align(alignment: Alignment.centerLeft, child: Text('My jobs', style: theme.textTheme.titleLarge)),
      ),
      if (orders case AsyncData(:final value)) _Summary(orders: value),
      FilterChips<MyJobsFilter>(
        values: MyJobsFilter.values,
        selected: _filter,
        label: (f) => f.label,
        keyPrefix: 'my-jobs-filter',
        onSelected: (f) => setState(() => _filter = f),
      ),
      Expanded(
        child: switch (orders) {
          AsyncData(:final value) => () {
              // Work in progress first, then newest.
              final shown = value.where(_filter.matches).toList()
                ..sort((a, b) => _rank(a.status).compareTo(_rank(b.status)));
              if (shown.isEmpty) {
                return EmptyView(
                  icon: Icons.assignment_turned_in_outlined,
                  title: _filter == MyJobsFilter.todo ? 'Nothing to do right now' : 'No jobs here',
                  message: _filter == MyJobsFilter.todo ? 'New jobs appear here as soon as a manager assigns them.' : null,
                );
              }
              return ListView(
                key: const Key('my-jobs-list'),
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                children: [
                  for (final o in shown)
                    Padding(padding: const EdgeInsets.only(bottom: AppSpacing.xs), child: WorkOrderCard(order: o, now: now)),
                ],
              );
            }(),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }

  static int _rank(WorkOrderStatus s) => switch (s) {
        WorkOrderStatus.inProgress => 0,
        WorkOrderStatus.paused => 1,
        WorkOrderStatus.accepted => 2,
        WorkOrderStatus.assigned => 3,
        WorkOrderStatus.pending => 4,
        WorkOrderStatus.completed => 5,
        WorkOrderStatus.cancelled => 6,
      };
}

class _Summary extends StatelessWidget {
  const _Summary({required this.orders});
  final List<WorkOrder> orders;

  @override
  Widget build(BuildContext context) {
    int count(bool Function(WorkOrder) f) => orders.where(f).length;
    final newJobs = count((o) => o.status == WorkOrderStatus.assigned);
    final active = count((o) => o.status.isActive);
    final done = count((o) => o.status == WorkOrderStatus.completed);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: Row(children: [
        Expanded(child: _Stat(key: const Key('my-jobs-new'), label: 'New', value: newJobs)),
        Expanded(child: _Stat(key: const Key('my-jobs-active'), label: 'In hand', value: active)),
        Expanded(child: _Stat(key: const Key('my-jobs-done'), label: 'Completed', value: done)),
      ]),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({super.key, required this.label, required this.value});
  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: Column(children: [
          Text('$value', style: theme.textTheme.headlineSmall),
          Text(label, style: theme.textTheme.bodySmall),
        ]),
      ),
    );
  }
}
