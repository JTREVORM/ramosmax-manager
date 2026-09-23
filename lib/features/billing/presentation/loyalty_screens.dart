import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/loyalty.dart';
import '../../../routes/app_routes.dart';
import '../../operations/application/operations_providers.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/billing_providers.dart';

/// Progress towards the next reward, with the reward when available.
class LoyaltySummaryCard extends ConsumerWidget {
  const LoyaltySummaryCard({super.key, required this.vehicleId, this.onOpen});
  final String vehicleId;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final config = ref.watch(loyaltyConfigProvider).value ?? LoyaltyConfig.defaults;
    final account = ref.watch(loyaltyAccountProvider(vehicleId)).value ?? LoyaltyAccount.none(vehicleId);
    final reward = ref.watch(availableRewardProvider(vehicleId)).value;
    final progress = (account.pointsBalance / config.rewardThreshold).clamp(0.0, 1.0);
    return SectionCard(
      key: const Key('loyalty-card'),
      title: 'Loyalty',
      icon: Icons.loyalty_outlined,
      trailing: onOpen == null ? null : TextButton(onPressed: onOpen, child: const Text('Details')),
      children: [
        Row(children: [
          Text('${account.pointsBalance}', key: const Key('loyalty-points'), style: theme.textTheme.headlineMedium),
          const SizedBox(width: AppSpacing.xs),
          Text('points', style: theme.textTheme.bodyMedium),
        ]),
        const SizedBox(height: AppSpacing.xxs),
        LinearProgressIndicator(value: progress, minHeight: 8, borderRadius: BorderRadius.circular(4)),
        const SizedBox(height: AppSpacing.xxs),
        Text(
          reward != null
              ? '${reward.discountPercent}% reward available — apply it on the next invoice.'
              : '${config.pointsToNextReward(account.pointsBalance)} more points to a ${config.rewardDiscountPercent}% reward '
                  '(${config.pointsPerQualifyingService} per qualifying service).',
          key: const Key('loyalty-progress-text'),
          style: theme.textTheme.bodySmall?.copyWith(color: reward != null ? AppColors.success : null),
        ),
        if (account.rewardsRedeemed > 0) Text('Rewards used: ${account.rewardsRedeemed}', style: theme.textTheme.bodySmall),
      ],
    );
  }
}

/// Loyalty module: vehicles with the most points, and a way in by plate.
class LoyaltyScreen extends ConsumerWidget {
  const LoyaltyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final config = ref.watch(loyaltyConfigProvider).value ?? LoyaltyConfig.defaults;
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, 96),
      children: [
        Text('Loyalty', style: theme.textTheme.titleLarge),
        const SizedBox(height: AppSpacing.xs),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.sm),
            child: Text(
              'Loyalty belongs to the vehicle. Each completed qualifying service on a fully paid invoice earns '
              '${config.pointsPerQualifyingService} points; at ${config.rewardThreshold} points a '
              '${config.rewardDiscountPercent}% reward unlocks (it uses ${config.pointsConsumedOnRedemption} points).',
              key: const Key('loyalty-rules'),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        OutlinedButton.icon(
          onPressed: () => context.go(AppRoutes.vehicles),
          icon: const Icon(Icons.search),
          label: const Text('Find a vehicle by plate'),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text('Most points', style: theme.textTheme.titleMedium),
        switch (ref.watch(topLoyaltyAccountsProvider)) {
          AsyncData(:final value) when value.isEmpty => const Padding(
              padding: EdgeInsets.all(AppSpacing.lg),
              child: Center(child: Text('No vehicle has earned points yet.')),
            ),
          AsyncData(:final value) => Column(children: [
              for (final a in value)
                Card(
                  key: Key('loyalty-account-${a.vehicleId}'),
                  child: ListTile(
                    onTap: () => context.go(AppRoutes.vehicleLoyalty(a.vehicleId)),
                    leading: FittedBox(child: PlateBadge(a.numberPlate ?? '—')),
                    title: Text('${a.pointsBalance} points'),
                    subtitle: Text(a.pointsBalance >= config.rewardThreshold
                        ? 'Reward due'
                        : '${config.pointsToNextReward(a.pointsBalance)} to next reward'),
                    trailing: const Icon(Icons.chevron_right),
                  ),
                ),
            ]),
          AsyncError(:final error) => Text(ErrorMapper.map(error).message),
          _ => const LinearProgressIndicator(),
        },
      ],
    );
  }
}

/// One vehicle's account: balance, reward, full ledger, corrections.
class VehicleLoyaltyScreen extends ConsumerWidget {
  const VehicleLoyaltyScreen({super.key, required this.vehicleId});
  final String vehicleId;

