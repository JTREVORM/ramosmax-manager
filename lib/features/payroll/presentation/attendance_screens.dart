import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/attendance.dart';
import '../../../routes/app_routes.dart';
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/workforce_providers.dart';
import '../data/workforce_api.dart';
import 'workforce_widgets.dart';

/// Attendance module. Managers (attendance.view) see the day, the
/// verification queue and anyone's history; everyone else sees only their own.
class AttendanceScreen extends ConsumerWidget {
  const AttendanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.attendanceView)) return const MyAttendanceView();
    final tabs = <(String, Widget)>[
      ('Day', const _DayTab()),
      ('To verify', const _PendingTab()),
      ('By staff', const _StaffTab()),
      if (canDo(ref, Permission.attendanceViewOwn)) ('Mine', const MyAttendanceView()),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        floatingActionButton: canDo(ref, Permission.attendanceRecord)
            ? FloatingActionButton.extended(
                key: const Key('record-attendance-button'),
                onPressed: () => showFormSheet<void>(context, const RecordAttendanceSheet()),
                icon: const Icon(Icons.add),
                label: const Text('Record'),
              )
            : null,
        body: Column(children: [
          TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final (label, _) in tabs) Tab(text: label)]),
          Expanded(child: TabBarView(children: [for (final (_, view) in tabs) view])),
        ]),
      ),
    );
  }
}

/// The signed-in person's own attendance: clock in / out for today, history.
class MyAttendanceView extends ConsumerWidget {
  const MyAttendanceView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final today = ref.watch(myTodayAttendanceProvider);
    final history = ref.watch(myAttendanceProvider);
    final policy = ref.watch(workforcePolicyProvider).value ?? WorkforcePolicy.defaults;
    final canMark = canDo(ref, Permission.attendanceMark);
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
      children: [
        SectionCard(title: 'Today', icon: Icons.today_outlined, children: [
          Text('Reporting time ${policy.reportingTime} · on time up to ${policy.gracePeriodMinutes} minutes after.',
              style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          switch (today) {
            AsyncData(value: final AttendanceRecord a) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Expanded(child: Text(attendanceTimes(a), key: const Key('my-today-times'))),
                  AttendanceStatusChip(a.status),
                ]),
                if (a.canClockOut && canMark) ...[
                  const SizedBox(height: AppSpacing.xs),
                  OutlinedButton.icon(
                    key: const Key('clock-out-button'),
                    icon: const Icon(Icons.logout),
                    label: const Text('Clock out'),
                    onPressed: () async {
                      final r = await ref.read(workforceActionsProvider).clockOut();
                      if (context.mounted) reportResult(context, r, 'Clocked out.');
                    },
                  ),
                ],
              ]),
            AsyncData() => canMark
                ? FilledButton.icon(
                    key: const Key('clock-in-button'),
                    icon: const Icon(Icons.login),
                    label: const Text('Clock in now'),
                    onPressed: () async {
                      final r = await ref.read(workforceActionsProvider).clockIn();
                      if (context.mounted) reportResult(context, r, 'Clocked in. A manager will verify it.');
                    },
                  )
                : const Text('No attendance recorded today.'),
            AsyncError(:final error) => InlineError(ErrorMapper.map(error).message),
            _ => const LinearProgressIndicator(),
          },
        ]),
        const SizedBox(height: AppSpacing.sm),
        Text('History', style: Theme.of(context).textTheme.titleMedium),
        switch (history) {
          AsyncData(:final value) when value.isEmpty => const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No attendance yet.')),
          AsyncData(:final value) => Column(children: [
              for (final a in value)
                AttendanceTile(record: a, showName: false, onTap: () => context.go(AppRoutes.attendanceDetail(a.attendanceId))),
            ]),
          AsyncError(:final error) => InlineError(ErrorMapper.map(error).message),
          _ => const LoadingView(),
        },
      ],
    );
  }
}

class _DayTab extends ConsumerStatefulWidget {
  const _DayTab();

  @override
  ConsumerState<_DayTab> createState() => _DayTabState();
}

