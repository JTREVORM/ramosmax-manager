import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/customer.dart';
import '../../../models/service_intake.dart';
import '../../../models/vehicle.dart';
import '../../../routes/app_routes.dart';
import '../../billing/application/billing_providers.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../billing/presentation/loyalty_screens.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/operations_providers.dart';
import '../data/operations_api.dart';
import 'operations_widgets.dart';

class VehicleDetailScreen extends ConsumerWidget {
  const VehicleDetailScreen({super.key, required this.vehicleId});
  final String vehicleId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(vehicleProvider(vehicleId))) {
        AsyncData(value: final Vehicle v) => _Details(vehicle: v),
        AsyncData() => const EmptyView(icon: Icons.directions_car_outlined, title: 'Vehicle not found'),
        AsyncError() => const EmptyView(icon: Icons.error_outline, title: 'Could not load this vehicle'),
        _ => const LoadingView(),
      };
}

class _Details extends ConsumerWidget {
  const _Details({required this.vehicle});
  final Vehicle vehicle;

  Future<void> _setStatus(BuildContext context, WidgetRef ref, RecordStatus status) async {
    final deactivate = status == RecordStatus.inactive;
    final reason = await showReasonDialog(
      context,
      title: deactivate ? 'Mark ${vehicle.numberPlate} inactive?' : 'Reactivate ${vehicle.numberPlate}?',
      message: deactivate
          ? 'Use this when the vehicle is sold, retired or no longer serviced. It stays in the records and '
              'its history is kept, but no new service can be started for it.'
          : 'New services can be started for this vehicle again.',
      confirmLabel: deactivate ? 'Mark inactive' : 'Reactivate',
      destructive: deactivate,
      reasonRequired: deactivate,
    );
    if (reason == null || !context.mounted) return;
    final r = await ref.read(operationsActionsProvider).updateVehicle(vehicle.vehicleId, const VehicleInput(),
        status: status.key, reason: reason.isEmpty ? null : reason);
    if (!context.mounted) return;
    switch (r) {
      case Success():
        AppSnackbar.success(context, deactivate ? 'Vehicle marked inactive.' : 'Vehicle reactivated.');
      case Failure(:final error):
        AppSnackbar.error(context, error.message);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final v = vehicle;
    final canEdit = canDo(ref, Permission.vehiclesManage);
    final canStart = canDo(ref, Permission.jobsCreate);
    final canSeeCustomer = canDo(ref, Permission.customersView);
    final canSeeJobs = canDo(ref, Permission.jobsView);

    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
      children: [
        Row(children: [
          IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.vehicles)),
          Flexible(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: PlateBadge(v.numberPlate, large: true))),
          const Spacer(),
          RecordStatusChip(v.status),
        ]),
        const SizedBox(height: AppSpacing.sm),
        Text(v.description, key: const Key('vehicle-detail-description'), style: theme.textTheme.titleLarge),
        const SizedBox(height: AppSpacing.md),
        if (canStart && v.isActive) ...[
          FilledButton.icon(
            key: const Key('vehicle-start-service'),
            onPressed: () => context.go(AppRoutes.startService(v.vehicleId)),
            icon: const Icon(Icons.local_car_wash),
            label: const Text('Start service'),
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        SectionCard(
          title: 'Vehicle',
          icon: Icons.directions_car_outlined,
          trailing: canEdit
              ? TextButton.icon(
                  key: const Key('vehicle-edit-button'),
                  onPressed: () => context.go(AppRoutes.editVehicle(v.vehicleId)),
                  icon: const Icon(Icons.edit_outlined, size: 18),
                  label: const Text('Edit'),
                )
              : null,
          children: [
            InfoRow('Number plate', v.numberPlate),
            InfoRow('Make', v.make),
            InfoRow('Model', v.model),
            InfoRow('Colour', v.colour),
            InfoRow('Year', v.year?.toString()),
            InfoRow('Type', v.vehicleType?.label),
            InfoRow('Notes', v.notes),
            InfoRow('Status', v.status.label),
            if (v.previousPlates.isNotEmpty) InfoRow('Previous plates', v.previousPlates.join(', ')),
            if (v.createdAt != null) InfoRow('Registered', DateTimeFormatter.date(v.createdAt!)),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        SectionCard(
          title: 'Customer',
          icon: Icons.person_outline,
          children: [
            if (v.customerId == null) const Text('No customer linked.') else ...[
              InfoRow('Name', v.customerName),
              InfoRow('Customer ID', v.customerNumber),
              if (canSeeCustomer) _CustomerPhone(customerId: v.customerId!),
              if (canSeeCustomer)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    key: const Key('vehicle-open-customer'),
                    onPressed: () => context.go(AppRoutes.customerDetail(v.customerId!)),
                    child: const Text('Open customer'),
                  ),
                ),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        SectionCard(
          title: 'Service activity',
          icon: Icons.history,
          children: [
            if (!canSeeJobs)
              const Text('Service history is visible to cashiers, managers and auditors.')
            else
              IntakeHistory(intakes: ref.watch(vehicleIntakesProvider(v.vehicleId))),
          ],
        ),
        if (canDo(ref, Permission.loyaltyView)) ...[
          const SizedBox(height: AppSpacing.sm),
          LoyaltySummaryCard(vehicleId: v.vehicleId, onOpen: () => context.go(AppRoutes.vehicleLoyalty(v.vehicleId))),
        ],
        if (canDo(ref, Permission.invoicesView)) ...[
          const SizedBox(height: AppSpacing.sm),
          SectionCard(title: 'Invoices', icon: Icons.receipt_long_outlined, children: [
            switch (ref.watch(vehicleInvoicesProvider(v.vehicleId))) {
              AsyncData(:final value) when value.isEmpty => const Text('No invoices yet.'),
              AsyncData(:final value) => Column(children: [
                  for (final i in value.take(10))
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.xxs),
                      child: InvoiceTile(invoice: i, onTap: () => context.go(AppRoutes.invoiceDetail(i.invoiceId))),
                    ),
                ]),
              AsyncError() => const Text('Invoices could not be loaded.'),
              _ => const LinearProgressIndicator(),
            },
          ]),
        ],
        if (canEdit) ...[
          const SizedBox(height: AppSpacing.md),
          v.isActive
              ? OutlinedButton.icon(
                  key: const Key('vehicle-deactivate'),
                  style: OutlinedButton.styleFrom(foregroundColor: theme.colorScheme.error),
                  onPressed: () => _setStatus(context, ref, RecordStatus.inactive),
                  icon: const Icon(Icons.block),
                  label: const Text('Mark inactive'),
                )
              : FilledButton.icon(
                  key: const Key('vehicle-reactivate'),
                  onPressed: () => _setStatus(context, ref, RecordStatus.active),
                  icon: const Icon(Icons.check_circle_outline),
                  label: const Text('Reactivate'),
                ),
        ],
      ],
    );
  }
}

class _CustomerPhone extends ConsumerWidget {
  const _CustomerPhone({required this.customerId});
  final String customerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      InfoRow('Phone', ref.watch(customerProvider(customerId)).value?.phoneNumber);
}

/// Service-intake history (the visit list Phase 4 extends).
class IntakeHistory extends StatelessWidget {
  const IntakeHistory({super.key, required this.intakes});
  final AsyncValue<List<ServiceIntake>> intakes;

  @override
  Widget build(BuildContext context) => switch (intakes) {
        AsyncData(:final value) when value.isEmpty => const Padding(
            padding: EdgeInsets.symmetric(vertical: AppSpacing.xs),
            child: Text('No service visits yet.'),
          ),
        AsyncData(:final value) => Column(children: [
            for (final i in value)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                child: IntakeTile(intake: i, onTap: () => context.go(AppRoutes.intakeDetail(i.intakeId))),
              ),
          ]),
        AsyncError() => const Text('Service history could not be loaded.'),
        _ => const LinearProgressIndicator(),
      };
}
