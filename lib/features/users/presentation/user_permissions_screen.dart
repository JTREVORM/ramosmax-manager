import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/access_policy.dart';
import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/app_user.dart';
import '../../../models/temporary_grant.dart';
import '../../../routes/app_routes.dart';
import '../application/user_management_providers.dart';
import 'user_dialogs.dart';
import 'user_widgets.dart';

/// How a permission reaches (or is withheld from) a user.
enum PermissionSource {
  role('Role permission', Icons.shield_outlined),
  grant('Explicit grant', Icons.add_circle_outline),
  denial('Explicit denial', Icons.remove_circle_outline),
  temporary('Temporary permission', Icons.schedule),
  expired('Expired permission', Icons.history_toggle_off);

  const PermissionSource(this.label, this.icon);
  final String label;
  final IconData icon;

  Color get color => switch (this) {
        PermissionSource.role => AppColors.info,
        PermissionSource.grant => AppColors.success,
        PermissionSource.denial => AppColors.danger,
        PermissionSource.temporary => AppColors.warning,
        PermissionSource.expired => Colors.grey,
      };
}

class UserPermissionsScreen extends ConsumerWidget {
  const UserPermissionsScreen({super.key, required this.uid});
  final String uid;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final actor = ref.watch(currentUserProvider);
    if (actor == null) return const SizedBox.shrink();
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    return switch (ref.watch(managedUserProvider(uid))) {
      AsyncData(value: final AppUser user) =>
        _PermissionsEditor(key: ValueKey('${user.uid}-${user.updatedAt}'), actor: actor, user: user, now: now),
      AsyncData() => const EmptyView(icon: Icons.person_off_outlined, title: 'User not found'),
      AsyncError() => const EmptyView(icon: Icons.error_outline, title: 'Could not load this user'),
      _ => const LoadingView(),
    };
  }
}

class _PermissionsEditor extends ConsumerStatefulWidget {
  const _PermissionsEditor({super.key, required this.actor, required this.user, required this.now});
  final AppUser actor;
  final AppUser user;
  final DateTime now;

  @override
  ConsumerState<_PermissionsEditor> createState() => _PermissionsEditorState();
}

class _PermissionsEditorState extends ConsumerState<_PermissionsEditor> {
  late final Set<Permission> _grants = {...widget.user.permissions};
  late final Set<Permission> _denials = {...widget.user.deniedPermissions};
  bool _saving = false;

  AppUser get _user => widget.user;
  bool get _canManage =>
      AccessPolicy.can(widget.actor, UserAdminAction.managePermissions, _user, widget.now);
  bool get _canTemporary =>
      AccessPolicy.can(widget.actor, UserAdminAction.grantTemporary, _user, widget.now);
  bool get _dirty =>
      !_setEquals(_grants, _user.permissions) || !_setEquals(_denials, _user.deniedPermissions);

  static bool _setEquals(Set<Permission> a, Set<Permission> b) => a.length == b.length && a.containsAll(b);

  /// Changes only the actor could hand out: adding a grant or lifting a denial.
  bool _canGive(Permission p) => AccessPolicy.canGrant(widget.actor, p, widget.now);

  Future<void> _add({required bool deny}) async {
    final rolePerms = RolePermissions.forRole(_user.role);
    final options = deny
        ? [
            for (final p in Permission.values)
              if (!_denials.contains(p) &&
                  AccessPolicy.canDeny(_user.role, p) &&
                  (rolePerms.contains(p) || _grants.contains(p)) &&
                  (widget.actor.role == UserRole.admin || !p.isAdminOnly))
                p,
          ]
        : [
            for (final p in AccessPolicy.grantablePermissions(widget.actor, widget.now))
              if (!rolePerms.contains(p) && !_grants.contains(p) && !_denials.contains(p)) p,
          ];
    final picked = await showPermissionPicker(
      context,
      title: deny ? 'Deny a permission' : 'Grant a permission',
      options: options,
    );
    if (picked == null) return;
    setState(() {
      if (deny) {
        _denials.add(picked);
        _grants.remove(picked);
      } else {
        _grants.add(picked);
      }
    });
  }

