import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/access_policy.dart';
import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/app_user.dart';
import '../../../models/audit_log_entry.dart';
import '../../../routes/app_routes.dart';
import '../application/user_management_providers.dart';
import 'user_dialogs.dart';
import 'user_widgets.dart';

/// Everything about one account, in sections, with the actions the viewer is
/// allowed to take.
class UserDetailScreen extends ConsumerWidget {
  const UserDetailScreen({super.key, required this.uid});
  final String uid;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final actor = ref.watch(currentUserProvider);
    if (actor == null) return const SizedBox.shrink();
    final now = ref.watch(clockProvider).value ?? DateTime.now();

    return switch (ref.watch(managedUserProvider(uid))) {
      AsyncData(value: null) => const EmptyView(
          icon: Icons.person_off_outlined,
          title: 'User not found',
          message: 'This account does not exist or you cannot view it.',
        ),
      AsyncData(value: final AppUser user) => _Details(actor: actor, user: user, now: now),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error),
          onRetry: () => ref.invalidate(managedUserProvider(uid))),
      _ => const LoadingView(),
    };
  }
}

class _Details extends ConsumerWidget {
  const _Details({required this.actor, required this.user, required this.now});

  final AppUser actor;
  final AppUser user;
  final DateTime now;

  bool _can(UserAdminAction a) => AccessPolicy.can(actor, a, user, now);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final names = ref.watch(userNamesProvider);
    final isSelf = actor.uid == user.uid;
    final effective = user.effectivePermissions(now);
    final activeTemp = user.temporaryPermissions.entries.where((e) => e.value.isLive(now)).toList()
      ..sort((a, b) => a.value.expiresAt.compareTo(b.value.expiresAt));
    final scheduledTemp = user.temporaryPermissions.entries.where((e) => e.value.isScheduled(now)).length;
    final canSeeHistory = actor.can(Permission.auditView, now);

