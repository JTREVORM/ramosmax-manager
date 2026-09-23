import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/app_notification.dart';
import '../../../routes/app_routes.dart';
import '../../finance/presentation/finance_widgets.dart' show ScreenHeader;
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../application/notifications_providers.dart';

/// App-bar bell with the unread count.
class NotificationBell extends ConsumerWidget {
  const NotificationBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(unreadNotificationsProvider).value ?? 0;
    return IconButton(
      key: const Key('notifications-button'),
      tooltip: unread == 0 ? 'Notifications' : 'Notifications ($unread unread)',
      onPressed: () => context.go(AppRoutes.notifications),
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text(unread > 99 ? '99+' : '$unread', key: const Key('notifications-badge')),
        child: const Icon(Icons.notifications_outlined, color: Colors.white),
      ),
    );
  }
}

/// The signed-in person's notifications, newest first (Phase 9).
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  Future<void> _open(BuildContext context, WidgetRef ref, AppNotification n) async {
    if (!n.read) await ref.read(notificationActionsProvider).markRead(n.id);
    if (!context.mounted) return;
    final now = ref.read(clockProvider).value ?? DateTime.now();
    context.go(notificationRoute(n, ref.read(currentUserProvider), now));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(myNotificationsProvider);
    final unread = ref.watch(unreadNotificationsProvider).value ?? 0;
    return Column(children: [
      ScreenHeader(
        'Notifications',
        subtitle: unread == 0 ? 'All caught up' : '$unread unread',
        action: Row(mainAxisSize: MainAxisSize.min, children: [
          if (unread > 0)
            IconButton(
              key: const Key('mark-all-read'),
              tooltip: 'Mark all as read',
              icon: const Icon(Icons.done_all),
              onPressed: () async {
                final r = await ref.read(notificationActionsProvider).markAllRead();
                if (context.mounted) r.when(success: (_) {}, failure: (f) => AppSnackbar.error(context, f.message));
              },
            ),
          IconButton(
            key: const Key('notification-settings'),
            tooltip: 'Notification settings',
            icon: const Icon(Icons.tune),
            onPressed: () => context.go(AppRoutes.notificationSettings),
          ),
        ]),
      ),
      Expanded(
        child: switch (list) {
          AsyncData(:final value) when value.isEmpty => const EmptyView(
              icon: Icons.notifications_none,
              title: 'No notifications',
              message: 'Jobs, approvals and changes to your account appear here.',
            ),
          AsyncData(:final value) => ListView.builder(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
              itemCount: value.length,
              itemBuilder: (context, i) {
                final n = value[i];
                return Card(
                  key: Key('notification-${n.id}'),
                  child: ListTile(
                    onTap: () => _open(context, ref, n),
                    leading: Icon(n.read ? Icons.notifications_none : Icons.notifications_active,
                        color: n.read ? Theme.of(context).colorScheme.outline : Theme.of(context).colorScheme.primary),
                    title: Text(n.title, style: n.read ? null : const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text([n.body, if (n.createdAt != null) DateTimeFormatter.dateTime(n.createdAt!)].join('\n')),
                    isThreeLine: true,
                  ),
                );
              },
            ),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error), onRetry: () => ref.invalidate(myNotificationsProvider)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }
}

/// Push on/off per category. Critical categories are shown but locked on.
class NotificationSettingsScreen extends ConsumerStatefulWidget {
  const NotificationSettingsScreen({super.key});

  @override
  ConsumerState<NotificationSettingsScreen> createState() => _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState extends ConsumerState<NotificationSettingsScreen> {
  final Set<String> _saving = {};

  Future<void> _set(NotificationCategory c, bool on) async {
    setState(() => _saving.add(c.key));
    final r = await ref.read(notificationActionsProvider).updatePreferences({c.key: on});
    if (!mounted) return;
    setState(() => _saving.remove(c.key));
    r.when(success: (_) => AppSnackbar.success(context, on ? '${c.label}: push on.' : '${c.label}: push off.'),
        failure: (f) => AppSnackbar.error(context, f.message));
  }

  @override
  Widget build(BuildContext context) {
    final prefs = ref.watch(currentUserProvider)?.notificationPreferences ?? const <String, bool>{};
    return ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
      ScreenHeader('Notification settings', onBack: () => context.go(AppRoutes.notifications),
          subtitle: 'Push notifications on this and your other devices. Everything still appears in Notifications.'),
      SectionCard(title: 'Always on', icon: Icons.lock_outline, children: [
        for (final c in NotificationCategory.values.where((c) => !c.mutable && c != NotificationCategory.other))
          SwitchListTile(
            key: Key('pref-${c.key}'),
            contentPadding: EdgeInsets.zero,
            value: true,
            onChanged: null,
            title: Text(c.label),
            subtitle: Text(c.description),
          ),
        Text('After-hours authorisations, overdue handovers and cash discrepancies also always notify you.',
            style: Theme.of(context).textTheme.bodySmall),
      ]),
      SectionCard(title: 'You choose', icon: Icons.tune, children: [
        for (final c in NotificationCategory.values.where((c) => c.mutable && c != NotificationCategory.other))
          SwitchListTile(
            key: Key('pref-${c.key}'),
            contentPadding: EdgeInsets.zero,
            value: prefs[c.key] ?? true,
            onChanged: _saving.contains(c.key) ? null : (v) => _set(c, v),
            title: Text(c.label),
            subtitle: Text(c.description),
          ),
      ]),
    ]);
  }
}
