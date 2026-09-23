import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/after_hours.dart';
import '../../../models/app_user.dart';
import '../../../models/payment.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show allUsersProvider, currentUserProvider;
import '../application/after_hours_providers.dart';
import '../data/after_hours_api.dart';
import 'after_hours_widgets.dart';

// Forms for after-hours work. Each sends only what the person entered; the
// server validates it and calculates every total.

/// East Africa wall-clock date and time; returns the UTC instant.
Future<DateTime?> _pickDateTime(BuildContext context, DateTime initial) async {
  final eat = EastAfricaTime.toEat(initial);
  final day = DateTime(eat.year, eat.month, eat.day);
  final date = await showDatePicker(context: context, initialDate: day, firstDate: day.subtract(const Duration(days: 1)), lastDate: day.add(const Duration(days: 30)));
  if (date == null || !context.mounted) return null;
  final time = await showTimePicker(context: context, initialTime: TimeOfDay(hour: eat.hour, minute: eat.minute));
  if (time == null) return null;
  return EastAfricaTime.fromEatWallClock(date.year, date.month, date.day, time.hour, time.minute);
}

class _WhenField extends StatelessWidget {
  const _WhenField({required this.label, required this.value, required this.onChanged, this.fieldKey});
  final String label;
  final DateTime value;
  final ValueChanged<DateTime> onChanged;
  final Key? fieldKey;

  @override
  Widget build(BuildContext context) => InkWell(
        key: fieldKey,
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: () async {
          final v = await _pickDateTime(context, value);
          if (v != null) onChanged(v);
        },
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, suffixIcon: const Icon(Icons.edit_calendar_outlined)),
          child: Text(DateTimeFormatter.dateTime(value)),
        ),
      );
}

/// Pure client-side check before sending (the server checks again with its clock).
String? validateAuthorizationDraft({
  required String? staffUid,
  required DateTime startsAt,
  required DateTime expiresAt,
  required DateTime now,
  required Money? openingFloat,
  required String reason,
  required AfterHoursPolicy policy,
}) {
  if (staffUid == null) return 'Choose the worker.';
  if (startsAt.isBefore(now.subtract(const Duration(minutes: 5)))) return 'The start time cannot be in the past.';
  if (!expiresAt.isAfter(startsAt)) return 'The end time must be after the start time.';
  if (expiresAt.difference(startsAt) > Duration(hours: policy.maxAuthorizationHours)) {
    return 'An after-hours authorisation can last at most ${policy.maxAuthorizationHours} hours.';
  }
  if (openingFloat == null) return 'Enter the opening float in whole shillings (0 for none).';
  if (openingFloat > policy.maxOpeningFloat) return 'The opening float can be at most ${policy.maxOpeningFloat.format()}.';
  if (reason.trim().length < 3) return 'Enter a reason (at least 3 characters).';
  return null;
}

/// after_hours.approve: authorise a worker for after-hours work.
class AuthorizeSheet extends ConsumerStatefulWidget {
  const AuthorizeSheet({super.key});

  @override
  ConsumerState<AuthorizeSheet> createState() => _AuthorizeSheetState();
}