    String nameOf(String? uid) {
      if (uid == null) return '—';
      if (uid.startsWith('admin-cli')) return 'Provisioning tool';
      return names[uid] ?? 'Another administrator';
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xl),
      children: [
        // --- Header -------------------------------------------------------
        Row(children: [
          IconButton(
            tooltip: 'Back to users',
            icon: const Icon(Icons.arrow_back),
            onPressed: () => context.go(AppRoutes.users),
          ),
          UserAvatar(user: user, radius: 30),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(user.displayName, key: const Key('user-detail-name'), style: theme.textTheme.titleLarge),
              const SizedBox(height: AppSpacing.xxs),
              Wrap(spacing: AppSpacing.xxs, runSpacing: AppSpacing.xxs, children: [
                RoleChip(user: user),
                ActiveStatusChip(active: user.active),
                if (isSelf) StatusChip('You', color: theme.colorScheme.tertiary),
              ]),
            ]),
          ),
        ]),
        if (isSelf) ...[
          const SizedBox(height: AppSpacing.sm),
          const _Notice(
            icon: Icons.shield_outlined,
            text: 'You cannot change your own role, permissions or account status. '
                'Ask another administrator.',
          ),
        ],
        const SizedBox(height: AppSpacing.md),

        // --- Account ------------------------------------------------------
        SectionCard(
          title: 'Account',
          icon: Icons.person_outline,
          trailing: _can(UserAdminAction.editProfile)
              ? TextButton.icon(
                  key: const Key('user-edit-button'),
                  onPressed: () => context.go(AppRoutes.editUser(user.uid)),
                  icon: const Icon(Icons.edit_outlined, size: 18),
                  label: const Text('Edit'),
                )
              : null,
          children: [
            InfoRow('Name', user.fullName),
            InfoRow('Phone', PhoneNumbers.formatForDisplay(user.phoneNumber)),
            InfoRow('Email', user.email),
            InfoRow('Sign-in', null, valueWidget: Align(
              alignment: Alignment.centerLeft,
              child: SignInStatusChip(user: user),
            )),
            InfoRow('Password change required', user.mustChangePassword ? 'Yes — at next sign-in' : 'No'),
            if (user.passwordChangedAt != null)
              InfoRow('Password changed', DateTimeFormatter.dateTime(user.passwordChangedAt!)),
            if (actor.can(Permission.usersEdit, now))
              InfoRow('User ID', null, valueWidget: SelectableText(user.uid, style: theme.textTheme.bodySmall)),
            InfoRow('Created', user.createdAt == null ? null : DateTimeFormatter.dateTime(user.createdAt!)),
            InfoRow('Last sign-in', user.lastLoginAt == null ? 'Never' : DateTimeFormatter.dateTime(user.lastLoginAt!)),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),

        // --- Employment ---------------------------------------------------
        SectionCard(
          title: 'Employment',
          icon: Icons.badge_outlined,
          trailing: _can(UserAdminAction.linkStaff) && !isSelf
              ? TextButton.icon(
                  key: const Key('user-link-staff-button'),
                  onPressed: () => _linkStaff(context, ref),
                  icon: const Icon(Icons.link, size: 18),
                  label: Text(user.staffId == null ? 'Link' : 'Change'),
                )
              : null,
          children: [
            InfoRow('Staff ID', user.staffId ?? 'Not linked to a staff record'),
            InfoRow('Position', user.position),
            InfoRow('Department', user.department),
            if (user.role == UserRole.worker) InfoRow('Specialisation', user.specialization?.label),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),

        // --- Access -------------------------------------------------------
        SectionCard(
          title: 'Access',
          icon: Icons.key_outlined,
          children: [
            InfoRow('Role', user.role.label),
            InfoRow('Effective', '${effective.length} permission${effective.length == 1 ? '' : 's'}'),
            InfoRow('Granted', user.permissions.isEmpty ? 'None' : _labels(user.permissions)),
            InfoRow('Denied', user.deniedPermissions.isEmpty ? 'None' : _labels(user.deniedPermissions)),
            InfoRow(
              'Temporary',
              activeTemp.isEmpty
                  ? (scheduledTemp > 0 ? '$scheduledTemp scheduled' : 'None active')
                  : [
                      for (final e in activeTemp)
                        '${e.key.label} until ${DateTimeFormatter.dateTime(e.value.expiresAt)}',
                    ].join('\n'),
            ),
            const SizedBox(height: AppSpacing.xs),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              OutlinedButton.icon(
                key: const Key('user-permissions-button'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 44)),
                onPressed: () => context.go(AppRoutes.userPermissions(user.uid)),
                icon: const Icon(Icons.tune, size: 18),
                label: const Text('Permissions'),
              ),
              if (_can(UserAdminAction.changeRole))
                OutlinedButton.icon(
                  key: const Key('user-change-role-button'),
                  style: OutlinedButton.styleFrom(minimumSize: const Size(0, 44)),
                  onPressed: () => _changeRole(context, ref),
                  icon: const Icon(Icons.swap_horiz, size: 18),
                  label: const Text('Change role'),
                ),
            ]),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),

        // --- Security -----------------------------------------------------
        SectionCard(
          title: 'Security',
          icon: Icons.security_outlined,
          children: [
            InfoRow('Status', user.active ? 'Active — can sign in' : 'Deactivated — cannot sign in'),
            if (user.statusChangedAt != null)
              InfoRow('Status changed', '${DateTimeFormatter.dateTime(user.statusChangedAt!)} by ${nameOf(user.statusChangedBy)}'),
            if (user.statusReason != null) InfoRow('Reason', user.statusReason),
            InfoRow(
              'Last access change',
              user.lastAccessChangeAt == null
                  ? '—'
                  : '${DateTimeFormatter.dateTime(user.lastAccessChangeAt!)} by ${nameOf(user.lastAccessChangeBy)}',
            ),
            if (user.accessExpiresAt != null) InfoRow('Access ends', DateTimeFormatter.dateTime(user.accessExpiresAt!)),
            if (user.passwordResetAt != null)
              InfoRow('Password reset', DateTimeFormatter.dateTime(user.passwordResetAt!)),
            const SizedBox(height: AppSpacing.xs),
            if (_can(UserAdminAction.resetPassword)) ...[
              OutlinedButton.icon(
                key: const Key('user-reset-password-button'),
                onPressed: () => _resetPassword(context, ref),
                icon: const Icon(Icons.lock_reset),
                label: Text(user.passwordSet ? 'Reset password' : 'Set password'),
              ),
              const SizedBox(height: AppSpacing.xs),
            ],
            if (_can(UserAdminAction.deactivate))
              OutlinedButton.icon(
                key: const Key('user-deactivate-button'),
                style: OutlinedButton.styleFrom(foregroundColor: theme.colorScheme.error),
                onPressed: () => _setActive(context, ref, false),
                icon: const Icon(Icons.block),
                label: const Text('Deactivate account'),
              ),
            if (_can(UserAdminAction.activate))
              FilledButton.icon(
                key: const Key('user-activate-button'),
                onPressed: () => _setActive(context, ref, true),
                icon: const Icon(Icons.check_circle_outline),
                label: const Text('Activate account'),
              ),
          ],
        ),
        if (canSeeHistory) ...[
          const SizedBox(height: AppSpacing.sm),
          _AccessHistory(uid: user.uid, nameOf: nameOf),
        ],
      ],
    );
  }

  static String _labels(Set<Permission> perms) => [for (final p in perms) p.label].join(', ');

  Future<void> _setActive(BuildContext context, WidgetRef ref, bool active) async {
    final name = user.displayName;
    final reason = await showReasonDialog(
      context,
      title: active ? 'Activate $name?' : 'Deactivate $name?',
      message: active
          ? '$name will be able to sign in to RamosMAX again with their current role and permissions.'
          : '$name will no longer be able to access the RamosMAX system. Their sessions end '
              'immediately. The account is kept and can be reactivated later.',
      confirmLabel: active ? 'Activate' : 'Deactivate',
      destructive: !active,
      reasonRequired: !active,
    );
    if (reason == null || !context.mounted) return;
    final result = await ref
        .read(userAdminActionsProvider)
        .setActive(user.uid, active: active, reason: reason.isEmpty ? null : reason);
    if (!context.mounted) return;
    _report(context, result, active ? '$name has been activated.' : '$name has been deactivated.');
  }

  Future<void> _resetPassword(BuildContext context, WidgetRef ref) async {
    final name = user.displayName;
    final reason = await showReasonDialog(
      context,
      title: user.passwordSet ? "Reset $name's password?" : 'Set a password for $name?',
      message: user.passwordSet
          ? "A new temporary password will be generated. $name's current password stops working and "
              'they are signed out everywhere. They must choose a new password when they sign in.'
          : 'This account comes from the retired SMS sign-in and has no password yet. A temporary '
              'password will be generated; $name must change it at first sign-in.',
      confirmLabel: 'Generate new password',
      reasonLabel: 'Reason (e.g. forgot password)',
    );
    if (reason == null || !context.mounted) return;
    final result = await ref.read(userAdminActionsProvider).resetPassword(user.uid, reason: reason);
    if (!context.mounted) return;
    await result.when(
      success: (password) => showTemporaryPasswordDialog(context, title: 'New password for $name', password: password),
      failure: (f) async => AppSnackbar.error(context, f.message),
    );
  }

  Future<void> _changeRole(BuildContext context, WidgetRef ref) async {
    final role = await showRolePicker(context, current: user.role, roles: AccessPolicy.assignableRoles(actor));
    if (role == null || !context.mounted) return;
    final reason = await showReasonDialog(
      context,
      title: 'Change role?',
      message: '${user.displayName}: ${user.role.label} → ${role.label}.\n\n'
          'Their access and menus change immediately to the ${role.label} permissions. '
          'Extra grants and denials are kept.',
      confirmLabel: 'Change role',
    );
    if (reason == null || !context.mounted) return;
    final result = await ref.read(userAdminActionsProvider).setRole(user.uid, role, reason: reason);
    if (!context.mounted) return;
    _report(context, result, '${user.displayName} is now ${role.label}.');
  }

  Future<void> _linkStaff(BuildContext context, WidgetRef ref) async {
    final controller = TextEditingController(text: user.staffId ?? '');
    var create = false;
    final staffId = await showDialog<String>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (dialog, setState) => AlertDialog(
          title: const Text('Link staff record'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              key: const Key('link-staff-field'),
              controller: controller,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Staff ID', hintText: 'RMX-STF-0001'),
            ),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: create,
              onChanged: (v) => setState(() => create = v ?? false),
              title: const Text('Create the staff record if it does not exist'),
            ),
          ]),
          actions: [
            if (user.staffId != null)
              TextButton(onPressed: () => Navigator.of(dialog).pop(''), child: const Text('Unlink')),
            TextButton(onPressed: () => Navigator.of(dialog).pop(), child: const Text('Cancel')),
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
              onPressed: () => Navigator.of(dialog).pop(controller.text.trim().toUpperCase()),
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
    if (staffId == null || !context.mounted) return;
    final result = await ref
        .read(userAdminActionsProvider)
        .linkStaff(user.uid, staffId.isEmpty ? null : staffId, createIfMissing: create);
    if (!context.mounted) return;
    _report(context, result, staffId.isEmpty ? 'Staff record unlinked.' : 'Linked to $staffId.');
  }
}

