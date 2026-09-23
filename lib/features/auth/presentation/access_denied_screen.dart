import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/widgets/brand_widgets.dart';
import '../application/login_controller.dart';
import '../application/session_controller.dart';
import '../application/session_state.dart';

/// Shown when someone is signed in but has no usable
/// RamosMAX profile. The Firebase session is kept only long enough to show
/// this message; nothing in the system is reachable from here.
class AccessDeniedScreen extends ConsumerWidget {
  const AccessDeniedScreen({super.key});

  static (IconData, String, String) describe(AccessDeniedReason reason) => switch (reason) {
        AccessDeniedReason.notRegistered => (
            Icons.person_off_outlined,
            'Not registered',
            'Your phone number is not registered for RamosMAX access. '
                'Please contact an administrator.',
          ),
        AccessDeniedReason.inactive => (
            Icons.block,
            'Account inactive',
            'Your RamosMAX account has been deactivated. '
                'Please contact an administrator if you believe this is a mistake.',
          ),
        AccessDeniedReason.expired => (
            Icons.timer_off_outlined,
            'Access expired',
            'Your RamosMAX access period has ended. '
                'Please contact an administrator to renew it.',
          ),
        AccessDeniedReason.misconfigured => (
            Icons.manage_accounts_outlined,
            'Account setup incomplete',
            'Your RamosMAX account is not fully set up yet. '
                'Please contact an administrator.',
          ),
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final theme = Theme.of(context);
    if (session is! AccessDenied) return const SizedBox.shrink();

    final (icon, title, message) = describe(session.reason);

    return Scaffold(
      body: SingleChildScrollView(
        child: Column(
          children: [
            const BrandHeader(logoSize: 104),
            ContentWidth(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(icon, size: 56, color: theme.colorScheme.error),
                    const SizedBox(height: AppSpacing.md),
                    Text(title,
                        key: const Key('access-denied-title'),
                        textAlign: TextAlign.center,
                        style: theme.textTheme.headlineSmall),
                    const SizedBox(height: AppSpacing.sm),
                    Text(message,
                        key: const Key('access-denied-message'),
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodyLarge),
                    if (session.phoneNumber != null) ...[
                      const SizedBox(height: AppSpacing.md),
                      Text(
                        'Signed in as ${PhoneNumbers.formatForDisplay(session.phoneNumber!)}',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                      ),
                    ],
                    const SizedBox(height: AppSpacing.xl),
                    FilledButton(
                      key: const Key('different-number-button'),
                      onPressed: () async {
                        ref.read(loginControllerProvider.notifier).reset();
                        await ref.read(sessionActionsProvider).signOut();
                      },
                      child: const Text('Sign out'),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
