import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/number_plates.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/vehicle.dart';
import '../../../routes/app_routes.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/operations_providers.dart';
import '../data/operations_api.dart';
import 'customer_fields.dart';
import 'operations_widgets.dart';

/// Register a vehicle ([vehicleId] null) or edit one.
///
/// Required: number plate, model, colour. The customer is optional: none,
/// an existing customer, or a new customer created in the same step (one
/// server transaction, so a duplicate plate never leaves an orphan customer).
class VehicleFormScreen extends ConsumerWidget {
  const VehicleFormScreen({super.key, this.vehicleId, this.initialPlate, this.initialCustomerId, this.startServiceAfter = false});
  final String? vehicleId;
  final String? initialPlate;
  final String? initialCustomerId;
  final bool startServiceAfter;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.vehiclesManage)) {
      return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted',
          message: 'You do not have permission to register or edit vehicles.');
    }
    if (vehicleId == null) {
      final preset = initialCustomerId == null ? null : ref.watch(customerProvider(initialCustomerId!)).value;
      return _VehicleForm(
        key: ValueKey('new-${preset?.customerId}'),
        initialPlate: initialPlate,
        initialLink: preset == null ? null : ExistingCustomer(preset.customerId, preset.fullName),
        startServiceAfter: startServiceAfter,
      );
    }
    return switch (ref.watch(vehicleProvider(vehicleId!))) {
      AsyncData(value: final Vehicle v) => _VehicleForm(key: ValueKey(v.vehicleId), existing: v),
      AsyncData() => const EmptyView(icon: Icons.directions_car_outlined, title: 'Vehicle not found'),
      AsyncError() => const EmptyView(icon: Icons.error_outline, title: 'Could not load this vehicle'),
      _ => const LoadingView(),
    };
  }
}

class _VehicleForm extends ConsumerStatefulWidget {
  const _VehicleForm({super.key, this.existing, this.initialPlate, this.initialLink, this.startServiceAfter = false});
  final Vehicle? existing;
  final String? initialPlate;
  final CustomerLink? initialLink;
  final bool startServiceAfter;

  @override
  ConsumerState<_VehicleForm> createState() => _VehicleFormState();
}

enum _CustomerMode { none, existing, create }

class _VehicleFormState extends ConsumerState<_VehicleForm> {
  final _form = GlobalKey<FormState>();
  late final Vehicle? _v = widget.existing;
  late final _plate = TextEditingController(text: _v?.numberPlate ?? widget.initialPlate ?? '');
  late final _make = TextEditingController(text: _v?.make ?? '');
  late final _model = TextEditingController(text: _v?.model ?? '');
  late final _colour = TextEditingController(text: _v?.colour ?? '');
  late final _year = TextEditingController(text: _v?.year?.toString() ?? '');
  late final _notes = TextEditingController(text: _v?.notes ?? '');
  late VehicleType? _type = _v?.vehicleType;
  final _newCustomer = CustomerControllers();

  late _CustomerMode _mode;
  ExistingCustomer? _chosen;
  bool _customerTouched = false;
  bool _saving = false;
  String? _error;
  String? _existingVehicleId;

  bool get _isCreate => _v == null;

  @override
  void initState() {
    super.initState();
    final link = widget.initialLink;
    if (link is ExistingCustomer) {
      _chosen = link;
      _mode = _CustomerMode.existing;
    } else if (_v?.customerId != null) {
      _chosen = ExistingCustomer(_v!.customerId!, _v.customerName ?? _v.customerNumber ?? 'Customer');
      _mode = _CustomerMode.existing;
    } else {
      _mode = _isCreate ? _CustomerMode.create : _CustomerMode.none;
    }
  }

  @override
  void dispose() {
    for (final c in [_plate, _make, _model, _colour, _year, _notes]) {
      c.dispose();
    }
    _newCustomer.dispose();
    super.dispose();
  }

  CustomerLink get _link => switch (_mode) {
        _CustomerMode.none => const NoCustomer(),
        _CustomerMode.existing => _chosen ?? const NoCustomer(),
        _CustomerMode.create => NewCustomer(_newCustomer.toInput()),
      };

