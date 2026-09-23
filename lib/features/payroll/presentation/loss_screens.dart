import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/constants/storage_paths.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/payroll.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/workforce_providers.dart';
import 'workforce_widgets.dart';

/// Loss incidents. Reporting one never deducts anything: a recovery exists
/// only after a decision and a schedule.
class LossesScreen extends ConsumerStatefulWidget {
  const LossesScreen({super.key});

  @override
  ConsumerState<LossesScreen> createState() => _LossesScreenState();
}

class _LossesScreenState extends ConsumerState<LossesScreen> {
  LossStatus? _status;

  @override
  Widget build(BuildContext context) => Scaffold(
        floatingActionButton: canDo(ref, Permission.lossesCreate)
            ? FloatingActionButton.extended(
                key: const Key('report-loss-button'),
                onPressed: () => showFormSheet<void>(context, const ReportLossSheet()),
                icon: const Icon(Icons.add),
                label: const Text('Report loss'),
              )
            : null,
        body: Column(children: [
          FilterChips<LossStatus?>(
            values: const [null, ...LossStatus.values],
            selected: _status,
            label: (s) => s?.label ?? 'All',
            keyPrefix: 'loss-status',
            onSelected: (s) => setState(() => _status = s),
          ),
          Expanded(
            child: switch (ref.watch(lossesProvider(_status))) {
              AsyncData(:final value) when value.isEmpty => const EmptyView(icon: Icons.report_problem_outlined, title: 'No loss incidents'),
              AsyncData(:final value) => ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
                  MoneyLine('Outstanding recoveries', Money.sum(value.map((l) => l.outstanding)), valueKey: const Key('losses-outstanding')),
                  for (final l in value)
                    Card(
                      key: Key('loss-${l.incidentId}'),
                      child: ListTile(
                        onTap: () => context.go(AppRoutes.lossDetail(l.incidentId)),
                        title: Row(children: [
                          Expanded(child: Text('${l.lossNumber} · ${l.type.label}', overflow: TextOverflow.ellipsis)),
                          Text(l.amount.format(), style: Theme.of(context).textTheme.titleSmall),
                        ]),
                        subtitle: Wrap(spacing: AppSpacing.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
                          Text([l.staffName ?? 'No staff member', if (l.outstanding.isPositive) 'outstanding ${l.outstanding.format()}'].join(' · ')),
                          LossStatusChip(l.status),
                        ]),
                      ),
                    ),
                ]),
              AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
              _ => const LoadingView(),
            },
          ),
        ]),
      );
}