class _DayTabState extends ConsumerState<_DayTab> {
  DateTime? _day;

  @override
  Widget build(BuildContext context) {
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final day = _day ?? now;
    final key = EastAfricaTime.businessDayKey(day);
    final me = ref.watch(currentUserProvider)?.uid;
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
      children: [
        DateField(fieldKey: const Key('attendance-day'), label: 'Day', value: day, last: now, onChanged: (d) => setState(() => _day = d)),
        const SizedBox(height: AppSpacing.sm),
        switch (ref.watch(attendanceDayProvider(key))) {
          AsyncData(:final value) => () {
              final count = <AttendanceStatus, int>{};
              for (final a in value) {
                count[a.status] = (count[a.status] ?? 0) + 1;
              }
              final onTimePending = value.where((a) => a.isPending && a.arrivalStatus == ArrivalStatus.onTime && a.staffUid != me).toList();
              return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
                  for (final s in AttendanceStatus.values)
                    if (count[s] != null) Chip(key: Key('day-count-${s.key}'), label: Text('${s.label}: ${count[s]}')),
                ]),
                if (onTimePending.isNotEmpty && canDo(ref, Permission.attendanceApprove))
                  TextButton.icon(
                    key: const Key('approve-on-time-button'),
                    icon: const Icon(Icons.done_all),
                    label: Text('Approve ${onTimePending.length} on-time record${onTimePending.length == 1 ? '' : 's'}'),
                    onPressed: () async {
                      final r = await ref.read(workforceActionsProvider).verifyAttendance([for (final a in onTimePending) a.attendanceId], approve: true);
                      if (context.mounted) reportResult(context, r, 'Attendance approved.');
                    },
                  ),
                if (value.isEmpty) const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No attendance recorded for this day.')),
                for (final a in value) AttendanceTile(record: a, onTap: () => context.go(AppRoutes.attendanceDetail(a.attendanceId))),
              ]);
            }(),
          AsyncError(:final error) => InlineError(ErrorMapper.map(error).message),
          _ => const LoadingView(),
        },
      ],
    );
  }
}

class _PendingTab extends ConsumerStatefulWidget {
  const _PendingTab();

  @override
  ConsumerState<_PendingTab> createState() => _PendingTabState();
}

class _PendingTabState extends ConsumerState<_PendingTab> {
  final Set<String> _selected = {};

  Future<void> _verify(bool approve) async {
    String? reason;
    if (!approve) {
      reason = await showReasonDialog(context,
          title: 'Reject ${_selected.length} record${_selected.length == 1 ? '' : 's'}?',
          message: 'Say why. The staff member is told their attendance was not approved.',
          confirmLabel: 'Reject',
          destructive: true);
      if (reason == null) return;
    }
    final r = await ref.read(workforceActionsProvider).verifyAttendance(_selected.toList(), approve: approve, reason: reason);
    if (!mounted) return;
    if (reportResult(context, r, approve ? 'Attendance approved.' : 'Attendance rejected.')) setState(_selected.clear);
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(currentUserProvider)?.uid;
    final canApprove = canDo(ref, Permission.attendanceApprove);
    final canReject = canApprove || canDo(ref, Permission.attendanceReview);
    return switch (ref.watch(pendingAttendanceProvider)) {
      AsyncData(:final value) when value.isEmpty =>
        const EmptyView(icon: Icons.how_to_reg_outlined, title: 'Nothing to verify', message: 'New attendance appears here for approval.'),
      AsyncData(:final value) => Column(children: [
          if (canReject)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: Row(children: [
                Expanded(child: Text('${_selected.length} selected')),
                if (canApprove)
                  TextButton(key: const Key('approve-selected-attendance'), onPressed: _selected.isEmpty ? null : () => _verify(true), child: const Text('Approve')),
                TextButton(key: const Key('reject-selected-attendance'), onPressed: _selected.isEmpty ? null : () => _verify(false), child: const Text('Reject')),
              ]),
            ),
          Expanded(
            child: ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96), children: [
              for (final a in value)
                AttendanceTile(
                  record: a,
                  onTap: () => context.go(AppRoutes.attendanceDetail(a.attendanceId)),
                  selected: _selected.contains(a.attendanceId),
                  // Nobody verifies their own attendance.
                  onSelect: !canReject || a.staffUid == me
                      ? null
                      : (on) => setState(() => on == true ? _selected.add(a.attendanceId) : _selected.remove(a.attendanceId)),
                ),
            ]),
          ),
        ]),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class _StaffTab extends ConsumerStatefulWidget {
  const _StaffTab();

  @override
  ConsumerState<_StaffTab> createState() => _StaffTabState();
}

