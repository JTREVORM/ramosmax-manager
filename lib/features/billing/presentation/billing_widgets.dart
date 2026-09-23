import 'package:flutter/material.dart';

import '../../../core/money/money.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/invoice.dart';
import '../../../models/payment.dart';
import '../../operations/presentation/operations_widgets.dart';

class PaymentStatusChip extends StatelessWidget {
  const PaymentStatusChip(this.status, {super.key});
  final PaymentStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        PaymentStatus.unpaid => const StatusChip('Unpaid', color: AppColors.danger, icon: Icons.error_outline),
        PaymentStatus.partiallyPaid => const StatusChip('Partially paid', color: AppColors.warning, icon: Icons.timelapse),
        PaymentStatus.credit => const StatusChip('Credit', color: AppColors.warning, icon: Icons.credit_score_outlined),
        PaymentStatus.paid => const StatusChip('Paid', color: AppColors.success, icon: Icons.check_circle_outline),
        PaymentStatus.cancelled => const StatusChip('Cancelled', color: Colors.grey, icon: Icons.cancel_outlined),
      };
}

/// One line of a money summary (subtotal, discount, total...).
class MoneyLine extends StatelessWidget {
  const MoneyLine(this.label, this.amount, {super.key, this.emphasis = false, this.negative = false, this.color, this.valueKey});
  final String label;
  final Money amount;
  final bool emphasis;
  final bool negative;
  final Color? color;
  final Key? valueKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = (emphasis ? theme.textTheme.titleMedium : theme.textTheme.bodyMedium)?.copyWith(color: color);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [
        Expanded(child: Text(label, style: style)),
        Text(negative ? '− ${amount.format()}' : amount.format(), key: valueKey, style: style),
      ]),
    );
  }
}

class InvoiceTile extends StatelessWidget {
  const InvoiceTile({super.key, required this.invoice, required this.onTap, this.now});
  final Invoice invoice;
  final VoidCallback onTap;

  /// When given, shows how long the balance has been owed.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final i = invoice;
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    return Card(
      key: Key('invoice-tile-${i.invoiceId}'),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              PlateBadge(i.numberPlate),
              const SizedBox(width: AppSpacing.xs),
              Expanded(child: Text(i.invoiceNumber, style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis)),
              PaymentStatusChip(i.paymentStatus),
            ]),
            const SizedBox(height: AppSpacing.xxs),
            Row(children: [
              Expanded(
                child: Text(
                  [i.customerName ?? 'No customer', if (i.issuedAt != null) DateTimeFormatter.date(i.issuedAt!)].join(' · '),
                  style: muted,
                ),
              ),
              Text(i.paymentStatus.isOutstanding ? 'Owes ${i.outstanding.format()}' : i.total.format(),
                  style: theme.textTheme.titleSmall),
            ]),
            if (now != null && i.paymentStatus.isOutstanding)
              Text('Owed for ${_age(i.debtAge(now!))}', style: muted),
          ]),
        ),
      ),
    );
  }

  static String _age(Duration d) => d.inDays < 1 ? 'less than a day' : '${d.inDays} day${d.inDays == 1 ? '' : 's'}';
}

class PaymentTile extends StatelessWidget {
  const PaymentTile({super.key, required this.payment, this.onTap, this.trailing});
  final Payment payment;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final p = payment;
    return Card(
      key: Key('payment-tile-${p.paymentId}'),
      child: ListTile(
        onTap: onTap,
        leading: Icon(p.method == PaymentMethod.cash ? Icons.payments_outlined : Icons.phone_android,
            color: p.reversed ? Colors.grey : theme.colorScheme.primary),
        title: Text(
          p.amount.format(),
          style: p.reversed ? const TextStyle(decoration: TextDecoration.lineThrough, color: Colors.grey) : null,
        ),
        subtitle: Text([
          p.method.label,
          ?p.reference,
          ?p.receiptNumber,
          if (p.receivedAt != null) DateTimeFormatter.dateTime(p.receivedAt!),
          if (p.reversed) 'Reversed${p.reversalReason == null ? '' : ': ${p.reversalReason}'}',
        ].join(' · ')),
        trailing: trailing,
      ),
    );
  }
}
