import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/branding/brand.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/brand_widgets.dart';
import '../application/session_controller.dart';
import '../application/session_state.dart';

/// Shown while the session is being resolved (restoring auth, fetching the
/// profile), and when that resolution is blocked by connectivity or errors.
/// Navigation away from here is driven by the router's redirect.
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    return BrandedSplash(
      status: switch (session) {
        AwaitingConnection() => _StatusMessage(
            icon: Icons.cloud_off,
            message: 'Connect to the internet to verify your RamosMAX access.',
            actionLabel: 'Use a different number',
            onAction: () => ref.read(sessionActionsProvider).signOut(),
          ),
        SessionFailed(:final failure) => _StatusMessage(
            icon: Icons.error_outline,
            message: failure.message,
            actionLabel: 'Try again',
            onAction: () => ref.invalidate(authSnapshotProvider),
          ),
        _ => null,
      },
    );
  }
}

/// The branded full-screen splash. Also used by the bootstrapper before
/// Firebase (and therefore Riverpod state) exists.
class BrandedSplash extends StatelessWidget {
  const BrandedSplash({super.key, this.status});

  final Widget? status;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Brand.purple,
      body: SafeArea(
        child: Column(
          children: [
            const Spacer(flex: 3),
            const AppLogo(size: 220, rounded: false),
            const Spacer(flex: 2),
            SizedBox(
              height: 140,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xl),
                child: status ??
                    const Column(
                      children: [
                        SizedBox(
                          width: 28,
                          height: 28,
                          child: CircularProgressIndicator(strokeWidth: 3, color: Brand.gold),
                        ),
                        SizedBox(height: AppSpacing.md),
                        Text('Loading…', style: TextStyle(color: Colors.white70)),
                      ],
                    ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: Text(
                Brand.legalName,
                style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusMessage extends StatelessWidget {
  const _StatusMessage({
    required this.icon,
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final String message;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) => Column(
        children: [
          Icon(icon, color: Brand.gold),
          const SizedBox(height: AppSpacing.xs),
          Text(message, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white)),
          const SizedBox(height: AppSpacing.xs),
          TextButton(
            onPressed: onAction,
            style: TextButton.styleFrom(foregroundColor: Brand.gold),
            child: Text(actionLabel),
          ),
        ],
      );
}
