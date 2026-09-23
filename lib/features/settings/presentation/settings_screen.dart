import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/sections.dart';
import '../../../routes/app_routes.dart';
import '../../dashboard/application/role_navigation.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;

/// Phase 9: one place to find every setting. Each policy is still edited on
/// its own screen (and only by settings.manage / the owning permission, on
/// the server) - this hub adds no second copy of any setting.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final env = ref.watch(appEnvironmentProvider);
    final user = ref.watch(currentUserProvider);
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    bool open(AppModule m) => user != null && RoleNavigation.canOpen(user, m, now);
    final links = <(String, String, IconData, String, AppModule?)>[
      ('Notification settings', 'Which push notifications you receive', Icons.notifications_outlined, AppRoutes.notificationSettings, null),
      ('Attendance, allowance and payroll policy', 'Payroll → Policy', Icons.wallet_outlined, AppRoutes.payroll, AppModule.payroll),
      ('After-hours policy', 'After-Hours → Policy', Icons.nightlight_outlined, AppRoutes.afterHours, AppModule.afterHours),
      ('Share and dividend policy', 'Shares → Policy, Dividends → Policy', Icons.donut_small_outlined, AppRoutes.shares, AppModule.shares),
      ('Financial accounts', 'Finance → Accounts', Icons.account_balance_outlined, AppRoutes.financeAccounts, AppModule.finance),
      ('Services and prices', 'Services', Icons.build_outlined, AppRoutes.services, AppModule.services),
      ('Users, roles and permissions', 'User Management', Icons.manage_accounts_outlined, AppRoutes.users, AppModule.users),
    ];
    return ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
      Text('Settings', style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: AppSpacing.sm),
      SectionCard(title: 'This app', icon: Icons.info_outline, children: [
        InfoRow('Environment', env.isProduction ? 'Production' : 'Development (test data)', valueWidget: Text(
            env.isProduction ? 'Production' : 'Development (test data)', key: const Key('settings-environment'))),
        InfoRow('Firebase project', env.firebaseProjectId),
        InfoRow('Application ID', env.expectedApplicationId),
      ]),
      SectionCard(title: 'Where each setting lives', icon: Icons.tune, children: [
        for (final (title, where, icon, route, module) in links)
          if (module == null || open(module))
            ListTile(
              key: Key('settings-link-${route.split('/').last}'),
              contentPadding: EdgeInsets.zero,
              leading: Icon(icon),
              title: Text(title),
              subtitle: Text(where),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.go(route),
            ),
      ]),
    ]);
  }
}
