import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/customer.dart';
import '../../../routes/app_routes.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/operations_providers.dart';
import '../data/operations_api.dart';
import 'customer_fields.dart';
import 'operations_widgets.dart';
import 'vehicle_detail_screen.dart' show IntakeHistory;

enum _StatusFilter { all, active, inactive }

extension on _StatusFilter {
  String get label => switch (this) { _StatusFilter.all => 'All', _StatusFilter.active => 'Active', _StatusFilter.inactive => 'Inactive' };
  RecordStatus? get status => switch (this) {
        _StatusFilter.all => null,
        _StatusFilter.active => RecordStatus.active,
        _StatusFilter.inactive => RecordStatus.inactive,
      };
}

/// Customers: search by name, phone (any format) or customer ID.
class CustomersScreen extends ConsumerStatefulWidget {
  const CustomersScreen({super.key});

  @override
  ConsumerState<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends ConsumerState<CustomersScreen> {
  final _search = TextEditingController();
  Timer? _debounce;
  int _req = 0;
  _StatusFilter _filter = _StatusFilter.all;
  List<Customer>? _results;
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
      final r = await ref.read(operationsRepositoryProvider).searchCustomers(_search.text, status: _filter.status);
      if (mounted && id == _req) setState(() => _results = r);
    } catch (e) {
      if (mounted && id == _req) setState(() => _error = ErrorMapper.map(e).message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final canCreate = canDo(ref, Permission.customersManage);
    return Scaffold(
      floatingActionButton: canCreate
          ? FloatingActionButton.extended(
              key: const Key('add-customer-button'),
              onPressed: () => context.go(AppRoutes.newCustomer),
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('Add customer'),
            )
          : null,
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Customers', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.sm),
            TextField(
              key: const Key('customer-search'),
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Name, phone or customer ID'),
              onChanged: (_) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 350), _run);
              },
              onSubmitted: (_) => _run(),
            ),
          ]),
        ),
        FilterChips<_StatusFilter>(
          values: _StatusFilter.values,
          selected: _filter,
          label: (f) => f.label,
          keyPrefix: 'customer-filter',
          onSelected: (f) {
            setState(() => _filter = f);
            _run();
          },
        ),
        Expanded(
          child: _error != null
              ? ErrorView(message: _error!, onRetry: _run)
              : _results == null
                  ? const LoadingView()
                  : _results!.isEmpty
                      ? EmptyView(
                          icon: Icons.person_search_outlined,
                          title: _search.text.trim().isEmpty ? 'No customers yet' : 'No matching customers',
                          message: 'Phone searches need the full number, e.g. 0772 123 456.',
                        )
                      : ListView(
                          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                          children: [
                            for (final c in _results!)
                              Padding(
                                padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                                child: CustomerTile(customer: c, onTap: () => context.go(AppRoutes.customerDetail(c.customerId))),
                              ),
                          ],
                        ),
        ),
      ]),
    );
  }
}

/// Add ([customerId] null) or edit a customer. Only the name is required.
class CustomerFormScreen extends ConsumerWidget {
  const CustomerFormScreen({super.key, this.customerId});
  final String? customerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.customersManage)) {
      return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted', message: 'You cannot add or edit customers.');
    }
    if (customerId == null) return const _CustomerForm(existing: null);
    return switch (ref.watch(customerProvider(customerId!))) {
      AsyncData(value: final Customer c) => _CustomerForm(key: ValueKey(c.customerId), existing: c),
      AsyncData() => const EmptyView(icon: Icons.person_off_outlined, title: 'Customer not found'),
      AsyncError() => const EmptyView(icon: Icons.error_outline, title: 'Could not load this customer'),
      _ => const LoadingView(),
    };
  }
}

class _CustomerForm extends ConsumerStatefulWidget {
  const _CustomerForm({super.key, required this.existing});
  final Customer? existing;

  @override
  ConsumerState<_CustomerForm> createState() => _CustomerFormState();
}