class _StaffTabState extends ConsumerState<_StaffTab> {
  String? _uid;

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
        children: [
          StaffDropdown(fieldKey: const Key('attendance-staff-filter'), value: _uid, onChanged: (v) => setState(() => _uid = v)),
          const SizedBox(height: AppSpacing.sm),
          if (_uid != null)
            switch (ref.watch(staffAttendanceProvider(_uid!))) {
              AsyncData(:final value) when value.isEmpty => const Text('No attendance recorded.'),
              AsyncData(:final value) => Column(children: [
                  for (final a in value)
                    AttendanceTile(record: a, showName: false, onTap: () => context.go(AppRoutes.attendanceDetail(a.attendanceId))),
                ]),
              AsyncError(:final error) => InlineError(ErrorMapper.map(error).message),
              _ => const LoadingView(),
            },
        ],
      );
}

// ---------------------------------------------------------------------------
// Detail, verification and correction
// ---------------------------------------------------------------------------

class AttendanceDetailScreen extends ConsumerWidget {
  const AttendanceDetailScreen({super.key, required this.attendanceId});
  final String attendanceId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(currentUserProvider)?.uid;
    return switch (ref.watch(attendanceProvider(attendanceId))) {
      AsyncData(value: final AttendanceRecord a) => () {
          final own = a.staffUid == me;
          final corrections = ref.watch(attendanceCorrectionsProvider(
              (attendanceId: a.attendanceId, staffUid: canDo(ref, Permission.attendanceView) ? null : me)));
          return ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
            children: [
              ScreenHeader(a.attendanceNumber, subtitle: '${a.staffName} · ${a.dayKey}', onBack: () => context.go(AppRoutes.attendance)),
              Align(alignment: Alignment.centerLeft, child: AttendanceStatusChip(a.status)),
              SectionCard(title: 'Attendance', icon: Icons.how_to_reg_outlined, children: [
                InfoRow('Recorded', a.arrivalStatus.label),
                InfoRow('Clock in', a.clockInAt == null ? null : DateTimeFormatter.time(a.clockInAt!)),
                InfoRow('Clock out', a.clockOutAt == null ? null : DateTimeFormatter.time(a.clockOutAt!)),
                InfoRow('Reporting time', '${a.reportingTime ?? '—'} (+${a.gracePeriodMinutes} min grace)'),
                InfoRow('Minutes late', '${a.minutesLate}'),
                InfoRow('Working day', a.workingDay ? 'Yes' : 'No'),
                InfoRow('Source', '${a.source.label}${a.recordedVia == 'self' ? ' (clocked in on the phone)' : ''}'),
                InfoRow('Recorded by', a.recordedByName),
                InfoRow('Notes', a.notes),
              ]),
              SectionCard(title: 'Verification', icon: Icons.verified_outlined, children: [
                InfoRow('Status', a.verificationStatus),
                if (a.verifiedAt != null) InfoRow('By', [?a.verifiedByName, DateTimeFormatter.dateTime(a.verifiedAt!)].join(' · ')),
                InfoRow('Notes', a.verificationNotes),
                if (a.rejectionReason != null) InfoRow('Rejected', a.rejectionReason),
              ]),
              SectionCard(title: 'Corrections', icon: Icons.history, children: [
                switch (corrections) {
                  AsyncData(:final value) when value.isEmpty => const Text('No corrections.'),
                  AsyncData(:final value) => Column(children: [
                      for (final c in value)
                        ListTile(
                          key: Key('correction-${c.correctionId}'),
                          contentPadding: EdgeInsets.zero,
                          title: Text(c.reason),
                          subtitle: Text([
                            _describe(c.previous),
                            '→ ${_describe(c.corrected)}',
                            [?c.correctedByName, if (c.createdAt != null) DateTimeFormatter.dateTime(c.createdAt!)].join(' · '),
                          ].join('\n')),
                        ),
                    ]),
                  AsyncError(:final error) => InlineError(ErrorMapper.map(error).message),
                  _ => const LinearProgressIndicator(),
                },
              ]),
              const SizedBox(height: AppSpacing.sm),
              Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
                if (a.isPending && !own && canDo(ref, Permission.attendanceApprove))
                  FilledButton(
                    key: const Key('approve-attendance-button'),
                    onPressed: () async {
                      final r = await ref.read(workforceActionsProvider).verifyAttendance([a.attendanceId], approve: true);
                      if (context.mounted) reportResult(context, r, 'Attendance approved.');
                    },
                    child: const Text('Approve'),
                  ),
                if (a.isPending && !own && (canDo(ref, Permission.attendanceApprove) || canDo(ref, Permission.attendanceReview)))
                  OutlinedButton(
                    key: const Key('reject-attendance-button'),
                    onPressed: () async {
                      final reason = await showReasonDialog(context,
                          title: 'Reject ${a.attendanceNumber}?', message: 'Say why it is not approved.', confirmLabel: 'Reject', destructive: true);
                      if (reason == null || !context.mounted) return;
                      final r = await ref.read(workforceActionsProvider).verifyAttendance([a.attendanceId], approve: false, reason: reason);
                      if (context.mounted) reportResult(context, r, 'Attendance rejected.');
                    },
                    child: const Text('Reject'),
                  ),
                if (!own && canDo(ref, Permission.attendanceCorrect))
                  OutlinedButton(
                    key: const Key('correct-attendance-button'),
                    onPressed: () => showFormSheet<void>(context, CorrectAttendanceSheet(record: a)),
                    child: const Text('Correct'),
                  ),
                if (own && a.canClockOut && canDo(ref, Permission.attendanceMark) && a.dayKey == EastAfricaTime.businessDayKey(DateTime.now()))
                  OutlinedButton(
                    key: const Key('detail-clock-out-button'),
                    onPressed: () async {
                      final r = await ref.read(workforceActionsProvider).clockOut();
                      if (context.mounted) reportResult(context, r, 'Clocked out.');
                    },
                    child: const Text('Clock out'),
                  ),
              ]),
            ],
          );
        }(),
      AsyncData() => const EmptyView(icon: Icons.how_to_reg_outlined, title: 'Attendance record not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }

  static String _describe(Map<String, Object?> v) {
    String t(Object? ms) => ms is int ? DateTimeFormatter.time(DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true)) : '—';
    return [ArrivalStatus.parse(v['arrivalStatus']).label, if (v['clockInAt'] != null) '${t(v['clockInAt'])}–${t(v['clockOutAt'])}'].join(' ');
  }
}

