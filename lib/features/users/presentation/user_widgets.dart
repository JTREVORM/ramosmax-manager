import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/branding/brand.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/app_user.dart';
import '../application/user_management_providers.dart';

export '../../../core/widgets/sections.dart';

/// Profile photo, or initials on the brand purple when there is none (or it
/// cannot be loaded, e.g. offline).
class UserAvatar extends ConsumerWidget {
  const UserAvatar({super.key, required this.user, this.radius = 22});

  final AppUser user;
  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final path = user.profilePhotoPath;
    final url = path == null ? null : ref.watch(profilePhotoUrlProvider(path)).value;
    return CircleAvatar(
      radius: radius,
      backgroundColor: user.active ? Brand.purple : Colors.grey.shade500,
      foregroundImage: url == null ? null : NetworkImage(url),
      child: Text(
        user.initials,
        style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: radius * 0.7),
      ),
    );
  }
}

class ActiveStatusChip extends StatelessWidget {
  const ActiveStatusChip({super.key, required this.active});
  final bool active;

  @override
  Widget build(BuildContext context) => active
      ? const StatusChip('Active', color: AppColors.success, icon: Icons.check_circle_outline)
      : const StatusChip('Inactive', color: AppColors.danger, icon: Icons.block);
}

class RoleChip extends StatelessWidget {
  const RoleChip({super.key, required this.user});
  final AppUser user;

  @override
  Widget build(BuildContext context) =>
      StatusChip(user.role.label, color: Theme.of(context).colorScheme.primary);
}

/// Where the account stands with its password (never the password itself).
class SignInStatusChip extends StatelessWidget {
  const SignInStatusChip({super.key, required this.user});
  final AppUser user;

  @override
  Widget build(BuildContext context) {
    if (!user.passwordSet) {
      return const StatusChip('No password yet', color: AppColors.danger, icon: Icons.key_off_outlined);
    }
    if (user.mustChangePassword) {
      return const StatusChip('Password change required', color: AppColors.warning, icon: Icons.lock_reset);
    }
    return const StatusChip('Password set', color: AppColors.info, icon: Icons.lock_outline);
  }
}

/// A temporary password shown to the person who created or reset it — the
/// only time it can ever be seen. Never stored by the app.
class TemporaryPasswordPanel extends StatelessWidget {
  const TemporaryPasswordPanel({super.key, required this.password});
  final String password;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: theme.colorScheme.secondaryContainer.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(AppSpacing.radius),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Temporary password', style: theme.textTheme.labelLarge),
        const SizedBox(height: AppSpacing.xxs),
        Row(children: [
          Expanded(
            child: SelectableText(
              password,
              key: const Key('temporary-password-text'),
              style: theme.textTheme.titleLarge?.copyWith(fontFamily: 'monospace', letterSpacing: 1.5),
            ),
          ),
          IconButton.filledTonal(
            key: const Key('copy-password-button'),
            tooltip: 'Copy password',
            icon: const Icon(Icons.copy),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: password));
              if (context.mounted) AppSnackbar.info(context, 'Password copied.');
            },
          ),
        ]),
        const SizedBox(height: AppSpacing.xs),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Icon(Icons.warning_amber_rounded, size: 18, color: AppColors.warning),
          const SizedBox(width: AppSpacing.xxs),
          Expanded(
            child: Text(
              'This password will only be shown now. Store or securely share it with the employee. '
              'They will be asked to choose their own password when they sign in.',
              style: theme.textTheme.bodySmall,
            ),
          ),
        ]),
      ]),
    );
  }
}

/// Shows a just-issued temporary password once.
Future<void> showTemporaryPasswordDialog(BuildContext context, {required String title, required String password}) =>
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialog) => AlertDialog(
        title: Text(title),
        content: TemporaryPasswordPanel(password: password),
        actions: [
          FilledButton(
            key: const Key('temporary-password-done'),
            style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
            onPressed: () => Navigator.of(dialog).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    );

/// "3 extra · 1 denied · 1 temporary" — shown on user cards.
String permissionSummary(AppUser user, DateTime now) {
  final parts = <String>[
    if (user.permissions.isNotEmpty) '${user.permissions.length} extra',
    if (user.deniedPermissions.isNotEmpty) '${user.deniedPermissions.length} denied',
    if (user.activeTemporaryPermissions(now).isNotEmpty)
      '${user.activeTemporaryPermissions(now).length} temporary',
  ];
  return parts.isEmpty ? 'Standard ${user.role.label.toLowerCase()} access' : parts.join(' · ');
}