  Future<void> _adjust(BuildContext context, WidgetRef ref, LoyaltyAccount account) async {
    final result = await showDialog<(int, String)>(context: context, builder: (_) => _AdjustDialog(balance: account.pointsBalance));
    if (result == null || !context.mounted) return;
    final r = await ref.read(billingActionsProvider).adjustLoyalty(vehicleId, result.$1, result.$2);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, 'Points adjusted.'), failure: (f) => AppSnackbar.error(context, f.message));
  }

  Future<void> _reverse(BuildContext context, WidgetRef ref, LoyaltyTransaction t) async {
    final reason = await showReasonDialog(context,
        title: 'Reverse ${t.signedPoints} points?',
        message: 'A reversal entry is added to the ledger; the original stays. This can be done once.',
        confirmLabel: 'Reverse',
        destructive: true);
    if (reason == null || !context.mounted) return;
    final r = await ref.read(billingActionsProvider).reverseLoyalty(t.transactionId, reason);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, 'Entry reversed.'), failure: (f) => AppSnackbar.error(context, f.message));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final vehicle = ref.watch(vehicleProvider(vehicleId)).value;
    final account = ref.watch(loyaltyAccountProvider(vehicleId)).value ?? LoyaltyAccount.none(vehicleId);
    final canAdjust = canDo(ref, Permission.loyaltyAdjust);
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
      children: [
        Row(children: [
          IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.loyalty)),
          Flexible(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: PlateBadge(vehicle?.numberPlate ?? account.numberPlate ?? '—', large: true),
            ),
          ),
        ]),
        const SizedBox(height: AppSpacing.sm),
        LoyaltySummaryCard(vehicleId: vehicleId),
        if (canAdjust) ...[
          const SizedBox(height: AppSpacing.xs),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              key: const Key('adjust-points-button'),
              onPressed: () => _adjust(context, ref, account),
              icon: const Icon(Icons.tune),
              label: const Text('Adjust points'),
            ),
          ),
        ],
        const SizedBox(height: AppSpacing.sm),
        SectionCard(title: 'History', icon: Icons.history, children: [
          switch (ref.watch(loyaltyLedgerProvider(vehicleId))) {
            AsyncData(:final value) when value.isEmpty => const Text('No points yet.'),
            AsyncData(:final value) => Column(children: [
                for (final t in value)
                  ListTile(
                    key: Key('ledger-${t.transactionId}'),
                    contentPadding: EdgeInsets.zero,
                    title: Text('${t.type.label} ${t.signedPoints}'),
                    subtitle: Text([
                      '${t.balanceBefore} → ${t.balanceAfter}',
                      ?t.reason,
                      if (t.createdAt != null) DateTimeFormatter.dateTime(t.createdAt!),
                      ?t.createdByName,
                    ].join(' · ')),
                    trailing: canAdjust && t.type.isReversible
                        ? IconButton(
                            key: Key('reverse-ledger-${t.transactionId}'),
                            tooltip: 'Reverse',
                            icon: const Icon(Icons.undo),
                            onPressed: () => _reverse(context, ref, t),
                          )
                        : null,
                  ),
              ]),
            AsyncError(:final error) => Text(ErrorMapper.map(error).message, style: theme.textTheme.bodySmall),
            _ => const LinearProgressIndicator(),
          },
        ]),
      ],
    );
  }
}

class _AdjustDialog extends StatefulWidget {
  const _AdjustDialog({required this.balance});
  final int balance;

  @override
  State<_AdjustDialog> createState() => _AdjustDialogState();
}

class _AdjustDialogState extends State<_AdjustDialog> {
  final _points = TextEditingController();
  final _reason = TextEditingController();
  bool _remove = false;
  String? _error;

  @override
  void dispose() {
    _points.dispose();
    _reason.dispose();
    super.dispose();
  }

  void _submit() {
    final n = int.tryParse(_points.text.trim());
    if (n == null || n <= 0 || n > 10000) return setState(() => _error = 'Enter a whole number of points (1–10,000).');
    if (_remove && n > widget.balance) return setState(() => _error = 'The vehicle has only ${widget.balance} points.');
    if (_reason.text.trim().length < 3) return setState(() => _error = 'Enter a reason (at least 3 characters).');
    Navigator.of(context).pop((_remove ? -n : n, _reason.text.trim()));
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Adjust points'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            SegmentedButton<bool>(
              segments: const [ButtonSegment(value: false, label: Text('Add')), ButtonSegment(value: true, label: Text('Remove'))],
              selected: {_remove},
              onSelectionChanged: (s) => setState(() => _remove = s.first),
            ),
            TextField(
              key: const Key('adjust-points-field'),
              controller: _points,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Points'),
            ),
            TextField(
              key: const Key('reason-field'),
              controller: _reason,
              maxLength: 500,
              decoration: const InputDecoration(labelText: 'Reason'),
            ),
            if (_error != null) InlineError(_error!),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(key: const Key('confirm-button'), onPressed: _submit, child: const Text('Save')),
        ],
      );
}