/// A manager records attendance for someone else (attendance.record).
class RecordAttendanceSheet extends ConsumerStatefulWidget {
  const RecordAttendanceSheet({super.key});

  @override
  ConsumerState<RecordAttendanceSheet> createState() => _RecordAttendanceSheetState();
}

class _RecordAttendanceSheetState extends ConsumerState<RecordAttendanceSheet> {
  String? _staff;
  DateTime _day = DateTime.now();
  ArrivalEntry _arrival = ArrivalEntry.present;
  DateTime? _in;
  DateTime? _out;
  final _notes = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final present = _arrival == ArrivalEntry.present;
    final ready = _staff != null && (!present || _in != null) && (_arrival != ArrivalEntry.excused || _notes.text.trim().isNotEmpty);
    return FormSheet(
      title: 'Record attendance',
      subtitle: 'Lateness is worked out by the server from the reporting time.',
      submitLabel: 'Record',
      submitKey: const Key('submit-attendance'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).recordAttendance(AttendanceEntry(
                    staffUid: _staff!,
                    date: _day,
                    arrival: _arrival,
                    clockInAt: present ? _in : null,
                    clockOutAt: present ? _out : null,
                    notes: _notes.text.trim().isEmpty ? null : _notes.text.trim(),
                  ));
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Attendance recorded.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        StaffDropdown(fieldKey: const Key('attendance-staff'), value: _staff, onChanged: (v) => setState(() => _staff = v)),
        DateField(label: 'Day', value: _day, first: DateTime.now().subtract(const Duration(days: 62)), onChanged: (d) => setState(() {
              _day = d;
              _in = null;
              _out = null;
            })),
        SegmentedButton<ArrivalEntry>(
          key: const Key('attendance-arrival'),
          segments: [for (final a in ArrivalEntry.values) ButtonSegment(value: a, label: Text(a.label))],
          selected: {_arrival},
          onSelectionChanged: (s) => setState(() => _arrival = s.first),
        ),
        if (present) ...[
          TimeField(fieldKey: const Key('attendance-clock-in'), label: 'Clock in', day: _day, value: _in, onChanged: (v) => setState(() => _in = v)),
          TimeField(fieldKey: const Key('attendance-clock-out'), label: 'Clock out (optional)', day: _day, value: _out, onChanged: (v) => setState(() => _out = v)),
        ],
        TextField(
          key: const Key('attendance-notes'),
          controller: _notes,
          maxLength: 500,
          decoration: InputDecoration(labelText: _arrival == ArrivalEntry.excused ? 'Why is the absence excused?' : 'Notes (optional)'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}

/// An authorised correction (attendance.correct): original values are kept.
class CorrectAttendanceSheet extends ConsumerStatefulWidget {
  const CorrectAttendanceSheet({super.key, required this.record});
  final AttendanceRecord record;

  @override
  ConsumerState<CorrectAttendanceSheet> createState() => _CorrectAttendanceSheetState();
}

class _CorrectAttendanceSheetState extends ConsumerState<CorrectAttendanceSheet> {
  late ArrivalEntry _arrival = switch (widget.record.arrivalStatus) {
    ArrivalStatus.absent => ArrivalEntry.absent,
    ArrivalStatus.excused => ArrivalEntry.excused,
    _ => ArrivalEntry.present,
  };
  late DateTime? _in = widget.record.clockInAt;
  late DateTime? _out = widget.record.clockOutAt;
  final _reason = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.record;
    final day = a.date ?? DateTime.now();
    final present = _arrival == ArrivalEntry.present;
    final ready = _reason.text.trim().length >= 3 && (!present || _in != null);
    return FormSheet(
      title: 'Correct ${a.attendanceNumber}',
      subtitle: 'The original values stay in the history. The record goes back for verification'
          '${a.allowanceId != null ? ', and an unpaid allowance for the day is cancelled for recalculation' : ''}.',
      submitLabel: 'Save correction',
      submitKey: const Key('submit-correction'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final r = await ref.read(workforceActionsProvider).correctAttendance(
                    a.attendanceId,
                    reason: _reason.text.trim(),
                    arrival: _arrival,
                    clockInAt: present ? _in : null,
                    clockOutAt: present ? _out : null,
                    clearClockOut: present && _out == null && a.clockOutAt != null,
                  );
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Correction saved.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        SegmentedButton<ArrivalEntry>(
          segments: [for (final e in ArrivalEntry.values) ButtonSegment(value: e, label: Text(e.label))],
          selected: {_arrival},
          onSelectionChanged: (s) => setState(() => _arrival = s.first),
        ),
        if (present) ...[
          TimeField(fieldKey: const Key('correct-clock-in'), label: 'Clock in', day: day, value: _in, onChanged: (v) => setState(() => _in = v)),
          TimeField(label: 'Clock out', day: day, value: _out, onChanged: (v) => setState(() => _out = v)),
        ],
        TextField(
          key: const Key('correction-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: const InputDecoration(labelText: 'Reason for the correction'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}