class _CustomerFormState extends ConsumerState<_CustomerForm> {
  final _form = GlobalKey<FormState>();
  late final _c = CustomerControllers(widget.existing);
  bool _saving = false;
  String? _error;
  String? _duplicateOf;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _error = null;
      _duplicateOf = null;
    });
    if (!_form.currentState!.validate()) return;
    final actions = ref.read(operationsActionsProvider);
    final input = _c.toInput();
    setState(() => _saving = true);
    final existing = widget.existing;
    final Result<String> r;
    if (existing == null) {
      r = await actions.createCustomer(input);
    } else {
      String? changed(String? now, String? before) => (now ?? '') == (before ?? '') ? null : now;
      // Compare phones in their stored (E.164) form.
      String? phoneChanged(String? typed, String? before) {
        final normalized = (typed == null || typed.isEmpty) ? '' : (PhoneNumbers.normalize(typed) ?? typed);
        return normalized == (before ?? '') ? null : typed;
      }
      final u = await actions.updateCustomer(
        existing.customerId,
        CustomerInput(
          fullName: changed(input.fullName, existing.fullName),
          phoneNumber: phoneChanged(input.phoneNumber, existing.phoneNumber),
          alternativePhone: phoneChanged(input.alternativePhone, existing.alternativePhone),
          email: changed(input.email?.toLowerCase(), existing.email),
          address: changed(input.address, existing.address),
          notes: changed(input.notes, existing.notes),
        ),
      );
      r = u.when(success: (_) => Success(existing.customerId), failure: (f) => f.code == 'no_changes' ? Success(existing.customerId) : Failure(f));
    }
    if (!mounted) return;
    setState(() => _saving = false);
    switch (r) {
      case Success(:final value):
        AppSnackbar.success(context, existing == null ? 'Customer added.' : 'Customer saved.');
        context.go(AppRoutes.customerDetail(value));
      case Failure(:final error):
        setState(() {
          _error = error.message;
          final id = error.details?['customerId'];
          _duplicateOf = error.code == 'duplicate_phone' && id is String ? id : null;
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final existing = widget.existing;
    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
        children: [
          Row(children: [
            IconButton(
              tooltip: 'Back',
              icon: const Icon(Icons.arrow_back),
              onPressed: () => context.go(existing == null ? AppRoutes.customers : AppRoutes.customerDetail(existing.customerId)),
            ),
            Expanded(child: Text(existing == null ? 'Add customer' : 'Edit customer', style: Theme.of(context).textTheme.titleLarge)),
          ]),
          const SizedBox(height: AppSpacing.sm),
          CustomerFields(controllers: _c),
          const SizedBox(height: AppSpacing.lg),
          if (_error != null) ...[
            InlineError(_error!),
            if (_duplicateOf != null)
              TextButton(
                key: const Key('open-existing-customer'),
                onPressed: () => context.go(AppRoutes.customerDetail(_duplicateOf!)),
                child: const Text('Open the existing customer'),
              ),
            const SizedBox(height: AppSpacing.sm),
          ],
          FilledButton(
            key: const Key('customer-save-button'),
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(existing == null ? 'Add customer' : 'Save changes'),
          ),
        ],
      ),
    );
  }
}

class CustomerDetailScreen extends ConsumerWidget {
  const CustomerDetailScreen({super.key, required this.customerId});
  final String customerId;

