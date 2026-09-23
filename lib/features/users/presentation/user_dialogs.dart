import 'package:flutter/material.dart';

import '../../../core/auth/access_policy.dart';
import '../../../core/auth/permissions.dart';
import '../../../core/auth/user_role.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';

/// Confirmation dialog that also collects a reason for the audit trail.
/// Returns the trimmed reason (possibly empty when optional), or null if the
/// person cancelled.
Future<String?> showReasonDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  bool destructive = false,
  bool reasonRequired = true,
  String reasonLabel = 'Reason',
}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _ReasonDialog(
      title: title,
      message: message,
      confirmLabel: confirmLabel,
      destructive: destructive,
      reasonRequired: reasonRequired,
      reasonLabel: reasonLabel,
    ),
  );
}

class _ReasonDialog extends StatefulWidget {
  const _ReasonDialog({
    required this.title,
    required this.message,
    required this.confirmLabel,
    required this.destructive,
    required this.reasonRequired,
    required this.reasonLabel,
  });

  final String title;
  final String message;
  final String confirmLabel;
  final bool destructive;
  final bool reasonRequired;
  final String reasonLabel;

  @override
  State<_ReasonDialog> createState() => _ReasonDialogState();
}

class _ReasonDialogState extends State<_ReasonDialog> {
  final _controller = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final reason = _controller.text.trim();
    if (widget.reasonRequired && reason.length < 3) {
      setState(() => _error = 'Enter a reason (at least 3 characters).');
      return;
    }
    Navigator.of(context).pop(reason);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.message),
          const SizedBox(height: AppSpacing.md),
          TextField(
            key: const Key('reason-field'),
            controller: _controller,
            maxLength: 500,
            maxLines: 3,
            minLines: 1,
            textCapitalization: TextCapitalization.sentences,
            decoration: InputDecoration(
              labelText: widget.reasonRequired ? widget.reasonLabel : '${widget.reasonLabel} (optional)',
              errorText: _error,
            ),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          key: const Key('confirm-button'),
          style: FilledButton.styleFrom(
            minimumSize: const Size(0, 44),
            backgroundColor: widget.destructive ? scheme.error : null,
            foregroundColor: widget.destructive ? scheme.onError : null,
          ),
          onPressed: _submit,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}

/// Bottom sheet listing the roles the actor may assign.
Future<UserRole?> showRolePicker(
  BuildContext context, {
  required UserRole? current,
  required List<UserRole> roles,
}) {
  return showModalBottomSheet<UserRole>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheet) => SafeArea(
      child: ListView(shrinkWrap: true, children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.xs),
          child: Text('Choose a role', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        ),
        for (final r in roles)
          ListTile(
            key: Key('role-option-${r.key}'),
            leading: Icon(r == current ? Icons.radio_button_checked : Icons.radio_button_off),
            title: Text(r.label),
            subtitle: Text(roleDescription(r)),
            enabled: r != current,
            onTap: () => Navigator.of(sheet).pop(r),
          ),
      ]),
    ),
  );
}

String roleDescription(UserRole role) => switch (role) {
      UserRole.admin => 'Full administration, including users and settings',
      UserRole.manager => 'Operations, staff, payments, expenses and approvals',
      UserRole.cashier => 'Invoices, payments, receipts, customers and vehicles',
      UserRole.worker => 'Own jobs, attendance and allowances',
      UserRole.auditor => 'Read-only access to records and audit logs',
      UserRole.shareholder => 'Business and financial summaries',
    };

/// Searchable, grouped permission list. Returns the chosen permission.
Future<Permission?> showPermissionPicker(
  BuildContext context, {
  required String title,
  required List<Permission> options,
}) {
  return showModalBottomSheet<Permission>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _PermissionPicker(title: title, options: options),
  );
}

class _PermissionPicker extends StatefulWidget {
  const _PermissionPicker({required this.title, required this.options});
  final String title;
  final List<Permission> options;

  @override
  State<_PermissionPicker> createState() => _PermissionPickerState();
}

class _PermissionPickerState extends State<_PermissionPicker> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final q = _query.toLowerCase();
    final visible = widget.options
        .where((p) => q.isEmpty || p.label.toLowerCase().contains(q) || p.key.contains(q))
        .toList();
    final groups = <PermissionGroup, List<Permission>>{};
    for (final p in visible) {
      groups.putIfAbsent(p.group, () => []).add(p);
    }
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.75,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.xs),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: AppSpacing.xs),
              TextField(
                key: const Key('permission-search'),
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search permissions'),
                onChanged: (v) => setState(() => _query = v),
              ),
            ]),
          ),
          Expanded(
            child: visible.isEmpty
                ? const EmptyView(title: 'No permissions available', icon: Icons.lock_outline)
                : ListView(children: [
                    for (final entry in groups.entries) ...[
                      Padding(
                        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 0),
                        child: Text(entry.key.label, style: Theme.of(context).textTheme.labelLarge),
                      ),
                      for (final p in entry.value)
                        ListTile(
                          key: Key('permission-option-${p.key}'),
                          dense: true,
                          title: Text(p.label),
                          subtitle: Text(p.key),
                          onTap: () => Navigator.of(context).pop(p),
                        ),
                    ],
                  ]),
          ),
        ]),
      ),
    );
  }
}