  Future<void> _save() async {
    final added = _grants.difference(_user.permissions).length + _denials.difference(_user.deniedPermissions).length;
    final removed = _user.permissions.difference(_grants).length + _user.deniedPermissions.difference(_denials).length;
    final reason = await showReasonDialog(
      context,
      title: 'Save permission changes?',
      message: '${_user.displayName}: $added added, $removed removed. '
          'The change takes effect on their device immediately.',
      confirmLabel: 'Save',
      reasonRequired: false,
    );
    if (reason == null || !mounted) return;
    setState(() => _saving = true);
    final result = await ref.read(userAdminActionsProvider).setPermissions(
          _user.uid,
          permissions: _grants,
          deniedPermissions: _denials,
          reason: reason.isEmpty ? null : reason,
        );
    if (!mounted) return;
    setState(() => _saving = false);
    result.when(
      success: (_) => AppSnackbar.success(context, 'Permissions updated.'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  Future<void> _grantTemporary() async {
    final permanent = _user.permanentPermissions();
    final options = [
      for (final p in AccessPolicy.grantablePermissions(widget.actor, widget.now))
        if (!permanent.contains(p) && !_user.deniedPermissions.contains(p)) p,
    ];
    final draft = await showTemporaryGrantSheet(context, options: options, now: widget.now);
    if (draft == null || !mounted) return;
    final result = await ref.read(userAdminActionsProvider).grantTemporary(
          _user.uid,
          permission: draft.permission,
          startsAt: draft.startsAt,
          expiresAt: draft.expiresAt,
          reason: draft.reason,
        );
    if (!mounted) return;
    result.when(
      success: (_) => AppSnackbar.success(context,
          '${draft.permission.label} granted until ${DateTimeFormatter.dateTime(draft.expiresAt)}.'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  Future<void> _revoke(TemporaryGrant grant) async {
    final reason = await showReasonDialog(
      context,
      title: 'Revoke temporary access?',
      message: '${_user.displayName} loses "${grant.permission.label}" immediately.',
      confirmLabel: 'Revoke',
      destructive: true,
    );
    if (reason == null || !mounted) return;
    final result = await ref.read(userAdminActionsProvider).revokeTemporary(_user.uid, grant.id, reason: reason);
    if (!mounted) return;
    result.when(
      success: (_) => AppSnackbar.success(context, 'Temporary access revoked.'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final now = widget.now;
    final rolePerms = RolePermissions.forRole(_user.role);
    final grouped = <PermissionGroup, List<Permission>>{};
    for (final p in Permission.values) {
      if (rolePerms.contains(p)) grouped.putIfAbsent(p.group, () => []).add(p);
    }
    final effective = _user.effectivePermissions(now);

    return Stack(children: [
      ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 120),
        children: [
          Row(children: [
            IconButton(
              tooltip: 'Back',
              icon: const Icon(Icons.arrow_back),
              onPressed: () => context.go(AppRoutes.userDetail(_user.uid)),
            ),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Permissions', style: theme.textTheme.titleLarge),
                Text('${_user.displayName} · ${_user.role.label} · ${effective.length} effective',
                    style: theme.textTheme.bodySmall),
              ]),
            ),
          ]),
          const SizedBox(height: AppSpacing.xs),
          Wrap(spacing: AppSpacing.xxs, runSpacing: AppSpacing.xxs, children: [
            for (final s in PermissionSource.values) StatusChip(s.label, color: s.color, icon: s.icon),
          ]),
          if (!_canManage && !_canTemporary) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              _user.uid == widget.actor.uid
                  ? 'You cannot change your own permissions.'
                  : 'You can view these permissions but not change them.',
              key: const Key('permissions-read-only'),
              style: theme.textTheme.bodyMedium,
            ),
          ],
          const SizedBox(height: AppSpacing.md),

          // --- Explicit grants ---------------------------------------------
          SectionCard(
            title: 'Explicit grants',
            icon: PermissionSource.grant.icon,
            trailing: _canManage
                ? TextButton.icon(
                    key: const Key('add-grant-button'),
                    onPressed: () => _add(deny: false),
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Grant'),
                  )
                : null,
            children: [
              if (_grants.isEmpty) const Text('No permissions beyond the role.'),
              for (final p in _grants)
                _PermissionTile(
                  permission: p,
                  source: PermissionSource.grant,
                  onRemove: _canManage && (widget.actor.role == UserRole.admin || !p.isAdminOnly)
                      ? () => setState(() => _grants.remove(p))
                      : null,
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),

          // --- Explicit denials --------------------------------------------
          SectionCard(
            title: 'Explicit denials',
            icon: PermissionSource.denial.icon,
            trailing: _canManage
                ? TextButton.icon(
                    key: const Key('add-denial-button'),
                    onPressed: () => _add(deny: true),
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Deny'),
                  )
                : null,
            children: [
              if (_denials.isEmpty) const Text('Nothing is withheld.'),
              for (final p in _denials)
                _PermissionTile(
                  permission: p,
                  source: PermissionSource.denial,
                  onRemove: _canManage && _canGive(p) ? () => setState(() => _denials.remove(p)) : null,
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),

          // --- Temporary ---------------------------------------------------
          _TemporarySection(
            user: _user,
            now: now,
            canGrant: _canTemporary,
            onGrant: _grantTemporary,
            onRevoke: _revoke,
          ),
          const SizedBox(height: AppSpacing.sm),

          // --- Role (read-only) --------------------------------------------
          SectionCard(
            title: '${_user.role.label} role permissions',
            icon: PermissionSource.role.icon,
            children: [
              Text('Granted by the role. Change the role, or add a denial, to alter them.',
                  style: theme.textTheme.bodySmall),
              for (final entry in grouped.entries) ...[
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.sm),
                  child: Text(entry.key.label, style: theme.textTheme.labelLarge),
                ),
                for (final p in entry.value)
                  _PermissionTile(
                    permission: p,
                    source: _denials.contains(p) ? PermissionSource.denial : PermissionSource.role,
                    struck: _denials.contains(p),
                  ),
              ],
            ],
          ),
        ],
      ),
      if (_dirty && _canManage)
        Positioned(
          left: AppSpacing.md,
          right: AppSpacing.md,
          bottom: AppSpacing.md,
          child: Material(
            elevation: 6,
            borderRadius: BorderRadius.circular(AppSpacing.radius),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.xs),
              child: Row(children: [
                Expanded(
                  child: TextButton(
                    onPressed: _saving
                        ? null
                        : () => setState(() {
                              _grants
                                ..clear()
                                ..addAll(_user.permissions);
                              _denials
                                ..clear()
                                ..addAll(_user.deniedPermissions);
                            }),
                    child: const Text('Discard'),
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: FilledButton(
                    key: const Key('save-permissions-button'),
                    onPressed: _saving ? null : _save,
                    child: const Text('Save changes'),
                  ),
                ),
              ]),
            ),
          ),
        ),
    ]);
  }
}

class _PermissionTile extends StatelessWidget {
  const _PermissionTile({required this.permission, required this.source, this.onRemove, this.struck = false});

  final Permission permission;
  final PermissionSource source;
  final VoidCallback? onRemove;
  final bool struck;

  @override
  Widget build(BuildContext context) => ListTile(
        key: Key('perm-${source.name}-${permission.key}'),
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: Icon(source.icon, color: source.color, size: 20),
        title: Text(
          permission.label,
          style: struck ? const TextStyle(decoration: TextDecoration.lineThrough) : null,
        ),
        subtitle: Text(permission.key),
        trailing: onRemove == null
            ? null
            : IconButton(tooltip: 'Remove', icon: const Icon(Icons.close), onPressed: onRemove),
      );
}

class _TemporarySection extends ConsumerWidget {
  const _TemporarySection({
    required this.user,
    required this.now,
    required this.canGrant,
    required this.onGrant,
    required this.onRevoke,
  });

  final AppUser user;
  final DateTime now;
  final bool canGrant;
  final VoidCallback onGrant;
  final ValueChanged<TemporaryGrant> onRevoke;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final grants = ref.watch(temporaryGrantsProvider(user.uid));
    final names = ref.watch(userNamesProvider);
    return SectionCard(
      title: 'Temporary permissions',
      icon: PermissionSource.temporary.icon,
      trailing: canGrant
          ? TextButton.icon(
              key: const Key('add-temporary-button'),
              onPressed: onGrant,
              icon: const Icon(Icons.add, size: 18),
              label: const Text('Grant'),
            )
          : null,
      children: switch (grants) {
        AsyncData(:final value) when value.isEmpty => [const Text('No temporary access has been granted.')],
        AsyncData(:final value) => [
            for (final g in value)
              _TemporaryGrantTile(
                grant: g,
                now: now,
                grantedBy: g.grantedByName ?? names[g.grantedBy] ?? 'Administrator',
                onRevoke: canGrant && g.isCurrent(now) ? () => onRevoke(g) : null,
              ),
          ],
        AsyncError() => [const Text('Temporary permissions could not be loaded.')],
        _ => [const LinearProgressIndicator()],
      },
    );
  }
}

class _TemporaryGrantTile extends StatelessWidget {
  const _TemporaryGrantTile({required this.grant, required this.now, required this.grantedBy, this.onRevoke});

