import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/constants/storage_paths.dart';
import '../../../core/errors/app_failure.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/callables.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/expense.dart';
import '../../../models/finance.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../finance/application/finance_providers.dart';
import '../../finance/presentation/finance_forms.dart' show pickPaymentAccount;
import '../../finance/presentation/finance_widgets.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/application/user_management_providers.dart' show currentUserProvider;
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/expenses_providers.dart';
import '../data/expenses_api.dart';

class ExpenseStatusChip extends StatelessWidget {
  const ExpenseStatusChip(this.status, {super.key});
  final ExpenseStatus status;

  @override
  Widget build(BuildContext context) => switch (status) {
        ExpenseStatus.draft => const StatusChip('Draft', color: Colors.grey, icon: Icons.edit_note),
        ExpenseStatus.pendingReview => const StatusChip('Pending approval', color: AppColors.warning, icon: Icons.hourglass_top),
        ExpenseStatus.approved => const StatusChip('Approved · unpaid', color: AppColors.info, icon: Icons.thumb_up_alt_outlined),
        ExpenseStatus.rejected => const StatusChip('Rejected', color: AppColors.danger, icon: Icons.block),
        ExpenseStatus.paid => const StatusChip('Paid', color: AppColors.success, icon: Icons.check_circle_outline),
        ExpenseStatus.cancelled => const StatusChip('Cancelled', color: Colors.grey, icon: Icons.cancel_outlined),
      };
}

class ExpenseTile extends StatelessWidget {
  const ExpenseTile({super.key, required this.expense, required this.onTap});
  final Expense expense;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final e = expense;
    final theme = Theme.of(context);
    return Card(
      key: Key('expense-${e.expenseId}'),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(e.description, style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis)),
              Text(e.amount.format(), style: theme.textTheme.titleSmall),
            ]),
            const SizedBox(height: AppSpacing.xxs),
            Row(children: [
              Expanded(
                child: Text(
                  [e.expenseNumber, e.categoryName, ?e.payee, if (e.expenseDate != null) DateTimeFormatter.date(e.expenseDate!)].join(' · '),
                  style: theme.textTheme.bodySmall,
                ),
              ),
              ExpenseStatusChip(e.status),
            ]),
          ]),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Expenses module: tabs
// ---------------------------------------------------------------------------