/// What the temporary-access sheet returns.
class TemporaryGrantDraft {
  const TemporaryGrantDraft({
    required this.permission,
    required this.startsAt,
    required this.expiresAt,
    required this.reason,
  });
  final Permission permission;
  final DateTime startsAt;
  final DateTime expiresAt;
  final String reason;
}

Future<TemporaryGrantDraft?> showTemporaryGrantSheet(
  BuildContext context, {
  required List<Permission> options,
  required DateTime now,
}) {
  return showModalBottomSheet<TemporaryGrantDraft>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: _TemporaryGrantSheet(options: options, now: now),
    ),
  );
}

class _TemporaryGrantSheet extends StatefulWidget {
  const _TemporaryGrantSheet({required this.options, required this.now});
  final List<Permission> options;
  final DateTime now;

  @override
  State<_TemporaryGrantSheet> createState() => _TemporaryGrantSheetState();
}

class _TemporaryGrantSheetState extends State<_TemporaryGrantSheet> {
  Permission? _permission;
  late DateTime _start = widget.now;
  late DateTime _end = widget.now.add(const Duration(hours: 4));
  final _reason = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<DateTime?> _pick(DateTime initial) async {
    final eat = EastAfricaTime.toEat(initial);
    final date = await showDatePicker(
      context: context,
      initialDate: DateTime(eat.year, eat.month, eat.day),
      firstDate: DateTime(eat.year, eat.month, eat.day).subtract(const Duration(days: 1)),
      lastDate: DateTime(eat.year, eat.month, eat.day).add(const Duration(days: 60)),
    );
    if (date == null || !mounted) return null;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: eat.hour, minute: eat.minute),
    );
    if (time == null) return null;
    // Chosen as East Africa wall-clock time, whatever the handset's zone.
    return EastAfricaTime.fromEatWallClock(date.year, date.month, date.day, time.hour, time.minute);
  }

  void _submit() {
    final permission = _permission;
    final reason = _reason.text.trim();
    // Checked again on the server against its own clock.
    final error = permission == null
        ? 'Choose a permission.'
        : AccessPolicy.validateTemporaryWindow(_start, _end, widget.now) ??
            (reason.length < 3 ? 'Enter a reason (at least 3 characters).' : null);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    Navigator.of(context).pop(TemporaryGrantDraft(
      permission: permission!,
      startsAt: _start,
      expiresAt: _end,
      reason: reason,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Grant temporary access', style: theme.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.xxs),
          Text('The permission switches on and off automatically at the times below (East Africa Time).',
              style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.md),
          OutlinedButton.icon(
            key: const Key('temp-permission-button'),
            icon: const Icon(Icons.key_outlined),
            label: Text(_permission?.label ?? 'Choose permission'),
            onPressed: () async {
              final p = await showPermissionPicker(context, title: 'Temporary permission', options: widget.options);
              if (p != null) setState(() => _permission = p);
            },
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(children: [
            Expanded(
              child: _TimeTile(
                key: const Key('temp-start'),
                label: 'Starts',
                value: _start,
                onTap: () async {
                  final v = await _pick(_start);
                  if (v != null) setState(() => _start = v);
                },
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: _TimeTile(
                key: const Key('temp-end'),
                label: 'Ends',
                value: _end,
                onTap: () async {
                  final v = await _pick(_end);
                  if (v != null) setState(() => _end = v);
                },
              ),
            ),
          ]),
          const SizedBox(height: AppSpacing.xs),
          Wrap(spacing: AppSpacing.xs, children: [
            for (final hours in [2, 4, 8, 24])
              ActionChip(
                label: Text(hours == 24 ? '1 day' : '$hours hours'),
                onPressed: () => setState(() => _end = _start.add(Duration(hours: hours))),
              ),
          ]),
          const SizedBox(height: AppSpacing.sm),
          TextField(
            key: const Key('temp-reason-field'),
            controller: _reason,
            maxLength: 500,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(labelText: 'Reason', hintText: 'e.g. Covering evening payments'),
          ),
          if (_error != null) ...[InlineError(_error!), const SizedBox(height: AppSpacing.sm)],
          FilledButton(key: const Key('temp-grant-submit'), onPressed: _submit, child: const Text('Grant access')),
        ]),
      ),
    );
  }
}

class _TimeTile extends StatelessWidget {
  const _TimeTile({super.key, required this.label, required this.value, required this.onTap});
  final String label;
  final DateTime value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, suffixIcon: const Icon(Icons.edit_calendar_outlined)),
          child: Text(DateTimeFormatter.dateTime(value)),
        ),
      );
}
