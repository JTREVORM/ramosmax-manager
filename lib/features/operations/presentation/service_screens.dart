import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/catalog_service.dart';
import '../../../routes/app_routes.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/operations_providers.dart';
import '../data/operations_api.dart';
import 'customer_fields.dart' show requiredText;
import 'operations_widgets.dart';

/// Pure catalogue filter, unit-tested.
List<CatalogService> filterServices(List<CatalogService> all,
    {String query = '', ServiceCategory? category, bool? active}) {
  final q = query.trim().toLowerCase();
  return [
    for (final s in all)
      if ((q.isEmpty || s.name.toLowerCase().contains(q) || (s.description ?? '').toLowerCase().contains(q)) &&
          (category == null || s.category == category) &&
          (active == null || s.isActive == active))
        s,
  ];
}

/// Validates a whole-shilling price as typed (`15000`, `15,000`, `UGX 15,000`).
String? priceValidator(String? v) {
  if (v == null || v.trim().isEmpty) return 'Enter the price';
  final m = Money.tryParse(v);
  if (m == null) return 'Enter whole shillings, e.g. 15,000 (no decimals)';
  if (m.isNegative) return 'The price cannot be negative';
  if (m.ugx > 100000000) return 'That price looks too high';
  return null;
}

class ServicesScreen extends ConsumerStatefulWidget {
  const ServicesScreen({super.key});

  @override
  ConsumerState<ServicesScreen> createState() => _ServicesScreenState();
}

enum _Active { all, active, inactive }

class _ServicesScreenState extends ConsumerState<ServicesScreen> {
  String _query = '';
  ServiceCategory? _category;
  _Active _active = _Active.active;

  @override
  Widget build(BuildContext context) {
    final canManage = canDo(ref, Permission.servicesManage);
    final services = ref.watch(servicesProvider);
    return Scaffold(
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              key: const Key('add-service-button'),
              onPressed: () => context.go(AppRoutes.newCatalogService),
              icon: const Icon(Icons.add),
              label: const Text('Add service'),
            )
          : null,
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Services', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.sm),
            TextField(
              key: const Key('service-search'),
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search services'),
              onChanged: (v) => setState(() => _query = v),
            ),
          ]),
        ),
        FilterChips<ServiceCategory?>(
          values: [null, ...ServiceCategory.values],
          selected: _category,
          label: (c) => c?.label ?? 'All categories',
          keyPrefix: 'service-category',
          onSelected: (c) => setState(() => _category = c),
        ),
        if (canManage)
          FilterChips<_Active>(
            values: _Active.values,
            selected: _active,
            label: (a) => switch (a) { _Active.all => 'All', _Active.active => 'Active', _Active.inactive => 'Inactive' },
            keyPrefix: 'service-status',
            onSelected: (a) => setState(() => _active = a),
          ),
        Expanded(
          child: switch (services) {
            AsyncData(:final value) => () {
                final list = filterServices(value,
                    query: _query,
                    category: _category,
                    // Only managers see inactive services; everyone else sees what is offered.
                    active: !canManage ? true : switch (_active) { _Active.all => null, _Active.active => true, _Active.inactive => false });
                if (list.isEmpty) {
                  return EmptyView(
                    icon: Icons.local_car_wash_outlined,
                    title: value.isEmpty ? 'No services yet' : 'No matching services',
                    message: value.isEmpty && canManage ? 'Add the services RamosMAX offers and their prices.' : null,
                  );
                }
                return ListView(
                  padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                  children: [for (final s in list) _ServiceCard(service: s)],
                );
              }(),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error), onRetry: () => ref.invalidate(servicesProvider)),
            _ => const LoadingView(),
          },
        ),
      ]),
    );
  }
}

