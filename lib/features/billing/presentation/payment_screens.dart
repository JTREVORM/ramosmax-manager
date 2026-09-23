import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/branding/brand.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/invoice.dart';
import '../../../models/payment.dart';
import '../../../routes/app_routes.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../application/billing_providers.dart';
import 'billing_widgets.dart';
import 'invoice_screens.dart' show invoiceMatches;

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

class PaymentsScreen extends ConsumerStatefulWidget {
  const PaymentsScreen({super.key});

  @override
  ConsumerState<PaymentsScreen> createState() => _PaymentsScreenState();
}

class _PaymentsScreenState extends ConsumerState<PaymentsScreen> {
  PaymentPeriod _period = PaymentPeriod.today;
  PaymentMethod? _method;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final payments = ref.watch(paymentsProvider((period: _period, method: _method)));
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
        child: Align(alignment: Alignment.centerLeft, child: Text('Payments', style: theme.textTheme.titleLarge)),
      ),
      FilterChips<PaymentPeriod>(
        values: PaymentPeriod.values,
        selected: _period,
        label: (p) => p.label,
        keyPrefix: 'payment-period',
        onSelected: (p) => setState(() => _period = p),
      ),
      FilterChips<PaymentMethod?>(
        values: const [null, ...PaymentMethod.values],
        selected: _method,
        label: (m) => m?.label ?? 'All methods',
        keyPrefix: 'payment-method',
        onSelected: (m) => setState(() => _method = m),
      ),
      Expanded(
        child: switch (payments) {
          AsyncData(:final value) => () {
              final received = value.where((p) => !p.reversed);
              final total = Money.sum(received.map((p) => p.amount));
              return ListView(
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                children: [
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      child: Column(children: [
                        MoneyLine('Received (${received.length})', total, emphasis: true, valueKey: const Key('payments-total')),
                        for (final m in PaymentMethod.values)
                          if (received.any((p) => p.method == m))
                            MoneyLine(m.label, Money.sum(received.where((p) => p.method == m).map((p) => p.amount))),
                        if (value.length >= 100) Text('Showing the latest 100 payments.', style: theme.textTheme.bodySmall),
                      ]),
                    ),
                  ),
                  if (value.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(AppSpacing.lg),
                      child: Center(child: Text('No payments in this period.')),
                    ),
                  for (final p in value)
                    PaymentTile(
                      payment: p,
                      onTap: () => context.go(p.receiptId != null ? AppRoutes.receiptDetail(p.receiptId!) : AppRoutes.invoiceDetail(p.invoiceId)),
                      trailing: p.numberPlate == null ? null : FittedBox(child: PlateBadge(p.numberPlate!)),
                    ),
                ],
              );
            }(),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

class ReceiptsScreen extends ConsumerWidget {
  const ReceiptsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
          child: Align(alignment: Alignment.centerLeft, child: Text('Receipts', style: Theme.of(context).textTheme.titleLarge)),
        ),
        Expanded(
          child: switch (ref.watch(receiptsProvider)) {
            AsyncData(:final value) when value.isEmpty =>
              const EmptyView(icon: Icons.receipt_outlined, title: 'No receipts yet', message: 'A receipt is issued with every payment.'),
            AsyncData(:final value) => ListView(
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                children: [
                  for (final r in value)
                    Card(
                      key: Key('receipt-tile-${r.receiptId}'),
                      child: ListTile(
                        onTap: () => context.go(AppRoutes.receiptDetail(r.receiptId)),
                        leading: const Icon(Icons.receipt_outlined),
                        title: Text(r.receiptNumber),
                        subtitle: Text([
                          r.numberPlate,
                          r.amountPaid.format(),
                          r.method.label,
                          if (r.issuedAt != null) DateTimeFormatter.dateTime(r.issuedAt!),
                          if (r.reversed) 'Reversed',
                        ].join(' · ')),
                      ),
                    ),
                ],
              ),
            AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
            _ => const LoadingView(),
          },
        ),
      ]);
}

