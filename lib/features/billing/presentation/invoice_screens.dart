import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/invoice.dart';
import '../../../models/loyalty.dart';
import '../../../models/payment.dart';
import '../../../routes/app_routes.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/billing_providers.dart';
import 'billing_widgets.dart';
import 'invoice_actions.dart';

/// Search within loaded invoices: plate, invoice number, job number or customer.
bool invoiceMatches(Invoice i, String query) {
  String norm(String? s) => (s ?? '').toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  final q = norm(query);
  if (q.isEmpty) return true;
  return norm(i.numberPlate).contains(q) ||
      norm(i.invoiceNumber).contains(q) ||
      norm(i.jobNumber).contains(q) ||
      norm(i.customerName).contains(q);
}

class InvoicesScreen extends ConsumerStatefulWidget {
  const InvoicesScreen({super.key});

  @override
  ConsumerState<InvoicesScreen> createState() => _InvoicesScreenState();
}

class _InvoicesScreenState extends ConsumerState<InvoicesScreen> {
  PaymentStatus? _status;
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final invoices = ref.watch(invoicesProvider(_status));
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
        child: Align(alignment: Alignment.centerLeft, child: Text('Invoices', style: Theme.of(context).textTheme.titleLarge)),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
        child: TextField(
          key: const Key('invoice-search-field'),
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Plate, invoice, job or customer', isDense: true),
          onChanged: (v) => setState(() => _query = v),
        ),
      ),
      FilterChips<PaymentStatus?>(
        values: const [null, ...PaymentStatus.values],
        selected: _status,
        label: (s) => s?.label ?? 'All',
        keyPrefix: 'invoice-filter',
        onSelected: (s) => setState(() => _status = s),
      ),
      Expanded(
        child: switch (invoices) {
          AsyncData(:final value) when value.where((i) => invoiceMatches(i, _query)).isEmpty => const EmptyView(
              icon: Icons.receipt_long_outlined,
              title: 'No invoices',
              message: 'Invoices are created from completed jobs.',
            ),
          AsyncData(:final value) => ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
              children: [
                for (final i in value.where((i) => invoiceMatches(i, _query)))
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                    child: InvoiceTile(invoice: i, onTap: () => context.go(AppRoutes.invoiceDetail(i.invoiceId))),
                  ),
              ],
            ),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }
}

class InvoiceDetailScreen extends ConsumerWidget {
  const InvoiceDetailScreen({super.key, required this.invoiceId});
  final String invoiceId;

  Future<void> _pay(BuildContext context, Invoice i) async {
    final outcome = await showPaymentSheet(context, i);
    if (outcome == null || !context.mounted) return;
    final extra = [
      if (outcome.pointsEarned > 0) '${outcome.pointsEarned} loyalty points earned',
      if (outcome.rewardUnlocked) 'a loyalty reward is now available',
    ];
    AppSnackbar.success(context, 'Payment recorded: ${outcome.receiptNumber}${extra.isEmpty ? '' : ' — ${extra.join(', ')}'}.');
    context.go(AppRoutes.receiptDetail(outcome.receiptId));
  }

