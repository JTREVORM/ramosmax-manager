import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/widgets/feedback.dart';
import '../../auth/application/login_controller.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/application/session_state.dart';
import '../../../routes/app_routes.dart';
import '../application/role_navigation.dart';

/// Destination for modules delivered in later phases. States plainly that the
/// module is not available yet — it never renders sample or fake data.
class ModuleNotAvailableScreen extends StatelessWidget {
  const ModuleNotAvailableScreen({super.key, required this.module});
  final AppModule module;

  @override
  Widget build(BuildContext context) => EmptyView(
        icon: module.icon,
        title: module.label,
        message: 'This module is planned for a later release of the RamosMAX system '
            'and is not available yet.',
      );
}

/// The signed-in user's own profile and the sign-out action.
class MyProfileScreen extends ConsumerWidget {
  const MyProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session is! Authorized) return const SizedBox.shrink();
    final user = session.user;
    final env = ref.watch(appEnvironmentProvider);
    final theme = Theme.of(context);

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Card(
          child: Column(children: [
            ListTile(
              leading: const Icon(Icons.person_outline),
              title: const Text('Name'),
              subtitle: Text(user.fullName ?? 'Not set'),
            ),
            ListTile(
              leading: const Icon(Icons.phone_outlined),
              title: const Text('Phone'),
              subtitle: Text(PhoneNumbers.formatForDisplay(user.phoneNumber)),
            ),
            ListTile(
              leading: const Icon(Icons.verified_user_outlined),
              title: const Text('Role'),
              subtitle: Text(user.role.label),
            ),
            if (user.staffId != null)
              ListTile(
                leading: const Icon(Icons.badge_outlined),
                title: const Text('Staff ID'),
                subtitle: Text(user.staffId!),
              ),
            if (user.specialization != null)
              ListTile(
                leading: const Icon(Icons.handyman_outlined),
                title: const Text('Specialisation'),
                subtitle: Text(user.specialization!.label),
              ),
            if (user.lastLoginAt != null)
              ListTile(
                leading: const Icon(Icons.history),
                title: const Text('Last sign-in'),
                subtitle: Text(DateTimeFormatter.dateTime(user.lastLoginAt!)),
              ),
          ]),
        ),
        const SizedBox(height: AppSpacing.md),
        Card(
          child: Column(children: [
            const ListTile(
              leading: Icon(Icons.security_outlined),
              title: Text('Security', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
            ListTile(
              key: const Key('change-password-button'),
              leading: const Icon(Icons.password),
              title: const Text('Change password'),
              subtitle: Text(user.passwordChangedAt == null
                  ? 'Choose a password only you know'
                  : 'Last changed ${DateTimeFormatter.date(user.passwordChangedAt!)}'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.go(AppRoutes.profilePassword),
            ),
          ]),
        ),
        const SizedBox(height: AppSpacing.lg),
        OutlinedButton.icon(
          key: const Key('sign-out-button'),
          icon: const Icon(Icons.logout),
          label: const Text('Sign out'),
          style: OutlinedButton.styleFrom(foregroundColor: theme.colorScheme.error),
          onPressed: () async {
            final confirmed = await showConfirmDialog(
              context,
              title: 'Sign out?',
              message: 'You will need your phone number and password to sign in again.',
              confirmLabel: 'Sign out',
              destructive: true,
            );
            if (!confirmed) return;
            ref.read(loginControllerProvider.notifier).reset();
            await ref.read(sessionActionsProvider).signOut();
          },
        ),
        const SizedBox(height: AppSpacing.lg),
        Center(
          child: Text(
            '${env.appTitle} · ${env.flavor.name}',
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
          ),
        ),
      ],
    );
  }
}
