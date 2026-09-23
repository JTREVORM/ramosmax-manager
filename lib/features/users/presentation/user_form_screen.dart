import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/auth/access_policy.dart';
import '../../../core/auth/password_policy.dart';
import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/app_user.dart';
import '../../../routes/app_routes.dart';
import '../application/user_management_providers.dart';
import '../data/user_admin_api.dart';
import 'user_dialogs.dart';
import 'user_widgets.dart';

/// Staff IDs: capital letters, digits and dashes (mirrors the server).
final RegExp staffIdPattern = RegExp(r'^[A-Z0-9][A-Z0-9-]{2,31}$');

/// Add a new user ([uid] null) or edit an existing user's profile.
///
/// Role, status and permissions of an EXISTING user are changed from the
/// details and permissions screens, each with its own confirmation.
class UserFormScreen extends ConsumerWidget {
  const UserFormScreen({super.key, this.uid});
  final String? uid;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final actor = ref.watch(currentUserProvider);
    if (actor == null) return const SizedBox.shrink();
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    if (uid == null) {
      if (!AccessPolicy.canCreateUsers(actor, now)) {
        return const EmptyView(icon: Icons.lock_outline, title: 'Not permitted',
            message: 'You do not have permission to add users.');
      }
      return _UserForm(actor: actor, existing: null, now: now);
    }
    return switch (ref.watch(managedUserProvider(uid!))) {
      AsyncData(value: final AppUser user) => AccessPolicy.can(actor, UserAdminAction.editProfile, user, now)
          ? _UserForm(key: ValueKey(user.uid), actor: actor, existing: user, now: now)
          : const EmptyView(icon: Icons.lock_outline, title: 'Not permitted',
              message: 'You do not have permission to edit this user.'),
      AsyncData() => const EmptyView(icon: Icons.person_off_outlined, title: 'User not found'),
      AsyncError() => const EmptyView(icon: Icons.error_outline, title: 'Could not load this user'),
      _ => const LoadingView(),
    };
  }
}

class _UserForm extends ConsumerStatefulWidget {
  const _UserForm({super.key, required this.actor, required this.existing, required this.now});
  final AppUser actor;
  final AppUser? existing;
  final DateTime now;

  @override
  ConsumerState<_UserForm> createState() => _UserFormState();
}

