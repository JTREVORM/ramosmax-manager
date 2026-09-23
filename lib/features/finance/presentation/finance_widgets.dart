import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/constants/storage_paths.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/finance.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;

// Building blocks shared by the finance, expenses and inventory screens.

/// Title row at the top of a list screen, with an optional back button and action.
class ScreenHeader extends StatelessWidget {
  const ScreenHeader(this.title, {super.key, this.onBack, this.action, this.subtitle});
  final String title;
  final String? subtitle;
  final VoidCallback? onBack;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.xs),
      child: Row(children: [
        if (onBack != null) IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: onBack),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: theme.textTheme.titleLarge),
            if (subtitle != null) Text(subtitle!, style: theme.textTheme.bodySmall),
          ]),
        ),
        ?action,
      ]),
    );
  }
}

/// A signed amount: green for money in, red for money out.
class SignedAmount extends StatelessWidget {
  const SignedAmount(this.amount, {super.key, this.style});
  final Money amount;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final color = amount.isNegative ? AppColors.danger : AppColors.success;
    final text = amount.isNegative ? '− ${(-amount).format()}' : '+ ${amount.format()}';
    return Text(text, style: (style ?? Theme.of(context).textTheme.titleSmall)?.copyWith(color: color));
  }
}

/// One account and its balance.
class AccountBalanceTile extends StatelessWidget {
  const AccountBalanceTile({super.key, required this.account, this.onTap});
  final FinancialAccount account;
  final VoidCallback? onTap;

  static IconData iconFor(AccountType t) => switch (t) {
        AccountType.cash => Icons.payments_outlined,
        AccountType.mobileMoney => Icons.phone_android,
        AccountType.bank => Icons.account_balance_outlined,
      };

  @override
  Widget build(BuildContext context) {
    final a = account;
    final theme = Theme.of(context);
    return ListTile(
      key: Key('account-${a.accountId}'),
      dense: true,
      contentPadding: EdgeInsets.zero,
      onTap: onTap,
      leading: Icon(iconFor(a.type), color: a.active ? theme.colorScheme.primary : Colors.grey),
      title: Text(a.name, overflow: TextOverflow.ellipsis),
      subtitle: Text([a.type.label, ?a.provider, if (!a.active) 'Inactive'].join(' · '), overflow: TextOverflow.ellipsis),
      trailing: Text(a.balance.format(), key: Key('balance-${a.accountId}'), style: theme.textTheme.titleSmall),
    );
  }
}

/// A ledger entry in a list. With [accountId], shows the change to that account.
class TransactionTile extends StatelessWidget {
  const TransactionTile({super.key, required this.transaction, this.accountId, this.onTap});
  final FinancialTransaction transaction;
  final String? accountId;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = transaction;
    final theme = Theme.of(context);
    final route = [
      if (t.sourceAccountName != null) t.sourceAccountName!,
      if (t.destinationAccountName != null) t.destinationAccountName!,
    ].join(' → ');
    return Card(
      key: Key('txn-${t.transactionId}'),
      child: ListTile(
        onTap: onTap,
        title: Row(children: [
          Expanded(child: Text(t.label, overflow: TextOverflow.ellipsis, style: t.reversed ? const TextStyle(decoration: TextDecoration.lineThrough) : null)),
          if (accountId != null) SignedAmount(t.deltaFor(accountId!)) else Text(t.amount.format(), style: theme.textTheme.titleSmall),
        ]),
        subtitle: Text([
          t.transactionNumber,
          if (route.isNotEmpty) route,
          ?t.invoiceNumber,
          ?t.expenseNumber,
          ?t.purchaseNumber,
          ?t.payrollNumber,
          if (t.createdAt != null) DateTimeFormatter.dateTime(t.createdAt!),
          if (t.reversed) 'Reversed',
        ].join(' · ')),
      ),
    );
  }
}

/// Whole-shilling amount input.
class MoneyField extends StatelessWidget {
  const MoneyField({super.key, required this.controller, required this.label, this.onChanged, this.errorText, this.fieldKey, this.allowZero = false});
  final TextEditingController controller;
  final String label;
  final ValueChanged<String>? onChanged;
  final String? errorText;
  final Key? fieldKey;
  final bool allowZero;

