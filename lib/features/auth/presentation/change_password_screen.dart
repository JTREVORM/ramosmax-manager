import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/password_policy.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/brand_widgets.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/app_user.dart';
import '../../../routes/app_routes.dart';
import '../../dashboard/application/role_navigation.dart';
import '../application/login_controller.dart';
import '../application/session_controller.dart';
import '../application/session_state.dart';

/// Choose a new password.
///
/// [forced]: shown straight after signing in with a temporary password (new
/// account or administrator reset). There is no way around it — the router
/// allows no other screen, and the rules and Cloud Functions refuse every
/// request until the server records the change. Otherwise it is the
/// self-service "Change password" from My Profile.
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key, required this.forced});
  final bool forced;

  @override
  ConsumerState<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final _form = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _new = TextEditingController();
  final _confirm = TextEditingController();
  bool _obscure = true;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _new.dispose();
    _confirm.dispose();
    super.dispose();
  }

  AppUser? get _user => switch (ref.read(sessionProvider)) {
        PasswordChangeRequired(:final user) => user,
        Authorized(:final user) => user,
        _ => null,
      };

  Future<void> _submit() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    setState(() => _saving = true);
    final result = await ref
        .read(sessionActionsProvider)
        .changePassword(currentPassword: _current.text, newPassword: _new.text);
    if (!mounted) return;
    setState(() => _saving = false);
    result.when(
      success: (_) {
        _current.clear();
        _new.clear();
        _confirm.clear();
        AppSnackbar.success(context, 'Your password has been changed.');
        // Forced: the session becomes Authorized once the server clears the
        // flag, and the router moves on to the dashboard by itself.
        if (!widget.forced) context.go(AppRoutes.module(AppModule.myProfile));
      },
      failure: (f) => setState(() => _error = f.message),
    );
  }

  Widget _passwordField({
    required Key key,
    required TextEditingController controller,
    required String label,
    required String? Function(String?) validator,
    List<String> autofill = const [AutofillHints.newPassword],
  }) =>
      TextFormField(
        key: key,
        controller: controller,
        obscureText: _obscure,
        enableSuggestions: false,
        autocorrect: false,
        keyboardType: TextInputType.visiblePassword,
        autofillHints: autofill,
        decoration: InputDecoration(labelText: label),
        validator: validator,
        onChanged: (_) => setState(() {}),
      );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    ref.watch(sessionProvider);
    final user = _user;
    if (user == null) return const Scaffold(body: LoadingView());

    final checks = <(String, bool)>[
      ('At least ${PasswordPolicy.minLength} characters', _new.text.length >= PasswordPolicy.minLength),
      ('An uppercase and a lowercase letter',
          RegExp('[A-Z]').hasMatch(_new.text) && RegExp('[a-z]').hasMatch(_new.text)),
      ('A number', RegExp(r'\d').hasMatch(_new.text)),
      ('A symbol, e.g. ! @ # \$ %', RegExp('[^A-Za-z0-9]').hasMatch(_new.text)),
    ];

    final form = Form(
      key: _form,
      child: AutofillGroup(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(widget.forced ? 'Choose your password' : 'Change password', style: theme.textTheme.headlineSmall),
          const SizedBox(height: AppSpacing.xs),
          Text(
            widget.forced
                ? 'You signed in with a temporary password. Choose your own password to continue. '
                    'Keep it private — nobody from RamosMAX will ask for it.'
                : 'Your other devices will be signed out.',
            style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.lg),
          _passwordField(
            key: const Key('current-password-field'),
            controller: _current,
            label: widget.forced ? 'Temporary password' : 'Current password',
            autofill: const [AutofillHints.password],
            validator: (v) => (v == null || v.isEmpty)
                ? (widget.forced ? 'Enter the temporary password' : 'Enter your current password')
                : null,
          ),
          const SizedBox(height: AppSpacing.sm),
          _passwordField(
            key: const Key('new-password-field'),
            controller: _new,
            label: 'New password',
            validator: (v) {
              final e = Validators.newPassword(v,
                  phoneNumber: user.phoneNumber, staffId: user.staffId, fullName: user.fullName);
              if (e != null) return e;
              if (v == _current.text) return 'Choose a password different from the current one.';
              return null;
            },
          ),
          const SizedBox(height: AppSpacing.sm),
          _passwordField(
            key: const Key('confirm-password-field'),
            controller: _confirm,
            label: 'Confirm new password',
            validator: (v) => v != _new.text ? 'The passwords do not match.' : null,
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              key: const Key('toggle-password-visibility'),
              onPressed: () => setState(() => _obscure = !_obscure),
              icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined, size: 18),
              label: Text(_obscure ? 'Show passwords' : 'Hide passwords'),
            ),
          ),
          for (final (label, ok) in checks)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(children: [
                Icon(ok ? Icons.check_circle : Icons.radio_button_unchecked,
                    size: 18, color: ok ? AppColors.success : theme.colorScheme.outline),
                const SizedBox(width: AppSpacing.xs),
                Expanded(child: Text(label, style: theme.textTheme.bodySmall)),
              ]),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text('Do not use your name, phone number or staff ID.', style: theme.textTheme.bodySmall),
          ),
          const SizedBox(height: AppSpacing.md),
          if (_error != null) ...[InlineError(_error!), const SizedBox(height: AppSpacing.sm)],
          FilledButton(
            key: const Key('change-password-submit'),
            onPressed: _saving ? null : _submit,
            child: _saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Text('Save new password'),
          ),
          if (widget.forced) ...[
            const SizedBox(height: AppSpacing.sm),
            TextButton(
              key: const Key('change-password-sign-out'),
              onPressed: _saving
                  ? null
                  : () async {
                      ref.read(loginControllerProvider.notifier).reset();
                      await ref.read(sessionActionsProvider).signOut();
                    },
              child: const Text('Sign out'),
            ),
          ],
        ]),
      ),
    );

    if (!widget.forced) {
      return ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: IconButton(
              tooltip: 'Back',
              icon: const Icon(Icons.arrow_back),
              onPressed: () => context.go(AppRoutes.module(AppModule.myProfile)),
            ),
          ),
          form,
        ],
      );
    }
    return Scaffold(
      body: SingleChildScrollView(
        child: Column(children: [
          const BrandHeader(logoSize: 96),
          ContentWidth(child: Padding(padding: const EdgeInsets.all(AppSpacing.lg), child: form)),
        ]),
      ),
    );
  }
}