class _ServiceCard extends StatelessWidget {
  const _ServiceCard({required this.service});
  final CatalogService service;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = service;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.xs),
      child: Card(
        key: Key('service-card-${s.serviceId}'),
        child: ListTile(
          onTap: () => context.go(AppRoutes.catalogService(s.serviceId)),
          title: Text(s.name),
          subtitle: Text([s.category.label, ?s.durationLabel, if (s.qualifiesForLoyalty) 'Loyalty'].join(' · ')),
          trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(s.price.format(), style: theme.textTheme.titleMedium),
            if (!s.isActive) const Text('Inactive', style: TextStyle(color: AppColors.danger, fontSize: 12)),
          ]),
        ),
      ),
    );
  }
}

/// Add ([serviceId] null) or edit a service. Read-only for people without
/// `services.manage` — they can see prices but never change them.
class ServiceFormScreen extends ConsumerWidget {
  const ServiceFormScreen({super.key, this.serviceId});
  final String? serviceId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canManage = canDo(ref, Permission.servicesManage);
    if (serviceId == null) {
      return canManage
          ? const _ServiceForm(existing: null)
          : const EmptyView(icon: Icons.lock_outline, title: 'Not permitted', message: 'You cannot add services.');
    }
    return switch (ref.watch(servicesProvider)) {
      AsyncData(:final value) => switch (value.where((s) => s.serviceId == serviceId).firstOrNull) {
          null => const EmptyView(icon: Icons.search_off, title: 'Service not found'),
          final s => canManage ? _ServiceForm(key: ValueKey('${s.serviceId}-${s.updatedAt}'), existing: s) : _ServiceView(service: s),
        },
      AsyncError() => const EmptyView(icon: Icons.error_outline, title: 'Could not load services'),
      _ => const LoadingView(),
    };
  }
}

class _ServiceView extends StatelessWidget {
  const _ServiceView({required this.service});
  final CatalogService service;

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Row(children: [
            IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.services)),
            Expanded(child: Text(service.name, style: Theme.of(context).textTheme.titleLarge)),
          ]),
          SectionCard(title: 'Service', icon: Icons.local_car_wash_outlined, children: [
            InfoRow('Price', service.price.format()),
            InfoRow('Category', service.category.label),
            InfoRow('Duration', service.durationLabel),
            InfoRow('Description', service.description),
            InfoRow('Loyalty', service.qualifiesForLoyalty ? 'Qualifies' : 'Does not qualify'),
            InfoRow('Status', service.isActive ? 'Offered' : 'Not currently offered'),
          ]),
          const SizedBox(height: AppSpacing.sm),
          const Text('Only managers and administrators can change services or prices.', key: Key('service-read-only')),
        ],
      );
}

class _ServiceForm extends ConsumerStatefulWidget {
  const _ServiceForm({super.key, required this.existing});
  final CatalogService? existing;

  @override
  ConsumerState<_ServiceForm> createState() => _ServiceFormState();
}

