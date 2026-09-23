import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/storage_paths.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/money/money.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/finance.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../application/finance_providers.dart';
import 'finance_widgets.dart';

// Every money-moving sheet keeps ONE request ID for its lifetime: pressing
// the button again after a lost response is recorded once by the server.

String? _text(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();

/// Shared state for the posting sheets.
mixin _Saving<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  final String requestId = newRequestId();
  bool saving = false;
  String? error;

  Future<void> submit(Future<Result<Object?>> Function() action, String success) async {
    setState(() {
      saving = true;
      error = null;
    });
    final r = await action();
    if (!mounted) return;
    setState(() => saving = false);
    switch (r) {
      case Success():
        AppSnackbar.success(context, success);
        Navigator.of(context).pop(true);
      case Failure(:final error):
        setState(() => this.error = error.message);
    }
  }
}

class TransferSheet extends ConsumerStatefulWidget {
  const TransferSheet({super.key});

  @override
  ConsumerState<TransferSheet> createState() => _TransferSheetState();
}

class _TransferSheetState extends ConsumerState<TransferSheet> with _Saving {
  String? _from;
  String? _to;
  final _amount = TextEditingController();
  final _reason = TextEditingController();
  final _reference = TextEditingController();
  DateTime _date = DateTime.now();

  @override
  void dispose() {
    _amount.dispose();
    _reason.dispose();
    _reference.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final accounts = (ref.watch(financialAccountsProvider).value ?? const <FinancialAccount>[]).where((a) => a.active).toList();
    final amount = MoneyField.parse(_amount.text);
    FinancialAccount? from;
    for (final a in accounts) {
      if (a.accountId == _from) from = a;
    }
    final String? amountError = switch (amount) {
      null when _amount.text.trim().isNotEmpty => 'Whole shillings above zero',
      final Money m when from != null && m > from.balance => '${from.name} has only ${from.balance.format()}',
      _ => null,
    };
    final same = _from != null && _from == _to;
    final ready = _from != null && _to != null && !same && amount != null && amountError == null && _reason.text.trim().length >= 3;
    return FormSheet(
      title: 'Transfer between accounts',
      subtitle: 'A transfer is not income. Both balances change together.',
      submitLabel: amount == null ? 'Transfer' : 'Transfer ${amount.format()}',
      submitKey: const Key('submit-transfer'),
      saving: saving,
      error: error ?? (same ? 'Choose two different accounts.' : null),
      onSubmit: ready
          ? () => submit(
              () => ref.read(financeActionsProvider).transfer(
                    fromAccountId: _from!,
                    toAccountId: _to!,
                    amount: amount,
                    reason: _reason.text.trim(),
                    requestId: requestId,
                    date: _date,
                    reference: _text(_reference),
                  ),
              'Transferred ${amount.format()}.')
          : null,
      children: [
        AccountDropdown(accounts: accounts, value: _from, label: 'From', fieldKey: const Key('transfer-from'), onChanged: (v) => setState(() => _from = v)),
        AccountDropdown(accounts: accounts, value: _to, label: 'To', fieldKey: const Key('transfer-to'), onChanged: (v) => setState(() => _to = v)),
        MoneyField(controller: _amount, label: 'Amount', fieldKey: const Key('transfer-amount'), errorText: amountError, onChanged: (_) => setState(() {})),
        DateField(label: 'Transfer date', value: _date, onChanged: (d) => setState(() => _date = d)),
        TextField(controller: _reference, maxLength: 60, decoration: const InputDecoration(labelText: 'Reference (optional)')),
        TextField(
          key: const Key('transfer-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: const InputDecoration(labelText: 'Reason'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}

class DepositSheet extends ConsumerStatefulWidget {
  const DepositSheet({super.key, this.suggested = Money.zero});
  final Money suggested;

  @override
  ConsumerState<DepositSheet> createState() => _DepositSheetState();
}

class _DepositSheetState extends ConsumerState<DepositSheet> with _Saving {
  String _source = DefaultAccounts.cashAtHand;
  String? _bank;
  late final _amount = TextEditingController(text: widget.suggested.isPositive ? widget.suggested.formatAmount() : '');
  final _slip = TextEditingController();
  final _description = TextEditingController();
  DateTime _date = DateTime.now();
  String? _attachment;

  @override
  void dispose() {
    _amount.dispose();
    _slip.dispose();
    _description.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final accounts = (ref.watch(financialAccountsProvider).value ?? const <FinancialAccount>[]).where((a) => a.active).toList();
    final sources = accounts.where((a) => a.type != AccountType.bank).toList();
    final banks = accounts.where((a) => a.type == AccountType.bank).toList();
    _bank ??= banks.length == 1 ? banks.single.accountId : null;
    final amount = MoneyField.parse(_amount.text);
    FinancialAccount? source;
    for (final a in sources) {
      if (a.accountId == _source) source = a;
    }
    final String? amountError = switch (amount) {
      null when _amount.text.trim().isNotEmpty => 'Whole shillings above zero',
      final Money m when source != null && m > source.balance => '${source.name} has only ${source.balance.format()}',
      _ => null,
    };
    final ready = _bank != null && amount != null && amountError == null && _slip.text.trim().isNotEmpty;
    return FormSheet(
      title: 'Record bank deposit',
      subtitle: 'Moves money to the bank: not income.',
      submitLabel: amount == null ? 'Record deposit' : 'Deposit ${amount.format()}',
      submitKey: const Key('submit-deposit'),
      saving: saving,
      error: error,
      onSubmit: ready
          ? () => submit(
              () => ref.read(financeActionsProvider).deposit(
                    sourceAccountId: _source,
                    bankAccountId: _bank!,
                    amount: amount,
                    bankReference: _slip.text.trim(),
                    requestId: requestId,
                    date: _date,
                    description: _text(_description),
                    attachmentPath: _attachment,
                  ),
              'Deposit of ${amount.format()} recorded.')
          : null,
      children: [
        AccountDropdown(accounts: sources, value: _source, label: 'From', onChanged: (v) => setState(() => _source = v ?? _source)),
        AccountDropdown(accounts: banks, value: _bank, label: 'Into bank account', fieldKey: const Key('deposit-bank'), onChanged: (v) => setState(() => _bank = v)),
        MoneyField(controller: _amount, label: 'Amount deposited', fieldKey: const Key('deposit-amount'), errorText: amountError, onChanged: (_) => setState(() {})),
        DateField(label: 'Deposit date', value: _date, onChanged: (d) => setState(() => _date = d)),
        TextField(
          key: const Key('deposit-slip'),
          controller: _slip,
          maxLength: 60,
          decoration: const InputDecoration(labelText: 'Bank reference / slip number'),
          onChanged: (_) => setState(() {}),
        ),
        TextField(controller: _description, maxLength: 200, decoration: const InputDecoration(labelText: 'Description (optional)')),
        AttachmentField(kind: FinanceUploadKind.deposits, onChanged: (p) => _attachment = p),
      ],
    );
  }
}

class ReconcileSheet extends ConsumerStatefulWidget {
  const ReconcileSheet({super.key, this.initialAccountId});
  final String? initialAccountId;

  @override
  ConsumerState<ReconcileSheet> createState() => _ReconcileSheetState();
}

class _ReconcileSheetState extends ConsumerState<ReconcileSheet> with _Saving {
  late String? _account = widget.initialAccountId;
  final _actual = TextEditingController();
  final _notes = TextEditingController();
  DateTime _date = DateTime.now();
  String? _attachment;

  @override
  void dispose() {
    _actual.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(financialAccountsProvider).value ?? const <FinancialAccount>[];
    FinancialAccount? account;
    for (final a in accounts) {
      if (a.accountId == _account) account = a;
    }
    final actual = MoneyField.parse(_actual.text, allowZero: true);
    final difference = actual == null || account == null ? null : Reconciliation.differenceOf(actual, account.balance);
    return FormSheet(
      title: 'Reconcile an account',
      subtitle: 'The balance is not changed. A difference needs a separate, authorised adjustment.',
      submitLabel: 'Save reconciliation',
      submitKey: const Key('submit-reconciliation'),
      saving: saving,
      error: error,
      onSubmit: account != null && actual != null
          ? () => submit(
              () => ref.read(financeActionsProvider).reconcile(
                    accountId: account!.accountId,
                    actualBalance: actual,
                    requestId: requestId,
                    date: _date,
                    notes: _text(_notes),
                    attachmentPath: _attachment,
                  ),
              difference!.isZero ? 'Balanced — no difference.' : 'Saved. Difference ${difference.format()}.')
          : null,
      children: [
        AccountDropdown(accounts: accounts, value: _account, label: 'Account', showBalance: false, onChanged: (v) => setState(() => _account = v)),
        MoneyField(
          controller: _actual,
          allowZero: true,
          label: account?.type == AccountType.cash ? 'Physically counted cash' : 'Statement balance',
          fieldKey: const Key('reconcile-actual'),
          onChanged: (_) => setState(() {}),
        ),
        if (account != null) MoneyLine('System balance', account.balance),
        if (difference != null)
          Row(children: [
            const Expanded(child: Text('Difference (actual − system)')),
            Text(
              difference.isZero ? 'None' : difference.format(),
              key: const Key('reconcile-difference'),
              style: TextStyle(fontWeight: FontWeight.w700, color: difference.isZero ? AppColors.success : AppColors.danger),
            ),
          ]),
        DateField(label: 'Reconciliation date', value: _date, onChanged: (d) => setState(() => _date = d)),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes (optional)')),
        AttachmentField(kind: FinanceUploadKind.reconciliations, label: 'Attach statement or count sheet (optional)', onChanged: (p) => _attachment = p),
      ],
    );
  }
}

/// Closes a reconciliation difference with an explicit adjustment (finance.adjust).
class AdjustmentSheet extends ConsumerStatefulWidget {
  const AdjustmentSheet({super.key, required this.reconciliation});
  final Reconciliation reconciliation;

  @override
  ConsumerState<AdjustmentSheet> createState() => _AdjustmentSheetState();
}

class _AdjustmentSheetState extends ConsumerState<AdjustmentSheet> with _Saving {
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.reconciliation;
    final increase = r.difference.isPositive;
    final amount = increase ? r.difference : -r.difference;
    return FormSheet(
      title: 'Adjust ${r.accountName}',
      subtitle: '${increase ? 'Adds' : 'Removes'} ${amount.format()} so the system matches ${r.reconciliationNumber}. '
          'This is recorded in the ledger and audit log.',
      submitLabel: '${increase ? 'Add' : 'Remove'} ${amount.format()}',
      submitKey: const Key('submit-adjustment'),
      saving: saving,
      error: error,
      onSubmit: _reason.text.trim().length >= 3
          ? () => submit(
              () => ref.read(financeActionsProvider).adjust(
                    accountId: r.accountId,
                    increase: increase,
                    amount: amount,
                    reason: _reason.text.trim(),
                    requestId: requestId,
                    reconciliationId: r.reconciliationId,
                  ),
              'Adjustment recorded.')
          : null,
      children: [
        TextField(
          key: const Key('adjustment-reason'),
          controller: _reason,
          maxLength: 500,
          decoration: const InputDecoration(labelText: 'Reason for the difference'),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }
}

class OpeningBalanceSheet extends ConsumerStatefulWidget {
  const OpeningBalanceSheet({super.key, required this.account});
  final FinancialAccount account;

  @override
  ConsumerState<OpeningBalanceSheet> createState() => _OpeningBalanceSheetState();
}

class _OpeningBalanceSheetState extends ConsumerState<OpeningBalanceSheet> with _Saving {
  final _amount = TextEditingController();
  final _reason = TextEditingController();

  @override
  void dispose() {
    _amount.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final amount = MoneyField.parse(_amount.text);
    return FormSheet(
      title: 'Opening balance — ${widget.account.name}',
      subtitle: 'The money this account held when RamosMAX started tracking it. It can be recorded once.',
      submitLabel: 'Record opening balance',
      submitKey: const Key('submit-opening-balance'),
      saving: saving,
      error: error,
      onSubmit: amount == null
          ? null
          : () => submit(() => ref.read(financeActionsProvider).recordOpeningBalance(widget.account.accountId, amount, reason: _text(_reason)),
              'Opening balance recorded.'),
      children: [
        MoneyField(controller: _amount, label: 'Opening balance', fieldKey: const Key('opening-amount'), onChanged: (_) => setState(() {})),
        TextField(controller: _reason, maxLength: 500, decoration: const InputDecoration(labelText: 'Note (optional)')),
      ],
    );
  }
}

class AccountFormSheet extends ConsumerStatefulWidget {
  const AccountFormSheet({super.key, this.existing});
  final FinancialAccount? existing;

  @override
  ConsumerState<AccountFormSheet> createState() => _AccountFormSheetState();
}

class _AccountFormSheetState extends ConsumerState<AccountFormSheet> with _Saving {
  late final _name = TextEditingController(text: widget.existing?.name);
  late final _provider = TextEditingController(text: widget.existing?.provider);
  late final _number = TextEditingController(text: widget.existing?.accountNumber);
  late final _notes = TextEditingController(text: widget.existing?.notes);
  final _opening = TextEditingController();
  AccountType _type = AccountType.bank;

  @override
  void dispose() {
    for (final c in [_name, _provider, _number, _notes, _opening]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.existing;
    final opening = _opening.text.trim().isEmpty ? null : MoneyField.parse(_opening.text, allowZero: true);
    final ready = _name.text.trim().length >= 2 && (_opening.text.trim().isEmpty || opening != null);
    final actions = ref.read(financeActionsProvider);
    return FormSheet(
      title: e == null ? 'New account' : 'Edit ${e.name}',
      submitLabel: e == null ? 'Create account' : 'Save',
      submitKey: const Key('submit-account'),
      saving: saving,
      error: error,
      onSubmit: !ready
          ? null
          : () => submit(
                () => e == null
                    ? actions.createAccount(
                        name: _name.text.trim(),
                        type: _type,
                        provider: _text(_provider),
                        accountNumber: _text(_number),
                        notes: _text(_notes),
                        openingBalance: opening,
                      )
                    : actions.updateAccount(e.accountId,
                        name: _name.text.trim(), provider: _provider.text.trim(), accountNumber: _number.text.trim(), notes: _notes.text.trim()),
                e == null ? 'Account created.' : 'Account updated.',
              ),
      children: [
        if (e == null)
          SegmentedButton<AccountType>(
            segments: const [
              ButtonSegment(value: AccountType.bank, label: Text('Bank')),
              ButtonSegment(value: AccountType.mobileMoney, label: Text('Mobile money')),
            ],
            selected: {_type},
            onSelectionChanged: (s) => setState(() => _type = s.first),
          ),
        TextField(key: const Key('account-name'), controller: _name, maxLength: 60, decoration: const InputDecoration(labelText: 'Account name'), onChanged: (_) => setState(() {})),
        TextField(controller: _provider, maxLength: 60, decoration: const InputDecoration(labelText: 'Bank / provider')),
        TextField(controller: _number, maxLength: 40, decoration: const InputDecoration(labelText: 'Account or merchant number')),
        if (e == null)
          MoneyField(controller: _opening, allowZero: true, label: 'Opening balance (optional)', onChanged: (_) => setState(() {})),
        TextField(controller: _notes, maxLength: 300, decoration: const InputDecoration(labelText: 'Notes')),
      ],
    );
  }
}

/// Picks the account a payment leaves from, showing balances; returns its ID.
Future<String?> pickPaymentAccount(BuildContext context, {required Money amount, String? suggested, String title = 'Pay from'}) =>
    showFormSheet<String>(context, _PickAccountSheet(amount: amount, suggested: suggested, title: title));

class _PickAccountSheet extends ConsumerStatefulWidget {
  const _PickAccountSheet({required this.amount, required this.title, this.suggested});
  final Money amount;
  final String title;
  final String? suggested;

  @override
  ConsumerState<_PickAccountSheet> createState() => _PickAccountSheetState();
}

class _PickAccountSheetState extends ConsumerState<_PickAccountSheet> {
  late String? _account = widget.suggested;

  @override
  Widget build(BuildContext context) {
    final accounts = (ref.watch(financialAccountsProvider).value ?? const <FinancialAccount>[]).where((a) => a.active).toList();
    FinancialAccount? chosen;
    for (final a in accounts) {
      if (a.accountId == _account) chosen = a;
    }
    final short = chosen != null && chosen.balance < widget.amount;
    return FormSheet(
      title: '${widget.title}: ${widget.amount.format()}',
      subtitle: 'Money leaves this account only now, when you confirm.',
      submitLabel: 'Pay ${widget.amount.format()}',
      submitKey: const Key('confirm-pay-from'),
      error: short ? '${chosen.name} has only ${chosen.balance.format()}.' : null,
      onSubmit: chosen == null || short ? null : () => Navigator.of(context).pop(_account),
      children: [
        AccountDropdown(accounts: accounts, value: _account, label: 'Account', fieldKey: const Key('pay-from-account'), onChanged: (v) => setState(() => _account = v)),
      ],
    );
  }
}