/// Plain-text receipt for sharing (WhatsApp, SMS, email). The receipt
/// document is a snapshot; nothing is recalculated.
String receiptText(Receipt r) {
  final lines = <String>[
    r.businessName,
    Brand.address,
    'Tel ${Brand.phone}',
    'RECEIPT ${r.receiptNumber}${r.reversed ? ' (REVERSED)' : ''}',
    if (r.issuedAt != null) DateTimeFormatter.transaction(r.issuedAt!),
    '',
    'Vehicle: ${r.numberPlate}${r.vehicleSummary == null ? '' : ' (${r.vehicleSummary})'}',
    if (r.customerName != null) 'Customer: ${r.customerName}',
    if (r.invoiceNumber != null) 'Invoice: ${r.invoiceNumber}',
    '',
    for (final l in r.lines) '${l.serviceName}: ${l.price.format()}',
    'Subtotal: ${r.subtotal.format()}',
    if (r.discount.isPositive) 'Discount${r.discountLabel == null ? '' : ' (${r.discountLabel})'}: -${r.discount.format()}',
    'Total: ${r.total.format()}',
    'Paid now: ${r.amountPaid.format()} (${r.method.label}${r.reference == null ? '' : ' ${r.reference}'})',
    'Total paid: ${r.totalPaid.format()}',
    'Balance: ${r.outstanding.format()}',
    if (r.loyaltyPointsEarned > 0) 'Loyalty points earned: ${r.loyaltyPointsEarned}',
    if (r.loyaltyPointsBalance != null) 'Loyalty points balance: ${r.loyaltyPointsBalance}',
    if (r.cashierName != null) 'Served by: ${r.cashierName}',
    '',
    'Thank you for choosing RamosMAX.',
  ];
  return lines.join('\n');
}

class ReceiptScreen extends ConsumerWidget {
  const ReceiptScreen({super.key, required this.receiptId});
  final String receiptId;

