import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/after_hours.dart';
import '../../../models/invoice.dart';
import '../../../models/loyalty.dart';
import '../../../models/payment.dart';
import '../../after_hours/application/after_hours_providers.dart' show afterHoursPolicyProvider, myOpenSessionProvider;
import '../../finance/application/finance_providers.dart' show paymentAccountOptionsProvider;
import '../../operations/presentation/operations_widgets.dart';
import '../application/billing_providers.dart';
import '../data/billing_api.dart';
import 'billing_widgets.dart';

// ---------------------------------------------------------------------------
// Discount
// ---------------------------------------------------------------------------

/// Discount with a live preview. The server recomputes and re-checks
/// everything; the preview only uses the same formula.
Future<void> showDiscountSheet(BuildContext context, Invoice invoice) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _DiscountSheet(invoice: invoice),
    );

class _DiscountSheet extends ConsumerStatefulWidget {
  const _DiscountSheet({required this.invoice});
  final Invoice invoice;

  @override
  ConsumerState<_DiscountSheet> createState() => _DiscountSheetState();
}

class _DiscountSheetState extends ConsumerState<_DiscountSheet> {
  DiscountType _type = DiscountType.percentage;
  DiscountReason? _reason;
  final _value = TextEditingController();
  final _description = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _value.dispose();
    _description.dispose();
    super.dispose();
  }

  int? get _entered => int.tryParse(_value.text.replaceAll(',', '').trim());

  Future<void> _apply(Money amount) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final r = await ref.read(billingActionsProvider).applyDiscount(widget.invoice.invoiceId,
        type: _type,
        value: _entered!,
        reason: _reason!,
        description: _description.text.trim().isEmpty ? null : _description.text.trim());
    if (!mounted) return;
    setState(() => _saving = false);
    switch (r) {
      case Success():
        AppSnackbar.success(context, 'Discount of ${amount.format()} applied.');
        Navigator.of(context).pop();
      case Failure(:final error):
        setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final inv = widget.invoice;
    final value = _entered;
    final amount = value == null ? null : previewDiscount(inv.subtotal, _type, value);
    final needsApproval =
        amount != null && amount.ugx * 100 > inv.subtotal.ugx * discountApprovalThresholdPercent && !canDo(ref, Permission.discountsApprove);
    final describe = _reason == DiscountReason.other;
    final ready = amount != null && _reason != null && !needsApproval && (!describe || _description.text.trim().length >= 3);
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, MediaQuery.viewInsetsOf(context).bottom + AppSpacing.md),
      child: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text('Discount ${inv.invoiceNumber}', style: theme.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.sm),
          SegmentedButton<DiscountType>(
            segments: [for (final t in DiscountType.values) ButtonSegment(value: t, label: Text(t.label))],
            selected: {_type},
            onSelectionChanged: (s) => setState(() => _type = s.first),
          ),
          const SizedBox(height: AppSpacing.sm),
          TextField(
            key: const Key('discount-value-field'),
            controller: _value,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: _type == DiscountType.percentage ? 'Percentage (1–100)' : 'Amount (UGX)',
              suffixText: _type == DiscountType.percentage ? '%' : 'UGX',
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: AppSpacing.sm),
          DropdownButtonFormField<DiscountReason>(
            key: const Key('discount-reason-field'),
            initialValue: _reason,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Reason'),
            items: [for (final r in DiscountReason.manual) DropdownMenuItem(value: r, child: Text(r.label))],
            onChanged: (r) => setState(() => _reason = r),
          ),
          const SizedBox(height: AppSpacing.sm),
          TextField(
            key: const Key('discount-description-field'),
            controller: _description,
            maxLength: 200,
            decoration: InputDecoration(labelText: describe ? 'Describe the reason' : 'Details (optional)'),
            onChanged: (_) => setState(() {}),
          ),
          MoneyLine('Subtotal', inv.subtotal),
          if (amount != null) ...[
            MoneyLine('Discount', amount, negative: true, valueKey: const Key('discount-preview')),
            MoneyLine('New total', inv.subtotal - amount, emphasis: true),
          ] else if (value != null)
            const InlineError('That discount is not valid for this invoice.'),
          if (needsApproval)
            const InlineError('Discounts above $discountApprovalThresholdPercent% need a manager. Ask a manager to apply it.'),
          if (_error != null) InlineError(_error!),
          const SizedBox(height: AppSpacing.sm),
          FilledButton(
            key: const Key('apply-discount-button'),
            onPressed: ready && !_saving ? () => _apply(amount) : null,
            child: _saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Text('Apply discount'),
          ),
        ]),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Loyalty reward
