import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/branding/brand.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/brand_widgets.dart';
import '../../../core/widgets/feedback.dart';
import '../application/login_controller.dart';

/// Phone number + password sign-in.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;

  @override
  void dispose() {
    _phone.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    if (!_formKey.currentState!.validate()) return;
    final password = _password.text;
    await ref.read(loginControllerProvider.notifier).signIn(_phone.text, password);
    // Don't keep the password around after an attempt fails.
    if (mounted && ref.read(loginControllerProvider).failure != null) _password.clear();
  }

  void _clearFailure() {
    if (ref.read(loginControllerProvider).failure != null) {
      ref.read(loginControllerProvider.notifier).clearFailure();
    }
  }

  Future<void> _pickCountry(PhoneCountry current) async {
    final picked = await showModalBottomSheet<PhoneCountry>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.xs),
              child: Text('Select country', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
            ),
            for (final c in PhoneNumbers.countries)
              ListTile(
                leading: Text(c.flag, style: const TextStyle(fontSize: 24)),
                title: Text(c.name),
                trailing: Text('+${c.dialCode}'),
                selected: c.isoCode == current.isoCode,
                onTap: () => Navigator.of(context).pop(c),
              ),
          ],
        ),
      ),
    );
    if (picked != null) ref.read(loginControllerProvider.notifier).selectCountry(picked);
  }

  /// There is no self-service reset by SMS or email: RamosMAX accounts are
  /// issued by the business, so a forgotten password is reset by a Manager
  /// (Workers) or an Administrator, who hands over a temporary password.
  void _forgotPassword() {
    showDialog<void>(
      context: context,
      builder: (dialog) => AlertDialog(
        icon: const Icon(Icons.lock_reset),
        title: const Text('Forgot your password?'),
        content: const Text(
          'Ask your manager or a RamosMAX administrator to reset it. '
          'They will give you a temporary password, and you will choose a new one '
          'when you sign in.\n\nNobody from RamosMAX will ever ask you for your password.',
        ),
        actions: [
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
            onPressed: () => Navigator.of(dialog).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(loginControllerProvider);
    final theme = Theme.of(context);
    final busy = state.busy;

    return Scaffold(
      body: SingleChildScrollView(
        child: Column(
          children: [
            const BrandHeader(subtitle: Brand.systemName),
            ContentWidth(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: AutofillGroup(
                  child: Form(
                    key: _formKey,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text('Sign in', style: theme.textTheme.headlineSmall),
                        const SizedBox(height: AppSpacing.xs),
                        Text(
                          'Enter the phone number registered with RamosMAX and your password.',
                          style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                        ),
                        const SizedBox(height: AppSpacing.lg),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                              height: 56,
                              child: OutlinedButton(
                                key: const Key('country-picker'),
                                onPressed: busy ? null : () => _pickCountry(state.country),
                                style: OutlinedButton.styleFrom(
                                  minimumSize: const Size(0, 56),
                                  padding: const EdgeInsets.symmetric(horizontal: 12),
                                ),
                                child: Row(mainAxisSize: MainAxisSize.min, children: [
                                  Text(state.country.display, style: const TextStyle(fontSize: 16)),
                                  const Icon(Icons.arrow_drop_down),
                                ]),
                              ),
                            ),
                            const SizedBox(width: AppSpacing.xs),
                            Expanded(
                              child: TextFormField(
                                key: const Key('phone-field'),
                                controller: _phone,
                                enabled: !busy,
                                keyboardType: TextInputType.phone,
                                textInputAction: TextInputAction.next,
                                autofillHints: const [AutofillHints.telephoneNumberNational, AutofillHints.username],
                                inputFormatters: [
                                  FilteringTextInputFormatter.allow(RegExp(r'[\d\s+]')),
                                  LengthLimitingTextInputFormatter(16),
                                ],
                                decoration: InputDecoration(labelText: 'Phone number', hintText: state.country.example),
                                validator: (v) => Validators.phone(v, country: state.country),
                                onChanged: (_) => _clearFailure(),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: AppSpacing.md),
                        TextFormField(
                          key: const Key('password-field'),
                          controller: _password,
                          enabled: !busy,
                          obscureText: _obscure,
                          enableSuggestions: false,
                          autocorrect: false,
                          keyboardType: TextInputType.visiblePassword,
                          textInputAction: TextInputAction.done,
                          autofillHints: const [AutofillHints.password],
                          decoration: InputDecoration(
                            labelText: 'Password',
                            suffixIcon: IconButton(
                              key: const Key('password-visibility'),
                              tooltip: _obscure ? 'Show password' : 'Hide password',
                              icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                              onPressed: () => setState(() => _obscure = !_obscure),
                            ),
                          ),
                          validator: Validators.signInPassword,
                          onChanged: (_) => _clearFailure(),
                          onFieldSubmitted: (_) => _submit(),
                        ),
                        Align(
                          alignment: Alignment.centerRight,
                          child: TextButton(
                            key: const Key('forgot-password-button'),
                            onPressed: _forgotPassword,
                            child: const Text('Forgot password?'),
                          ),
                        ),
                        if (state.failure != null) ...[
                          const SizedBox(height: AppSpacing.xs),
                          InlineError(state.failure!.message),
                        ],
                        const SizedBox(height: AppSpacing.md),
                        FilledButton(
                          key: const Key('sign-in-button'),
                          onPressed: busy ? null : _submit,
                          child: busy
                              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                              : const Text('Sign in'),
                        ),
                        const SizedBox(height: AppSpacing.lg),
                        Row(children: [
                          Icon(Icons.lock_outline, size: 16, color: theme.colorScheme.outline),
                          const SizedBox(width: AppSpacing.xs),
                          Expanded(
                            child: Text(
                              'Access is limited to registered RamosMAX staff and partners.',
                              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                            ),
                          ),
                        ]),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