  Future<void> _withReason(
    BuildContext context,
    Future<Result<void>> Function(String reason) action, {
    required String title,
    required String message,
    required String confirm,
    required String done,
    bool destructive = false,
  }) async {
    final reason = await showReasonDialog(context, title: title, message: message, confirmLabel: confirm, destructive: destructive);
    if (reason == null || !context.mounted) return;
    final r = await action(reason);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, done), failure: (f) => AppSnackbar.error(context, f.message));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final actions = ref.read(billingActionsProvider);
    return switch (ref.watch(invoiceProvider(invoiceId))) {
      AsyncData(value: final Invoice i) => ListView(
          key: const Key('invoice-detail'),
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xl),
          children: [
            Row(children: [
              IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.go(AppRoutes.invoices)),
              Expanded(child: Text(i.invoiceNumber, style: theme.textTheme.titleLarge, overflow: TextOverflow.ellipsis)),
              PaymentStatusChip(i.paymentStatus),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(title: 'Customer & vehicle', icon: Icons.directions_car_outlined, children: [
              InfoRow('Plate', null, valueWidget: Align(alignment: Alignment.centerLeft, child: PlateBadge(i.numberPlate))),
              InfoRow('Vehicle', i.vehicleSummary),
              InfoRow('Customer', i.customerName ?? 'Not recorded'),
              InfoRow('Job', i.jobNumber),
              if (i.issuedAt != null) InfoRow('Issued', DateTimeFormatter.dateTime(i.issuedAt!)),
              InfoRow('Issued by', i.createdByName),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: () => context.go(AppRoutes.intakeDetail(i.serviceIntakeId)),
                  child: const Text('Open job'),
                ),
              ),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(title: 'Services', icon: Icons.checklist, children: [
              for (final item in i.items) MoneyLine(item.serviceName, item.price),
              const Divider(),
              MoneyLine('Subtotal', i.subtotal, valueKey: const Key('invoice-subtotal')),
              if (i.discount != null) MoneyLine('Discount (${i.discount!.label})', i.discountAmount, negative: true),
              MoneyLine('Total', i.total, emphasis: true, valueKey: const Key('invoice-total')),
              MoneyLine('Paid', i.paid),
              MoneyLine('Outstanding', i.outstanding,
                  emphasis: true, color: i.outstanding.isPositive ? AppColors.danger : AppColors.success, valueKey: const Key('invoice-outstanding')),
              if (i.discount != null) ...[
                const SizedBox(height: AppSpacing.xxs),
                Text(
                  'Discount: ${i.discount!.reason}${i.discount!.createdByName == null ? '' : ' — by ${i.discount!.createdByName}'}'
                  '${i.discount!.approvedBy == null ? '' : ' (approved)'}',
                  style: theme.textTheme.bodySmall,
                ),
              ],
              if (i.onCredit) Text('On credit: ${i.creditReason ?? ''}', style: theme.textTheme.bodySmall),
              if (i.cancelReason != null) Text('Cancelled: ${i.cancelReason}', style: theme.textTheme.bodySmall),
              if (i.loyaltyPointsEarned > 0) Text('Earned ${i.loyaltyPointsEarned} loyalty points.', style: theme.textTheme.bodySmall),
            ]),
            if (i.canDiscount) _LoyaltyOffer(invoice: i),
            const SizedBox(height: AppSpacing.sm),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              if (i.canPay && canDo(ref, Permission.paymentsRecord))
                FilledButton.icon(
                  key: const Key('pay-button'),
                  onPressed: () => _pay(context, i),
                  icon: const Icon(Icons.payments_outlined),
                  label: const Text('Record payment'),
                ),
              if (i.canDiscount && canDo(ref, Permission.discountsApply))
                OutlinedButton.icon(
                  key: const Key('discount-button'),
                  onPressed: () => showDiscountSheet(context, i),
                  icon: const Icon(Icons.percent),
                  label: const Text('Discount'),
                ),
              if (i.canMarkCredit && canDo(ref, Permission.creditManage))
                OutlinedButton.icon(
                  key: const Key('credit-button'),
                  onPressed: () => _withReason(context, (r) => actions.markCredit(i.invoiceId, r),
                      title: 'Put ${i.outstanding.format()} on credit?',
                      message: 'The customer leaves owing this amount. It appears on the Credit screen until paid.',
                      confirm: 'Mark as credit',
                      done: 'Marked as credit.'),
                  icon: const Icon(Icons.credit_score_outlined),
                  label: const Text('Mark as credit'),
                ),
              if (i.canCancel && canDo(ref, Permission.invoicesVoid))
                OutlinedButton.icon(
                  key: const Key('cancel-invoice-button'),
                  style: OutlinedButton.styleFrom(foregroundColor: theme.colorScheme.error),
                  onPressed: () => _withReason(context, (r) => actions.cancelInvoice(i.invoiceId, r),
                      title: 'Cancel ${i.invoiceNumber}?',
                      message: 'The invoice is kept and marked cancelled. The job can then be invoiced again. '
                          'A loyalty reward used on it is given back.',
                      confirm: 'Cancel invoice',
                      done: 'Invoice cancelled.',
                      destructive: true),
                  icon: const Icon(Icons.block),
                  label: const Text('Cancel invoice'),
                ),
            ]),
            if (canDo(ref, Permission.paymentsView)) ...[
              const SizedBox(height: AppSpacing.sm),
              _PaymentsSection(invoice: i),
            ],
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.receipt_long_outlined, title: 'Invoice not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

/// Offers the vehicle's available loyalty reward, with its exact effect.
class _LoyaltyOffer extends ConsumerWidget {
  const _LoyaltyOffer({required this.invoice});
  final Invoice invoice;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canDo(ref, Permission.loyaltyView)) return const SizedBox.shrink();
    final reward = ref.watch(availableRewardProvider(invoice.vehicleId)).value;
    final account = ref.watch(loyaltyAccountProvider(invoice.vehicleId)).value ?? LoyaltyAccount.none(invoice.vehicleId);
    if (reward == null) return const SizedBox.shrink();
    final amount = reward.previewFor(invoice.subtotal);
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Card(
        key: const Key('loyalty-offer'),
        color: AppColors.success.withValues(alpha: 0.08),
        child: ListTile(
          leading: const Icon(Icons.card_giftcard, color: AppColors.success),
          title: Text('${reward.discountPercent}% loyalty reward available'),
          subtitle: Text('Would take ${amount.format()} off · uses ${reward.pointsCost} of ${account.pointsBalance} points'),
          trailing: canDo(ref, Permission.loyaltyRedeem)
              ? TextButton(
                  key: const Key('apply-reward-button'),
                  onPressed: () => confirmLoyaltyReward(context, ref, invoice, reward, account),
                  child: const Text('Apply'),
                )
              : null,
        ),
      ),
    );
  }
}

