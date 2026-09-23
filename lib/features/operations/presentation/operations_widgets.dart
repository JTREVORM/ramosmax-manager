import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/branding/brand.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/customer.dart';
import '../../../models/service_intake.dart';
import '../../../models/vehicle.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;

/// Whether the signed-in user currently holds [permission] (UI only; the
/// rules and Cloud Functions decide for real).
bool canDo(WidgetRef ref, Permission permission) {
  final user = ref.watch(currentUserProvider);
  final now = ref.watch(clockProvider).value ?? DateTime.now();
  return user != null && user.can(permission, now);
}

/// Upper-cases as the person types, so plates always look like plates.
class UpperCaseFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) =>
      newValue.copyWith(text: newValue.text.toUpperCase());
}

/// A number plate styled like the real thing — the anchor of every
/// vehicle screen.
class PlateBadge extends StatelessWidget {
  const PlateBadge(this.plate, {super.key, this.large = false});
  final String plate;
  final bool large;

  @override
  Widget build(BuildContext context) => Container(
        padding: EdgeInsets.symmetric(horizontal: large ? 14 : 8, vertical: large ? 6 : 3),
        decoration: BoxDecoration(
          color: const Color(0xFFFFD84D),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.black87, width: 1.5),
        ),
        child: Text(
          plate,
          style: TextStyle(
            color: Colors.black,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.2,
            fontSize: large ? 24 : 15,
            fontFamily: 'monospace',
          ),
        ),
      );
}

class RecordStatusChip extends StatelessWidget {
  const RecordStatusChip(this.status, {super.key});
  final RecordStatus status;

  @override
  Widget build(BuildContext context) => status == RecordStatus.active
      ? const StatusChip('Active', color: AppColors.success, icon: Icons.check_circle_outline)
      : const StatusChip('Inactive', color: AppColors.danger, icon: Icons.block);
}

class IntakeStatusChip extends StatelessWidget {
  const IntakeStatusChip(this.status, {super.key});
  final IntakeStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        IntakeStatus.open => const StatusChip('Open', color: AppColors.info, icon: Icons.pending_actions),
        IntakeStatus.draft => const StatusChip('Draft', color: AppColors.warning, icon: Icons.edit_note),
        IntakeStatus.completed => const StatusChip('Completed', color: AppColors.success, icon: Icons.task_alt),
        IntakeStatus.cancelled => const StatusChip('Cancelled', color: AppColors.danger, icon: Icons.cancel_outlined),
      };
}

class VehicleTile extends StatelessWidget {
  const VehicleTile({super.key, required this.vehicle, this.onTap, this.trailing});
  final Vehicle vehicle;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      key: Key('vehicle-tile-${vehicle.vehicleId}'),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Row(children: [
            PlateBadge(vehicle.numberPlate),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(vehicle.description, style: theme.textTheme.bodyMedium, overflow: TextOverflow.ellipsis),
                Text(vehicle.customerName ?? 'No customer linked',
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
              ]),
            ),
            if (!vehicle.isActive) const RecordStatusChip(RecordStatus.inactive),
            ?trailing,
          ]),
        ),
      ),
    );
  }
}

class CustomerTile extends StatelessWidget {
  const CustomerTile({super.key, required this.customer, this.onTap});
  final Customer customer;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    return Card(
      key: Key('customer-tile-${customer.customerId}'),
      child: ListTile(
        onTap: onTap,
        leading: CircleAvatar(
          backgroundColor: customer.isActive ? Brand.purple : Colors.grey,
          child: const Icon(Icons.person, color: Colors.white),
        ),
        title: Text(customer.fullName),
        subtitle: Text(
          [customer.customerNumber, if (customer.phoneNumber != null) customer.phoneNumber!,
            '${customer.vehicleCount} vehicle${customer.vehicleCount == 1 ? '' : 's'}'].join(' · '),
          style: muted,
        ),
        trailing: customer.isActive ? const Icon(Icons.chevron_right) : const RecordStatusChip(RecordStatus.inactive),
      ),
    );
  }
}

class IntakeTile extends StatelessWidget {
  const IntakeTile({super.key, required this.intake, this.onTap});
  final ServiceIntake intake;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      key: Key('intake-tile-${intake.intakeId}'),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              PlateBadge(intake.numberPlate),
              const Spacer(),
              IntakeStatusChip(intake.status),
            ]),
            const SizedBox(height: AppSpacing.xxs),
            Text(intake.selectedServices.map((s) => s.name).join(', '), style: theme.textTheme.bodyMedium),
            if (intake.liveOrders > 0)
              Text(
                [
                  '${intake.completedOrders}/${intake.liveOrders} done',
                  if (intake.orders.any((o) => o.workerName != null)) {for (final o in intake.orders) ?o.workerName}.join(', '),
                  if (intake.invoiceNumber != null) intake.invoiceNumber! else if (intake.awaitingInvoice) 'Ready to invoice',
                ].join(' · '),
                style: theme.textTheme.bodySmall,
              ),
            Text(
              [
                ?intake.jobNumber,
                intake.customerName ?? 'No customer',
                if (intake.createdAt != null) DateTimeFormatter.dateTime(intake.createdAt!),
              ].join(' · '),
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Chip row for filters, non-lazy so every chip exists (and is tappable).
class FilterChips<T> extends StatelessWidget {
  const FilterChips({super.key, required this.values, required this.selected, required this.label, required this.onSelected, required this.keyPrefix});
  final List<T> values;
  final T selected;
  final String Function(T) label;
  final ValueChanged<T> onSelected;
  final String keyPrefix;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xxs),
        child: Row(children: [
          for (final v in values)
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.xs),
              child: FilterChip(
                key: Key('$keyPrefix-${label(v).toLowerCase()}'),
                label: Text(label(v)),
                selected: v == selected,
                showCheckmark: false,
                onSelected: (_) => onSelected(v),
              ),
            ),
        ]),
      );
}