  Future<void> _save() async {
    setState(() {
      _error = null;
      _existingVehicleId = null;
    });
    if (!_form.currentState!.validate()) return;
    if (_mode == _CustomerMode.existing && _chosen == null) {
      setState(() => _error = 'Choose the customer, or select "No customer".');
      return;
    }
    final plate = NumberPlates.parse(_plate.text)!;
    final actions = ref.read(operationsActionsProvider);
    final year = int.tryParse(_year.text.trim());

    if (_isCreate) {
      setState(() => _saving = true);
      final r = await actions.createVehicle(
        VehicleInput(
          numberPlate: plate.display,
          make: _make.text.trim(),
          model: _model.text.trim(),
          colour: _colour.text.trim(),
          year: year,
          vehicleType: _type?.key,
          notes: _notes.text.trim(),
        ),
        _link,
      );
      if (!mounted) return;
      setState(() => _saving = false);
      switch (r) {
        case Success(:final value):
          AppSnackbar.success(context, '${plate.display} registered.');
          context.go(widget.startServiceAfter ? AppRoutes.startService(value) : AppRoutes.vehicleDetail(value));
        case Failure(:final error):
          _showFailure(error);
      }
      return;
    }

    final v = _v!;
    final plateChanged = plate.key != v.normalizedNumberPlate;
    final customerChanged = _customerTouched && switch (_link) {
      NoCustomer() => v.customerId != null,
      ExistingCustomer(:final customerId) => customerId != v.customerId,
      NewCustomer() => true,
    };
    String? reason;
    if (plateChanged || customerChanged) {
      reason = await showReasonDialog(
        context,
        title: plateChanged ? 'Change the number plate?' : 'Change the customer?',
        message: plateChanged
            ? '${v.numberPlate} → ${plate.display}. The old plate is kept in this vehicle\'s history and '
                'past visits keep the plate they were recorded with.'
            : 'This vehicle will be linked to a different customer. Past visits are not changed.',
        confirmLabel: 'Save change',
      );
      if (reason == null || !mounted) return;
    }
    String? changed(TextEditingController c, String? before) => c.text.trim() == (before ?? '') ? null : c.text.trim();
    setState(() => _saving = true);
    final r = await actions.updateVehicle(
      v.vehicleId,
      VehicleInput(
        numberPlate: plate.display == v.numberPlate ? null : plate.display,
        make: changed(_make, v.make),
        model: changed(_model, v.model),
        colour: changed(_colour, v.colour),
        year: year != v.year ? year : null,
        vehicleType: _type != v.vehicleType ? (_type?.key ?? '') : null,
        notes: changed(_notes, v.notes),
      ),
      clearYear: year == null && v.year != null,
      customer: customerChanged ? _link : null,
      reason: reason,
    );
    if (!mounted) return;
    setState(() => _saving = false);
    switch (r) {
      case Success():
        AppSnackbar.success(context, 'Vehicle saved.');
        context.go(AppRoutes.vehicleDetail(v.vehicleId));
      case Failure(:final error):
        if (error.code == 'no_changes') {
          context.go(AppRoutes.vehicleDetail(v.vehicleId));
        } else {
          _showFailure(error);
        }
    }
  }