void _report(BuildContext context, Result<void> result, String success) {
  result.when(
    success: (_) => AppSnackbar.success(context, success),
    failure: (f) => AppSnackbar.error(context, f.message),
  );
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(AppSpacing.radius),
      ),
      child: Row(children: [
        Icon(icon, size: 20),
        const SizedBox(width: AppSpacing.xs),
        Expanded(child: Text(text)),
      ]),
    );
  }
}

class _AccessHistory extends ConsumerWidget {
  const _AccessHistory({required this.uid, required this.nameOf});
  final String uid;
  final String Function(String?) nameOf;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(accessHistoryProvider(uid));
    return SectionCard(
      title: 'Access history',
      icon: Icons.history,
      children: switch (history) {
        AsyncData(:final value) when value.isEmpty => [const Text('No recorded changes yet.')],
        AsyncData(:final value) => [for (final r in value) _HistoryTile(record: r, actor: nameOf(r.userId))],
        AsyncError() => [const Text('Access history could not be loaded.')],
        _ => [const LinearProgressIndicator()],
      },
    );
  }
}

class _HistoryTile extends StatelessWidget {
  const _HistoryTile({required this.record, required this.actor});
  final AuditRecord record;
  final String actor;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final when = record.timestamp == null ? 'Pending' : DateTimeFormatter.dateTime(record.timestamp!);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(describeAuditAction(record), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
        Text('$when · $actor', style: theme.textTheme.bodySmall),
        if (record.reason != null) Text('Reason: ${record.reason}', style: theme.textTheme.bodySmall),
      ]),
    );
  }
}

