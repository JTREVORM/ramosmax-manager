import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/shareholding.dart';
import '../application/shareholders_providers.dart';

// Building blocks shared by the shareholder, share and dividend screens.

class ShareholderStatusChip extends StatelessWidget {
  const ShareholderStatusChip(this.status, {super.key});
  final ShareholderStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        ShareholderStatus.active => const StatusChip('Active', color: AppColors.success, icon: Icons.check_circle_outline),
        ShareholderStatus.inactive => const StatusChip('Inactive', color: Colors.grey, icon: Icons.pause_circle_outline),
        ShareholderStatus.suspended => const StatusChip('Suspended', color: AppColors.warning, icon: Icons.block),
        ShareholderStatus.exited => const StatusChip('Exited', color: AppColors.danger, icon: Icons.logout),
      };
}

class ShareTransactionStatusChip extends StatelessWidget {
  const ShareTransactionStatusChip(this.status, {super.key});
  final ShareTransactionStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        ShareTransactionStatus.pendingApproval => const StatusChip('Pending approval', color: AppColors.warning, icon: Icons.hourglass_top),
        ShareTransactionStatus.posted => const StatusChip('Posted', color: AppColors.success, icon: Icons.check_circle_outline),
        ShareTransactionStatus.rejected => const StatusChip('Rejected', color: AppColors.danger, icon: Icons.block),
        ShareTransactionStatus.reversed => const StatusChip('Reversed', color: Colors.grey, icon: Icons.undo),
      };
}

class DividendStatusChip extends StatelessWidget {
  const DividendStatusChip(this.status, {super.key});
  final DividendStatus status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      DividendStatus.draft => Colors.grey,
      DividendStatus.declared => AppColors.warning,
      DividendStatus.approved || DividendStatus.partiallyPaid => AppColors.info,
      DividendStatus.paid => AppColors.success,
      DividendStatus.cancelled => AppColors.danger,
    };
    return StatusChip(status.label, color: color);
  }
}

class ShareholderTile extends StatelessWidget {
  const ShareholderTile({super.key, required this.shareholder, this.onTap});
  final Shareholder shareholder;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = shareholder;
    return Card(
      key: Key('shareholder-${s.shareholderId}'),
      child: ListTile(
        onTap: onTap,
        leading: CircleAvatar(child: Text(s.fullName.isEmpty ? '?' : s.fullName[0].toUpperCase())),
        title: Text(s.fullName, overflow: TextOverflow.ellipsis),
        subtitle: Wrap(spacing: AppSpacing.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('${s.shareholderNumber} · ${formatShares(s.totalShares)} shares · ${formatPercent(s.ownershipPercent)}'),
          ShareholderStatusChip(s.status),
        ]),
      ),
    );
  }
}

class ShareTransactionTile extends StatelessWidget {
  const ShareTransactionTile({super.key, required this.transaction, this.onTap, this.forShareholder});
  final ShareTransaction transaction;
  final VoidCallback? onTap;

  /// When given, shows the change to that shareholder only.
  final String? forShareholder;

  @override
  Widget build(BuildContext context) {
    final t = transaction;
    final theme = Theme.of(context);
    final delta = forShareholder == null ? null : t.deltaFor(forShareholder!);
    return Card(
      key: Key('share-txn-${t.transactionId}'),
      child: ListTile(
        onTap: onTap,
        title: Row(children: [
          Expanded(child: Text(t.label, overflow: TextOverflow.ellipsis)),
          Text(
            delta == null ? '${formatShares(t.shares)} ${t.classCode}' : '${delta >= 0 ? '+' : '−'}${formatShares(delta.abs())}',
            style: theme.textTheme.titleSmall?.copyWith(color: delta == null ? null : delta >= 0 ? AppColors.success : AppColors.danger),
          ),
        ]),
        subtitle: Wrap(spacing: AppSpacing.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text([
            t.transactionNumber,
            if (forShareholder == null && t.lines.isNotEmpty) t.parties,
            if (t.effectiveDate != null) 'effective ${DateTimeFormatter.date(t.effectiveDate!)}',
          ].join(' · ')),
          ShareTransactionStatusChip(t.status),
        ]),
      ),
    );
  }
}

