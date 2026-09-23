import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/number_plates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/vehicle.dart';
import '../../../routes/app_routes.dart';
import '../application/operations_providers.dart';
import 'operations_widgets.dart';

/// Plate-first vehicle search — the reception point's main screen.
///
/// Type a plate (any spacing/case: `ugb123a`, `UGB-123A`…). As soon as the
/// typed plate matches a registered vehicle it is shown as "Vehicle found"
/// with **Start service**; similar plates are listed below; an unknown valid
/// plate offers **Register vehicle** with the plate pre-filled.
///
/// [intakeMode] (the "New Service" entry) makes tapping a result go straight
/// to service selection.
class VehicleSearchScreen extends ConsumerStatefulWidget {
  const VehicleSearchScreen({super.key, this.intakeMode = false});
  final bool intakeMode;

  @override
  ConsumerState<VehicleSearchScreen> createState() => _VehicleSearchScreenState();
}

class _VehicleSearchScreenState extends ConsumerState<VehicleSearchScreen> {
  static const debounce = Duration(milliseconds: 350);

  final _controller = TextEditingController();
  Timer? _debounce;
  int _requestId = 0;
  bool _loading = true;
  List<Vehicle> _results = const [];
  String _searchedKey = '';
  String? _error;

  @override
  void initState() {
    super.initState();
    _search('');
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(debounce, () => _search(value));
  }

  Future<void> _search(String input, {bool log = false}) async {
    _debounce?.cancel();
    final id = ++_requestId;
    final key = NumberPlates.key(input);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await ref.read(operationsRepositoryProvider).searchVehicles(input);
      if (!mounted || id != _requestId) return; // a newer search replaced this one
      setState(() {
        _results = results;
        _searchedKey = key;
        _loading = false;
      });
      if (log && key.isNotEmpty) {
        await ref.read(operationsActionsProvider).logSearch(found: results.any((v) => v.normalizedNumberPlate == key));
      }
    } catch (e) {
      if (!mounted || id != _requestId) return;
      setState(() {
        _loading = false;
        _error = ErrorMapper.map(e).message;
      });
    }
  }

  void _open(Vehicle v) => context.go(
      widget.intakeMode && v.isActive ? AppRoutes.startService(v.vehicleId) : AppRoutes.vehicleDetail(v.vehicleId));

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final canRegister = canDo(ref, Permission.vehiclesManage);
    final canStart = canDo(ref, Permission.jobsCreate);
    final exact = _searchedKey.isEmpty
        ? null
        : _results.where((v) => v.normalizedNumberPlate == _searchedKey).firstOrNull;
    final others = [for (final v in _results) if (v != exact) v];
    final typedPlate = NumberPlates.parse(_controller.text);

    return ListView(
      key: const Key('vehicle-search-list'),
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xl),
      children: [
        Text(widget.intakeMode ? 'New service' : 'Vehicles', style: theme.textTheme.titleLarge),
        Text('Search by number plate', style: theme.textTheme.bodySmall),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          key: const Key('plate-search-field'),
          controller: _controller,
          autofocus: widget.intakeMode,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [UpperCaseFormatter()],
          textInputAction: TextInputAction.search,
          style: theme.textTheme.titleLarge?.copyWith(letterSpacing: 1.5, fontWeight: FontWeight.w700),
          decoration: InputDecoration(
            hintText: 'UGB 123A',
            prefixIcon: const Icon(Icons.directions_car_outlined),
            suffixIcon: _controller.text.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Clear',
                    icon: const Icon(Icons.close),
                    onPressed: () {
                      _controller.clear();
                      _search('');
                    },
                  ),
          ),
          onChanged: (v) {
            setState(() {});
            _onChanged(v);
          },
          onSubmitted: (v) => _search(v, log: true),
        ),
        const SizedBox(height: AppSpacing.xs),
        FilledButton.icon(
          key: const Key('plate-search-button'),
          onPressed: () => _search(_controller.text, log: true),
          icon: const Icon(Icons.search),
          label: const Text('Search'),
        ),
        const SizedBox(height: AppSpacing.md),
        if (_loading) const LinearProgressIndicator(),
        if (_error != null) InlineError(_error!),
        if (!_loading && exact != null) _FoundCard(vehicle: exact, canStart: canStart, onView: () => context.go(AppRoutes.vehicleDetail(exact.vehicleId))),
        if (!_loading && exact == null && _searchedKey.isNotEmpty) ...[
          Card(
            key: const Key('vehicle-not-found'),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(
                  typedPlate == null ? 'Keep typing the plate, e.g. UBA 123A' : 'No vehicle found for ${typedPlate.display}.',
                  style: theme.textTheme.titleMedium,
                ),
                if (typedPlate != null && canRegister) ...[
                  const SizedBox(height: AppSpacing.sm),
                  FilledButton.icon(
                    key: const Key('register-vehicle-button'),
                    onPressed: () => context.go(AppRoutes.newVehicle(plate: typedPlate.display, startService: widget.intakeMode && canStart)),
                    icon: const Icon(Icons.add),
                    label: const Text('Register vehicle'),
                  ),
                ],
                if (typedPlate != null && !canRegister)
                  const Text('Ask a cashier or manager to register this vehicle.'),
              ]),
            ),
          ),
        ],
        if (!_loading && others.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.md),
          Text(_searchedKey.isEmpty ? 'Recently registered' : 'Similar plates', style: theme.textTheme.labelLarge),
          const SizedBox(height: AppSpacing.xs),
          for (final v in others)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.xs),
              child: VehicleTile(vehicle: v, onTap: () => _open(v)),
            ),
        ],
        if (!_loading && _results.isEmpty && _searchedKey.isEmpty)
          const EmptyView(icon: Icons.directions_car_outlined, title: 'No vehicles yet', message: 'Search a plate to register the first one.'),
      ],
    );
  }
}

class _FoundCard extends StatelessWidget {
  const _FoundCard({required this.vehicle, required this.canStart, required this.onView});
  final Vehicle vehicle;
  final bool canStart;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      key: const Key('vehicle-found'),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.check_circle, color: AppColors.success),
            const SizedBox(width: AppSpacing.xs),
            Text('Vehicle found', style: theme.textTheme.titleMedium),
            const Spacer(),
            if (!vehicle.isActive) RecordStatusChip(vehicle.status),
          ]),
          const SizedBox(height: AppSpacing.sm),
          PlateBadge(vehicle.numberPlate, large: true),
          const SizedBox(height: AppSpacing.xs),
          Text(vehicle.description, style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.xxs),
          Text('Owner: ${vehicle.customerName ?? 'not recorded'}', style: theme.textTheme.bodyMedium),
          const SizedBox(height: AppSpacing.md),
          Row(children: [
            Expanded(
              child: OutlinedButton(key: const Key('view-vehicle-button'), onPressed: onView, child: const Text('View vehicle')),
            ),
            if (canStart && vehicle.isActive) ...[
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: FilledButton(
                  key: const Key('start-service-button'),
                  onPressed: () => context.go(AppRoutes.startService(vehicle.vehicleId)),
                  child: const Text('Start service'),
                ),
              ),
            ],
          ]),
          if (!vehicle.isActive) ...[
            const SizedBox(height: AppSpacing.xs),
            Text('This vehicle is inactive. Reactivate it before starting a service.', style: theme.textTheme.bodySmall),
          ],
        ]),
      ),
    );
  }
}
