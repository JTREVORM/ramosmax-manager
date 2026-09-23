import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/catalog_service.dart';
import '../../../models/service_intake.dart';
import '../../../models/vehicle.dart';
import '../../../routes/app_routes.dart';
import '../../../core/providers/core_providers.dart';
import '../../../models/work_order.dart';
import '../../billing/application/billing_providers.dart';
import '../../jobs/application/jobs_providers.dart';
import '../../jobs/presentation/job_widgets.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/operations_providers.dart';
import 'operations_widgets.dart';

/// Active services grouped by category, in category order.
Map<ServiceCategory, List<CatalogService>> groupActive(List<CatalogService> all) {
  final groups = <ServiceCategory, List<CatalogService>>{};
  for (final c in ServiceCategory.values) {
    final inCat = all.where((s) => s.isActive && s.category == c).toList();
    if (inCat.isNotEmpty) groups[c] = inCat;
  }
  return groups;
}

/// Checklist of active services. Used to start a service and to change the
/// services of an open intake.
class ServiceChecklist extends StatelessWidget {
  const ServiceChecklist({super.key, required this.services, required this.selected, required this.onChanged});
  final List<CatalogService> services;
  final Set<String> selected;
  final void Function(String serviceId, bool selected) onChanged;

  @override
  Widget build(BuildContext context) {
    final groups = groupActive(services);
    if (groups.isEmpty) {
      return const EmptyView(icon: Icons.local_car_wash_outlined, title: 'No services are offered yet',
          message: 'A manager needs to add services to the catalogue first.');
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final entry in groups.entries) ...[
        Padding(
          padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: AppSpacing.xxs),
          child: Text(entry.key.label, style: Theme.of(context).textTheme.labelLarge),
        ),
        for (final s in entry.value)
          Card(
            child: CheckboxListTile(
              key: Key('select-service-${s.serviceId}'),
              value: selected.contains(s.serviceId),
              onChanged: (v) => onChanged(s.serviceId, v ?? false),
              title: Text(s.name),
              subtitle: Text([s.price.format(), ?s.durationLabel].join(' · ')),
              controlAffinity: ListTileControlAffinity.leading,
            ),
          ),
      ],
    ]);
  }
}

/// Vehicle → select services → service intake created.
class StartServiceScreen extends ConsumerStatefulWidget {
  const StartServiceScreen({super.key, required this.vehicleId});
  final String vehicleId;

  @override
  ConsumerState<StartServiceScreen> createState() => _StartServiceScreenState();
}

