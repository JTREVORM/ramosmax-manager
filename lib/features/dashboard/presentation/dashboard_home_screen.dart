import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/branding/brand.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../routes/app_routes.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/application/session_state.dart';
import '../application/role_navigation.dart';
import 'dashboard_stats.dart';

/// Dashboard: identity, role, live figures for the role ([DashboardStats]) and
/// the modules this user can reach. No placeholder figures are shown.
class DashboardHomeScreen extends ConsumerWidget {
  const DashboardHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session is! Authorized) return const SizedBox.shrink();
    final user = session.user;
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final modules = RoleNavigation.modulesFor(user, now)
        .where((m) => m != AppModule.dashboard)
        .toList();
    final temporary = user.temporaryPermissions.entries
        .where((e) => e.value.isLive(now))
        .toList();
    final theme = Theme.of(context);

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Card(
          color: Brand.purple,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_greeting(now), style: const TextStyle(color: Colors.white70)),
                const SizedBox(height: AppSpacing.xxs),
                Text(
                  user.displayName,
                  key: const Key('dashboard-name'),
                  style: theme.textTheme.headlineSmall?.copyWith(color: Colors.white),
                ),
                const SizedBox(height: AppSpacing.sm),
                Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
                  _Chip(user.role.label, key: const Key('dashboard-role')),
                  if (user.specialization != null) _Chip(user.specialization!.label),
                  _Chip(DateTimeFormatter.date(now)),
                ]),
              ],
            ),
          ),
        ),
        // Reception's main job: one tap to the plate search.
        if (modules.contains(AppModule.newService)) ...[
          const SizedBox(height: AppSpacing.md),
          FilledButton.icon(
            key: const Key('dashboard-new-service'),
            onPressed: () => context.go(AppRoutes.module(AppModule.newService)),
            icon: const Icon(Icons.add_task),
            label: const Text('New service — enter number plate'),
          ),
        ],
        DashboardStats(user: user),
        if (temporary.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.md),
          Card(
            child: ListTile(
              leading: const Icon(Icons.schedule, color: Brand.goldDeep),
              title: const Text('Temporary access active'),
              subtitle: Text(
                '${temporary.length} temporary permission(s). Earliest expires '
                '${DateTimeFormatter.dateTime(temporary.map((e) => e.value.expiresAt).reduce((a, b) => a.isBefore(b) ? a : b))}.',
              ),
            ),
          ),
        ],
        const SizedBox(height: AppSpacing.lg),
        Text('Your workspace', style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (modules.isEmpty)
          const Text('No modules are assigned to your account yet.')
        else
          GridView.count(
            crossAxisCount: MediaQuery.sizeOf(context).width > 600 ? 4 : 3,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: AppSpacing.sm,
            crossAxisSpacing: AppSpacing.sm,
            children: [
              for (final m in modules)
                Card(
                  child: InkWell(
                    borderRadius: BorderRadius.circular(AppSpacing.radius),
                    onTap: () => context.go(AppRoutes.module(m)),
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.xs),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(m.icon, color: theme.colorScheme.primary, size: 28),
                          const SizedBox(height: AppSpacing.xs),
                          Text(m.label,
                              textAlign: TextAlign.center,
                              maxLines: 2,
                              style: theme.textTheme.labelMedium),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
      ],
    );
  }

  static String _greeting(DateTime now) {
    final hour = EastAfricaTime.toEat(now).hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.label, {super.key});
  final String label;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(label, style: const TextStyle(color: Brand.gold, fontWeight: FontWeight.w600)),
      );
}