  Future<void> _share(BuildContext context, WidgetRef ref, Receipt r) async {
    try {
      await SharePlus.instance.share(ShareParams(text: receiptText(r), subject: 'RamosMAX receipt ${r.receiptNumber}'));
      await ref.read(billingActionsProvider).logReceiptShared();
    } catch (_) {
      if (context.mounted) AppSnackbar.error(context, 'Sharing is not available on this device.');
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    return switch (ref.watch(receiptProvider(receiptId))) {
      AsyncData(value: final Receipt r) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
          children: [
            Row(children: [
              IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.invoiceDetail(r.invoiceId))),
              Expanded(child: Text('Receipt', style: theme.textTheme.titleLarge)),
              IconButton(
                key: const Key('share-receipt-button'),
                tooltip: 'Share / print',
                icon: const Icon(Icons.share),
                onPressed: () => _share(context, ref, r),
              ),
            ]),
            Card(
              key: const Key('receipt-card'),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Image.asset('assets/branding/ramosmax_logo.png', height: 56, errorBuilder: (_, _, _) => const SizedBox.shrink()),
                  const SizedBox(height: AppSpacing.xs),
                  Text(r.businessName, textAlign: TextAlign.center, style: theme.textTheme.titleMedium?.copyWith(color: Brand.purple)),
                  Text('${Brand.address} · ${Brand.phone}', textAlign: TextAlign.center, style: theme.textTheme.bodySmall),
                  Text(r.receiptNumber, key: const Key('receipt-number'), textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
                  if (r.issuedAt != null)
                    Text(DateTimeFormatter.transaction(r.issuedAt!), textAlign: TextAlign.center, style: theme.textTheme.bodySmall),
                  if (r.reversed)
                    const Padding(
                      padding: EdgeInsets.only(top: AppSpacing.xs),
                      child: Center(child: StatusChip('REVERSED', color: AppColors.danger, icon: Icons.undo)),
                    ),
                  const Divider(height: AppSpacing.lg),
                  Center(child: PlateBadge(r.numberPlate, large: true)),
                  const SizedBox(height: AppSpacing.xs),
                  InfoRow('Vehicle', r.vehicleSummary),
                  InfoRow('Customer', r.customerName),
                  InfoRow('Invoice', r.invoiceNumber),
                  InfoRow('Job', r.jobNumber),
                  const Divider(),
                  for (final l in r.lines) MoneyLine(l.serviceName, l.price),
                  const Divider(),
                  MoneyLine('Subtotal', r.subtotal),
                  if (r.discount.isPositive) MoneyLine('Discount${r.discountLabel == null ? '' : ' (${r.discountLabel})'}', r.discount, negative: true),
                  MoneyLine('Total', r.total, emphasis: true),
                  MoneyLine('Paid now (${r.method.label})', r.amountPaid, emphasis: true, valueKey: const Key('receipt-paid')),
                  if (r.reference != null) InfoRow('Reference', r.reference),
                  MoneyLine('Total paid', r.totalPaid),
                  MoneyLine('Balance', r.outstanding, valueKey: const Key('receipt-balance')),
                  if (r.loyaltyPointsEarned > 0 || r.loyaltyPointsBalance != null) ...[
                    const Divider(),
                    if (r.loyaltyPointsEarned > 0) InfoRow('Points earned', '${r.loyaltyPointsEarned}'),
                    if (r.loyaltyPointsBalance != null) InfoRow('Points balance', '${r.loyaltyPointsBalance}'),
                  ],
                  const Divider(),
                  InfoRow('Served by', r.cashierName),
                  const SizedBox(height: AppSpacing.xs),
                  Text('Thank you for choosing RamosMAX.', textAlign: TextAlign.center, style: theme.textTheme.bodySmall),
                ]),
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            FilledButton.icon(
              onPressed: () => _share(context, ref, r),
              icon: const Icon(Icons.share),
              label: const Text('Share or print'),
            ),
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.receipt_outlined, title: 'Receipt not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

// ---------------------------------------------------------------------------
// Credit / receivables
// ---------------------------------------------------------------------------

class CreditScreen extends ConsumerStatefulWidget {
  const CreditScreen({super.key});

  @override
  ConsumerState<CreditScreen> createState() => _CreditScreenState();
}

class _CreditScreenState extends ConsumerState<CreditScreen> {
  DebtAge? _age;
  PaymentStatus? _status;
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    return switch (ref.watch(outstandingInvoicesProvider)) {
      AsyncData(:final value) => () {
          final summary = CreditSummary.of(value, now);
          final shown = value
              .where((i) => _status == null || i.paymentStatus == _status)
              .where((i) => _age == null || DebtAge.of(i.debtAge(now)) == _age)
              .where((i) => invoiceMatches(i, _query))
              .toList()
            ..sort((a, b) => b.debtAge(now).compareTo(a.debtAge(now)));
          return ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, 96),
            children: [
              Text('Credit & receivables', style: theme.textTheme.titleLarge),
              const SizedBox(height: AppSpacing.xs),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.sm),
                  child: Column(children: [
                    MoneyLine('Owed to RamosMAX (${summary.count})', summary.total,
                        emphasis: true, color: AppColors.danger, valueKey: const Key('credit-total')),
                    for (final a in DebtAge.values) MoneyLine(a.label, summary.byAge[a]!),
                    Text('Credit is money owed, not cash received.', style: theme.textTheme.bodySmall),
                  ]),
                ),
              ),
              TextField(
                key: const Key('credit-search-field'),
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Customer, plate or invoice', isDense: true),
                onChanged: (v) => setState(() => _query = v),
              ),
              FilterChips<DebtAge?>(
                values: const [null, ...DebtAge.values],
                selected: _age,
                label: (a) => a?.label ?? 'Any age',
                keyPrefix: 'credit-age',
                onSelected: (a) => setState(() => _age = a),
              ),
              FilterChips<PaymentStatus?>(
                values: const [null, ...PaymentStatus.outstanding],
                selected: _status,
                label: (s) => s?.label ?? 'Any status',
                keyPrefix: 'credit-status',
                onSelected: (s) => setState(() => _status = s),
              ),
              if (shown.isEmpty)
                const Padding(padding: EdgeInsets.all(AppSpacing.lg), child: Center(child: Text('Nothing owed here.'))),
              for (final i in shown)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                  child: InvoiceTile(invoice: i, now: now, onTap: () => context.go(AppRoutes.invoiceDetail(i.invoiceId))),
                ),
            ],
          );
        }(),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}