class _StartServiceScreenState extends ConsumerState<StartServiceScreen> {
  final _selected = <String>{};
  final _notes = TextEditingController();
  bool _saving = false;
  String? _error;
  String? _openIntakeId;

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  Future<void> _create(Vehicle v, List<CatalogService> services) async {
    // Keep the selection in catalogue order.
    final ids = [for (final s in services) if (_selected.contains(s.serviceId)) s.serviceId];
    setState(() {
      _saving = true;
      _error = null;
      _openIntakeId = null;
    });
    final r = await ref.read(operationsActionsProvider).createServiceIntake(v.vehicleId, ids,
        notes: _notes.text.trim().isEmpty ? null : _notes.text.trim());
    if (!mounted) return;
    setState(() => _saving = false);
    switch (r) {
      case Success(:final value):
        AppSnackbar.success(context, 'Service started for ${v.numberPlate}.');
        context.go(AppRoutes.intakeDetail(value));
      case Failure(:final error):
        setState(() {
          _error = error.message;
          final id = error.details?['intakeId'];
          _openIntakeId = error.code == 'open_intake_exists' && id is String ? id : null;
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!canDo(ref, Permission.jobsCreate)) {
      return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted', message: 'You cannot start services.');
    }
    final theme = Theme.of(context);
    final vehicle = ref.watch(vehicleProvider(widget.vehicleId));
    final services = ref.watch(servicesProvider);
    return switch ((vehicle, services)) {
      (AsyncData(value: final Vehicle v), AsyncData(value: final all)) => ListView(
          key: const Key('start-service-list'),
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
          children: [
            Row(children: [
              IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back),
                  onPressed: () => context.go(AppRoutes.vehicleDetail(v.vehicleId))),
              Expanded(child: Text('Start service', style: theme.textTheme.titleLarge)),
            ]),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.sm),
                child: Row(children: [
                  Flexible(child: FittedBox(fit: BoxFit.scaleDown, child: PlateBadge(v.numberPlate, large: true))),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(v.description, style: theme.textTheme.titleMedium),
                      Text(v.customerName ?? 'No customer linked', style: theme.textTheme.bodySmall),
                    ]),
                  ),
                ]),
              ),
            ),
            if (!v.isActive) ...[
              const SizedBox(height: AppSpacing.sm),
              const InlineError('This vehicle is inactive. Reactivate it before starting a service.'),
            ],
            const SizedBox(height: AppSpacing.sm),
            Text('Select services', style: theme.textTheme.titleMedium),
            ServiceChecklist(
              services: all,
              selected: _selected,
              onChanged: (id, on) => setState(() => on ? _selected.add(id) : _selected.remove(id)),
            ),
            const SizedBox(height: AppSpacing.sm),
            TextField(
              key: const Key('intake-notes-field'),
              controller: _notes,
              minLines: 1,
              maxLines: 3,
              maxLength: 500,
              decoration: const InputDecoration(labelText: 'Notes (optional)', hintText: 'e.g. Scratch on rear door'),
            ),
            Text('Selected services: ${_selected.length}',
                key: const Key('selected-count'), style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.sm),
            if (_error != null) ...[
              InlineError(_error!),
              if (_openIntakeId != null)
                TextButton(
                  key: const Key('open-existing-intake'),
                  onPressed: () => context.go(AppRoutes.intakeDetail(_openIntakeId!)),
                  child: const Text('Open the service in progress'),
                ),
              const SizedBox(height: AppSpacing.sm),
            ],
            FilledButton.icon(
              key: const Key('create-intake-button'),
              onPressed: _saving || _selected.isEmpty || !v.isActive ? null : () => _create(v, all),
              icon: const Icon(Icons.check),
              label: _saving
                  ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : const Text('Create service intake'),
            ),
          ],
        ),
      (AsyncData(value: null), _) => const EmptyView(icon: Icons.directions_car_outlined, title: 'Vehicle not found'),
      (AsyncError(:final error), _) || (_, AsyncError(:final error)) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

/// Jobs: search by plate, job number or worker; filter by status.
class IntakesScreen extends ConsumerStatefulWidget {
  const IntakesScreen({super.key});

  @override
  ConsumerState<IntakesScreen> createState() => _IntakesScreenState();
}

class _IntakesScreenState extends ConsumerState<IntakesScreen> {
  JobFilter _filter = JobFilter.open;
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final intakes = ref.watch(intakesProvider(_filter.status));
    return Scaffold(
      floatingActionButton: canDo(ref, Permission.jobsCreate)
          ? FloatingActionButton.extended(
              key: const Key('jobs-new-service'),
              onPressed: () => context.go(AppRoutes.newService),
              icon: const Icon(Icons.add_task),
              label: const Text('New service'),
            )
          : null,
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
          child: Align(alignment: Alignment.centerLeft, child: Text('Jobs', style: Theme.of(context).textTheme.titleLarge)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
          child: TextField(
            key: const Key('job-search-field'),
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'Plate, job number or worker',
              isDense: true,
            ),
            onChanged: (v) => setState(() => _query = v),
          ),
        ),
        FilterChips<JobFilter>(
          values: JobFilter.values,
          selected: _filter,
          label: (f) => f.label,
          keyPrefix: 'intake-filter',
          onSelected: (f) => setState(() => _filter = f),
        ),
        Expanded(
          child: switch (intakes) {
            AsyncData(:final value) when value.where((i) => jobMatches(i, _query)).isEmpty => EmptyView(
                icon: Icons.assignment_outlined,
                title: _query.trim().isEmpty ? 'No jobs' : 'No matching jobs',
                message: _query.trim().isEmpty ? 'Start one with New service.' : 'Searches the latest 50 jobs in this list.',
              ),
            AsyncData(:final value) => ListView(
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                children: [
                  for (final i in value.where((i) => jobMatches(i, _query)))
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                      child: IntakeTile(intake: i, onTap: () => context.go(AppRoutes.intakeDetail(i.intakeId))),
                    ),
                ],
              ),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]),
    );
  }
}