  final TemporaryGrant grant;
  final DateTime now;
  final String grantedBy;
  final VoidCallback? onRevoke;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = grant.statusAt(now);
    final color = switch (status) {
      TemporaryGrantStatus.active => AppColors.warning,
      TemporaryGrantStatus.scheduled => AppColors.info,
      TemporaryGrantStatus.revoked => AppColors.danger,
      _ => Colors.grey,
    };
    return Padding(
      key: Key('temp-grant-${grant.id}'),
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(
          grant.isCurrent(now) ? PermissionSource.temporary.icon : PermissionSource.expired.icon,
          color: color,
          size: 20,
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(grant.permission.label, style: theme.textTheme.bodyMedium)),
              StatusChip(status.label, color: color),
            ]),
            Text(
              '${DateTimeFormatter.dateTime(grant.startsAt)} → ${DateTimeFormatter.dateTime(grant.expiresAt)}',
              style: theme.textTheme.bodySmall,
            ),
            Text('Granted by $grantedBy', style: theme.textTheme.bodySmall),
            if (grant.reason != null) Text('Reason: ${grant.reason}', style: theme.textTheme.bodySmall),
            if (onRevoke != null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  key: Key('revoke-${grant.id}'),
                  onPressed: onRevoke,
                  child: const Text('Revoke'),
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}
