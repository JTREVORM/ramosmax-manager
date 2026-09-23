import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/providers/core_providers.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/application/session_controller.dart';
import 'routes/app_router.dart';

class RamosMaxApp extends ConsumerWidget {
  const RamosMaxApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Activate session side effects (analytics identity, login bookkeeping…).
    ref.watch(sessionEffectsProvider);
    final router = ref.watch(appRouterProvider);
    final env = ref.watch(appEnvironmentProvider);

    return MaterialApp.router(
      title: env.appTitle,
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.light,
      routerConfig: router,
    );
  }
}