class ExpensesScreen extends ConsumerWidget {
  const ExpensesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tabs = <(String, Widget)>[
      ('Expenses', const _ExpenseList()),
      ('Pending approval', const _ExpenseList(status: ExpenseStatus.pendingReview)),
      ('Recurring', const RecurringExpensesTab()),
      ('Categories', const ExpenseCategoriesTab()),
      if (canDo(ref, Permission.reportsFinancialView) || canDo(ref, Permission.expensesApprove)) ('Reports', const ExpenseReportsTab()),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        floatingActionButton: canDo(ref, Permission.expensesCreate)
            ? FloatingActionButton.extended(
                key: const Key('new-expense-button'),
                onPressed: () => context.go(AppRoutes.newExpense),
                icon: const Icon(Icons.add),
                label: const Text('Expense'),
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

class _ExpenseList extends ConsumerStatefulWidget {
  const _ExpenseList({this.status});
  final ExpenseStatus? status;

  @override
  ConsumerState<_ExpenseList> createState() => _ExpenseListState();
}

class _ExpenseListState extends ConsumerState<_ExpenseList> {
  late ExpenseStatus? _status = widget.status;
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final fixed = widget.status != null;
    return Column(children: [
      if (!fixed)
        FilterChips<ExpenseStatus?>(
          values: const [null, ...ExpenseStatus.values],
          selected: _status,
          label: (s) => s?.label ?? 'All',
          keyPrefix: 'expense-status',
          onSelected: (s) => setState(() => _status = s),
        ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
        child: TextField(
          key: const Key('expense-search'),
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Description, payee or number', isDense: true),
          onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
        ),
      ),
      Expanded(
        child: switch (ref.watch(expensesProvider(_status))) {
          AsyncData(:final value) => () {
              final shown = value
                  .where((e) => _query.isEmpty ||
                      e.description.toLowerCase().contains(_query) ||
                      (e.payee ?? '').toLowerCase().contains(_query) ||
                      e.expenseNumber.toLowerCase().contains(_query))
                  .toList();
              if (shown.isEmpty) {
                return EmptyView(
                  icon: Icons.request_quote_outlined,
                  title: fixed ? 'Nothing waiting for approval' : 'No expenses',
                  message: fixed ? 'Submitted expenses appear here for review and approval.' : 'Record an expense with the + button.',
                );
              }
              return ListView(
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                    child: MoneyLine('${shown.length} shown', Money.sum(shown.map((e) => e.amount)), valueKey: const Key('expense-list-total')),
                  ),
                  for (final e in shown) ExpenseTile(expense: e, onTap: () => context.go(AppRoutes.expenseDetail(e.expenseId))),
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
// Create / edit
// ---------------------------------------------------------------------------

class ExpenseFormScreen extends ConsumerStatefulWidget {
  const ExpenseFormScreen({super.key, this.expenseId});
  final String? expenseId;

  @override
  ConsumerState<ExpenseFormScreen> createState() => _ExpenseFormScreenState();
}

class _ExpenseFormScreenState extends ConsumerState<ExpenseFormScreen> {
  final _description = TextEditingController();
  final _amount = TextEditingController();
  final _payee = TextEditingController();
  final _reference = TextEditingController();
  final _notes = TextEditingController();
  String? _category;
  String? _account;
  DateTime _date = DateTime.now();
  String? _attachment;
  final String _requestId = newRequestId();
  bool _loaded = false;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_description, _amount, _payee, _reference, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  void _load(Expense e) {
    if (_loaded) return;
    _loaded = true;
    _description.text = e.description;
    _amount.text = e.amount.formatAmount();
    _payee.text = e.payee ?? '';
    _reference.text = e.reference ?? '';
    _notes.text = e.notes ?? '';
    _category = e.categoryId;
    _account = e.paymentAccountId;
    _date = e.expenseDate ?? _date;
  }

  ExpenseDraft? _draft() {
    final amount = MoneyField.parse(_amount.text);
    if (_category == null || amount == null || _description.text.trim().isEmpty) return null;
    String? t(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();
    return ExpenseDraft(
      categoryId: _category!,
      description: _description.text.trim(),
      amount: amount,
      expenseDate: _date,
      payee: t(_payee),
      paymentAccountId: _account,
      reference: t(_reference),
      notes: t(_notes),
      attachmentPath: _attachment,
    );
  }

  Future<void> _save({required bool submit}) async {
    final draft = _draft();
    if (draft == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final actions = ref.read(expenseActionsProvider);
    final Result<String> r = widget.expenseId == null
        ? await actions.create(draft, submit: submit, requestId: _requestId)
        : (await actions.update(widget.expenseId!, draft)).when(success: (_) => Success(widget.expenseId!), failure: Failure.new);
    if (!mounted) return;
    setState(() => _saving = false);
    switch (r) {
      case Success(:final value):
        AppSnackbar.success(context, submit ? 'Expense submitted for review.' : 'Expense saved.');
        context.go(AppRoutes.expenseDetail(value));
      case Failure(:final error):
        setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.expenseId != null) {
      final existing = ref.watch(expenseProvider(widget.expenseId!)).value;
      if (existing == null) return const LoadingView();
      _load(existing);
    }
    final categories = (ref.watch(expenseCategoriesProvider).value ?? ExpenseCategory.merge(const [])).where((c) => c.active || c.categoryId == _category).toList();
    final accounts = canDo(ref, Permission.financeView)
        ? (ref.watch(financialAccountsProvider).value ?? const []).where((a) => a.active).toList()
        : const <Never>[];
    final amount = MoneyField.parse(_amount.text);
    final ready = _draft() != null && !_saving;
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
      children: [
        ScreenHeader(widget.expenseId == null ? 'New expense' : 'Edit expense',
            subtitle: 'Recording an expense does not move money. It is paid only after approval.',
            onBack: () => context.go(widget.expenseId == null ? AppRoutes.expenses : AppRoutes.expenseDetail(widget.expenseId!))),
        DropdownButtonFormField<String>(
          key: const Key('expense-category'),
          initialValue: _category,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Category'),
          items: [for (final c in categories) DropdownMenuItem(value: c.categoryId, child: Text(c.name))],
          onChanged: (v) => setState(() => _category = v),
        ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          key: const Key('expense-description'),
          controller: _description,
          maxLength: 200,
          decoration: const InputDecoration(labelText: 'Description', hintText: 'e.g. Office electricity, September'),
          onChanged: (_) => setState(() {}),
        ),
        MoneyField(
          controller: _amount,
          label: 'Amount',
          fieldKey: const Key('expense-amount'),
          errorText: amount == null && _amount.text.trim().isNotEmpty ? 'Whole shillings above zero' : null,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: AppSpacing.sm),
        DateField(label: 'Expense date', value: _date, last: DateTime.now().add(const Duration(days: 365)), onChanged: (d) => setState(() => _date = d)),
        const SizedBox(height: AppSpacing.sm),
        TextField(controller: _payee, maxLength: 80, decoration: const InputDecoration(labelText: 'Vendor / payee')),
        if (accounts.isNotEmpty)
          AccountDropdown(
            accounts: accounts,
            value: _account,
            label: 'Planned payment account (optional)',
            showBalance: false,
            onChanged: (v) => setState(() => _account = v),
          ),
        const SizedBox(height: AppSpacing.sm),
        TextField(controller: _reference, maxLength: 60, decoration: const InputDecoration(labelText: 'Bill / invoice reference')),
        TextField(controller: _notes, maxLength: 500, decoration: const InputDecoration(labelText: 'Notes')),
        if (widget.expenseId == null) AttachmentField(kind: FinanceUploadKind.expenses, label: 'Attach receipt or bill (optional)', onChanged: (p) => _attachment = p),
        if (_error != null) InlineError(_error!),
        const SizedBox(height: AppSpacing.sm),
        FilledButton.icon(
          key: const Key('submit-expense'),
          onPressed: ready ? () => _save(submit: widget.expenseId == null) : null,
          icon: const Icon(Icons.send),
          label: Text(widget.expenseId == null ? 'Submit for approval' : 'Save changes'),
        ),
        if (widget.expenseId == null)
          TextButton(key: const Key('save-expense-draft'), onPressed: ready ? () => _save(submit: false) : null, child: const Text('Save as draft')),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Detail and workflow
// ---------------------------------------------------------------------------

class ExpenseDetailScreen extends ConsumerWidget {
  const ExpenseDetailScreen({super.key, required this.expenseId});
  final String expenseId;

  static const _permissionFor = {
    ExpenseAction.submit: Permission.expensesCreate,
    ExpenseAction.review: Permission.expensesReview,
    ExpenseAction.approve: Permission.expensesApprove,
    ExpenseAction.reject: Permission.expensesReview,
    ExpenseAction.cancel: Permission.expensesCancel,
  };

  bool _allowed(WidgetRef ref, Expense e, ExpenseAction a) {
    if (a == ExpenseAction.reject) return canDo(ref, Permission.expensesReview) || canDo(ref, Permission.expensesApprove);
    if (!canDo(ref, _permissionFor[a]!)) return false;
    if (a == ExpenseAction.submit) return e.createdBy == ref.watch(currentUserProvider)?.uid || canDo(ref, Permission.expensesReview);
    return true;
  }

  Future<void> _act(BuildContext context, WidgetRef ref, Expense e, ExpenseAction a) async {
    String? reason;
    String? notes;
    if (a.needsReason) {
      reason = await showReasonDialog(context,
          title: '${a.label} ${e.expenseNumber}?',
          message: a == ExpenseAction.reject ? 'Say why it is rejected.' : 'Say why it is cancelled. The record is kept.',
          confirmLabel: a.label,
          destructive: true);
      if (reason == null) return;
    } else if (a == ExpenseAction.review) {
      final entered = await showReasonDialog(context,
          title: 'Mark ${e.expenseNumber} reviewed?',
          message: 'Confirm the bill, amount and payee are correct.',
          confirmLabel: 'Reviewed',
          reasonRequired: false,
          reasonLabel: 'Review notes');
      if (entered == null) return;
      notes = entered.isEmpty ? null : entered;
    } else {
      final ok = await showConfirmDialog(context,
          title: '${a.label}?',
          message: a == ExpenseAction.approve
              ? 'Approving does not pay it. ${e.amount.format()} leaves an account only when someone pays it.'
              : 'Send ${e.expenseNumber} for review.',
          confirmLabel: a.label);
      if (!ok) return;
    }
    if (!context.mounted) return;
    final r = await ref.read(expenseActionsProvider).act(e.expenseId, a, reason: reason, notes: notes);
    if (context.mounted) reportResult(context, r, 'Expense ${a.done}.');
  }

  Future<void> _pay(BuildContext context, WidgetRef ref, Expense e) async {
    final accountId = await pickPaymentAccount(context, amount: e.amount, suggested: e.paymentAccountId, title: 'Pay ${e.expenseNumber}');
    if (accountId == null || !context.mounted) return;
    final r = await ref.read(expenseActionsProvider).pay(e.expenseId, accountId: accountId, requestId: newRequestId());
    if (context.mounted) reportResult(context, r, 'Paid ${e.amount.format()}.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return switch (ref.watch(expenseProvider(expenseId))) {
      AsyncData(value: final Expense e) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
          children: [
            ScreenHeader(e.expenseNumber, subtitle: e.categoryName, onBack: () => context.go(AppRoutes.expenses)),
            Align(alignment: Alignment.centerLeft, child: ExpenseStatusChip(e.status)),
            const SizedBox(height: AppSpacing.xs),
            SectionCard(title: e.description, children: [
              MoneyLine('Amount', e.amount, emphasis: true, valueKey: const Key('expense-amount-value')),
              InfoRow('Category', e.categoryName),
              if (e.expenseDate != null) InfoRow('Expense date', DateTimeFormatter.date(e.expenseDate!)),
              if (e.dueDate != null) InfoRow('Due', DateTimeFormatter.date(e.dueDate!)),
              InfoRow('Payee', e.payee),
              InfoRow('Reference', e.reference),
              InfoRow('Notes', e.notes),
              InfoRow('Attachment', e.attachmentPath == null ? null : 'Attached'),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(title: 'History', icon: Icons.timeline, children: [
              InfoRow('Created by', [?e.createdByName, if (e.createdAt != null) DateTimeFormatter.dateTime(e.createdAt!)].join(' · ')),
              if (e.recurringExpenseId != null) const InfoRow('Source', 'Recurring expense (due item)'),
              if (e.reviewedAt != null)
                InfoRow('Reviewed', [?e.reviewedByName, DateTimeFormatter.dateTime(e.reviewedAt!), ?e.reviewNotes].join(' · ')),
              if (e.approvedAt != null) InfoRow('Approved', [?e.approvedByName, DateTimeFormatter.dateTime(e.approvedAt!)].join(' · ')),
              if (e.status == ExpenseStatus.rejected) InfoRow('Rejected', e.rejectionReason),
              if (e.paidAt != null)
                InfoRow('Paid', [?e.paidByName, ?e.paidFromAccountName, DateTimeFormatter.date(e.paidAt!), ?e.financialTransactionNumber].join(' · ')),
              if (e.status == ExpenseStatus.cancelled) InfoRow('Cancelled', e.cancelReason),
              if (e.paymentReversalReason != null) InfoRow('Payment reversed', e.paymentReversalReason),
            ]),
            const SizedBox(height: AppSpacing.sm),
            if (e.canPay && canDo(ref, Permission.expensesPay))
              FilledButton.icon(
                key: const Key('pay-expense-button'),
                icon: const Icon(Icons.payments_outlined),
                label: Text('Pay ${e.amount.format()}'),
                onPressed: () => _pay(context, ref, e),
              ),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              for (final a in e.availableActions)
                if (_allowed(ref, e, a))
                  OutlinedButton(key: Key('expense-action-${a.key}'), onPressed: () => _act(context, ref, e, a), child: Text(a.label)),
              if (e.canEdit && (e.createdBy == ref.watch(currentUserProvider)?.uid || canDo(ref, Permission.expensesReview)) && canDo(ref, Permission.expensesCreate))
                OutlinedButton(key: const Key('edit-expense-button'), onPressed: () => context.go(AppRoutes.editExpense(e.expenseId)), child: const Text('Edit')),
              if (e.financialTransactionId != null && canDo(ref, Permission.financeTransactionsView))
                TextButton(onPressed: () => context.go(AppRoutes.financeTransaction(e.financialTransactionId!)), child: const Text('Open payment')),
            ]),
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.request_quote_outlined, title: 'Expense not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

class RecurringExpensesTab extends ConsumerWidget {
  const RecurringExpensesTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manage = canDo(ref, Permission.expensesRecurringManage);
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    return switch (ref.watch(recurringExpensesProvider)) {
      AsyncData(:final value) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
          children: [
            const Text('Bills that come round again (rent, internet, security…). RamosMAX reminds approvers and creates a draft '
                'expense when each is due. Nothing is ever paid automatically.'),
            if (manage)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  key: const Key('new-recurring-button'),
                  icon: const Icon(Icons.add),
                  label: const Text('Add recurring expense'),
                  onPressed: () => showFormSheet<void>(context, const RecurringExpenseSheet()),
                ),
              ),
            if (value.isEmpty) const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Center(child: Text('No recurring expenses yet.'))),
            for (final r in value)
              Card(
                key: Key('recurring-${r.recurringExpenseId}'),
                child: ListTile(
                  onTap: manage ? () => showFormSheet<void>(context, RecurringExpenseSheet(existing: r)) : null,
                  leading: Icon(Icons.event_repeat, color: r.active ? Theme.of(context).colorScheme.primary : Colors.grey),
                  title: Text('${r.name} · ${r.expectedAmount.format()}'),
                  subtitle: Text([
                    r.frequency.label,
                    r.categoryName,
                    if (!r.active) 'Inactive'
                    else if (r.nextDueDate != null) 'Next due ${DateTimeFormatter.date(r.nextDueDate!)}${_dueIn(r, now)}',
                  ].join(' · ')),
                  trailing: manage
                      ? Switch(
                          key: Key('recurring-active-${r.recurringExpenseId}'),
                          value: r.active,
                          onChanged: (on) async {
                            String? reason;
                            if (!on) {
                              reason = await showReasonDialog(context,
                                  title: 'Stop "${r.name}"?', message: 'No more reminders or due items will be created.', confirmLabel: 'Stop');
                              if (reason == null) return;
                            }
                            final res = await ref.read(expenseActionsProvider).updateRecurring(r.recurringExpenseId, active: on, reason: reason);
                            if (context.mounted) reportResult(context, res, on ? 'Recurring expense resumed.' : 'Recurring expense stopped.');
                          },
                        )
                      : null,
                ),
              ),
          ],
        ),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }

  static String _dueIn(RecurringExpense r, DateTime now) {
    final d = r.daysUntilDue(now);
    if (d == null) return '';
    if (d < 0) return ' (overdue)';
    if (d == 0) return ' (today)';
    return ' (in $d day${d == 1 ? '' : 's'})';
  }
}

class RecurringExpenseSheet extends ConsumerStatefulWidget {
  const RecurringExpenseSheet({super.key, this.existing});
  final RecurringExpense? existing;

  @override
  ConsumerState<RecurringExpenseSheet> createState() => _RecurringExpenseSheetState();
}

class _RecurringExpenseSheetState extends ConsumerState<RecurringExpenseSheet> {
  late final _name = TextEditingController(text: widget.existing?.name);
  late final _amount = TextEditingController(text: widget.existing?.expectedAmount.formatAmount());
  late final _payee = TextEditingController(text: widget.existing?.payee);
  late String? _category = widget.existing?.categoryId;
  late ExpenseFrequency _frequency = widget.existing?.frequency ?? ExpenseFrequency.monthly;
  late DateTime _due = widget.existing?.nextDueDate ?? DateTime.now().add(const Duration(days: 7));
  late int _remind = widget.existing?.reminderDaysBefore ?? 3;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _amount.dispose();
    _payee.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final categories = (ref.watch(expenseCategoriesProvider).value ?? ExpenseCategory.merge(const [])).where((c) => c.active).toList();
    final amount = MoneyField.parse(_amount.text);
    final ready = _name.text.trim().isNotEmpty && _category != null && amount != null;
    return FormSheet(
      title: widget.existing == null ? 'New recurring expense' : 'Edit ${widget.existing!.name}',
      submitLabel: 'Save',
      submitKey: const Key('submit-recurring'),
      saving: _saving,
      error: _error,
      onSubmit: !ready
          ? null
          : () async {
              setState(() => _saving = true);
              final draft = RecurringDraft(
                name: _name.text.trim(),
                categoryId: _category!,
                expectedAmount: amount,
                frequency: _frequency,
                nextDueDate: _due,
                payee: _payee.text.trim().isEmpty ? null : _payee.text.trim(),
                reminderDaysBefore: _remind,
              );
              final actions = ref.read(expenseActionsProvider);
              final r = widget.existing == null
                  ? await actions.createRecurring(draft)
                  : await actions.updateRecurring(widget.existing!.recurringExpenseId, draft: draft);
              if (!mounted) return;
              setState(() => _saving = false);
              r.when(
                success: (_) {
                  AppSnackbar.success(context, 'Recurring expense saved.');
                  Navigator.of(context).pop();
                },
                failure: (f) => setState(() => _error = f.message),
              );
            },
      children: [
        TextField(key: const Key('recurring-name'), controller: _name, maxLength: 80, decoration: const InputDecoration(labelText: 'Name (e.g. Office rent)'), onChanged: (_) => setState(() {})),
        DropdownButtonFormField<String>(
          key: const Key('recurring-category'),
          initialValue: _category,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Category'),
          items: [for (final c in categories) DropdownMenuItem(value: c.categoryId, child: Text(c.name))],
          onChanged: (v) => setState(() => _category = v),
        ),
        MoneyField(controller: _amount, label: 'Expected amount', fieldKey: const Key('recurring-amount'), onChanged: (_) => setState(() {})),
        SegmentedButton<ExpenseFrequency>(
          segments: [for (final f in ExpenseFrequency.values) ButtonSegment(value: f, label: Text(f.label))],
          selected: {_frequency},
          onSelectionChanged: (s) => setState(() => _frequency = s.first),
        ),
        DateField(
          label: 'Next due date',
          value: _due,
          first: DateTime.now().subtract(const Duration(days: 365)),
          last: DateTime.now().add(const Duration(days: 400)),
          onChanged: (d) => setState(() => _due = d),
        ),
        DropdownButtonFormField<int>(
          initialValue: _remind,
          decoration: const InputDecoration(labelText: 'Remind'),
          items: [for (final d in const [0, 1, 3, 5, 7, 14]) DropdownMenuItem(value: d, child: Text(d == 0 ? 'On the due date' : '$d day${d == 1 ? '' : 's'} before'))],
          onChanged: (v) => setState(() => _remind = v ?? _remind),
        ),
        TextField(controller: _payee, maxLength: 80, decoration: const InputDecoration(labelText: 'Vendor / payee')),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

class ExpenseCategoriesTab extends ConsumerWidget {
  const ExpenseCategoriesTab({super.key});

  Future<void> _rename(BuildContext context, WidgetRef ref, ExpenseCategory? c) async {
    final name = await showReasonDialog(context,
        title: c == null ? 'New category' : 'Rename ${c.name}',
        message: c == null ? 'Name the new expense category.' : 'Enter the new name.',
        confirmLabel: 'Save',
        reasonLabel: 'Category name');
    if (name == null || !context.mounted) return;
    final actions = ref.read(expenseActionsProvider);
    final r = c == null ? await actions.createCategory(name) : await actions.updateCategory(c.categoryId, name: name);
    if (context.mounted) reportResult(context, r, 'Category saved.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manage = canDo(ref, Permission.expensesCategoriesManage);
    final list = ref.watch(expenseCategoriesProvider).value ?? ExpenseCategory.merge(const []);
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
      children: [
        if (manage)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              key: const Key('new-category-button'),
              icon: const Icon(Icons.add),
              label: const Text('Add category'),
              onPressed: () => _rename(context, ref, null),
            ),
          ),
        for (final c in list)
          Card(
            key: Key('category-${c.categoryId}'),
            child: ListTile(
              title: Text(c.name, style: c.active ? null : const TextStyle(color: Colors.grey)),
              subtitle: Text([if (c.isDefault) 'Built-in', if (!c.active) 'Not in use'].join(' · ')),
              onTap: manage ? () => _rename(context, ref, c) : null,
              trailing: manage
                  ? Switch(
                      value: c.active,
                      onChanged: (on) async {
                        String? reason;
                        if (!on) {
                          reason = await showReasonDialog(context,
                              title: 'Stop using ${c.name}?', message: 'Existing expenses keep it.', confirmLabel: 'Stop using');
                          if (reason == null) return;
                        }
                        final r = await ref.read(expenseActionsProvider).updateCategory(c.categoryId, active: on, reason: reason);
                        if (context.mounted) reportResult(context, r, 'Category updated.');
                      },
                    )
                  : null,
            ),
          ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

class ExpenseReportsTab extends ConsumerStatefulWidget {
  const ExpenseReportsTab({super.key});

  @override
  ConsumerState<ExpenseReportsTab> createState() => _ExpenseReportsTabState();
}

class _ExpenseReportsTabState extends ConsumerState<ExpenseReportsTab> {
  FinancePeriod _period = FinancePeriod.month;
  String? _category;

  @override
  Widget build(BuildContext context) {
    final expenses = ref.watch(periodExpensesProvider(_period));
    final paidTotals = canDo(ref, Permission.financeView) ? ref.watch(periodSummariesProvider(_period)).value : null;
    final categories = ref.watch(expenseCategoriesProvider).value ?? ExpenseCategory.merge(const []);
    final large = ref.watch(largeExpensesProvider).value ?? const <Expense>[];
    final threshold = ref.watch(largeExpenseThresholdProvider).value ?? 500000;
    return ListView(
      padding: const EdgeInsets.fromLTRB(0, AppSpacing.sm, 0, 96),
      children: [
        FilterChips<FinancePeriod>(
          values: FinancePeriod.values,
          selected: _period,
          label: (p) => p.label,
          keyPrefix: 'expense-period',
          onSelected: (p) => setState(() => _period = p),
        ),
        FilterChips<String?>(
          values: [null, for (final c in categories) c.categoryId],
          selected: _category,
          label: (id) => id == null ? 'All categories' : ExpenseCategory.nameOf(id, categories),
          keyPrefix: 'expense-report-category',
          onSelected: (c) => setState(() => _category = c),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
          child: switch (expenses) {
            AsyncData(:final value) => () {
                final list = value.where((e) => _category == null || e.categoryId == _category).toList();
                final totals = ExpenseTotals.of(list);
                final byDay = <String, Money>{};
                for (final e in list.where((e) => e.status != ExpenseStatus.cancelled && e.status != ExpenseStatus.rejected)) {
                  if (e.expenseDate == null) continue;
                  final k = EastAfricaTime.businessDayKey(e.expenseDate!);
                  byDay[k] = (byDay[k] ?? Money.zero) + e.amount;
                }
                final paid = paidTotals == null ? null : DailyFinancePaid.of(paidTotals, _category);
                return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  if (paid != null)
                    MoneyCard(
                      title: 'Paid out (server totals)',
                      footer: 'From the ledger: expense payments less reversals, by payment day.',
                      lines: [MoneyLine('Expenses paid', paid, emphasis: true, valueKey: const Key('expenses-paid-total'))],
                    ),
                  const SizedBox(height: AppSpacing.sm),
                  MoneyCard(
                    title: 'Expenses dated in ${_period.label.toLowerCase()} (${totals.count})',
                    footer: 'Totals of the expense records (up to 500). Rejected and cancelled ones are listed separately.',
                    lines: [
                      MoneyLine('All live expenses', totals.total, emphasis: true, valueKey: const Key('expenses-dated-total')),
                      for (final s in ExpenseStatus.values)
                        if (totals.byStatus[s] != null) MoneyLine(s.label, totals.byStatus[s]!),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  MoneyCard(title: 'By category', lines: [
                    if (totals.byCategory.isEmpty) const Text('No expenses.'),
                    for (final e in totals.byCategory.entries) MoneyLine(e.key, e.value),
                  ]),
                  const SizedBox(height: AppSpacing.sm),
                  MoneyCard(title: 'Daily totals', lines: [
                    if (byDay.isEmpty) const Text('No expenses.'),
                    for (final e in (byDay.entries.toList()..sort((a, b) => b.key.compareTo(a.key)))) MoneyLine(e.key, e.value),
                  ]),
                ]);
              }(),
            AsyncError(:final error) => InlineError(ErrorMapper.map(error).message),
            _ => const LoadingView(),
          },
        ),
        Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: SectionCard(title: 'Large expenses (${Money(threshold).format()} or more)', children: [
            if (large.isEmpty) const Text('None.'),
            for (final e in large) ExpenseTile(expense: e, onTap: () => context.go(AppRoutes.expenseDetail(e.expenseId))),
          ]),
        ),
      ],
    );
  }
}

/// Paid expense totals from the server's daily summaries, optionally one category.
abstract final class DailyFinancePaid {
  static Money of(List<DailyFinanceSummary> days, String? categoryId) {
    var total = Money.zero;
    for (final d in days) {
      total += categoryId == null ? d.netExpenses : d.expensesByCategory[categoryId] ?? Money.zero;
    }
    return total;
  }
}