class _AuthorizeSheetState extends ConsumerState<AuthorizeSheet> {
  String? _staff;
  late DateTime _start = ref.read(clockProvider).value ?? DateTime.now();
  late DateTime _end = _start.add(const Duration(hours: 8));
  final Set<Permission> _permissions = {...afterHoursDefaultGrants};
  final _float = TextEditingController(text: '0');
  final _reason = TextEditingController();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _float.dispose();
    _reason.dispose();
    super.dispose();
  }

  Future<void> _submit(AfterHoursPolicy policy) async {
    final now = ref.read(clockProvider).value ?? DateTime.now();
    final float = MoneyField.parse(_float.text, allowZero: true);
    final error = validateAuthorizationDraft(
        staffUid: _staff, startsAt: _start, expiresAt: _end, now: now, openingFloat: float, reason: _reason.text, policy: policy);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final r = await ref.read(afterHoursActionsProvider).authorize(
          AuthorizationDraft(
            staffUid: _staff!,
            startsAt: _start,
            expiresAt: _end,
            reason: _reason.text.trim(),
            permissions: [for (final p in afterHoursGrantable) if (_permissions.contains(p)) p],
            openingFloat: float!,
          ),
          requestId: _requestId,
        );
    if (!mounted) return;
    setState(() => _saving = false);
    r.when(
      success: (_) {
        AppSnackbar.success(context, 'After-hours work authorised.');
        Navigator.of(context).pop();
      },
      failure: (f) => setState(() => _error = f.message),
    );
  }

  @override
  Widget build(BuildContext context) {
    final policy = ref.watch(afterHoursPolicyProvider).value ?? const AfterHoursPolicy();
    final me = ref.watch(currentUserProvider)?.uid;
    final eligible = (ref.watch(allUsersProvider).value ?? const <AppUser>[])
        .where((u) => u.active && u.uid != me && u.permanentPermissions().contains(Permission.afterHoursRequest))
        .toList()
      ..sort((a, b) => a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()));
    return FormSheet(
      title: 'Authorise after-hours work',
      subtitle: 'The worker gets these permissions only between the times below (East Africa Time). '
          'Payroll, users, settings, finance set-up, reversals, prices and discounts are never included.',
      submitLabel: 'Authorise',
      submitKey: const Key('submit-authorization'),
      saving: _saving,
      error: _error,
      onSubmit: () => _submit(policy),
      children: [
        DropdownButtonFormField<String>(
          key: const Key('authorization-staff'),
          initialValue: eligible.any((u) => u.uid == _staff) ? _staff : null,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Worker', helperText: 'Only people eligible for after-hours work (after_hours.request)'),
          items: [
            for (final u in eligible)
              DropdownMenuItem(value: u.uid, child: Text([u.displayName, u.role.label, ?u.staffId].join(' · '), overflow: TextOverflow.ellipsis)),
          ],
          onChanged: (v) => setState(() => _staff = v),
        ),
        Row(children: [
          Expanded(child: _WhenField(fieldKey: const Key('authorization-start'), label: 'Starts', value: _start, onChanged: (v) => setState(() => _start = v))),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: _WhenField(fieldKey: const Key('authorization-end'), label: 'Ends', value: _end, onChanged: (v) => setState(() => _end = v))),
        ]),
        Wrap(spacing: AppSpacing.xs, children: [
          for (final hours in {4, 8, 12, policy.maxAuthorizationHours})
            if (hours <= policy.maxAuthorizationHours)
              ActionChip(
                key: Key('authorization-hours-$hours'),
                label: Text('$hours hours'),
                onPressed: () => setState(() => _end = _start.add(Duration(hours: hours))),
              ),
        ]),
        Text('Permissions (at most ${policy.maxAuthorizationHours} hours)', style: Theme.of(context).textTheme.titleSmall),
        for (final p in afterHoursGrantable)
          CheckboxListTile(
            key: Key('authorization-perm-${p.key}'),
            dense: true,
            contentPadding: EdgeInsets.zero,
            value: _permissions.contains(p),
            title: Text(p.label),
            // Running a session is what an authorisation is.
            onChanged: p == Permission.afterHoursOperate
                ? null
                : (v) => setState(() => v == true ? _permissions.add(p) : _permissions.remove(p)),
          ),
        MoneyField(
          controller: _float,
          label: 'Opening float (cash given to the worker)',
          fieldKey: const Key('authorization-float'),
          allowZero: true,
          onChanged: (_) => setState(() {}),
        ),
        TextField(
          key: const Key('authorization-reason'),
          controller: _reason,
          maxLength: 500,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(labelText: 'Reason', hintText: 'e.g. Evening shift cover'),
        ),
      ],
    );
  }
}

/// The worker states what they are handing over. The expected cash is shown
/// read-only: it is the server's figure and can never be edited.
class SubmitHandoverSheet extends ConsumerStatefulWidget {
  const SubmitHandoverSheet({super.key, required this.handover});
  final CashHandover handover;

  @override
  ConsumerState<SubmitHandoverSheet> createState() => _SubmitHandoverSheetState();
}

class _SubmitHandoverSheetState extends ConsumerState<SubmitHandoverSheet> {
  final _declared = TextEditingController();
  final _notes = TextEditingController();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _declared.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final h = widget.handover;
    final declared = MoneyField.parse(_declared.text, allowZero: true);
    return FormSheet(
      title: 'Hand over ${h.handoverNumber}',
      subtitle: 'Count the cash and enter what you are handing over. A manager counts it again and records what was received.',
      submitLabel: 'Submit handover',
      submitKey: const Key('submit-handover'),
      saving: _saving,
      error: _error,
      onSubmit: declared == null
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(afterHoursActionsProvider).submitHandover(h.handoverId,
                  declared: declared, requestId: _requestId, notes: _notes.text.trim().isEmpty ? null : _notes.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Handover submitted.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        MoneyLine('Expected cash (set by the system)', h.expectedCash, emphasis: true, valueKey: const Key('handover-expected')),
        MoneyField(
          controller: _declared,
          label: 'Cash you are handing over',
          fieldKey: const Key('handover-declared'),
          allowZero: true,
          onChanged: (_) => setState(() {}),
        ),
        if (declared != null && declared != h.expectedCash)
          Text('That is ${describeDifference(declared - h.expectedCash)} against the expected cash.',
              key: const Key('handover-declared-difference'), style: TextStyle(color: differenceColor(declared - h.expectedCash))),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes (optional)')),
      ],
    );
  }
}