// ---------------------------------------------------------------------------

/// Shows exactly what the reward will do, then applies it on confirmation.
Future<void> confirmLoyaltyReward(BuildContext context, WidgetRef ref, Invoice invoice, LoyaltyReward reward, LoyaltyAccount account) async {
  final amount = reward.previewFor(invoice.subtotal);
  final ok = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: const Text('Apply loyalty reward?'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('${invoice.numberPlate} has a ${reward.discountPercent}% reward.'),
        const SizedBox(height: AppSpacing.sm),
        MoneyLine('Subtotal', invoice.subtotal),
        MoneyLine('Reward (${reward.discountPercent}%)', amount, negative: true, valueKey: const Key('reward-preview')),
        MoneyLine('New total', invoice.subtotal - amount, emphasis: true),
        const SizedBox(height: AppSpacing.xs),
        Text('Uses ${reward.pointsCost} points: ${account.pointsBalance} → ${account.pointsBalance - reward.pointsCost}.'),
        const SizedBox(height: AppSpacing.xs),
        const Text('A reward can be used once. Cancelling this invoice gives the points back.'),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: const Text('Cancel')),
        FilledButton(
          key: const Key('confirm-reward-button'),
          onPressed: () => Navigator.of(dialog).pop(true),
          child: const Text('Apply reward'),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  final r = await ref.read(billingActionsProvider).applyLoyaltyReward(invoice.invoiceId, amount);
  if (!context.mounted) return;
  r.when(
    success: (_) => AppSnackbar.success(context, 'Loyalty reward applied: ${amount.format()} off.'),
    failure: (f) => AppSnackbar.error(context, f.message),
  );
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/// Records a payment. Returns the outcome (to open the receipt), or null.
Future<PaymentOutcome?> showPaymentSheet(BuildContext context, Invoice invoice) => showModalBottomSheet<PaymentOutcome>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _PaymentSheet(invoice: invoice),
    );

class _PaymentSheet extends ConsumerStatefulWidget {
  const _PaymentSheet({required this.invoice});
  final Invoice invoice;

  @override
  ConsumerState<_PaymentSheet> createState() => _PaymentSheetState();
}

class _PaymentSheetState extends ConsumerState<_PaymentSheet> {
  late final _amount = TextEditingController(text: widget.invoice.outstanding.formatAmount());
  final _reference = TextEditingController();
  PaymentMethod _method = PaymentMethod.cash;

  /// Bank account for a bank payment, when there is more than one to choose from.
  String? _bankAccountId;

  /// One key per attempt: retrying after a lost response cannot pay twice.
  final String _requestId = newRequestId();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _reference.dispose();
    super.dispose();
  }

  Future<void> _submit(Money amount) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final r = await ref.read(billingActionsProvider).recordPayment(PaymentRequest(
          invoiceId: widget.invoice.invoiceId,
          amount: amount,
          method: _method,
          requestId: _requestId,
          reference: _reference.text.trim().isEmpty ? null : _reference.text.trim(),
          accountId: _method == PaymentMethod.bank ? _bankAccountId : null,
        ));
    if (!mounted) return;
    setState(() => _saving = false);
    switch (r) {
      case Success(:final value):
        Navigator.of(context).pop(value);
      case Failure(:final error):
        setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final inv = widget.invoice;
    final amount = Money.tryParse(_amount.text);
    final String? amountError = switch (amount) {
      null when _amount.text.trim().isNotEmpty => 'Whole shillings only',
      Money(isPositive: false) => 'Enter an amount above zero',
      final Money a when a > inv.outstanding => 'More than the ${inv.outstanding.format()} owed. Give change instead.',
      _ => null,
    };
    // Phase 8: during an after-hours session (or for someone who may only
    // collect after hours) only the policy's methods are offered. The server
    // enforces the same policy and ties the payment to the open session.
    final afterHours = canDo(ref, Permission.afterHoursRequest) ? ref.watch(myOpenSessionProvider) : null;
    final collectOnly = !canDo(ref, Permission.paymentsRecord);
    final restricted = afterHours != null || collectOnly;
    final methods = restricted
        ? (ref.watch(afterHoursPolicyProvider).value ?? const AfterHoursPolicy()).allowedPaymentMethods
        : PaymentMethod.values;
    if (methods.isNotEmpty && !methods.contains(_method)) _method = methods.first;
    final noSession = collectOnly && afterHours == null;
    final needsRef = _method.needsReference && _reference.text.trim().isEmpty;
    // Phase 5: the payment lands in a financial account. With several active
    // bank accounts the cashier says which one received a bank payment.
    final banks = ref.watch(paymentAccountOptionsProvider).value ?? const [];
    final needsBank = _method == PaymentMethod.bank && banks.length > 1 && _bankAccountId == null;
    final ready = amount != null && amountError == null && !needsRef && !needsBank && !noSession && methods.isNotEmpty;
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, MediaQuery.viewInsetsOf(context).bottom + AppSpacing.md),
      child: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text('Record payment', style: theme.textTheme.titleLarge),
          Text('${inv.invoiceNumber} · ${inv.numberPlate}', style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.sm),
          MoneyLine('Outstanding', inv.outstanding, emphasis: true),
          if (afterHours != null)
            Text('After-hours session ${afterHours.sessionNumber}: cash you collect is added to what you hand over.',
                key: const Key('payment-after-hours-note'), style: theme.textTheme.bodySmall),
          if (noSession) const InlineError('Open your after-hours session before collecting payments.'),
          const SizedBox(height: AppSpacing.sm),
          TextField(
            key: const Key('payment-amount-field'),
            controller: _amount,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: 'Amount received (UGX)', errorText: amountError),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: AppSpacing.sm),
          Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
            for (final m in methods)
              ChoiceChip(
                key: Key('method-${m.key}'),
                label: Text(m.label),
                selected: _method == m,
                onSelected: (_) => setState(() => _method = m),
              ),
          ]),
          if (_method == PaymentMethod.bank && banks.length > 1) ...[
            const SizedBox(height: AppSpacing.sm),
            DropdownButtonFormField<String>(
              key: const Key('payment-bank-account'),
              initialValue: _bankAccountId,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Received into bank account'),
              items: [for (final b in banks) DropdownMenuItem(value: b.accountId, child: Text(b.label))],
              onChanged: (v) => setState(() => _bankAccountId = v),
            ),
          ],
          if (_method.needsReference) ...[
            const SizedBox(height: AppSpacing.sm),
            TextField(
              key: const Key('payment-reference-field'),
              controller: _reference,
              maxLength: 60,
              decoration: const InputDecoration(labelText: 'Transaction reference'),
              onChanged: (_) => setState(() {}),
            ),
          ],
          if (amount != null && amountError == null) MoneyLine('Balance after', inv.outstanding - amount),
          if (_error != null) InlineError(_error!),
          const SizedBox(height: AppSpacing.sm),
          FilledButton.icon(
            key: const Key('record-payment-button'),
            onPressed: ready && !_saving ? () => _submit(amount) : null,
            icon: const Icon(Icons.check),
            label: _saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(amount == null ? 'Record payment' : 'Record ${amount.format()}'),
          ),
        ]),
      ),
    );
  }
}