  void _showFailure(AppFailure error) => setState(() {
        _error = error.message;
        final id = error.details?['vehicleId'];
        _existingVehicleId = error.code == 'duplicate_plate' && id is String ? id : null;
      });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final canCreateCustomer = canDo(ref, Permission.customersManage);
    final canPickCustomer = canDo(ref, Permission.customersView);

    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
        children: [
          Row(children: [
            IconButton(
              tooltip: 'Back',
              icon: const Icon(Icons.arrow_back),
              onPressed: () => context.go(_isCreate ? AppRoutes.vehicles : AppRoutes.vehicleDetail(_v!.vehicleId)),
            ),
            Expanded(child: Text(_isCreate ? 'Register vehicle' : 'Edit vehicle', style: theme.textTheme.titleLarge)),
          ]),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('vehicle-plate-field'),
            controller: _plate,
            textCapitalization: TextCapitalization.characters,
            inputFormatters: [UpperCaseFormatter(), LengthLimitingTextInputFormatter(12)],
            style: theme.textTheme.titleLarge?.copyWith(letterSpacing: 1.5, fontWeight: FontWeight.w700),
            decoration: const InputDecoration(labelText: 'Number plate *', hintText: 'UGB 123A'),
            validator: Validators.numberPlate,
          ),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('vehicle-make-field'),
            controller: _make,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Make', hintText: 'e.g. Toyota'),
            validator: (v) => (v?.trim().length ?? 0) > 40 ? 'Too long' : null,
          ),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('vehicle-model-field'),
            controller: _model,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Model *', hintText: 'e.g. Harrier'),
            validator: (v) => requiredText(v, 'model'),
          ),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('vehicle-colour-field'),
            controller: _colour,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Colour *', hintText: 'e.g. Black'),
            validator: (v) => requiredText(v, 'colour', max: 30),
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(children: [
            Expanded(
              child: TextFormField(
                key: const Key('vehicle-year-field'),
                controller: _year,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
                decoration: const InputDecoration(labelText: 'Year'),
                validator: (v) {
                  if (v == null || v.isEmpty) return null;
                  final y = int.tryParse(v);
                  final max = DateTime.now().year + 1;
                  return (y == null || y < 1950 || y > max) ? '1950–$max' : null;
                },
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: DropdownButtonFormField<VehicleType?>(
                key: const Key('vehicle-type-field'),
                initialValue: _type,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Type'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('—')),
                  for (final t in VehicleType.values) DropdownMenuItem(value: t, child: Text(t.label)),
                ],
                onChanged: (t) => setState(() => _type = t),
              ),
            ),
          ]),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('vehicle-notes-field'),
            controller: _notes,
            minLines: 1,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Notes'),
            validator: (v) => (v?.trim().length ?? 0) > 500 ? 'Too long (500 characters maximum)' : null,
          ),
          const SizedBox(height: AppSpacing.lg),
          Text('Customer', style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.xs),
          SegmentedButton<_CustomerMode>(
            key: const Key('vehicle-customer-mode'),
            segments: [
              const ButtonSegment(value: _CustomerMode.none, label: Text('None')),
              if (canPickCustomer) const ButtonSegment(value: _CustomerMode.existing, label: Text('Existing')),
              if (canCreateCustomer) const ButtonSegment(value: _CustomerMode.create, label: Text('New')),
            ],
            selected: {_mode},
            onSelectionChanged: (s) => setState(() {
              _mode = s.first;
              _customerTouched = true;
            }),
          ),
          const SizedBox(height: AppSpacing.sm),
          if (_mode == _CustomerMode.existing)
            OutlinedButton.icon(
              key: const Key('choose-customer-button'),
              icon: const Icon(Icons.person_search),
              label: Text(_chosen?.label ?? 'Choose customer'),
              onPressed: () async {
                final c = await showCustomerPicker(context);
                if (c != null) {
                  setState(() {
                    _chosen = ExistingCustomer(c.customerId, c.fullName);
                    _customerTouched = true;
                  });
                }
              },
            ),
          if (_mode == _CustomerMode.create) CustomerFields(controllers: _newCustomer, compact: true),
          if (_mode == _CustomerMode.none)
            Text('The vehicle can be linked to a customer later.', style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.lg),
          if (_error != null) ...[
            InlineError(_error!),
            if (_existingVehicleId != null)
              TextButton(
                key: const Key('open-existing-vehicle'),
                onPressed: () => context.go(AppRoutes.vehicleDetail(_existingVehicleId!)),
                child: const Text('Open the existing vehicle'),
              ),
            const SizedBox(height: AppSpacing.sm),
          ],
          FilledButton(
            key: const Key('vehicle-save-button'),
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(_isCreate ? (widget.startServiceAfter ? 'Register and continue' : 'Register vehicle') : 'Save changes'),
          ),
        ],
      ),
    );
  }
}
