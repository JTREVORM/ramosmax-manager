import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../errors/app_failure.dart';
import '../providers/core_providers.dart';
import '../theme/app_theme.dart';

/// Loading, empty and error states. Every async screen uses these so the
/// three states look and read the same across modules.

class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.message});
  final String? message;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              if (message != null) ...[
                const SizedBox(height: AppSpacing.md),
                Text(message!, textAlign: TextAlign.center),
              ],
            ],
          ),
        ),
      );
}

class EmptyView extends StatelessWidget {
  const EmptyView({
    super.key,
    required this.title,
    this.message,
    this.icon = Icons.inbox_outlined,
    this.action,
  });

  final String title;
  final String? message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: theme.colorScheme.outline),
            const SizedBox(height: AppSpacing.md),
            Text(title, style: theme.textTheme.titleMedium, textAlign: TextAlign.center),
            if (message != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(
                message!,
                style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ],
            if (action != null) ...[const SizedBox(height: AppSpacing.lg), action!],
          ],
        ),
      ),
    );
  }
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry, this.title = 'Something went wrong'});

  factory ErrorView.failure(AppFailure failure, {VoidCallback? onRetry}) => ErrorView(
        message: failure.message,
        onRetry: failure.retryable ? onRetry : null,
        title: failure.kind == FailureKind.network ? 'You are offline' : 'Something went wrong',
      );

  final String title;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => EmptyView(
        icon: Icons.error_outline,
        title: title,
        message: message,
        action: onRetry == null
            ? null
            : OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
              ),
      );
}

/// Inline error banner for forms.
class InlineError extends StatelessWidget {
  const InlineError(this.message, {super.key});
  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpacing.sm),
        decoration: BoxDecoration(
          color: scheme.errorContainer,
          borderRadius: BorderRadius.circular(AppSpacing.radius),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.error_outline, color: scheme.onErrorContainer, size: 20),
            const SizedBox(width: AppSpacing.xs),
            Expanded(child: Text(message, style: TextStyle(color: scheme.onErrorContainer))),
          ],
        ),
      ),
    );
  }
}

/// Snackbars for transient success / error feedback.
abstract final class AppSnackbar {
  static void success(BuildContext context, String message) =>
      _show(context, message, AppColors.success, Icons.check_circle_outline);

  static void error(BuildContext context, String message) =>
      _show(context, message, AppColors.danger, Icons.error_outline);

  static void info(BuildContext context, String message) =>
      _show(context, message, AppColors.info, Icons.info_outline);

  static void _show(BuildContext context, String message, Color color, IconData icon) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        backgroundColor: color,
        content: Row(children: [
          Icon(icon, color: Colors.white),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(message, style: const TextStyle(color: Colors.white))),
        ]),
      ));
  }
}

/// Confirmation dialog. Returns true only when the user confirms.
Future<bool> showConfirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  String confirmLabel = 'Confirm',
  String cancelLabel = 'Cancel',
  bool destructive = false,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      return AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(cancelLabel)),
          FilledButton(
            style: destructive
                ? FilledButton.styleFrom(
                    backgroundColor: scheme.error,
                    foregroundColor: scheme.onError,
                    minimumSize: const Size(0, 44),
                  )
                : FilledButton.styleFrom(minimumSize: const Size(0, 44)),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      );
    },
  );
  return result ?? false;
}

/// Thin banner shown while the device has no network.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final online = ref.watch(isOnlineProvider).value ?? true;
    return AnimatedSize(
      duration: const Duration(milliseconds: 200),
      child: online
          ? const SizedBox(width: double.infinity)
          : const Material(
              color: AppColors.warning,
              child: SafeArea(
                bottom: false,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: 6),
                  child: Row(children: [
                    Icon(Icons.cloud_off, color: Colors.white, size: 18),
                    SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        'Offline — showing saved data. Payments and other financial actions need a connection.',
                        style: TextStyle(color: Colors.white, fontSize: 12.5),
                      ),
                    ),
                  ]),
                ),
              ),
            ),
    );
  }
}