/// Plain-language description of an access-management audit entry.
String describeAuditAction(AuditRecord r) {
  String perm(Map<String, dynamic>? v) =>
      Permission.tryParse(v?['permission'] as String? ?? '')?.label ?? (v?['permission']?.toString() ?? '');
  return switch (r.action) {
    'user.created' => 'Account created',
    'user.updated' => 'Profile updated (${r.newValue?.keys.join(', ') ?? ''})',
    'user.phone_changed' => 'Phone number changed — re-verification required',
    'user.role_changed' => 'Role changed: ${r.previousValue?['role']} → ${r.newValue?['role']}',
    'user.activated' => 'Account activated',
    'user.deactivated' => 'Account deactivated',
    'permission.granted' => 'Granted: ${perm(r.newValue)}',
    'permission.grant_removed' => 'Grant removed: ${perm(r.previousValue)}',
    'permission.denied' => 'Denied: ${perm(r.newValue)}',
    'permission.denial_removed' => 'Denial removed: ${perm(r.previousValue)}',
    'permission.temporary_granted' => 'Temporary access: ${perm(r.newValue)}',
    'permission.temporary_revoked' => 'Temporary access revoked: ${perm(r.previousValue)}',
    'staff.linked' => 'Linked to staff record ${r.newValue?['staffId'] ?? ''}',
    'staff.unlinked' => 'Unlinked from staff record ${r.previousValue?['staffId'] ?? ''}',
    'session.sign_in' => 'Signed in',
    'session.sign_out' => 'Signed out',
    _ => r.description ?? r.action,
  };
}