class LossDetailScreen extends ConsumerWidget {
  const LossDetailScreen({super.key, required this.incidentId});
  final String incidentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(currentUserProvider)?.uid;
    final actions = ref.read(workforceActionsProvider);
    return switch (ref.watch(lossProvider(incidentId))) {
      AsyncData(value: final LossIncident l) => () {
          final own = l.staffUid == me;
          return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
            ScreenHeader(l.lossNumber, subtitle: l.type.label, onBack: () => context.go(AppRoutes.losses)),
            Align(alignment: Alignment.centerLeft, child: LossStatusChip(l.status)),
            SectionCard(title: l.description, icon: Icons.report_problem_outlined, children: [
              MoneyLine('Loss', l.amount, emphasis: true),
              InfoRow('Staff member', l.staffName ?? 'None linked'),
              if (l.incidentDate != null) InfoRow('Date', DateTimeFormatter.date(l.incidentDate!)),
              InfoRow('Reported by', l.reportedByName),
              InfoRow('Evidence', l.attachmentPath == null ? null : 'Attached'),
              InfoRow('Notes', l.notes),
            ]),
            SectionCard(title: 'Decision and recovery', icon: Icons.gavel_outlined, children: [
              if (l.reviewedByName != null) InfoRow('Reviewed', [?l.reviewedByName, ?l.reviewNotes].join(' · ')),
              InfoRow('Decided by', l.approvedByName),
              if (l.rejectionReason != null) InfoRow('Rejected', l.rejectionReason),
              MoneyLine('Approved recovery', l.approvedRecovery),
              MoneyLine('Recovered', l.recovered),
              MoneyLine('Outstanding', l.outstanding, emphasis: true, valueKey: const Key('loss-outstanding')),
              InfoRow('Reason', l.recoveryReason),
              if (l.deductionNumber != null)
                InfoRow('Schedule', l.deductionNumber,
                    valueWidget: canDo(ref, Permission.payrollView) || canDo(ref, Permission.salaryView)
                        ? InkWell(onTap: () => context.go(AppRoutes.deductionDetail(l.deductionId!)), child: Text(l.deductionNumber!))
                        : null),
              if (l.cancelReason != null) InfoRow('Cancelled', '${l.cancelReason} (outstanding written off: ${l.cancelledOutstanding.format()})'),
            ]),
            const SizedBox(height: AppSpacing.sm),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              if (l.status == LossStatus.reported && !own && canDo(ref, Permission.lossesReview))
                OutlinedButton(
                  key: const Key('review-loss-button'),
                  onPressed: () async {
                    final notes = await showReasonDialog(context,
                        title: 'Start the review of ${l.lossNumber}?', message: 'Record what is being checked.', confirmLabel: 'Start review',
                        reasonRequired: false, reasonLabel: 'Notes');
                    if (notes == null || !context.mounted) return;
                    final r = await actions.reviewLoss(l.incidentId, notes: notes.isEmpty ? null : notes);
                    if (context.mounted) reportResult(context, r, 'Review started.');
                  },
                  child: const Text('Start review'),
                ),
              if (l.status.isOpen && !own && canDo(ref, Permission.lossesApprove))
                FilledButton(
                  key: const Key('decide-loss-button'),
                  onPressed: () => showFormSheet<void>(context, DecideLossSheet(incident: l)),
                  child: const Text('Decide'),
                ),
              if (l.canSchedule && !own && l.staffUid != null && canDo(ref, Permission.lossesSchedule))
                FilledButton(
                  key: const Key('schedule-recovery-button'),
                  onPressed: () => showFormSheet<void>(context, ScheduleRecoverySheet(incident: l)),
                  child: const Text('Schedule recovery'),
                ),
              if (l.canCancel && canDo(ref, Permission.lossesAdjust))
                TextButton(
                  key: const Key('cancel-loss-button'),
                  onPressed: () async {
                    final reason = await showReasonDialog(context,
                        title: 'Cancel ${l.lossNumber}?',
                        message: 'Any schedule stops; nothing more is recovered. What was recovered stays recorded.',
                        confirmLabel: 'Cancel incident',
                        destructive: true);
                    if (reason == null || !context.mounted) return;
                    final r = await actions.cancelLoss(l.incidentId, reason: reason);
                    if (context.mounted) reportResult(context, r, 'Incident cancelled.');
                  },
                  child: const Text('Cancel incident'),
                ),
            ]),
          ]);
        }(),
      AsyncData() => const EmptyView(icon: Icons.report_problem_outlined, title: 'Incident not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class ReportLossSheet extends ConsumerStatefulWidget {
  const ReportLossSheet({super.key});

  @override
  ConsumerState<ReportLossSheet> createState() => _ReportLossSheetState();
}

class _ReportLossSheetState extends ConsumerState<ReportLossSheet> {
  LossType _type = LossType.damagedEquipment;
  String? _staff;
  final _amount = TextEditingController();
  final _description = TextEditingController();
  final _notes = TextEditingController();
  DateTime _date = DateTime.now();
  String? _attachment;
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_amount, _description, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final amount = MoneyField.parse(_amount.text);
    final ready = amount != null && _description.text.trim().isNotEmpty;
    return FormSheet(
      title: 'Report a loss',
      subtitle: 'Reporting records the incident only. Nobody is charged unless an approver decides so.',
      submitLabel: 'Report',
      submitKey: const Key('submit-loss'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).reportLoss(
                    type: _type, amount: amount, description: _description.text.trim(), incidentDate: _date, requestId: _requestId,
                    staffUid: _staff, notes: _notes.text.trim().isEmpty ? null : _notes.text.trim(), attachmentPath: _attachment);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Loss incident reported.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        DropdownButtonFormField<LossType>(
          key: const Key('loss-type'),
          initialValue: _type,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Type'),
          items: [for (final t in LossType.values) DropdownMenuItem(value: t, child: Text(t.label))],
          onChanged: (v) => setState(() => _type = v ?? _type),
        ),
        StaffDropdown(fieldKey: const Key('loss-staff'), label: 'Staff member involved (optional)', value: _staff, onChanged: (v) => setState(() => _staff = v)),
        MoneyField(controller: _amount, label: 'Loss amount', fieldKey: const Key('loss-amount'), onChanged: (_) => setState(() {})),
        DateField(label: 'Date', value: _date, onChanged: (d) => setState(() => _date = d)),
        TextField(key: const Key('loss-description'), controller: _description, maxLength: 1000, maxLines: 3, minLines: 1,
            decoration: const InputDecoration(labelText: 'What happened'), onChanged: (_) => setState(() {})),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes')),
        PayrollEvidenceField(kind: PayrollUploadKind.losses, onChanged: (p) => _attachment = p),
      ],
    );
  }
}