class IntakeDetailScreen extends ConsumerWidget {
  const IntakeDetailScreen({super.key, required this.intakeId});
  final String intakeId;

  Future<void> _cancel(BuildContext context, WidgetRef ref, ServiceIntake i) async {
    final reason = await showReasonDialog(
      context,
      title: 'Cancel the service for ${i.numberPlate}?',
      message: 'The job is kept for the record and marked cancelled, with all its work orders. '
          'A new service can be started afterwards.',
      confirmLabel: 'Cancel service',
      destructive: true,
    );
    if (reason == null || !context.mounted) return;
    final r = await ref.read(operationsActionsProvider).updateServiceIntake(i.intakeId, status: 'cancelled', reason: reason);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, 'Service cancelled.'), failure: (f) => AppSnackbar.error(context, f.message));
  }

  Future<void> _editServices(BuildContext context, WidgetRef ref, ServiceIntake i) async {
    final all = ref.read(servicesProvider).value ?? const <CatalogService>[];
    final selected = {...i.selectedServices.map((s) => s.serviceId)};
    final ids = await showModalBottomSheet<List<String>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, setState) => SafeArea(
          child: SizedBox(
            height: MediaQuery.sizeOf(context).height * 0.8,
            child: Column(children: [
              Expanded(
                child: ListView(padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md), children: [
                  ServiceChecklist(
                    services: all,
                    selected: selected,
                    onChanged: (id, on) => setState(() => on ? selected.add(id) : selected.remove(id)),
                  ),
                ]),
              ),
              Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: FilledButton(
                  key: const Key('save-intake-services'),
                  onPressed: selected.isEmpty
                      ? null
                      : () => Navigator.of(sheet).pop([for (final s in all) if (selected.contains(s.serviceId)) s.serviceId]),
                  child: Text('Save (${selected.length} selected)'),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
    if (ids == null || !context.mounted) return;
    final r = await ref.read(operationsActionsProvider).updateServiceIntake(i.intakeId, serviceIds: ids);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, 'Services updated.'), failure: (f) => AppSnackbar.error(context, f.message));
  }

  Future<void> _createInvoice(BuildContext context, WidgetRef ref, ServiceIntake i) async {
    final r = await ref.read(billingActionsProvider).createInvoice(i.intakeId);
    if (!context.mounted) return;
    switch (r) {
      case Success(:final value):
        AppSnackbar.success(context, 'Invoice created.');
        context.go(AppRoutes.invoiceDetail(value));
      case Failure(:final error):
        final existing = error.details?['invoiceId'];
        AppSnackbar.error(context, error.message);
        if (error.code == 'already_invoiced' && existing is String) context.go(AppRoutes.invoiceDetail(existing));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final canChange = canDo(ref, Permission.jobsCreate);
    return switch (ref.watch(intakeProvider(intakeId))) {
      AsyncData(value: final ServiceIntake i) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
          children: [
            Row(children: [
              IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.jobs)),
              Flexible(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: PlateBadge(i.numberPlate, large: true))),
              const Spacer(),
              IntakeStatusChip(i.status),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(title: i.jobNumber ?? 'Visit', icon: Icons.directions_car_outlined, children: [
              InfoRow('Vehicle', i.vehicleSummary),
              InfoRow('Customer', i.customerName ?? 'Not recorded'),
              if (i.createdAt != null) InfoRow('Started', DateTimeFormatter.dateTime(i.createdAt!)),
              InfoRow('Started by', i.createdByName),
              if (i.completedAt != null) InfoRow('Completed', DateTimeFormatter.dateTime(i.completedAt!)),
              InfoRow('Notes', i.notes),
              if (i.cancelReason != null) InfoRow('Cancelled because', i.cancelReason),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: () => context.go(AppRoutes.vehicleDetail(i.vehicleId)),
                  child: const Text('Open vehicle'),
                ),
              ),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(
              title: 'Selected services: ${i.selectedServices.length}',
              icon: Icons.checklist,
              trailing: canChange && i.isOpen
                  ? TextButton.icon(
                      key: const Key('edit-intake-services'),
                      onPressed: () => _editServices(context, ref, i),
                      icon: const Icon(Icons.edit_outlined, size: 18),
                      label: const Text('Change'),
                    )
                  : null,
              children: [
                for (final s in i.selectedServices) InfoRow(s.name, s.price.format()),
                const SizedBox(height: AppSpacing.xxs),
                Text('Prices as at the start of the visit; the invoice uses these.', style: theme.textTheme.bodySmall),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            _WorkSection(intake: i),
            if (i.status == IntakeStatus.completed || i.isInvoiced) ...[
              const SizedBox(height: AppSpacing.sm),
              SectionCard(title: 'Billing', icon: Icons.receipt_long_outlined, children: [
                if (i.isInvoiced) ...[
                  InfoRow('Invoice', i.invoiceNumber),
                  if (canDo(ref, Permission.invoicesView))
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(
                        key: const Key('open-invoice-button'),
                        onPressed: () => context.go(AppRoutes.invoiceDetail(i.invoiceId!)),
                        child: const Text('Open invoice'),
                      ),
                    ),
                ] else if (canDo(ref, Permission.invoicesCreate))
                  FilledButton.icon(
                    key: const Key('create-invoice-button'),
                    onPressed: () => _createInvoice(context, ref, i),
                    icon: const Icon(Icons.receipt_long),
                    label: const Text('Create invoice'),
                  )
                else
                  const Text('Work is complete. A cashier will prepare the invoice.'),
              ]),
            ],
            if (canChange && i.isOpen) ...[
              const SizedBox(height: AppSpacing.md),
              OutlinedButton.icon(
                key: const Key('cancel-intake-button'),
                style: OutlinedButton.styleFrom(foregroundColor: theme.colorScheme.error),
                onPressed: () => _cancel(context, ref, i),
                icon: const Icon(Icons.cancel_outlined),
                label: const Text('Cancel service'),
              ),
            ],
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.assignment_outlined, title: 'Job not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

/// The job's worker orders: who does each service, where it stands, and the
/// manager's assign / reassign / cancel actions.
class _WorkSection extends ConsumerWidget {
  const _WorkSection({required this.intake});
  final ServiceIntake intake;

  static const _reassignable = {WorkOrderStatus.assigned, WorkOrderStatus.accepted, WorkOrderStatus.inProgress, WorkOrderStatus.paused};

  Future<void> _assign(BuildContext context, WidgetRef ref, WorkOrder o) async {
    final worker = await pickWorker(context);
    if (worker == null || !context.mounted) return;
    final r = await ref.read(jobsActionsProvider).assign(o.workerOrderId, worker.uid);
    if (!context.mounted) return;
    r.when(
      success: (_) => AppSnackbar.success(context, '${o.serviceName} assigned to ${worker.displayName}.'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  Future<void> _reassign(BuildContext context, WidgetRef ref, WorkOrder o) async {
    final worker = await pickWorker(context, exclude: o.workerId);
    if (worker == null || !context.mounted) return;
    final reason = await showReasonDialog(context,
        title: 'Reassign ${o.serviceName} to ${worker.displayName}?',
        message: 'The current assignment is kept in the history. Progress restarts with the new worker.',
        confirmLabel: 'Reassign');
    if (reason == null || !context.mounted) return;
    final r = await ref.read(jobsActionsProvider).reassign(o.workerOrderId, worker.uid, reason: reason);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, 'Reassigned.'), failure: (f) => AppSnackbar.error(context, f.message));
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref, WorkOrder o) async {
    final reason = await showReasonDialog(context,
        title: 'Cancel ${o.serviceName}?',
        message: 'The service is left off the invoice. The record is kept.',
        confirmLabel: 'Cancel service',
        destructive: true);
    if (reason == null || !context.mounted) return;
    final r = await ref.read(jobsActionsProvider).cancelOrder(o.workerOrderId, reason: reason);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, 'Service cancelled.'), failure: (f) => AppSnackbar.error(context, f.message));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final me = ref.watch(currentUserProvider)?.uid;
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final canAssign = canDo(ref, Permission.jobsAssign) && !intake.isInvoiced && intake.status != IntakeStatus.cancelled;
    final canManage = canDo(ref, Permission.jobsManage) && !intake.isInvoiced && intake.status != IntakeStatus.cancelled;
    final orders = ref.watch(jobOrdersProvider(intake.intakeId));
    return SectionCard(
      title: 'Work',
      icon: Icons.engineering_outlined,
      trailing: intake.liveOrders > 0 ? Text('${intake.completedOrders}/${intake.liveOrders} done', style: theme.textTheme.bodySmall) : null,
      children: [
        switch (orders) {
          AsyncData(:final value) when value.isEmpty => const Text('No work orders for this job.'),
          AsyncData(:final value) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final o in value)
                Padding(
                  key: Key('job-order-${o.workerOrderId}'),
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text(o.serviceName, style: theme.textTheme.titleSmall)),
                      WorkOrderStatusChip(o.status),
                    ]),
                    Text(
                      [o.orderNumber, o.workerName ?? 'Not assigned', if (o.startedAt != null) 'worked ${formatWorked(o.workedTime(now))}'].join(' · '),
                      style: theme.textTheme.bodySmall,
                    ),
                    if (o.pauseReason != null && o.status == WorkOrderStatus.paused)
                      Text('Paused: ${o.pauseReason}', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.warning)),
                    if (o.cancelReason != null) Text('Cancelled: ${o.cancelReason}', style: theme.textTheme.bodySmall),
                    if (o.completionNotes != null) Text('Notes: ${o.completionNotes}', style: theme.textTheme.bodySmall),
                    if (o.assignmentHistory.length > 1)
                      Text(
                        'Previously: ${o.assignmentHistory.take(o.assignmentHistory.length - 1).map((h) => '${h.workerName ?? 'someone'}${h.reason == null ? '' : ' (${h.reason})'}').join(', ')}',
                        style: theme.textTheme.bodySmall,
                      ),
                    Wrap(spacing: AppSpacing.xs, children: [
                      if (canAssign && o.status == WorkOrderStatus.pending)
                        TextButton.icon(
                          key: Key('assign-${o.workerOrderId}'),
                          onPressed: () => _assign(context, ref, o),
                          icon: const Icon(Icons.person_add_alt, size: 18),
                          label: const Text('Assign'),
                        ),
                      if (canAssign && _reassignable.contains(o.status))
                        TextButton.icon(
                          key: Key('reassign-${o.workerOrderId}'),
                          onPressed: () => _reassign(context, ref, o),
                          icon: const Icon(Icons.swap_horiz, size: 18),
                          label: const Text('Reassign'),
                        ),
                      if (canManage && !o.status.isFinished)
                        TextButton.icon(
                          key: Key('cancel-order-${o.workerOrderId}'),
                          style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
                          onPressed: () => _cancel(context, ref, o),
                          icon: const Icon(Icons.close, size: 18),
                          label: const Text('Cancel'),
                        ),
                      if (o.workerId == me && !intake.isInvoiced)
                        for (final a in o.workerActions)
                          TextButton(
                            key: Key('order-${a.key}-${o.workerOrderId}'),
                            onPressed: () => runWorkerAction(context, ref, o, a),
                            child: Text(a.label),
                          ),
                    ]),
                    const Divider(height: AppSpacing.sm),
                  ]),
                ),
            ]),
          AsyncError(:final error) => Text(ErrorMapper.map(error).message),
          _ => const LinearProgressIndicator(),
        },
      ],
    );
  }
}