/// cash_handover.approve: the manager's count. A difference needs an
/// explanation and opens a discrepancy; expected and actual are never edited.
class ReceiveHandoverSheet extends ConsumerStatefulWidget {
  const ReceiveHandoverSheet({super.key, required this.handover});
  final CashHandover handover;

  @override
  ConsumerState<ReceiveHandoverSheet> createState() => _ReceiveHandoverSheetState();
}

class _ReceiveHandoverSheetState extends ConsumerState<ReceiveHandoverSheet> {
  final _actual = TextEditingController();
  final _explanation = TextEditingController();
  final _notes = TextEditingController();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _actual.dispose();
    _explanation.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final h = widget.handover;
    final actual = MoneyField.parse(_actual.text, allowZero: true);
    final preview = actual == null ? null : previewDifference(h.expectedCash, actual);
    final needsExplanation = preview != null && !preview.difference.isZero;
    final ready = actual != null && (!needsExplanation || _explanation.text.trim().length >= 3);
    return FormSheet(
      title: 'Receive ${h.handoverNumber}',
      subtitle: 'Count the cash from ${h.staffName}. It is already in Cash at Hand: receiving it posts nothing new.',
      submitLabel: needsExplanation ? 'Record with discrepancy' : 'Record as received',
      submitKey: const Key('submit-receive'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(afterHoursActionsProvider).receiveHandover(h.handoverId,
                  actual: actual,
                  requestId: _requestId,
                  explanation: _explanation.text.trim().isEmpty ? null : _explanation.text.trim(),
                  notes: _notes.text.trim().isEmpty ? null : _notes.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (v) {
                  AppSnackbar.success(
                      context, v.discrepancyNumber == null ? 'Handover received.' : 'Handover recorded. Discrepancy ${v.discrepancyNumber} opened.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        MoneyLine('Expected cash', h.expectedCash, emphasis: true, valueKey: const Key('receive-expected')),
        if (h.declaredAmount != null) MoneyLine('Worker says', h.declaredAmount!),
        MoneyField(controller: _actual, label: 'Cash counted', fieldKey: const Key('receive-actual'), allowZero: true, onChanged: (_) => setState(() {})),
        if (preview != null)
          Text(describeDifference(preview.difference),
              key: const Key('receive-difference'), style: TextStyle(color: differenceColor(preview.difference), fontWeight: FontWeight.w600)),
        if (needsExplanation)
          TextField(
            key: const Key('receive-explanation'),
            controller: _explanation,
            maxLength: 500,
            maxLines: 3,
            minLines: 1,
            decoration: const InputDecoration(labelText: 'Explanation (required)'),
            onChanged: (_) => setState(() {}),
          ),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes (optional)')),
      ],
    );
  }
}

/// after_hours.discrepancy.review: close a discrepancy. Nothing is charged
/// automatically: "report as a loss" only opens a Phase 6 loss incident, whose
/// recovery needs its own approval.
class ResolveDiscrepancySheet extends ConsumerStatefulWidget {
  const ResolveDiscrepancySheet({super.key, required this.discrepancy});
  final CashDiscrepancy discrepancy;

  @override
  ConsumerState<ResolveDiscrepancySheet> createState() => _ResolveDiscrepancySheetState();
}

class _ResolveDiscrepancySheetState extends ConsumerState<ResolveDiscrepancySheet> {
  DiscrepancyOutcome _outcome = DiscrepancyOutcome.resolved;
  bool _recover = false;
  bool _adjust = false;
  final _resolution = TextEditingController();
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _resolution.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.discrepancy;
    final shortage = d.difference.isNegative;
    final canRecover = shortage && _outcome == DiscrepancyOutcome.resolved && canDo(ref, Permission.lossesCreate);
    final canAdjust = canDo(ref, Permission.financeAdjust);
    return FormSheet(
      title: 'Close ${d.discrepancyNumber}',
      subtitle: 'Expected ${d.expectedCash.format()}, counted ${d.actualAmount.format()}: ${describeDifference(d.difference)}. '
          'These figures stay as recorded.',
      submitLabel: _outcome == DiscrepancyOutcome.resolved ? 'Resolve' : 'Waive',
      submitKey: const Key('submit-resolve'),
      saving: _saving,
      error: _error,
      onSubmit: _resolution.text.trim().length < 3
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(afterHoursActionsProvider).resolveDiscrepancy(d.discrepancyId,
                  outcome: _outcome,
                  resolution: _resolution.text.trim(),
                  requestId: _requestId,
                  recoverFromWorker: canRecover && _recover,
                  postAdjustment: canAdjust && _adjust);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Discrepancy closed.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        SegmentedButton<DiscrepancyOutcome>(
          key: const Key('resolve-outcome'),
          segments: const [
            ButtonSegment(value: DiscrepancyOutcome.resolved, label: Text('Resolved')),
            ButtonSegment(value: DiscrepancyOutcome.waived, label: Text('Waived')),
          ],
          selected: {_outcome},
          onSelectionChanged: (s) => setState(() => _outcome = s.first),
        ),
        TextField(
          key: const Key('resolve-resolution'),
          controller: _resolution,
          maxLength: 500,
          maxLines: 3,
          minLines: 1,
          decoration: const InputDecoration(labelText: 'Resolution (required)'),
          onChanged: (_) => setState(() {}),
        ),
        if (canRecover)
          CheckboxListTile(
            key: const Key('resolve-recover'),
            contentPadding: EdgeInsets.zero,
            value: _recover,
            title: const Text('Report the shortage as a loss incident'),
            subtitle: const Text('Opens a loss incident for approval. No salary deduction is made.'),
            onChanged: (v) => setState(() => _recover = v ?? false),
          ),
        if (canAdjust)
          CheckboxListTile(
            key: const Key('resolve-adjust'),
            contentPadding: EdgeInsets.zero,
            value: _adjust,
            title: const Text('Post an adjustment to Cash at Hand'),
            subtitle: Text('Makes the recorded balance match the counted cash (${describeDifference(d.difference)}).'),
            onChanged: (v) => setState(() => _adjust = v ?? false),
          ),
      ],
    );
  }
}