class DecideLossSheet extends ConsumerStatefulWidget {
  const DecideLossSheet({super.key, required this.incident});
  final LossIncident incident;

  @override
  ConsumerState<DecideLossSheet> createState() => _DecideLossSheetState();
}

class _DecideLossSheetState extends ConsumerState<DecideLossSheet> {
  bool _approve = true;
  final _recovery = TextEditingController();
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _recovery.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = widget.incident;
    final recovery = _recovery.text.trim().isEmpty ? Money.zero : MoneyField.parse(_recovery.text, allowZero: true);
    final recoveryError = !_approve
        ? null
        : recovery == null
            ? 'Whole shillings'
            : recovery > l.amount
                ? 'Cannot exceed the loss (${l.amount.format()})'
                : recovery.isPositive && l.staffUid == null
                    ? 'No staff member is linked'
                    : null;
    final ready = recoveryError == null && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Decide ${l.lossNumber}',
      subtitle: 'Loss ${l.amount.format()}${l.staffName == null ? '' : ' · ${l.staffName}'}. Enter 0 if the business absorbs it.',
      submitLabel: _approve ? 'Approve' : 'Reject',
      submitKey: const Key('submit-loss-decision'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).decideLoss(l.incidentId,
                  approve: _approve, reason: _reason.text.trim(), recovery: _approve ? recovery : null);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        SegmentedButton<bool>(
          segments: const [ButtonSegment(value: true, label: Text('Approve')), ButtonSegment(value: false, label: Text('Reject'))],
          selected: {_approve},
          onSelectionChanged: (s) => setState(() => _approve = s.first),
        ),
        if (_approve)
          MoneyField(
            controller: _recovery,
            allowZero: true,
            label: 'Amount the staff member repays',
            fieldKey: const Key('loss-recovery'),
            errorText: recoveryError,
            onChanged: (_) => setState(() {}),
          ),
        TextField(key: const Key('loss-reason'), controller: _reason, maxLength: 500, decoration: const InputDecoration(labelText: 'Reason / findings'), onChanged: (_) => setState(() {})),
      ],
    );
  }
}

class ScheduleRecoverySheet extends ConsumerStatefulWidget {
  const ScheduleRecoverySheet({super.key, required this.incident});
  final LossIncident incident;

  @override
  ConsumerState<ScheduleRecoverySheet> createState() => _ScheduleRecoverySheetState();
}

class _ScheduleRecoverySheetState extends ConsumerState<ScheduleRecoverySheet> {
  final _instalment = TextEditingController();
  DateTime _start = DateTime.now();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _instalment.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = widget.incident;
    final instalment = MoneyField.parse(_instalment.text);
    final error = instalment != null && instalment > l.outstanding ? 'At most ${l.outstanding.format()}' : null;
    final payrolls = instalment == null || error != null ? null : (l.outstanding.ugx + instalment.ugx - 1) ~/ instalment.ugx;
    return FormSheet(
      title: 'Schedule recovery of ${l.outstanding.format()}',
      subtitle: 'Taken from ${l.staffName} through payroll, never more than what is outstanding.',
      submitLabel: 'Schedule',
      submitKey: const Key('submit-schedule'),
      saving: _saving,
      error: _error,
      onSubmit: instalment == null || error != null
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).scheduleRecovery(l.incidentId, instalment: instalment, startDate: _start);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(success: (_) => Navigator.of(context).pop(), failure: (f) => setState(() => _error = f.message));
            },
      children: [
        MoneyField(controller: _instalment, label: 'Amount per payroll', fieldKey: const Key('recovery-instalment'), errorText: error, onChanged: (_) => setState(() {})),
        if (payrolls != null) Text('About $payrolls payroll${payrolls == 1 ? '' : 's'}.', key: const Key('recovery-payrolls')),
        DateField(label: 'From the payroll covering', value: _start, last: DateTime.now().add(const Duration(days: 400)), onChanged: (d) => setState(() => _start = d)),
      ],
    );
  }
}

/// Evidence photo uploaded to `payroll_uploads/{kind}/…` (admins and managers).
class PayrollEvidenceField extends ConsumerWidget {
  const PayrollEvidenceField({super.key, required this.kind, required this.onChanged});
  final String kind;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Reuses the finance evidence picker, pointed at the Phase 6 prefix.
    return AttachmentField(kind: kind, label: 'Attach evidence (optional)', onChanged: onChanged, pathBuilder: StoragePaths.payrollUpload);
  }
}
