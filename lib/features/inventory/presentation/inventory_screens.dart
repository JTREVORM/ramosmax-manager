import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/inventory.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_forms.dart' show pickPaymentAccount;
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/inventory_providers.dart';
import '../data/inventory_api.dart';

class StockStatusChip extends StatelessWidget {
  const StockStatusChip(this.status, {super.key});
  final StockStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        StockStatus.ok => const StatusChip('OK', color: AppColors.success, icon: Icons.check_circle_outline),
        StockStatus.low => const StatusChip('LOW', color: AppColors.warning, icon: Icons.trending_down),
        StockStatus.outOfStock => const StatusChip('OUT OF STOCK', color: AppColors.danger, icon: Icons.remove_shopping_cart_outlined),
      };
}

class ItemTile extends StatelessWidget {
  const ItemTile({super.key, required this.item, required this.onTap});
  final InventoryItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final i = item;
    final theme = Theme.of(context);
    return Card(
      key: Key('item-${i.itemId}'),
      child: ListTile(
        onTap: onTap,
        title: Text(i.name, style: i.active ? null : const TextStyle(color: Colors.grey)),
        subtitle: Text([
          i.sku,
          i.category.label,
          'min ${i.minimumStock} · reorder ${i.reorderLevel}',
          ?i.preferredSupplierName,
          if (!i.active) 'Inactive',
        ].join(' · ')),
        trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(i.unit.quantity(i.quantity), key: Key('qty-${i.itemId}'), style: theme.textTheme.titleSmall),
          StockStatusChip(i.stockStatus),
        ]),
      ),
    );
  }
}

class MovementTile extends StatelessWidget {
  const MovementTile({super.key, required this.movement, this.showItem = true, this.onReverse});
  final StockMovement movement;
  final bool showItem;
  final VoidCallback? onReverse;

  @override
  Widget build(BuildContext context) {
    final m = movement;
    final up = m.quantityChange > 0;
    return Card(
      key: Key('movement-${m.movementId}'),
      child: ListTile(
        leading: Icon(up ? Icons.add_circle_outline : Icons.remove_circle_outline, color: up ? AppColors.success : AppColors.danger),
        title: Text(
          '${showItem ? '${m.itemName} · ' : ''}${m.type.label} ${up ? '+' : '−'}${m.quantityChange.abs()}',
          style: m.reversed ? const TextStyle(decoration: TextDecoration.lineThrough) : null,
        ),
        subtitle: Text([
          m.movementNumber,
          'now ${m.quantityAfter}',
          ?m.reasonCode?.label,
          ?m.reason,
          ?m.purchaseNumber,
          ?m.jobNumber,
          if (m.workerName != null) 'by ${m.workerName}',
          ?m.createdByName,
          if (m.createdAt != null) DateTimeFormatter.dateTime(m.createdAt!),
          if (m.reversed) 'Reversed',
        ].join(' · ')),
        trailing: onReverse == null ? null : IconButton(tooltip: 'Reverse', icon: const Icon(Icons.undo), onPressed: onReverse),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Inventory module: tabs
// ---------------------------------------------------------------------------

class InventoryScreen extends ConsumerWidget {
  const InventoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tabs = <(String, Widget)>[
      ('Dashboard', const _InventoryDashboard()),
      ('Items', const _ItemsTab()),
      ('Low stock', const _LowStockTab()),
      ('Suppliers', const _SuppliersTab()),
      ('Purchases', const _PurchasesTab()),
      ('Movements', const _MovementsTab()),
      ('Adjustments', const _MovementsTab(adjustmentsOnly: true)),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Column(children: [
        TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final (label, _) in tabs) Tab(text: label)]),
        Expanded(child: TabBarView(children: [for (final (_, view) in tabs) view])),
      ]),
    );
  }
}

class _InventoryDashboard extends ConsumerWidget {
  const _InventoryDashboard();

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(inventoryItemsProvider)) {
        AsyncData(:final value) => () {
            final s = StockSummary.of(value);
            final recent = ref.watch(stockMovementsProvider(null)).value ?? const <StockMovement>[];
            return ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
              children: [
                FigureGrid(children: [
                  FigureCard(label: 'Active items', value: '${s.activeItems}'),
                  FigureCard(label: 'Low stock', value: '${s.low}', color: s.low > 0 ? AppColors.warning : null, valueKey: const Key('inv-low-count')),
                  FigureCard(label: 'Out of stock', value: '${s.outOfStock}', color: s.outOfStock > 0 ? AppColors.danger : null, valueKey: const Key('inv-out-count')),
                  if (canDo(ref, Permission.inventoryReportsView))
                    FigureCard(
                      label: 'Indicative stock value',
                      value: s.indicativeValue.format(),
                      caption: 'At last purchase cost — not an accounting valuation',
                    ),
                ]),
                if (s.itemsWithoutCost > 0 && canDo(ref, Permission.inventoryReportsView))
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.xs),
                    child: Text('${s.itemsWithoutCost} item(s) in stock have no recorded cost and are left out of the value.',
                        style: Theme.of(context).textTheme.bodySmall),
                  ),
                const SizedBox(height: AppSpacing.sm),
                Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
                  if (canDo(ref, Permission.inventoryManage))
                    FilledButton.icon(
                      key: const Key('new-item-button'),
                      onPressed: () => context.go(AppRoutes.newInventoryItem),
                      icon: const Icon(Icons.add),
                      label: const Text('New item'),
                    ),
                  if (canDo(ref, Permission.inventoryPurchaseCreate))
                    OutlinedButton.icon(
                      key: const Key('new-purchase-button'),
                      onPressed: () => context.go(AppRoutes.newPurchase),
                      icon: const Icon(Icons.shopping_cart_outlined),
                      label: const Text('New purchase'),
                    ),
                ]),
                const SizedBox(height: AppSpacing.sm),
                SectionCard(title: 'Recent stock movements', children: [
                  if (recent.isEmpty) const Text('No movements yet.'),
                  for (final m in recent.take(10)) MovementTile(movement: m),
                ]),
              ],
            );
          }(),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

