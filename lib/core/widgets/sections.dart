import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

// Building blocks for detail screens, shared by every module.

/// Small rounded label used for role, status and permission kinds.
class StatusChip extends StatelessWidget {
  const StatusChip(this.label, {super.key, required this.color, this.icon});

  final String label;
  final Color color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: color.withValues(alpha: 0.35)),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[Icon(icon, size: 13, color: color), const SizedBox(width: 3)],
          Flexible(
            child: Text(label,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
          ),
        ]),
      );
}

/// A titled card grouping related rows on the details screen.
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.title, required this.children, this.icon, this.trailing});

  final String title;
  final IconData? icon;
  final Widget? trailing;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.sm),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            if (icon != null) ...[Icon(icon, size: 20, color: theme.colorScheme.primary), const SizedBox(width: AppSpacing.xs)],
            Expanded(child: Text(title, style: theme.textTheme.titleMedium)),
            ?trailing,
          ]),
          const SizedBox(height: AppSpacing.xs),
          ...children,
        ]),
      ),
    );
  }
}

/// Label / value row inside a [SectionCard].
class InfoRow extends StatelessWidget {
  const InfoRow(this.label, this.value, {super.key, this.valueWidget});

  final String label;
  final String? value;
  final Widget? valueWidget;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
          width: 120,
          child: Text(label, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ),
        Expanded(
          child: valueWidget ??
              Text(value == null || value!.isEmpty ? '—' : value!, style: theme.textTheme.bodyMedium),
        ),
      ]),
    );
  }
}