class _PaymentsSection extends ConsumerWidget {
  const _PaymentsSection({required this.invoice});
  final Invoice invoice;

  Future<void> _reverse(BuildContext context, WidgetRef ref, Payment p) async {
    final reason = await showReasonDialog(context,
        title: 'Reverse ${p.amount.format()}?',
        message: 'The payment and its receipt are kept and marked reversed; the balance goes back on the invoice. '
            'Loyalty points it earned are taken back.',
        confirmLabel: 'Reverse payment',
        destructive: true);
    if (reason == null || !context.mounted) return;
    final r = await ref.read(billingActionsProvider).reversePayment(p.paymentId, reason);
    if (!context.mounted) return;
    r.when(success: (_) => AppSnackbar.success(context, 'Payment reversed.'), failure: (f) => AppSnackbar.error(context, f.message));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canReverse = canDo(ref, Permission.paymentsReverse);
    return SectionCard(title: 'Payments', icon: Icons.history, children: [
      switch (ref.watch(invoicePaymentsProvider(invoice.invoiceId))) {
        AsyncData(:final value) when value.isEmpty => const Text('No payments yet.'),
        AsyncData(:final value) => Column(children: [
            for (final p in value)
              PaymentTile(
                payment: p,
                onTap: p.receiptId == null ? null : () => context.go(AppRoutes.receiptDetail(p.receiptId!)),
                trailing: canReverse && !p.reversed
                    ? IconButton(
                        key: Key('reverse-${p.paymentId}'),
                        tooltip: 'Reverse',
                        icon: const Icon(Icons.undo),
                        onPressed: () => _reverse(context, ref, p),
                      )
                    : null,
              ),
          ]),
        AsyncError(:final error) => Text(ErrorMapper.map(error).message),
        _ => const LinearProgressIndicator(),
      },
    ]);
  }
}
