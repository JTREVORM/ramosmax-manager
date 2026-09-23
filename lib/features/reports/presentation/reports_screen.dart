import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/business_report.dart';
import '../../finance/presentation/finance_widgets.dart' show FigureCard, FigureGrid;
import '../../operations/presentation/operations_widgets.dart' show FilterChips;
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../application/reports_providers.dart';

/// Reports (Phase 9): pick a report and a period; the server calculates it
/// from the authoritative records and returns only what this person may see.
class ReportsScreen extends ConsumerStatefulWidget {
  const ReportsScreen({super.key, this.initial});
  final ReportType? initial;

  @override
  ConsumerState<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends ConsumerState<ReportsScreen> {
  ReportType? _type;
  ReportPeriodPreset _preset = ReportPeriodPreset.today;
  ReportPeriod? _custom;

  ReportPeriod _period(DateTime now) =>
      _preset == ReportPeriodPreset.custom && _custom != null ? _custom! : ReportPeriod.forPreset(_preset, now);

  Future<void> _pickRange(DateTime now) async {
    final e = EastAfricaTime.toEat(now);
    final today = DateTime(e.year, e.month, e.day);
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: today,
      initialDateRange: DateTimeRange(start: today.subtract(const Duration(days: 6)), end: today),
      helpText: 'Report period (at most 400 days)',
    );
    if (picked == null || !mounted) return;
    if (picked.end.difference(picked.start).inDays >= 400) {
      AppSnackbar.error(context, 'A report can cover at most 400 days.');
      return;
    }
    setState(() {
      _preset = ReportPeriodPreset.custom;
      _custom = ReportPeriod(ReportPeriod.dayKey(picked.start), ReportPeriod.dayKey(picked.end));
    });
  }

  Future<void> _export(BusinessReport report) async {
    final csv = report.toCsv();
    final name = 'ramosmax-${report.type.key}-${report.period.from}_${report.period.to}.csv';
    try {
      await SharePlus.instance.share(ShareParams(
        files: [XFile.fromData(utf8.encode(csv), mimeType: 'text/csv', name: name)],
        fileNameOverrides: [name],
        subject: 'RamosMAX ${report.type.label} ${report.period.label}',
      ));
      await ref.read(analyticsProvider).logEvent(AnalyticsEvents.reportExported, {'outcome': report.type.key});
    } catch (_) {
      if (mounted) AppSnackbar.error(context, 'Sharing is not available on this device.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(currentUserProvider);
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    if (user == null) return const LoadingView();
    final available = reportsFor(user, now);
    if (available.isEmpty) {
      return const EmptyView(icon: Icons.bar_chart_outlined, title: 'No reports', message: 'Your role has no report permissions.');
    }
    final type = (_type != null && available.contains(_type)) ? _type! : (available.contains(widget.initial) ? widget.initial! : available.first);
    final period = _period(now);
    final report = ref.watch(businessReportProvider((type: type, period: period)));
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96), children: [
      Row(children: [
        Expanded(child: Text('Reports', style: Theme.of(context).textTheme.titleLarge)),
        if (report.value case final r?)
          IconButton(key: const Key('export-report'), tooltip: 'Export CSV', icon: const Icon(Icons.ios_share), onPressed: () => _export(r)),
      ]),
      const SizedBox(height: AppSpacing.xs),
      DropdownButtonFormField<ReportType>(
        key: const Key('report-type'),
        initialValue: type,
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'Report'),
        items: [for (final t in available) DropdownMenuItem(value: t, child: Text(t.label, overflow: TextOverflow.ellipsis))],
        onChanged: (t) => setState(() => _type = t),
      ),
      Padding(
        padding: const EdgeInsets.only(top: AppSpacing.xxs),
        child: Text(type.description, style: Theme.of(context).textTheme.bodySmall),
      ),
      const SizedBox(height: AppSpacing.xs),
      FilterChips<ReportPeriodPreset>(
        values: ReportPeriodPreset.values,
        selected: _preset,
        label: (p) => p.label,
        keyPrefix: 'report-period',
        onSelected: (p) => p == ReportPeriodPreset.custom ? _pickRange(now) : setState(() => _preset = p),
      ),
      Text('Period: ${period.label} (East Africa Time)', key: const Key('report-period-label'), style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(height: AppSpacing.sm),
      switch (report) {
        AsyncData(:final value) => ReportView(report: value),
        AsyncError(:final error) => ErrorView.failure(error is AppFailure ? error : ErrorMapper.map(error),
            onRetry: () => ref.invalidate(businessReportProvider((type: type, period: period)))),
        _ => const Padding(padding: EdgeInsets.all(AppSpacing.lg), child: LoadingView(message: 'Calculating on the server…')),
      },
    ]);
  }
}

/// Renders any report: figure cards per section, then scrollable tables.
class ReportView extends StatelessWidget {
  const ReportView({super.key, required this.report});
  final BusinessReport report;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (report.sections.isEmpty) {
      return const EmptyView(icon: Icons.bar_chart_outlined, title: 'Nothing to show', message: 'No part of this report is open to your role.');
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (report.truncated)
        const Padding(
          padding: EdgeInsets.only(bottom: AppSpacing.sm),
          child: InlineError('This period has more records than one report reads. Choose a shorter period for complete figures.'),
        ),
      for (final s in report.sections) ...[
        Padding(
          padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: AppSpacing.xs),
          child: Text(s.title, key: Key('report-section-${s.key}'), style: theme.textTheme.titleMedium),
        ),
        if (s.note != null) Padding(padding: const EdgeInsets.only(bottom: AppSpacing.xs), child: Text(s.note!, style: theme.textTheme.bodySmall)),
        if (s.figures.isNotEmpty)
          FigureGrid(children: [
            for (final f in s.figures) FigureCard(label: f.label, value: f.formatted, valueKey: Key('fig-${s.key}-${f.key}')),
          ]),
        for (final t in s.tables) _TableCard(sectionKey: s.key, table: t),
      ],
    ]);
  }
}

class _TableCard extends StatelessWidget {
  const _TableCard({required this.sectionKey, required this.table});
  final String sectionKey;
  final ReportTable table;

  static const int _maxRows = 200;

  @override
  Widget build(BuildContext context) {
    final rows = table.rows.take(_maxRows).toList();
    return SectionCard(
      key: Key('table-$sectionKey-${table.key}'),
      title: table.title,
      children: [
        if (table.rows.isEmpty)
          const Text('None in this period.')
        else
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: DataTable(
              headingRowHeight: 36,
              dataRowMinHeight: 32,
              dataRowMaxHeight: 44,
              columnSpacing: AppSpacing.md,
              columns: [for (final c in table.columns) DataColumn(label: Text(c.label), numeric: c.numeric)],
              rows: [
                for (final r in rows)
                  DataRow(cells: [for (final c in table.columns) DataCell(Text(formatReportValue(r[c.key], c.kind)))]),
              ],
            ),
          ),
        if (table.rows.length > _maxRows)
          Text('Showing $_maxRows of ${table.rows.length} rows. Export for all of them.', style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}