/// Horizontal bars of the ownership distribution (server percentages).
class OwnershipDistribution extends StatelessWidget {
  const OwnershipDistribution({super.key, required this.holders, this.onTap, this.limit});
  final List<RegisterHolder> holders;
  final ValueChanged<RegisterHolder>? onTap;
  final int? limit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final shown = limit == null ? holders : holders.take(limit!).toList();
    if (shown.isEmpty) return const Text('No shares have been issued yet.');
    return Column(children: [
      for (final h in shown)
        InkWell(
          key: Key('holder-${h.shareholderId}'),
          onTap: onTap == null ? null : () => onTap!(h),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('${h.shareholderName} · ${h.shareholderNumber}', overflow: TextOverflow.ellipsis)),
                Text('${formatShares(h.shares)} · ${formatPercent(h.ownershipPercent)}', key: Key('holder-pct-${h.shareholderId}'),
                    style: theme.textTheme.titleSmall),
              ]),
              const SizedBox(height: 2),
              LinearProgressIndicator(value: (h.ownershipPercent / 100).clamp(0, 1), minHeight: 6, borderRadius: BorderRadius.circular(3)),
            ]),
          ),
        ),
      if (limit != null && holders.length > limit!) Text('and ${holders.length - limit!} more', style: theme.textTheme.bodySmall),
    ]);
  }
}

/// Dropdown of active shareholders (needs shareholders.view).
class ShareholderDropdown extends ConsumerWidget {
  const ShareholderDropdown({super.key, required this.value, required this.onChanged, this.label = 'Shareholder', this.fieldKey, this.exclude});
  final String? value;
  final ValueChanged<String?> onChanged;
  final String label;
  final Key? fieldKey;
  final String? exclude;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = (ref.watch(activeShareholdersProvider).value ?? const <Shareholder>[]).where((s) => s.shareholderId != exclude).toList();
    return DropdownButtonFormField<String>(
      key: fieldKey,
      initialValue: list.any((s) => s.shareholderId == value) ? value : null,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final s in list)
          DropdownMenuItem(value: s.shareholderId, child: Text('${s.fullName} · ${s.shareholderNumber}', overflow: TextOverflow.ellipsis)),
      ],
      onChanged: onChanged,
    );
  }
}

/// Dropdown of share classes (active ones unless [includeInactive]).
class ShareClassDropdown extends ConsumerWidget {
  const ShareClassDropdown({super.key, required this.value, required this.onChanged, this.fieldKey, this.includeInactive = false, this.allowAll = false});
  final String? value;
  final ValueChanged<String?> onChanged;
  final Key? fieldKey;
  final bool includeInactive;

  /// Adds an "All classes" choice (null).
  final bool allowAll;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = (ref.watch(shareClassesProvider).value ?? const <ShareClass>[]).where((c) => includeInactive || c.active).toList();
    return DropdownButtonFormField<String?>(
      key: fieldKey,
      initialValue: list.any((c) => c.classId == value) ? value : null,
      isExpanded: true,
      decoration: const InputDecoration(labelText: 'Share class'),
      items: [
        if (allowAll) const DropdownMenuItem<String?>(value: null, child: Text('All classes')),
        for (final c in list)
          DropdownMenuItem<String?>(value: c.classId, child: Text('${c.code} · ${c.name} · ${c.valuePerShare.format()} a share', overflow: TextOverflow.ellipsis)),
      ],
      onChanged: onChanged,
    );
  }
}

/// Whole-number share input (optionally signed, for adjustments).
class SharesField extends StatelessWidget {
  const SharesField({super.key, required this.controller, required this.label, this.onChanged, this.errorText, this.fieldKey, this.signed = false});
  final TextEditingController controller;
  final String label;
  final ValueChanged<String>? onChanged;
  final String? errorText;
  final Key? fieldKey;
  final bool signed;

  /// Positive whole number (or non-zero signed), else null.
  static int? parse(String text, {bool signed = false}) {
    final cleaned = text.replaceAll(RegExp(r'[\s,]'), '').replaceAll('−', '-');
    final n = int.tryParse(cleaned);
    if (n == null || n == 0 || (!signed && n < 0)) return null;
    return n;
  }

  @override
  Widget build(BuildContext context) => TextField(
        key: fieldKey,
        controller: controller,
        keyboardType: TextInputType.numberWithOptions(signed: signed),
        decoration: InputDecoration(labelText: label, errorText: errorText, suffixText: 'shares'),
        onChanged: onChanged,
      );
}