class _ItemsTab extends ConsumerStatefulWidget {
  const _ItemsTab();

  @override
  ConsumerState<_ItemsTab> createState() => _ItemsTabState();
}

class _ItemsTabState extends ConsumerState<_ItemsTab> {
  String _query = '';
  InventoryCategory? _category;
  bool _showInactive = false;

  @override
  Widget build(BuildContext context) => Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 0),
          child: TextField(
            key: const Key('item-search'),
            decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Name, SKU or category', isDense: true),
            onChanged: (v) => setState(() => _query = v),
          ),
        ),
        FilterChips<InventoryCategory?>(
          values: const [null, ...InventoryCategory.values],
          selected: _category,
          label: (c) => c?.label ?? 'All',
          keyPrefix: 'item-category',
          onSelected: (c) => setState(() => _category = c),
        ),
        Expanded(
          child: switch (ref.watch(inventoryItemsProvider)) {
            AsyncData(:final value) => () {
                final shown = value
                    .where((i) => (_showInactive || i.active) && (_category == null || i.category == _category) && itemMatches(i, _query))
                    .toList();
                return ListView(
                  padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
                  children: [
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Show inactive items'),
                      value: _showInactive,
                      onChanged: (v) => setState(() => _showInactive = v),
                    ),
                    if (shown.isEmpty)
                      const EmptyView(icon: Icons.inventory_2_outlined, title: 'No items', message: 'Add stock items from the Dashboard tab.'),
                    for (final i in shown) ItemTile(item: i, onTap: () => context.go(AppRoutes.inventoryItem(i.itemId))),
                  ],
                );
              }(),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]);
}

class _LowStockTab extends ConsumerWidget {
  const _LowStockTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(lowStockProvider)) {
        AsyncData(:final value) when value.isEmpty =>
          const EmptyView(icon: Icons.check_circle_outline, title: 'Stock is healthy', message: 'No item is at or below its reorder level.'),
        AsyncData(:final value) => ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
            children: [
              for (final i in [...value]..sort((a, b) => b.stockStatus.index.compareTo(a.stockStatus.index)))
                ItemTile(item: i, onTap: () => context.go(AppRoutes.inventoryItem(i.itemId))),
            ],
          ),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

class _MovementsTab extends ConsumerStatefulWidget {
  const _MovementsTab({this.adjustmentsOnly = false});
  final bool adjustmentsOnly;

  @override
  ConsumerState<_MovementsTab> createState() => _MovementsTabState();
}

class _MovementsTabState extends ConsumerState<_MovementsTab> {
  late MovementType? _type = widget.adjustmentsOnly ? MovementType.adjustmentOut : null;