class _ServiceFormState extends ConsumerState<_ServiceForm> {
  final _form = GlobalKey<FormState>();
  late final CatalogService? _s = widget.existing;
  late final _name = TextEditingController(text: _s?.name ?? '');
  late final _description = TextEditingController(text: _s?.description ?? '');
  late final _price = TextEditingController(text: _s?.price.formatAmount() ?? '');
  late final _duration = TextEditingController(text: _s?.estimatedDurationMinutes?.toString() ?? '');
  late ServiceCategory _category = _s?.category ?? ServiceCategory.washing;
  late bool _loyalty = _s?.qualifiesForLoyalty ?? false;
  late bool _active = _s?.isActive ?? true;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_name, _description, _price, _duration]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    final price = Money.tryParse(_price.text)!.ugx;
    final duration = int.tryParse(_duration.text.trim());
    final actions = ref.read(operationsActionsProvider);
    final s = _s;

    String? reason;
    if (s != null && price != s.price.ugx) {
      reason = await showReasonDialog(
        context,
        title: 'Change the price of ${s.name}?',
        message: '${s.price.format()} → ${Money(price).format()}. New service visits use the new price; '
            'visits already started keep the price they were recorded with.',
        confirmLabel: 'Change price',
        reasonRequired: false,
      );
      if (reason == null || !mounted) return;
    }
    setState(() => _saving = true);
    final Result<String> r;
    if (s == null) {
      r = await actions.createService(ServiceInput(
        name: _name.text.trim(),
        description: _description.text.trim(),
        category: _category.key,
        priceUgx: price,
        estimatedDurationMinutes: duration,
        qualifiesForLoyalty: _loyalty,
        isActive: _active,
      ));
    } else {
      final u = await actions.updateService(
        s.serviceId,
        ServiceInput(
          name: _name.text.trim() == s.name ? null : _name.text.trim(),
          description: _description.text.trim() == (s.description ?? '') ? null : _description.text.trim(),
          category: _category == s.category ? null : _category.key,
          priceUgx: price == s.price.ugx ? null : price,
          estimatedDurationMinutes: duration == s.estimatedDurationMinutes ? null : duration,
          clearDuration: duration == null && s.estimatedDurationMinutes != null,
          qualifiesForLoyalty: _loyalty == s.qualifiesForLoyalty ? null : _loyalty,
          isActive: _active == s.isActive ? null : _active,
        ),
        reason: (reason == null || reason.isEmpty) ? null : reason,
      );
      r = u.when(success: (_) => Success(s.serviceId), failure: (f) => f.code == 'no_changes' ? Success(s.serviceId) : Failure(f));
    }
    if (!mounted) return;
    setState(() => _saving = false);
    switch (r) {
      case Success():
        AppSnackbar.success(context, s == null ? 'Service added.' : 'Service saved.');
        context.go(AppRoutes.services);
      case Failure(:final error):
        setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
        children: [
          Row(children: [
            IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.services)),
            Expanded(child: Text(_s == null ? 'Add service' : 'Edit service', style: theme.textTheme.titleLarge)),
          ]),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('service-name-field'),
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Service name *', hintText: 'e.g. Full Wash'),
            validator: (v) => requiredText(v, 'service name'),
          ),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('service-description-field'),
            controller: _description,
            minLines: 1,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Description'),
            validator: (v) => (v?.trim().length ?? 0) > 300 ? 'Too long (300 characters maximum)' : null,
          ),
          const SizedBox(height: AppSpacing.sm),
          DropdownButtonFormField<ServiceCategory>(
            key: const Key('service-category-field'),
            initialValue: _category,
            decoration: const InputDecoration(labelText: 'Category'),
            items: [for (final c in ServiceCategory.values) DropdownMenuItem(value: c, child: Text(c.label))],
            onChanged: (c) => setState(() => _category = c ?? ServiceCategory.other),
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: TextFormField(
                key: const Key('service-price-field'),
                controller: _price,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d,.\s-]'))],
                decoration: const InputDecoration(labelText: 'Price *', prefixText: 'UGX '),
                validator: priceValidator,
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: TextFormField(
                key: const Key('service-duration-field'),
                controller: _duration,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(labelText: 'Duration', suffixText: 'min'),
                validator: (v) {
                  if (v == null || v.isEmpty) return null;
                  final d = int.tryParse(v);
                  return (d == null || d < 1 || d > 1440) ? '1–1440 minutes' : null;
                },
              ),
            ),
          ]),
          SwitchListTile(
            key: const Key('service-loyalty-switch'),
            contentPadding: EdgeInsets.zero,
            value: _loyalty,
            onChanged: (v) => setState(() => _loyalty = v),
            title: const Text('Qualifies for loyalty'),
            subtitle: const Text('Used by the loyalty programme in a later release'),
          ),
          SwitchListTile(
            key: const Key('service-active-switch'),
            contentPadding: EdgeInsets.zero,
            value: _active,
            onChanged: (v) => setState(() => _active = v),
            title: const Text('Active'),
            subtitle: Text(_active ? 'Offered when starting a service' : 'Hidden from new service visits; history is kept'),
          ),
          const SizedBox(height: AppSpacing.md),
          if (_error != null) ...[InlineError(_error!), const SizedBox(height: AppSpacing.sm)],
          FilledButton(
            key: const Key('service-save-button'),
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(_s == null ? 'Add service' : 'Save changes'),
          ),
        ],
      ),
    );
  }
}