class _UserFormState extends ConsumerState<_UserForm> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.existing?.fullName ?? '');
  late final _phone = TextEditingController(
      text: widget.existing == null ? '' : _national(widget.existing!.phoneNumber));
  late final _email = TextEditingController(text: widget.existing?.email ?? '');
  late final _staffId = TextEditingController();
  late final _position = TextEditingController(text: widget.existing?.position ?? '');
  late final _department = TextEditingController(text: widget.existing?.department ?? '');

  late PhoneCountry _country = _countryOf(widget.existing?.phoneNumber);
  late UserRole? _role = widget.existing?.role;
  late WorkerSpecialization? _specialization = widget.existing?.specialization;
  bool _active = true;
  bool _linkStaff = true;
  final Set<Permission> _grants = {};
  final Set<Permission> _denials = {};

  /// The generated temporary password (create only). Kept in memory just
  /// long enough to show and submit it.
  String? _password;
  bool _saving = false;
  String? _error;

  bool get _isCreate => widget.existing == null;

  static PhoneCountry _countryOf(String? e164) {
    if (e164 == null) return PhoneNumbers.uganda;
    for (final c in PhoneNumbers.countries) {
      if (e164.startsWith('+${c.dialCode}')) return c;
    }
    return PhoneNumbers.uganda;
  }

  static String _national(String e164) {
    final c = _countryOf(e164);
    return e164.substring(c.dialCode.length + 1);
  }

  @override
  void dispose() {
    for (final c in [_name, _phone, _email, _staffId, _position, _department]) {
      c.dispose();
    }
    super.dispose();
  }

  String? _optional(String text) => text.trim().isEmpty ? null : text.trim();

  Future<void> _save() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    final phone = PhoneNumbers.toE164(_phone.text, _country)!;
    final actions = ref.read(userAdminActionsProvider);

    if (_isCreate) {
      final role = _role;
      if (role == null) {
        setState(() => _error = 'Choose a role.');
        return;
      }
      final password = _password;
      if (password == null) {
        setState(() => _error = 'Generate a temporary password.');
        return;
      }
      final problems = PasswordPolicy.problems(password,
          phoneNumber: phone, staffId: _optional(_staffId.text.toUpperCase()), fullName: _name.text);
      if (problems.isNotEmpty) {
        // A generated password matched the person's details: make another.
        setState(() {
          _password = PasswordPolicy.generate();
          _error = 'Please use the new temporary password shown below.';
        });
        return;
      }
      setState(() => _saving = true);
      final result = await actions.createUser(NewUserRequest(
        fullName: _name.text.trim(),
        phoneNumber: phone,
        role: role,
        password: password,
        email: _optional(_email.text),
        specialization: role == UserRole.worker ? _specialization : null,
        position: _optional(_position.text),
        department: _optional(_department.text),
        active: _active,
        linkStaff: _linkStaff,
        staffId: _linkStaff ? _optional(_staffId.text.toUpperCase()) : null,
        permissions: _grants,
        deniedPermissions: _denials,
      ));
      if (!mounted) return;
      setState(() => _saving = false);
      if (result is Failure<CreatedUser>) {
        setState(() => _error = result.error.message);
        return;
      }
      final created = (result as Success<CreatedUser>).value;
      final name = _name.text.trim();
      // Last chance to copy it: the password is never retrievable again.
      await showTemporaryPasswordDialog(context, title: '$name was added', password: password);
      if (!mounted) return;
      AppSnackbar.success(context,
          '$name can now sign in with their phone number and the temporary password'
          '${created.staffId == null ? '' : ' (staff ID ${created.staffId})'}.');
      setState(() => _password = null);
      context.go(AppRoutes.userDetail(created.uid));
      return;
    }

    final user = widget.existing!;
    String? changed(String now, String? before) => now.trim() == (before ?? '') ? null : now.trim();
    final phoneChanged = phone != user.phoneNumber;
    if (phoneChanged) {
      final ok = await showConfirmDialog(
        context,
        title: 'Change sign-in phone number?',
        message: '${user.displayName} will sign in with ${PhoneNumbers.formatForDisplay(phone)} and their '
            'current password. They will be signed out now, and the old number will no longer work.',
        confirmLabel: 'Change number',
      );
      if (!ok || !mounted) return;
    }
    final update = ProfileUpdate(
      fullName: changed(_name.text, user.fullName),
      email: changed(_email.text, user.email),
      position: changed(_position.text, user.position),
      department: changed(_department.text, user.department),
      specialization: user.role == UserRole.worker && _specialization != user.specialization
          ? (_specialization?.key ?? '')
          : null,
    );
    if (update.isEmpty && !phoneChanged) {
      context.go(AppRoutes.userDetail(user.uid));
      return;
    }
    setState(() => _saving = true);
    if (phoneChanged) {
      final r = await actions.changePhone(user.uid, phone);
      if (r is Failure<void>) {
        if (!mounted) return;
        setState(() {
          _saving = false;
          _error = r.error.message;
        });
        return;
      }
    }
    final result = update.isEmpty ? const Success<void>(null) : await actions.updateProfile(user.uid, update);
    if (!mounted) return;
    setState(() => _saving = false);
    result.when(
      success: (_) {
        AppSnackbar.success(context,
            phoneChanged ? 'Saved. They now sign in with the new phone number.' : 'Profile saved.');
        context.go(AppRoutes.userDetail(user.uid));
      },
      failure: (f) => setState(() => _error = f.message),
    );
  }

  Future<void> _pickPhoto() async {
    final user = widget.existing!;
    final file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 800, imageQuality: 85);
    if (file == null || !mounted) return;
    final bytes = await file.readAsBytes();
    final type = file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    setState(() => _saving = true);
    final result = await ref.read(userAdminActionsProvider).setProfilePhoto(user, bytes: bytes, contentType: type);
    if (!mounted) return;
    setState(() => _saving = false);
    result.when(
      success: (_) => AppSnackbar.success(context, 'Profile photo updated.'),
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  Future<void> _addPermission({required bool deny}) async {
    final role = _role;
    if (role == null) {
      setState(() => _error = 'Choose a role first.');
      return;
    }
    final rolePerms = RolePermissions.forRole(role);
    final options = deny
        ? [
            for (final p in rolePerms)
              if (!_denials.contains(p) && AccessPolicy.canDeny(role, p)) p,
          ]
        : [
            for (final p in AccessPolicy.grantablePermissions(widget.actor, widget.now))
              if (!rolePerms.contains(p) && !_grants.contains(p)) p,
          ];
    options.sort((a, b) => a.index.compareTo(b.index));
    final picked = await showPermissionPicker(
      context,
      title: deny ? 'Deny a role permission' : 'Grant an extra permission',
      options: options,
    );
    if (picked == null) return;
    setState(() => deny ? _denials.add(picked) : _grants.add(picked));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final existing = widget.existing;
    final isSelf = existing?.uid == widget.actor.uid;
    final online = ref.watch(isOnlineProvider).value ?? true;
    final canManagePermissions = widget.actor.can(Permission.usersPermissionsManage, widget.now);

    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
        children: [
          Row(children: [
            IconButton(
              tooltip: 'Back',
              icon: const Icon(Icons.arrow_back),
              onPressed: () => context.go(existing == null ? AppRoutes.users : AppRoutes.userDetail(existing.uid)),
            ),
            Text(_isCreate ? 'Add user' : 'Edit profile', style: theme.textTheme.titleLarge),
          ]),
          if (!online) ...[
            const InlineError('You are offline. Adding or changing users needs an internet connection.'),
            const SizedBox(height: AppSpacing.sm),
          ],
          if (existing != null) ...[
            Center(
              child: Column(children: [
                UserAvatar(user: existing, radius: 40),
                TextButton.icon(
                  key: const Key('user-photo-button'),
                  onPressed: existing.staffId == null || _saving ? null : _pickPhoto,
                  icon: const Icon(Icons.photo_camera_outlined),
                  label: Text(existing.staffId == null ? 'Link a staff record to add a photo' : 'Change photo'),
                ),
              ]),
            ),
          ],
          const _Heading('Personal details'),
          TextFormField(
            key: const Key('user-name-field'),
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Full name'),
            validator: (v) {
              final value = v?.trim() ?? '';
              if (value.length < 2) return 'Enter the full name';
              if (value.length > 80) return 'The name is too long';
              return null;
            },
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(
              width: 116,
              child: DropdownButtonFormField<PhoneCountry>(
                initialValue: _country,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Code'),
                items: [
                  for (final c in PhoneNumbers.countries) DropdownMenuItem(value: c, child: Text(c.display)),
                ],
                onChanged: isSelf ? null : (c) => setState(() => _country = c ?? PhoneNumbers.uganda),
              ),
            ),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: TextFormField(
                key: const Key('user-phone-field'),
                controller: _phone,
                enabled: !isSelf,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: 'Phone number',
                  hintText: _country.example,
                  helperText: isSelf ? 'Another administrator must change your number' : null,
                ),
                validator: (v) => Validators.phone(v, country: _country),
              ),
            ),
          ]),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('user-email-field'),
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Email (optional)'),
            validator: Validators.email,
          ),

          const _Heading('Employment'),
          if (_isCreate) ...[
            SwitchListTile(
              key: const Key('user-staff-link-switch'),
              contentPadding: EdgeInsets.zero,
              value: _linkStaff,
              onChanged: (v) => setState(() => _linkStaff = v),
              title: const Text('Link to a staff record'),
              subtitle: const Text('Employees should have one. Shareholders may not.'),
            ),
            if (_linkStaff)
              TextFormField(
                key: const Key('user-staff-id-field'),
                controller: _staffId,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                  labelText: 'Staff ID (optional)',
                  helperText: 'Leave blank to assign the next RMX-STF number',
                ),
                validator: (v) {
                  final value = v?.trim().toUpperCase() ?? '';
                  if (value.isEmpty) return null;
                  return staffIdPattern.hasMatch(value) ? null : 'Use capital letters, digits and dashes, e.g. RMX-STF-0001';
                },
              ),
            const SizedBox(height: AppSpacing.sm),
          ],
          TextFormField(
            key: const Key('user-position-field'),
            controller: _position,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Position (optional)', hintText: 'e.g. Senior Detailer'),
            validator: (v) => (v?.trim().length ?? 0) > 60 ? 'Too long (60 characters maximum)' : null,
          ),
          const SizedBox(height: AppSpacing.sm),
          TextFormField(
            key: const Key('user-department-field'),
            controller: _department,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Department (optional)', hintText: 'e.g. Washing bay'),
            validator: (v) => (v?.trim().length ?? 0) > 60 ? 'Too long (60 characters maximum)' : null,
          ),

          if (_isCreate) ...[
            const _Heading('Access'),
            InkWell(
              key: const Key('user-role-field'),
              borderRadius: BorderRadius.circular(AppSpacing.radius),
              onTap: () async {
                final role = await showRolePicker(context,
                    current: _role, roles: AccessPolicy.assignableRoles(widget.actor));
                if (role != null) {
                  setState(() {
                    _role = role;
                    if (role != UserRole.worker) _specialization = null;
                    // Denials only make sense against the chosen role.
                    _denials.removeWhere((p) => !RolePermissions.forRole(role).contains(p));
                    _grants.removeWhere(RolePermissions.forRole(role).contains);
                  });
                }
              },
              child: InputDecorator(
                decoration: const InputDecoration(labelText: 'Role', suffixIcon: Icon(Icons.arrow_drop_down)),
                child: Text(_role?.label ?? 'Choose a role'),
              ),
            ),
          ],
          if ((_role ?? existing?.role) == UserRole.worker) ...[
            const SizedBox(height: AppSpacing.sm),
            DropdownButtonFormField<WorkerSpecialization?>(
              key: const Key('user-specialization-field'),
              initialValue: _specialization,
              decoration: const InputDecoration(labelText: 'Specialisation'),
              items: [
                const DropdownMenuItem(value: null, child: Text('Not set')),
                for (final s in WorkerSpecialization.values) DropdownMenuItem(value: s, child: Text(s.label)),
              ],
              onChanged: (s) => setState(() => _specialization = s),
            ),
          ],
          if (_isCreate) ...[
            SwitchListTile(
              key: const Key('user-active-switch'),
              contentPadding: EdgeInsets.zero,
              value: _active,
              onChanged: (v) => setState(() => _active = v),
              title: const Text('Account active'),
              subtitle: Text(_active ? 'Can sign in as soon as it is created' : 'Created but cannot sign in yet'),
            ),
            if (canManagePermissions) ...[
              _PermissionChips(
                title: 'Extra permissions',
                permissions: _grants,
                color: AppColors.success,
                onRemove: (p) => setState(() => _grants.remove(p)),
                onAdd: () => _addPermission(deny: false),
                addKey: const Key('add-grant-button'),
              ),
              _PermissionChips(
                title: 'Denied role permissions',
                permissions: _denials,
                color: AppColors.danger,
                onRemove: (p) => setState(() => _denials.remove(p)),
                onAdd: () => _addPermission(deny: true),
                addKey: const Key('add-denial-button'),
              ),
            ],
            Text(
              'Temporary access can be added from the user\'s permissions once the account exists.',
              style: theme.textTheme.bodySmall,
            ),
            const _Heading('Password'),
            Text(
              'Generate a temporary password for the first sign-in. The employee must replace it '
              'with their own password straight away.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.sm),
            if (_password != null) ...[
              TemporaryPasswordPanel(password: _password!),
              const SizedBox(height: AppSpacing.xs),
            ],
            OutlinedButton.icon(
              key: const Key('generate-password-button'),
              onPressed: _saving ? null : () => setState(() => _password = PasswordPolicy.generate()),
              icon: const Icon(Icons.password),
              label: Text(_password == null ? 'Generate secure password' : 'Generate a different password'),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          if (_error != null) ...[InlineError(_error!), const SizedBox(height: AppSpacing.sm)],
          FilledButton(
            key: const Key('user-save-button'),
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(_isCreate ? 'Create user' : 'Save changes'),
          ),
        ],
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: AppSpacing.lg, bottom: AppSpacing.sm),
        child: Text(text, style: Theme.of(context).textTheme.titleMedium),
      );
}

class _PermissionChips extends StatelessWidget {
  const _PermissionChips({
    required this.title,
    required this.permissions,
    required this.color,
    required this.onRemove,
    required this.onAdd,
    required this.addKey,
  });

  final String title;
  final Set<Permission> permissions;
  final Color color;
  final ValueChanged<Permission> onRemove;
  final VoidCallback onAdd;
  final Key addKey;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.sm),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(title, style: Theme.of(context).textTheme.labelLarge)),
            TextButton.icon(key: addKey, onPressed: onAdd, icon: const Icon(Icons.add, size: 18), label: const Text('Add')),
          ]),
          if (permissions.isEmpty)
            Text('None', style: Theme.of(context).textTheme.bodySmall)
          else
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              for (final p in permissions)
                InputChip(
                  label: Text(p.label),
                  side: BorderSide(color: color.withValues(alpha: 0.5)),
                  onDeleted: () => onRemove(p),
                ),
            ]),
        ]),
      );
}