  @override
  Widget build(BuildContext context) {
    final types = widget.adjustmentsOnly
        ? const [MovementType.adjustmentOut, MovementType.adjustmentIn, MovementType.reversal]
        : const [null, ...MovementType.values];
    return Column(children: [
      FilterChips<MovementType?>(
        values: types,
        selected: _type,
        label: (t) => t?.label ?? 'All',
        keyPrefix: widget.adjustmentsOnly ? 'adjustment-type' : 'movement-type',
        onSelected: (t) => setState(() => _type = t),
      ),
      Expanded(
        child: switch (ref.watch(stockMovementsProvider(_type))) {
          AsyncData(:final value) when value.isEmpty => const EmptyView(icon: Icons.swap_vert, title: 'No movements'),
          AsyncData(:final value) => ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
              children: [for (final m in value) MovementTile(movement: m)],
            ),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Item detail, movements and adjustments
// ---------------------------------------------------------------------------

class ItemDetailScreen extends ConsumerWidget {
  const ItemDetailScreen({super.key, required this.itemId});
  final String itemId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canIn = canDo(ref, Permission.inventoryStockIn);
    final canOut = canDo(ref, Permission.inventoryStockOut);
    final canAdjust = canDo(ref, Permission.inventoryStockAdjust);
    return switch (ref.watch(inventoryItemProvider(itemId))) {
      AsyncData(value: final InventoryItem i) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
          children: [
            ScreenHeader(i.name, subtitle: i.sku, onBack: () => context.go(AppRoutes.inventory)),
            SectionCard(title: 'Stock', icon: Icons.inventory_2_outlined, trailing: StockStatusChip(i.stockStatus), children: [
              InfoRow('In stock', i.unit.quantity(i.quantity)),
              InfoRow('Minimum stock', '${i.minimumStock}'),
              InfoRow('Reorder level', '${i.reorderLevel}'),
              InfoRow('Category', i.category.label),
              InfoRow('Type', i.isConsumable ? 'Consumable' : 'Reusable / equipment'),
              InfoRow('Supplier', i.preferredSupplierName),
              InfoRow('Last unit cost', i.lastUnitCost?.format()),
              InfoRow('Description', i.description),
              if (!i.active) const InfoRow('Status', 'Inactive'),
            ]),
            const SizedBox(height: AppSpacing.sm),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              if (canOut)
                FilledButton.icon(
                  key: const Key('record-usage-button'),
                  icon: const Icon(Icons.remove),
                  label: const Text('Use / stock out'),
                  onPressed: () => showFormSheet<void>(context, MovementSheet(item: i, initial: MovementType.usage)),
                ),
              if (canIn && i.active)
                OutlinedButton.icon(
                  key: const Key('record-stock-in-button'),
                  icon: const Icon(Icons.add),
                  label: const Text('Stock in'),
                  onPressed: () => showFormSheet<void>(context, MovementSheet(item: i, initial: MovementType.stockIn)),
                ),
              if (canAdjust)
                OutlinedButton.icon(
                  key: const Key('adjust-stock-button'),
                  icon: const Icon(Icons.fact_check_outlined),
                  label: const Text('Count / adjust'),
                  onPressed: () => showFormSheet<void>(context, AdjustStockSheet(item: i)),
                ),
              if (canDo(ref, Permission.inventoryManage))
                OutlinedButton.icon(
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('Edit'),
                  onPressed: () => context.go(AppRoutes.editInventoryItem(i.itemId)),
                ),
            ]),
            const SizedBox(height: AppSpacing.md),
            Text('Movement history', style: Theme.of(context).textTheme.titleMedium),
            ...switch (ref.watch(itemMovementsProvider(itemId))) {
              AsyncData(:final value) when value.isEmpty => [const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No movements yet.'))],
              AsyncData(:final value) => [
                  for (final m in value)
                    MovementTile(
                      movement: m,
                      showItem: false,
                      onReverse: canAdjust && m.canReverse
                          ? () async {
                              final reason = await showReasonDialog(context,
                                  title: 'Reverse ${m.movementNumber}?',
                                  message: 'Adds a reversal movement of ${m.quantityChange.abs()}. The original is kept.',
                                  confirmLabel: 'Reverse',
                                  destructive: true);
                              if (reason == null || !context.mounted) return;
                              final r = await ref.read(inventoryActionsProvider).reverseMovement(m.movementId, reason);
                              if (context.mounted) reportResult(context, r, 'Movement reversed.');
                            }
                          : null,
                    ),
                ],
              AsyncError(:final error) => [InlineError(ErrorMapper.map(error).message)],
              _ => [const LoadingView()],
            },
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.inventory_2_outlined, title: 'Item not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

/// Usage, stock-out, return or stock-in for one item. Never below zero: the
/// sheet warns, and the server refuses.
class MovementSheet extends ConsumerStatefulWidget {
  const MovementSheet({super.key, required this.item, this.initial = MovementType.usage});
  final InventoryItem item;
  final MovementType initial;

  @override
  ConsumerState<MovementSheet> createState() => _MovementSheetState();
}

class _MovementSheetState extends ConsumerState<MovementSheet> {
  late MovementType _type = widget.initial;
  final _qty = TextEditingController();
  final _reason = TextEditingController();
  final _reference = TextEditingController();
  final _cost = TextEditingController();
  StockOutReason? _reasonCode;
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_qty, _reason, _reference, _cost]) {
      c.dispose();
    }
    super.dispose();
  }

  List<MovementType> get _allowed => [
        if (canDo(ref, Permission.inventoryStockOut)) ...[MovementType.usage, MovementType.stockOut, MovementType.returned],
        if (canDo(ref, Permission.inventoryStockIn) && widget.item.active) MovementType.stockIn,
      ];

  @override
  Widget build(BuildContext context) {
    final i = widget.item;
    final q = int.tryParse(_qty.text.trim());
    final out = _type != MovementType.stockIn;
    final String? qtyError = switch (q) {
      null when _qty.text.trim().isNotEmpty => 'Whole number',
      final int n when n <= 0 => 'Above zero',
      final int n when out && n > i.quantity => 'Only ${i.unit.quantity(i.quantity)} available',
      _ => null,
    };
    final cost = _cost.text.trim().isEmpty ? null : MoneyField.parse(_cost.text, allowZero: true);
    final ready = q != null && qtyError == null && _reason.text.trim().length >= 3 && (_type != MovementType.stockOut || _reasonCode != null);
    return FormSheet(
      title: '${i.name} · ${i.unit.quantity(i.quantity)} in stock',
      submitLabel: 'Record ${_type.label.toLowerCase()}',
      submitKey: const Key('submit-movement'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() {
                _saving = true;
                _error = null;
              });
              final r = await ref.read(inventoryActionsProvider).recordMovement(
                    itemId: i.itemId,
                    type: _type,
                    quantity: q,
                    reason: _reason.text.trim(),
                    requestId: _requestId,
                    reasonCode: _type == MovementType.stockOut ? _reasonCode : null,
                    reference: _reference.text.trim().isEmpty ? null : _reference.text.trim(),
                    unitCost: _type == MovementType.stockIn ? cost : null,
                  );
              if (!mounted) return;
              setState(() => _saving = false);
              switch (r) {
                case Success():
                  AppSnackbar.success(this.context, '${_type.label}: ${i.unit.quantity(q)} recorded.');
                  Navigator.of(this.context).pop();
                case Failure(:final error):
                  setState(() => _error = error.message);
              }
            },
      children: [
        Wrap(spacing: AppSpacing.xs, children: [
          for (final t in _allowed)
            ChoiceChip(key: Key('movement-${t.key}'), label: Text(t.label), selected: _type == t, onSelected: (_) => setState(() => _type = t)),
        ]),
        TextField(
          key: const Key('movement-quantity'),
          controller: _qty,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: InputDecoration(labelText: 'Quantity (${i.unit.label.toLowerCase()})', errorText: qtyError),
          onChanged: (_) => setState(() {}),
        ),
        if (_type == MovementType.stockOut)
          DropdownButtonFormField<StockOutReason>(
            key: const Key('movement-reason-code'),
            initialValue: _reasonCode,
            decoration: const InputDecoration(labelText: 'Why is it going out?'),
            items: [for (final r in StockOutReason.values) DropdownMenuItem(value: r, child: Text(r.label))],
            onChanged: (v) => setState(() => _reasonCode = v),
          ),
        if (_type == MovementType.stockIn)
          MoneyField(controller: _cost, allowZero: true, label: 'Unit cost (optional)', onChanged: (_) => setState(() {})),
        TextField(
          key: const Key('movement-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: InputDecoration(labelText: _type == MovementType.usage ? 'What was it used for? (e.g. job, bay)' : 'Reason'),
          onChanged: (_) => setState(() {}),
        ),
        TextField(controller: _reference, maxLength: 60, decoration: const InputDecoration(labelText: 'Reference (optional)')),
        if (_type == MovementType.stockOut)
          Text('High-value stock-outs need a manager (inventory.stock.adjust).', style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

/// Physical count: the server records the difference as an adjustment.
class AdjustStockSheet extends ConsumerStatefulWidget {
  const AdjustStockSheet({super.key, required this.item});
  final InventoryItem item;

  @override
  ConsumerState<AdjustStockSheet> createState() => _AdjustStockSheetState();
}

class _AdjustStockSheetState extends ConsumerState<AdjustStockSheet> {
  final _count = TextEditingController();
  final _reason = TextEditingController();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _count.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final i = widget.item;
    final counted = int.tryParse(_count.text.trim());
    final diff = counted == null ? null : counted - i.quantity;
    final ready = counted != null && counted >= 0 && diff != 0 && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Count ${i.name}',
      subtitle: 'The quantity is never overwritten: the difference is recorded as an adjustment with your reason.',
      submitLabel: 'Record adjustment',
      submitKey: const Key('submit-adjustment'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(inventoryActionsProvider).adjust(i.itemId, countedQuantity: counted, reason: _reason.text.trim(), requestId: _requestId);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Stock adjusted to $counted.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        InfoRow('System quantity', '${i.quantity}'),
        TextField(
          key: const Key('count-quantity'),
          controller: _count,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(labelText: 'Physical count'),
          onChanged: (_) => setState(() {}),
        ),
        if (diff != null)
          Text(diff == 0 ? 'No difference — nothing to adjust.' : 'Difference: ${diff > 0 ? '+' : ''}$diff',
              key: const Key('count-difference'),
              style: TextStyle(fontWeight: FontWeight.w700, color: diff == 0 ? AppColors.success : AppColors.danger)),
        TextField(
          key: const Key('count-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: const InputDecoration(labelText: 'Reason (e.g. physical count discrepancy)'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Item form
// ---------------------------------------------------------------------------

class ItemFormScreen extends ConsumerStatefulWidget {
  const ItemFormScreen({super.key, this.itemId});
  final String? itemId;

  @override
  ConsumerState<ItemFormScreen> createState() => _ItemFormScreenState();
}

class _ItemFormScreenState extends ConsumerState<ItemFormScreen> {
  final _name = TextEditingController();
  final _description = TextEditingController();
  final _min = TextEditingController(text: '0');
  final _reorder = TextEditingController(text: '0');
  final _opening = TextEditingController();
  final _cost = TextEditingController();
  final _sku = TextEditingController();
  InventoryCategory _category = InventoryCategory.chemicals;
  InventoryUnit _unit = InventoryUnit.bottle;
  bool _consumable = true;
  String? _supplier;
  bool _active = true;
  bool _loaded = false;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_name, _description, _min, _reorder, _opening, _cost, _sku]) {
      c.dispose();
    }
    super.dispose();
  }

  void _load(InventoryItem i) {
    if (_loaded) return;
    _loaded = true;
    _name.text = i.name;
    _description.text = i.description ?? '';
    _min.text = '${i.minimumStock}';
    _reorder.text = '${i.reorderLevel}';
    _cost.text = i.lastUnitCost?.formatAmount() ?? '';
    _category = i.category;
    _unit = i.unit;
    _consumable = i.isConsumable;
    _supplier = i.preferredSupplierId;
    _active = i.active;
  }

  @override
  Widget build(BuildContext context) {
    InventoryItem? existing;
    if (widget.itemId != null) {
      existing = ref.watch(inventoryItemProvider(widget.itemId!)).value;
      if (existing == null) return const LoadingView();
      _load(existing);
    }
    final suppliers = (ref.watch(suppliersProvider).value ?? const <Supplier>[]).where((s) => s.active || s.supplierId == _supplier).toList();
    final min = int.tryParse(_min.text.trim());
    final reorder = int.tryParse(_reorder.text.trim());
    final opening = _opening.text.trim().isEmpty ? 0 : int.tryParse(_opening.text.trim());
    final cost = _cost.text.trim().isEmpty ? null : MoneyField.parse(_cost.text, allowZero: true);
    final levelsError = min != null && reorder != null && reorder < min ? 'Reorder level must be at least the minimum' : null;
    final ready = _name.text.trim().length >= 2 && min != null && reorder != null && levelsError == null && opening != null &&
        (_cost.text.trim().isEmpty || cost != null);
    final canOpen = canDo(ref, Permission.inventoryStockIn);
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
      children: [
        ScreenHeader(existing == null ? 'New inventory item' : 'Edit ${existing.name}',
            subtitle: existing == null ? 'A SKU such as RMX-CHEM-001 is generated.' : 'Quantities change only through stock movements.',
            onBack: () => context.go(existing == null ? AppRoutes.inventory : AppRoutes.inventoryItem(existing.itemId))),
        TextField(key: const Key('item-name'), controller: _name, maxLength: 60, decoration: const InputDecoration(labelText: 'Item name'), onChanged: (_) => setState(() {})),
        DropdownButtonFormField<InventoryCategory>(
          key: const Key('item-category-field'),
          initialValue: _category,
          decoration: const InputDecoration(labelText: 'Category'),
          items: [for (final c in InventoryCategory.values) DropdownMenuItem(value: c, child: Text(c.label))],
          onChanged: (v) => setState(() => _category = v ?? _category),
        ),
        const SizedBox(height: AppSpacing.sm),
        DropdownButtonFormField<InventoryUnit>(
          initialValue: _unit,
          decoration: const InputDecoration(labelText: 'Unit'),
          items: [for (final u in InventoryUnit.values) DropdownMenuItem(value: u, child: Text(u.label))],
          onChanged: (v) => setState(() => _unit = v ?? _unit),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Consumable'),
          subtitle: const Text('Off for reusable tools and equipment'),
          value: _consumable,
          onChanged: (v) => setState(() => _consumable = v),
        ),
        Row(children: [
          Expanded(
            child: TextField(
              key: const Key('item-min'),
              controller: _min,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(labelText: 'Minimum stock'),
              onChanged: (_) => setState(() {}),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: TextField(
              key: const Key('item-reorder'),
              controller: _reorder,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(labelText: 'Reorder level', errorText: levelsError),
              onChanged: (_) => setState(() {}),
            ),
          ),
        ]),
        const SizedBox(height: AppSpacing.sm),
        DropdownButtonFormField<String?>(
          initialValue: _supplier,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Preferred supplier (optional)'),
          items: [const DropdownMenuItem<String?>(value: null, child: Text('None')), for (final s in suppliers) DropdownMenuItem(value: s.supplierId, child: Text(s.name))],
          onChanged: (v) => setState(() => _supplier = v),
        ),
        const SizedBox(height: AppSpacing.sm),
        MoneyField(controller: _cost, allowZero: true, label: 'Unit cost (optional)', onChanged: (_) => setState(() {})),
        TextField(controller: _description, maxLength: 300, decoration: const InputDecoration(labelText: 'Description')),
        if (existing == null) ...[
          TextField(controller: _sku, maxLength: 24, decoration: const InputDecoration(labelText: 'Own SKU (optional — leave blank to generate)')),
          if (canOpen)
            TextField(
              key: const Key('item-opening'),
              controller: _opening,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(labelText: 'Opening quantity (recorded as a stock-in)'),
              onChanged: (_) => setState(() {}),
            ),
        ] else
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Active'),
            value: _active,
            onChanged: (v) => setState(() => _active = v),
          ),
        if (_error != null) InlineError(_error!),
        const SizedBox(height: AppSpacing.sm),
        FilledButton(
          key: const Key('submit-item'),
          onPressed: !ready || _saving
              ? null
              : () async {
                  String? reason;
                  if (existing != null && existing.active && !_active) {
                    reason = await showReasonDialog(context, title: 'Deactivate ${existing.name}?', message: 'Its history is kept.', confirmLabel: 'Deactivate');
                    if (reason == null) return;
                  }
                  setState(() {
                    _saving = true;
                    _error = null;
                  });
                  final draft = ItemDraft(
                    name: _name.text.trim(),
                    category: _category,
                    unit: _unit,
                    minimumStock: min,
                    reorderLevel: reorder,
                    description: _description.text.trim().isEmpty ? null : _description.text.trim(),
                    isConsumable: _consumable,
                    preferredSupplierId: _supplier,
                    unitCost: cost,
                  );
                  final actions = ref.read(inventoryActionsProvider);
                  final Result<String> r = existing == null
                      ? await actions.createItem(draft, sku: _sku.text.trim().isEmpty ? null : _sku.text.trim(), openingQuantity: opening)
                      : (await actions.updateItem(existing.itemId, draft, active: _active == existing.active ? null : _active, reason: reason))
                          .when(success: (_) => Success(existing!.itemId), failure: Failure.new);
                  if (!context.mounted) return;
                  setState(() => _saving = false);
                  switch (r) {
                    case Success(:final value):
                      AppSnackbar.success(context, 'Item saved.');
                      context.go(AppRoutes.inventoryItem(value));
                    case Failure(:final error):
                      setState(() => _error = error.message);
                  }
                },
          child: const Text('Save item'),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

class _SuppliersTab extends ConsumerStatefulWidget {
  const _SuppliersTab();

  @override
  ConsumerState<_SuppliersTab> createState() => _SuppliersTabState();
}

class _SuppliersTabState extends ConsumerState<_SuppliersTab> {
  String _query = '';

  @override
  Widget build(BuildContext context) => Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 0),
          child: Row(children: [
            Expanded(
              child: TextField(
                key: const Key('supplier-search'),
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Supplier or contact', isDense: true),
                onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
              ),
            ),
            if (canDo(ref, Permission.inventorySuppliersManage))
              IconButton(
                key: const Key('new-supplier-button'),
                tooltip: 'Add supplier',
                icon: const Icon(Icons.add),
                onPressed: () => showFormSheet<void>(context, const SupplierSheet()),
              ),
          ]),
        ),
        Expanded(
          child: switch (ref.watch(suppliersProvider)) {
            AsyncData(:final value) => () {
                final shown = value
                    .where((s) => _query.isEmpty || s.name.toLowerCase().contains(_query) || (s.contactPerson ?? '').toLowerCase().contains(_query))
                    .toList();
                if (shown.isEmpty) return const EmptyView(icon: Icons.local_shipping_outlined, title: 'No suppliers');
                return ListView(
                  padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                  children: [
                    for (final s in shown)
                      Card(
                        key: Key('supplier-${s.supplierId}'),
                        child: ListTile(
                          onTap: () => context.go(AppRoutes.supplierDetail(s.supplierId)),
                          leading: const Icon(Icons.local_shipping_outlined),
                          title: Text(s.name, style: s.active ? null : const TextStyle(color: Colors.grey)),
                          subtitle: Text([
                            s.supplierNumber,
                            ?s.contactPerson,
                            if (s.phone != null) PhoneNumbers.formatForDisplay(s.phone!),
                            '${s.purchaseCount} purchase(s)',
                            if (!s.active) 'Inactive',
                          ].join(' · ')),
                        ),
                      ),
                  ],
                );
              }(),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]);
}

class SupplierSheet extends ConsumerStatefulWidget {
  const SupplierSheet({super.key, this.existing});
  final Supplier? existing;

  @override
  ConsumerState<SupplierSheet> createState() => _SupplierSheetState();
}

class _SupplierSheetState extends ConsumerState<SupplierSheet> {
  late final _name = TextEditingController(text: widget.existing?.name);
  late final _contact = TextEditingController(text: widget.existing?.contactPerson);
  late final _phone = TextEditingController(text: widget.existing?.phone);
  late final _email = TextEditingController(text: widget.existing?.email);
  late final _address = TextEditingController(text: widget.existing?.address);
  late final _notes = TextEditingController(text: widget.existing?.notes);
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_name, _contact, _phone, _email, _address, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    String? t(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();
    return FormSheet(
      title: widget.existing == null ? 'New supplier' : 'Edit ${widget.existing!.name}',
      submitLabel: 'Save supplier',
      submitKey: const Key('submit-supplier'),
      saving: _saving,
      error: _error,
      onSubmit: _name.text.trim().length < 2
          ? null
          : () async {
              setState(() => _saving = true);
              final draft = SupplierDraft(name: _name.text.trim(), contactPerson: t(_contact), phone: t(_phone), email: t(_email), address: t(_address), notes: t(_notes));
              final actions = ref.read(inventoryActionsProvider);
              final r = widget.existing == null ? await actions.createSupplier(draft) : await actions.updateSupplier(widget.existing!.supplierId, draft);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Supplier saved.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        TextField(key: const Key('supplier-name'), controller: _name, maxLength: 80, decoration: const InputDecoration(labelText: 'Supplier name'), onChanged: (_) => setState(() {})),
        TextField(controller: _contact, maxLength: 80, decoration: const InputDecoration(labelText: 'Contact person')),
        TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone')),
        TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
        TextField(controller: _address, maxLength: 200, decoration: const InputDecoration(labelText: 'Address')),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes')),
      ],
    );
  }
}

class SupplierDetailScreen extends ConsumerWidget {
  const SupplierDetailScreen({super.key, required this.supplierId});
  final String supplierId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(supplierProvider(supplierId))) {
        AsyncData(value: final Supplier s) => ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
            children: [
              ScreenHeader(s.name, subtitle: s.supplierNumber, onBack: () => context.go(AppRoutes.inventory)),
              SectionCard(title: 'Details', children: [
                InfoRow('Contact', s.contactPerson),
                InfoRow('Phone', s.phone == null ? null : PhoneNumbers.formatForDisplay(s.phone!)),
                InfoRow('Email', s.email),
                InfoRow('Address', s.address),
                InfoRow('Notes', s.notes),
                InfoRow('Status', s.active ? 'Active' : 'Inactive'),
                MoneyLine('Received purchases (${s.purchaseCount})', s.totalPurchased),
              ]),
              if (canDo(ref, Permission.inventorySuppliersManage))
                Wrap(spacing: AppSpacing.xs, children: [
                  OutlinedButton(onPressed: () => showFormSheet<void>(context, SupplierSheet(existing: s)), child: const Text('Edit')),
                  OutlinedButton(
                    onPressed: () async {
                      String? reason;
                      if (s.active) {
                        reason = await showReasonDialog(context, title: 'Deactivate ${s.name}?', message: 'Purchase history is kept.', confirmLabel: 'Deactivate');
                        if (reason == null) return;
                      }
                      if (!context.mounted) return;
                      final r = await ref.read(inventoryActionsProvider).updateSupplier(
                          s.supplierId,
                          SupplierDraft(name: s.name, contactPerson: s.contactPerson, phone: s.phone, email: s.email, address: s.address, notes: s.notes),
                          active: !s.active,
                          reason: reason);
                      if (context.mounted) reportResult(context, r, 'Supplier updated.');
                    },
                    child: Text(s.active ? 'Deactivate' : 'Activate'),
                  ),
                ]),
              const SizedBox(height: AppSpacing.md),
              Text('Purchase history', style: Theme.of(context).textTheme.titleMedium),
              ...switch (ref.watch(purchasesProvider((status: null, supplierId: supplierId)))) {
                AsyncData(:final value) when value.isEmpty => [const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No purchases yet.'))],
                AsyncData(:final value) => [for (final p in value) PurchaseTile(purchase: p)],
                AsyncError(:final error) => [InlineError(ErrorMapper.map(error).message)],
                _ => [const LoadingView()],
              },
            ],
          ),
        AsyncData() => const EmptyView(icon: Icons.local_shipping_outlined, title: 'Supplier not found'),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

class PurchaseTile extends StatelessWidget {
  const PurchaseTile({super.key, required this.purchase});
  final InventoryPurchase purchase;

  @override
  Widget build(BuildContext context) {
    final p = purchase;
    return Card(
      key: Key('purchase-${p.purchaseId}'),
      child: ListTile(
        onTap: () => context.go(AppRoutes.purchaseDetail(p.purchaseId)),
        leading: const Icon(Icons.shopping_cart_outlined),
        title: Text('${p.purchaseNumber} · ${p.total.format()}'),
        subtitle: Text([
          p.supplierName,
          p.status.label,
          p.paid ? 'Paid' : 'Unpaid',
          if (p.purchaseDate != null) DateTimeFormatter.date(p.purchaseDate!),
        ].join(' · ')),
      ),
    );
  }
}

class _PurchasesTab extends ConsumerStatefulWidget {
  const _PurchasesTab();

  @override
  ConsumerState<_PurchasesTab> createState() => _PurchasesTabState();
}

class _PurchasesTabState extends ConsumerState<_PurchasesTab> {
  PurchaseStatus? _status;

  @override
  Widget build(BuildContext context) => Column(children: [
        FilterChips<PurchaseStatus?>(
          values: const [null, ...PurchaseStatus.values],
          selected: _status,
          label: (s) => s?.label ?? 'All',
          keyPrefix: 'purchase-status',
          onSelected: (s) => setState(() => _status = s),
        ),
        Expanded(
          child: switch (ref.watch(purchasesProvider((status: _status, supplierId: null)))) {
            AsyncData(:final value) => ListView(
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                children: [
                  const Text('Stock purchases are inventory acquisitions, recorded separately from operating expenses.'),
                  if (canDo(ref, Permission.inventoryPurchaseCreate))
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(onPressed: () => context.go(AppRoutes.newPurchase), icon: const Icon(Icons.add), label: const Text('New purchase')),
                    ),
                  if (value.isEmpty) const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Center(child: Text('No purchases.'))),
                  MoneyLine('Total shown (${value.length})', Money.sum(value.where((p) => p.status != PurchaseStatus.cancelled).map((p) => p.total))),
                  for (final p in value) PurchaseTile(purchase: p),
                ],
              ),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]);
}

class PurchaseFormScreen extends ConsumerStatefulWidget {
  const PurchaseFormScreen({super.key});

  @override
  ConsumerState<PurchaseFormScreen> createState() => _PurchaseFormScreenState();
}

class _Line {
  String? itemId;
  final qty = TextEditingController();
  final cost = TextEditingController();
}

class _PurchaseFormScreenState extends ConsumerState<PurchaseFormScreen> {
  String? _supplier;
  final List<_Line> _lines = [_Line()];
  final _reference = TextEditingController();
  final _notes = TextEditingController();
  DateTime _date = DateTime.now();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final l in _lines) {
      l.qty.dispose();
      l.cost.dispose();
    }
    _reference.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final suppliers = (ref.watch(suppliersProvider).value ?? const <Supplier>[]).where((s) => s.active).toList();
    final items = (ref.watch(inventoryItemsProvider).value ?? const <InventoryItem>[]).where((i) => i.active).toList();
    final parsed = <PurchaseLine>[];
    var valid = _lines.isNotEmpty;
    for (final l in _lines) {
      final q = int.tryParse(l.qty.text.trim());
      final c = MoneyField.parse(l.cost.text, allowZero: true);
      InventoryItem? item;
      for (final i in items) {
        if (i.itemId == l.itemId) item = i;
      }
      if (item == null || q == null || q <= 0 || c == null) {
        valid = false;
        continue;
      }
      parsed.add(PurchaseLine(itemId: item.itemId, name: item.name, unit: item.unit, quantity: q, unitCost: c));
    }
    final duplicate = _lines.map((l) => l.itemId).whereType<String>().toSet().length != _lines.where((l) => l.itemId != null).length;
    final total = Money.sum(parsed.map((l) => l.total));
    final ready = valid && !duplicate && _supplier != null && !_saving;
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
      children: [
        ScreenHeader('New stock purchase', subtitle: 'Stock is added when the delivery is received.', onBack: () => context.go(AppRoutes.inventory)),
        DropdownButtonFormField<String>(
          key: const Key('purchase-supplier'),
          initialValue: _supplier,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Supplier'),
          items: [for (final s in suppliers) DropdownMenuItem(value: s.supplierId, child: Text(s.name))],
          onChanged: (v) => setState(() => _supplier = v),
        ),
        const SizedBox(height: AppSpacing.sm),
        DateField(label: 'Purchase date', value: _date, onChanged: (d) => setState(() => _date = d)),
        TextField(controller: _reference, maxLength: 60, decoration: const InputDecoration(labelText: 'Supplier invoice / reference')),
        for (final (index, l) in _lines.indexed)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.sm),
              child: Column(children: [
                Row(children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      key: Key('purchase-item-$index'),
                      initialValue: l.itemId,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Item'),
                      items: [for (final i in items) DropdownMenuItem(value: i.itemId, child: Text('${i.name} (${i.sku})', overflow: TextOverflow.ellipsis))],
                      onChanged: (v) => setState(() {
                        l.itemId = v;
                        for (final i in items) {
                          if (i.itemId == v && l.cost.text.isEmpty && i.lastUnitCost != null) l.cost.text = i.lastUnitCost!.formatAmount();
                        }
                      }),
                    ),
                  ),
                  if (_lines.length > 1)
                    IconButton(tooltip: 'Remove line', icon: const Icon(Icons.close), onPressed: () => setState(() => _lines.removeAt(index))),
                ]),
                Row(children: [
                  Expanded(
                    child: TextField(
                      key: Key('purchase-qty-$index'),
                      controller: l.qty,
                      keyboardType: TextInputType.number,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      decoration: const InputDecoration(labelText: 'Quantity'),
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(child: MoneyField(controller: l.cost, allowZero: true, label: 'Unit cost', fieldKey: Key('purchase-cost-$index'), onChanged: (_) => setState(() {}))),
                ]),
              ]),
            ),
          ),
        TextButton.icon(onPressed: () => setState(() => _lines.add(_Line())), icon: const Icon(Icons.add), label: const Text('Add line')),
        if (duplicate) const InlineError('Each item may appear only once.'),
        MoneyLine('Total', total, emphasis: true, valueKey: const Key('purchase-total')),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes')),
        if (_error != null) InlineError(_error!),
        FilledButton(
          key: const Key('submit-purchase'),
          onPressed: !ready
              ? null
              : () async {
                  setState(() {
                    _saving = true;
                    _error = null;
                  });
                  final r = await ref.read(inventoryActionsProvider).createPurchase(
                        supplierId: _supplier!,
                        lines: parsed,
                        requestId: _requestId,
                        purchaseDate: _date,
                        supplierReference: _reference.text.trim().isEmpty ? null : _reference.text.trim(),
                        notes: _notes.text.trim().isEmpty ? null : _notes.text.trim(),
                      );
                  if (!context.mounted) return;
                  setState(() => _saving = false);
                  switch (r) {
                    case Success(:final value):
                      AppSnackbar.success(context, 'Purchase recorded.');
                      context.go(AppRoutes.purchaseDetail(value));
                    case Failure(:final error):
                      setState(() => _error = error.message);
                  }
                },
          child: Text('Record purchase · ${total.format()}'),
        ),
      ],
    );
  }
}

class PurchaseDetailScreen extends ConsumerWidget {
  const PurchaseDetailScreen({super.key, required this.purchaseId});
  final String purchaseId;

  Future<void> _receive(BuildContext context, WidgetRef ref, InventoryPurchase p) async {
    final canPay = canDo(ref, Permission.expensesPay) && !p.paid && p.total.isPositive;
    String? payFrom;
    if (canPay) {
      final choice = await showDialog<String>(
        context: context,
        builder: (d) => AlertDialog(
          title: Text('Receive ${p.purchaseNumber}?'),
          content: Text('Adds the delivered quantities to stock. Pay ${p.total.format()} now as well?'),
          actions: [
            TextButton(onPressed: () => Navigator.of(d).pop(), child: const Text('Cancel')),
            TextButton(key: const Key('receive-only'), onPressed: () => Navigator.of(d).pop('later'), child: const Text('Receive, pay later')),
            FilledButton(key: const Key('receive-and-pay'), onPressed: () => Navigator.of(d).pop('pay'), child: const Text('Receive and pay')),
          ],
        ),
      );
      if (choice == null || !context.mounted) return;
      if (choice == 'pay') {
        payFrom = await pickPaymentAccount(context, amount: p.total, title: 'Pay ${p.supplierName}');
        if (payFrom == null) return;
      }
    } else {
      final ok = await showConfirmDialog(context, title: 'Receive ${p.purchaseNumber}?', message: 'Adds the delivered quantities to stock.', confirmLabel: 'Receive');
      if (!ok) return;
    }
    if (!context.mounted) return;
    final r = await ref.read(inventoryActionsProvider).receivePurchase(p.purchaseId, requestId: newRequestId(), payFromAccountId: payFrom);
    if (context.mounted) reportResult(context, r, payFrom == null ? 'Stock received.' : 'Stock received and paid.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(purchaseProvider(purchaseId))) {
        AsyncData(value: final InventoryPurchase p) => ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
            children: [
              ScreenHeader(p.purchaseNumber, subtitle: p.supplierName, onBack: () => context.go(AppRoutes.inventory)),
              Wrap(spacing: AppSpacing.xs, children: [
                StatusChip(p.status.label, color: p.status == PurchaseStatus.cancelled ? Colors.grey : AppColors.info),
                StatusChip(p.paid ? 'Paid' : 'Unpaid', color: p.paid ? AppColors.success : AppColors.warning),
              ]),
              const SizedBox(height: AppSpacing.xs),
              SectionCard(title: 'Lines', children: [
                for (final l in p.lines) MoneyLine('${l.name} · ${l.quantity} × ${l.unitCost.format()}', l.total),
                const Divider(),
                MoneyLine('Total', p.total, emphasis: true),
                InfoRow('Supplier ref.', p.supplierReference),
                if (p.purchaseDate != null) InfoRow('Date', DateTimeFormatter.date(p.purchaseDate!)),
                InfoRow('Raised by', p.createdByName),
                InfoRow('Notes', p.notes),
              ]),
              const SizedBox(height: AppSpacing.sm),
              Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
                if (p.canApprove && canDo(ref, Permission.inventoryPurchaseApprove))
                  FilledButton(
                    key: const Key('approve-purchase'),
                    onPressed: () async {
                      final r = await ref.read(inventoryActionsProvider).approvePurchase(p.purchaseId);
                      if (context.mounted) reportResult(context, r, 'Purchase approved.');
                    },
                    child: const Text('Approve'),
                  ),
                if (p.canReceive && canDo(ref, Permission.inventoryStockIn))
                  FilledButton.icon(
                    key: const Key('receive-purchase'),
                    icon: const Icon(Icons.move_to_inbox_outlined),
                    label: const Text('Receive stock'),
                    onPressed: () => _receive(context, ref, p),
                  ),
                if (p.canPay && canDo(ref, Permission.expensesPay))
                  OutlinedButton.icon(
                    key: const Key('pay-purchase'),
                    icon: const Icon(Icons.payments_outlined),
                    label: Text('Pay ${p.total.format()}'),
                    onPressed: () async {
                      final accountId = await pickPaymentAccount(context, amount: p.total, title: 'Pay ${p.supplierName}');
                      if (accountId == null || !context.mounted) return;
                      final r = await ref.read(inventoryActionsProvider).payPurchase(p.purchaseId, accountId: accountId, requestId: newRequestId());
                      if (context.mounted) reportResult(context, r, 'Purchase paid.');
                    },
                  ),
                if (p.canCancel && canDo(ref, Permission.inventoryPurchaseApprove))
                  OutlinedButton(
                    onPressed: () async {
                      final reason = await showReasonDialog(context, title: 'Cancel ${p.purchaseNumber}?', message: 'The record is kept.', confirmLabel: 'Cancel purchase', destructive: true);
                      if (reason == null || !context.mounted) return;
                      final r = await ref.read(inventoryActionsProvider).cancelPurchase(p.purchaseId, reason);
                      if (context.mounted) reportResult(context, r, 'Purchase cancelled.');
                    },
                    child: const Text('Cancel'),
                  ),
              ]),
            ],
          ),
        AsyncData() => const EmptyView(icon: Icons.shopping_cart_outlined, title: 'Purchase not found'),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
        _ => const LoadingView(),
      };
}
