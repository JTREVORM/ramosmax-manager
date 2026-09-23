import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/brand_widgets.dart';
import '../../../core/widgets/feedback.dart';
import '../../../routes/app_routes.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/application/session_state.dart';
import '../application/role_navigation.dart';

/// Role-aware scaffold around every signed-in screen: branded app bar,
/// offline banner and a bottom bar built from the user's permitted modules.
class DashboardShell extends ConsumerWidget {
  const DashboardShell({super.key, required this.location, required this.child});

  final String location;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session is! Authorized) return const Scaffold(body: LoadingView());

    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final modules = RoleNavigation.modulesFor(session.user, now);
    final current = AppRoutes.moduleForLocation(location);

    final overflow = modules.length > RoleNavigation.maxBarItems;
    final barModules = overflow ? modules.take(RoleNavigation.maxBarItems - 1).toList() : modules;
    final moreModules = overflow ? modules.skip(RoleNavigation.maxBarItems - 1).toList() : <AppModule>[];

    var selected = barModules.indexOf(current ?? AppModule.dashboard);
    if (selected < 0) selected = overflow ? barModules.length : 0;

    return Scaffold(
      appBar: AppBar(
        title: const AppBarLogo(),
        actions: [
          const Padding(
            padding: EdgeInsets.only(right: AppSpacing.xs),
            child: Center(child: EnvironmentBadge()),
          ),
          IconButton(
            key: const Key('account-button'),
            tooltip: 'My account',
            icon: CircleAvatar(
              radius: 16,
              backgroundColor: Colors.white24,
              child: Text(
                session.user.displayName.characters.first.toUpperCase(),
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
              ),
            ),
            onPressed: () => context.go(AppRoutes.module(AppModule.myProfile)),
          ),
        ],
      ),
      body: Column(children: [
        const OfflineBanner(),
        Expanded(child: child),
      ]),
      bottomNavigationBar: barModules.length < 2
          ? null
          : NavigationBar(
              selectedIndex: selected,
              onDestinationSelected: (i) {
                if (i < barModules.length) {
                  context.go(AppRoutes.module(barModules[i]));
                } else {
                  _showMore(context, moreModules);
                }
              },
              destinations: [
                for (final m in barModules)
                  NavigationDestination(icon: Icon(m.icon), label: m.barLabel),
                if (overflow)
                  const NavigationDestination(icon: Icon(Icons.menu), label: 'More'),
              ],
            ),
    );
  }


  void _showMore(BuildContext context, List<AppModule> modules) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final m in modules)
              ListTile(
                leading: Icon(m.icon),
                title: Text(m.label),
                onTap: () {
                  Navigator.of(sheet).pop();
                  context.go(AppRoutes.module(m));
                },
              ),
          ],
        ),
      ),
    );
  }
}
