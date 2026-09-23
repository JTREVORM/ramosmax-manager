import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/error_mapper.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/shareholding.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../application/shareholders_providers.dart';

/// A shareholder's OWN shareholding (shareholders.view.own). Served by the
/// getMyShareholding function - the app never queries the register, so no
/// other shareholder's data can be reached from here.
class MyShareholdingScreen extends ConsumerWidget {
  const MyShareholdingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (ref.watch(myShareholdingProvider)) {
        AsyncData(value: final m) when !m.linked => const EmptyView(
            icon: Icons.pie_chart_outline,
            title: 'No shareholding linked',
            message: 'Your sign-in is not linked to a shareholder record yet. Ask an administrator.',
          ),
        AsyncData(value: final m) => RefreshIndicator(
            onRefresh: () async => ref.invalidate(myShareholdingProvider),
            child: ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
              _Summary(m.shareholder!),
              if (m.holdings.isNotEmpty)
                SectionCard(title: 'Holdings', icon: Icons.category_outlined, children: [
                  for (final h in m.holdings) InfoRow(h.classCode, '${formatShares(h.shares)} shares · paid ${h.paid.format()}'),
                ]),
              SectionCard(title: 'Dividends', icon: Icons.payments_outlined, children: [
                if (m.dividends.isEmpty) const Text('No approved dividends yet.'),
                for (final d in m.dividends)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text('${d.dividendNumber} · ${d.period}'),
                    subtitle: Text([
                      '${formatShares(d.shares)} shares at the record date',
                      if (d.recordDate != null) DateTimeFormatter.date(d.recordDate!),
                      d.paid ? 'Paid${d.paidAt == null ? '' : ' ${DateTimeFormatter.date(d.paidAt!)}'}' : 'Not paid yet',
                    ].join(' · ')),
                    trailing: Text(d.net.format()),
                  ),
              ]),
              SectionCard(title: 'Share history', icon: Icons.history, children: [
                if (m.transactions.isEmpty) const Text('No share transactions.'),
                for (final t in m.transactions)
                  InfoRow(t.number, '${t.label} · ${t.delta >= 0 ? '+' : '−'}${formatShares(t.delta.abs())} ${t.classCode}'
                      '${t.effectiveDate == null ? '' : ' · ${DateTimeFormatter.date(t.effectiveDate!)}'}'),
              ]),
              SectionCard(title: 'Contributions', icon: Icons.savings_outlined, children: [
                if (m.contributions.isEmpty) const Text('No contributions recorded.'),
                for (final c in m.contributions)
                  InfoRow(c.number, '${c.amount.format()}${c.reversed ? ' · reversed' : ''}'
                      '${c.paymentDate == null ? '' : ' · ${DateTimeFormatter.date(c.paymentDate!)}'}'),
              ]),
            ]),
          ),
        AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error), onRetry: () => ref.invalidate(myShareholdingProvider)),
        _ => const LoadingView(),
      };
}

class _Summary extends StatelessWidget {
  const _Summary(this.s);
  final Shareholder s;

  @override
  Widget build(BuildContext context) => SectionCard(title: s.fullName, icon: Icons.pie_chart_outline, children: [
        InfoRow('Shareholder', s.shareholderNumber),
        InfoRow('Shares', formatShares(s.totalShares), valueWidget: Text(formatShares(s.totalShares), key: const Key('my-shares'))),
        InfoRow('Ownership', formatPercent(s.ownershipPercent), valueWidget: Text(formatPercent(s.ownershipPercent), key: const Key('my-ownership'))),
        MoneyLine('Contributions', s.paid),
        if (s.outstanding.isPositive) MoneyLine('Outstanding', s.outstanding),
        MoneyLine('Dividends received', s.dividendsPaid),
      ]);
}