  /// Null when the text is not a valid amount.
  static Money? parse(String text, {bool allowZero = false}) {
    final m = Money.tryParse(text);
    if (m == null || m.isNegative || (!allowZero && m.isZero)) return null;
    return m;
  }

  @override
  Widget build(BuildContext context) => TextField(
        key: fieldKey,
        controller: controller,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9,]'))],
        decoration: InputDecoration(labelText: label, prefixText: 'UGX ', errorText: errorText),
        onChanged: onChanged,
      );
}

/// A business date (EAT), defaulting to today; never after [last].
class DateField extends StatelessWidget {
  const DateField({super.key, required this.label, required this.value, required this.onChanged, this.last, this.first, this.fieldKey});
  final String label;
  final DateTime value;
  final ValueChanged<DateTime> onChanged;
  final DateTime? last;
  final DateTime? first;
  final Key? fieldKey;

  @override
  Widget build(BuildContext context) => InkWell(
        key: fieldKey,
        onTap: () async {
          final picked = await showDatePicker(
            context: context,
            initialDate: value,
            firstDate: first ?? DateTime(2020),
            lastDate: last ?? DateTime.now(),
          );
          if (picked != null) onChanged(DateTime(picked.year, picked.month, picked.day, 12));
        },
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, suffixIcon: const Icon(Icons.calendar_today, size: 18)),
          child: Text(DateTimeFormatter.date(value)),
        ),
      );
}

/// Dropdown of financial accounts (active ones, optionally filtered).
class AccountDropdown extends StatelessWidget {
  const AccountDropdown({
    super.key,
    required this.accounts,
    required this.value,
    required this.onChanged,
    required this.label,
    this.fieldKey,
    this.showBalance = true,
  });
  final List<FinancialAccount> accounts;
  final String? value;
  final ValueChanged<String?> onChanged;
  final String label;
  final Key? fieldKey;
  final bool showBalance;

  @override
  Widget build(BuildContext context) => DropdownButtonFormField<String>(
        key: fieldKey,
        initialValue: accounts.any((a) => a.accountId == value) ? value : null,
        isExpanded: true,
        decoration: InputDecoration(labelText: label),
        items: [
          for (final a in accounts)
            DropdownMenuItem(
              value: a.accountId,
              child: Text(showBalance ? '${a.name} · ${a.balance.format()}' : a.name, overflow: TextOverflow.ellipsis),
            ),
        ],
        onChanged: onChanged,
      );
}

/// Bottom-sheet form scaffold: title, fields, error and one primary button.
class FormSheet extends StatelessWidget {
  const FormSheet({
    super.key,
    required this.title,
    required this.children,
    required this.submitLabel,
    required this.onSubmit,
    this.saving = false,
    this.error,
    this.submitKey,
    this.subtitle,
  });

  final String title;
  final String? subtitle;
  final List<Widget> children;
  final String submitLabel;
  final VoidCallback? onSubmit;
  final bool saving;
  final String? error;
  final Key? submitKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, MediaQuery.viewInsetsOf(context).bottom + AppSpacing.md),
      child: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text(title, style: theme.textTheme.titleLarge),
          if (subtitle != null) Text(subtitle!, style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.sm),
          for (final c in children) Padding(padding: const EdgeInsets.only(bottom: AppSpacing.sm), child: c),
          if (error != null) ...[InlineError(error!), const SizedBox(height: AppSpacing.sm)],
          FilledButton(
            key: submitKey,
            onPressed: saving ? null : onSubmit,
            child: saving
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(submitLabel),
          ),
        ]),
      ),
    );
  }
}

Future<T?> showFormSheet<T>(BuildContext context, Widget sheet) => showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => sheet,
    );

/// Shows a snackbar for [result]; true on success.
bool reportResult(BuildContext context, Result<Object?> result, String success) {
  if (!context.mounted) return false;
  return result.when(
    success: (_) {
      AppSnackbar.success(context, success);
      return true;
    },
    failure: (f) {
      AppSnackbar.error(context, f.message);
      return false;
    },
  );
}