/// settings.manage: payment methods allowed after hours, longest window, largest float.
class AfterHoursPolicySheet extends ConsumerStatefulWidget {
  const AfterHoursPolicySheet({super.key, required this.policy});
  final AfterHoursPolicy policy;

  @override
  ConsumerState<AfterHoursPolicySheet> createState() => _AfterHoursPolicySheetState();
}

class _AfterHoursPolicySheetState extends ConsumerState<AfterHoursPolicySheet> {
  late final Set<PaymentMethod> _methods = {...widget.policy.allowedPaymentMethods};
  late final _hours = TextEditingController(text: '${widget.policy.maxAuthorizationHours}');
  late final _float = TextEditingController(text: widget.policy.maxOpeningFloat.formatAmount());
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _hours.dispose();
    _float.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hours = int.tryParse(_hours.text.trim());
    final float = MoneyField.parse(_float.text, allowZero: true);
    final ready = _methods.isNotEmpty && hours != null && hours >= 1 && hours <= 24 && float != null && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'After-hours policy',
      submitLabel: 'Save',
      submitKey: const Key('submit-after-hours-policy'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(afterHoursActionsProvider).updatePolicy({
                'allowedPaymentMethods': [for (final m in PaymentMethod.values) if (_methods.contains(m)) m.key],
                'maxAuthorizationHours': hours,
                'maxOpeningFloatUgx': float.ugx,
              }, reason: _reason.text.trim());
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Policy saved.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        Text('Payment methods allowed after hours', style: Theme.of(context).textTheme.titleSmall),
        Wrap(spacing: AppSpacing.xs, children: [
          for (final m in PaymentMethod.values)
            FilterChip(
              key: Key('policy-method-${m.key}'),
              label: Text(m.label),
              selected: _methods.contains(m),
              onSelected: (v) => setState(() => v ? _methods.add(m) : _methods.remove(m)),
            ),
        ]),
        TextField(
          key: const Key('policy-hours'),
          controller: _hours,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Longest authorisation (hours, 1–24)'),
          onChanged: (_) => setState(() {}),
        ),
        MoneyField(controller: _float, label: 'Largest opening float', fieldKey: const Key('policy-float'), allowZero: true, onChanged: (_) => setState(() {})),
        TextField(
          key: const Key('policy-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: const InputDecoration(labelText: 'Reason'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}