  Future<void> _setStatus(BuildContext context, WidgetRef ref, Customer c, RecordStatus status) async {
    final deactivate = status == RecordStatus.inactive;
    final reason = await showReasonDialog(
      context,
      title: deactivate ? 'Mark ${c.fullName} inactive?' : 'Reactivate ${c.fullName}?',
      message: deactivate
          ? 'The customer and their history are kept. Vehicles cannot be newly linked to an inactive customer.'
          : 'The customer can be linked to vehicles again.',
      confirmLabel: deactivate ? 'Mark inactive' : 'Reactivate',
      destructive: deactivate,
      reasonRequired: deactivate,
    );
    if (reason == null || !context.mounted) return;
    final r = await ref.read(operationsActionsProvider)
        .updateCustomer(c.customerId, const CustomerInput(), status: status.key, reason: reason.isEmpty ? null : reason);
    if (!context.mounted) return;
    r.when(
      success: (_) => AppSnackbar.success(context, deactivate ? 'Customer marked inactive.' : 'Customer reactivated.'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final canEdit = canDo(ref, Permission.customersManage);
    final canAddVehicle = canDo(ref, Permission.vehiclesManage);
    return switch (ref.watch(customerProvider(customerId))) {
      AsyncData(value: final Customer c) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
          children: [
            Row(children: [
              IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.customers)),
              Expanded(child: Text(c.fullName, key: const Key('customer-detail-name'), style: theme.textTheme.titleLarge)),
              RecordStatusChip(c.status),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(
              title: 'Customer information',
              icon: Icons.person_outline,
              trailing: canEdit
                  ? TextButton.icon(
                      key: const Key('customer-edit-button'),
                      onPressed: () => context.go(AppRoutes.editCustomer(c.customerId)),
                      icon: const Icon(Icons.edit_outlined, size: 18),
                      label: const Text('Edit'),
                    )
                  : null,
              children: [
                InfoRow('Name', c.fullName),
                InfoRow('Customer ID', c.customerNumber),
                InfoRow('Phone', c.phoneNumber == null ? null : PhoneNumbers.formatForDisplay(c.phoneNumber!)),
                InfoRow('Alternative', c.alternativePhone == null ? null : PhoneNumbers.formatForDisplay(c.alternativePhone!)),
                InfoRow('Email', c.email),
                InfoRow('Address', c.address),
                InfoRow('Notes', c.notes),
                if (c.createdAt != null) InfoRow('Customer since', DateTimeFormatter.date(c.createdAt!)),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(
              title: 'Vehicles',
              icon: Icons.directions_car_outlined,
              trailing: canAddVehicle && c.isActive
                  ? TextButton.icon(
                      key: const Key('customer-add-vehicle'),
                      onPressed: () => context.go(AppRoutes.newVehicle(customerId: c.customerId)),
                      icon: const Icon(Icons.add, size: 18),
                      label: const Text('Add'),
                    )
                  : null,
              children: switch (ref.watch(customerVehiclesProvider(c.customerId))) {
                AsyncData(:final value) when value.isEmpty => [const Text('No vehicles linked yet.')],
                AsyncData(:final value) => [
                    for (final v in value)
                      Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                        child: VehicleTile(vehicle: v, onTap: () => context.go(AppRoutes.vehicleDetail(v.vehicleId))),
                      ),
                  ],
                AsyncError() => [const Text('Vehicles could not be loaded.')],
                _ => [const LinearProgressIndicator()],
              },
            ),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(
              title: 'History',
              icon: Icons.history,
              children: [
                if (canDo(ref, Permission.jobsView))
                  IntakeHistory(intakes: ref.watch(customerIntakesProvider(c.customerId)))
                else
                  const Text('Service history is visible to cashiers, managers and auditors.'),
                Text('Invoices and payments will appear here in a later release.', style: theme.textTheme.bodySmall),
              ],
            ),
            if (canEdit) ...[
              const SizedBox(height: AppSpacing.md),
              c.isActive
                  ? OutlinedButton.icon(
                      key: const Key('customer-deactivate'),
                      style: OutlinedButton.styleFrom(foregroundColor: theme.colorScheme.error),
                      onPressed: () => _setStatus(context, ref, c, RecordStatus.inactive),
                      icon: const Icon(Icons.block),
                      label: const Text('Mark inactive'),
                    )
                  : FilledButton.icon(
                      key: const Key('customer-reactivate'),
                      onPressed: () => _setStatus(context, ref, c, RecordStatus.active),
                      icon: const Icon(Icons.check_circle_outline),
                      label: const Text('Reactivate'),
                    ),
            ],
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.person_off_outlined, title: 'Customer not found'),
      AsyncError() => const EmptyView(icon: Icons.error_outline, title: 'Could not load this customer'),
      _ => const LoadingView(),
    };
  }
}