/// Evidence (receipt, slip, statement): picks a photo, uploads it to
/// `finance_uploads/{kind}/…` (or the prefix [pathBuilder] gives, e.g. the
/// Phase 6 `payroll_uploads`) and reports the storage path. Optional.
class AttachmentField extends ConsumerStatefulWidget {
  const AttachmentField({
    super.key,
    required this.kind,
    required this.onChanged,
    this.label = 'Attach photo of slip / receipt (optional)',
    this.pathBuilder = StoragePaths.financeUpload,
  });
  final String kind;
  final ValueChanged<String?> onChanged;
  final String label;
  final String Function(String kind, String uploadId, String fileName) pathBuilder;

  @override
  ConsumerState<AttachmentField> createState() => _AttachmentFieldState();
}

class _AttachmentFieldState extends ConsumerState<AttachmentField> {
  String? _path;
  bool _uploading = false;

  Future<void> _pick(ImageSource source) async {
    final user = ref.read(currentUserProvider);
    if (user == null) return;
    final file = await ImagePicker().pickImage(source: source, maxWidth: 1600, imageQuality: 80);
    if (file == null || !mounted) return;
    setState(() => _uploading = true);
    final bytes = await file.readAsBytes();
    final type = file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    final name = type == 'image/png' ? 'evidence.png' : 'evidence.jpg';
    final path = widget.pathBuilder(widget.kind, newRequestId(), name);
    final r = await ref.read(storageServiceProvider).upload(path: path, bytes: bytes, contentType: type, uploadedBy: user.uid);
    if (!mounted) return;
    setState(() => _uploading = false);
    r.when(
      success: (p) {
        setState(() => _path = p);
        widget.onChanged(p);
      },
      failure: (f) => AppSnackbar.error(context, f.message),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_uploading) return const LinearProgressIndicator();
    if (_path != null) {
      return ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.attach_file, color: AppColors.success),
        title: const Text('Attachment added'),
        trailing: IconButton(
          tooltip: 'Remove',
          icon: const Icon(Icons.close),
          onPressed: () {
            setState(() => _path = null);
            widget.onChanged(null);
          },
        ),
      );
    }
    return Wrap(spacing: AppSpacing.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
      Text(widget.label, style: Theme.of(context).textTheme.bodySmall),
      TextButton.icon(onPressed: () => _pick(ImageSource.camera), icon: const Icon(Icons.photo_camera_outlined), label: const Text('Camera')),
      TextButton.icon(onPressed: () => _pick(ImageSource.gallery), icon: const Icon(Icons.photo_outlined), label: const Text('Gallery')),
    ]);
  }
}

/// Small figure card for dashboards.
class FigureCard extends StatelessWidget {
  const FigureCard({super.key, required this.label, required this.value, this.color, this.onTap, this.caption, this.valueKey});
  final String label;
  final String value;
  final Color? color;
  final String? caption;
  final VoidCallback? onTap;
  final Key? valueKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            FittedBox(fit: BoxFit.scaleDown, child: Text(value, key: valueKey, style: theme.textTheme.titleLarge?.copyWith(color: color))),
            Text(label, style: theme.textTheme.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
            if (caption != null) Text(caption!, style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.outline)),
          ]),
        ),
      ),
    );
  }
}

/// Two-column wrap of [children] that fits phones.
class FigureGrid extends StatelessWidget {
  const FigureGrid({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) {
        final width = (c.maxWidth - AppSpacing.sm) / 2;
        return Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [for (final w in children) SizedBox(width: width, child: w)]);
      });
}

/// Money lines inside a card.
class MoneyCard extends StatelessWidget {
  const MoneyCard({super.key, required this.title, required this.lines, this.footer});
  final String title;
  final List<Widget> lines;
  final String? footer;

  @override
  Widget build(BuildContext context) => SectionCard(title: title, children: [
        ...lines,
        if (footer != null) Text(footer!, style: Theme.of(context).textTheme.bodySmall),
      ]);
}

