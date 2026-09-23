import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/money/money.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/sections.dart';
import '../../../models/expense.dart';
import '../../../models/finance.dart';
import '../../../routes/app_routes.dart';
import '../../billing/presentation/billing_widgets.dart';
import '../../expenses/application/expenses_providers.dart';
import '../../operations/presentation/operations_widgets.dart';
import '../../users/presentation/user_dialogs.dart' show showReasonDialog;
import '../application/finance_providers.dart';
import 'finance_forms.dart';
import 'finance_widgets.dart';

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/// Balances straight from the server-maintained accounts, today's totals from
/// the server's daily summary, and the latest ledger entries. Nothing here is
/// computed from raw payments on the phone.
class FinanceDashboardScreen extends ConsumerWidget {
  const FinanceDashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accounts = ref.watch(financialAccountsProvider);
    final canTxns = canDo(ref, Permission.financeTransactionsView);
    return switch (accounts) {
      AsyncData(:final value) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 96),
          children: [
            Text('Finance', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.xs),
            const _FinanceNav(),
            const SizedBox(height: AppSpacing.sm),
            _BalancesCard(accounts: value),
            const SizedBox(height: AppSpacing.sm),
            _AwaitingBankingCard(accounts: value),
            const SizedBox(height: AppSpacing.sm),
            const _TodayCard(),
            if (canTxns) ...[
              const SizedBox(height: AppSpacing.sm),
              const _RecentTransactions(),
            ],
          ],
        ),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

class _FinanceNav extends ConsumerWidget {
  const _FinanceNav();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final entries = <(String, IconData, String, bool)>[
      ('Accounts', Icons.account_balance_wallet_outlined, AppRoutes.financeAccounts, true),
      ('Transactions', Icons.receipt_long_outlined, AppRoutes.financeTransactions, canDo(ref, Permission.financeTransactionsView)),
      ('Transfers', Icons.swap_horiz, AppRoutes.financeTransfers,
          canDo(ref, Permission.financeTransfer) || canDo(ref, Permission.financeTransactionsView)),
      ('Banking', Icons.account_balance_outlined, AppRoutes.financeBanking,
          canDo(ref, Permission.financeDeposit) || canDo(ref, Permission.financeTransactionsView)),
      ('Reconciliation', Icons.fact_check_outlined, AppRoutes.financeReconciliation,
          canDo(ref, Permission.financeReconcile) || canDo(ref, Permission.financeTransactionsView)),
      ('Reports', Icons.bar_chart_outlined, AppRoutes.financeReports, true),
    ];
    return Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
      for (final (label, icon, route, allowed) in entries)
        if (allowed)
          ActionChip(
            key: Key('finance-nav-${label.toLowerCase()}'),
            avatar: Icon(icon, size: 18),
            label: Text(label),
            onPressed: () => context.go(route),
          ),
    ]);
  }
}

class _BalancesCard extends StatelessWidget {
  const _BalancesCard({required this.accounts});
  final List<FinancialAccount> accounts;

  @override
  Widget build(BuildContext context) {
    final active = accounts.where((a) => a.active).toList();
    final summary = FundsSummary.of(active);
    return SectionCard(
      title: 'Balances',
      icon: Icons.account_balance_wallet_outlined,
      children: [
        for (final a in active) AccountBalanceTile(account: a, onTap: () => context.go(AppRoutes.financeAccount(a.accountId))),
        const Divider(),
        MoneyLine('Total funds', summary.total, emphasis: true, valueKey: const Key('total-funds')),
        Text('Balances are kept by the server with every payment, transfer and expense.',
            style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _AwaitingBankingCard extends ConsumerWidget {
  const _AwaitingBankingCard({required this.accounts});
  final List<FinancialAccount> accounts;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summary = FundsSummary.of(accounts);
    return Card(
      child: ListTile(
        key: const Key('awaiting-banking'),
        leading: const Icon(Icons.savings_outlined, color: AppColors.warning),
        title: const Text('Cash awaiting banking'),
        subtitle: const Text('Part of Cash at Hand — not extra money.'),
        trailing: Text(summary.awaitingBanking.format(), key: const Key('awaiting-banking-amount'), style: Theme.of(context).textTheme.titleSmall),
        onTap: () => context.go(AppRoutes.financeBanking),
      ),
    );
  }
}

class _TodayCard extends ConsumerWidget {
  const _TodayCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final today = ref.watch(todayFinanceProvider).value;
    if (today == null) return const SizedBox.shrink();
    return SectionCard(title: 'Today', icon: Icons.today_outlined, children: [
      MoneyLine("Today's income (customer payments)", today.netIncome, valueKey: const Key('today-income')),
      MoneyLine("Today's expenses paid", today.netExpenses, valueKey: const Key('today-expenses')),
      MoneyLine('Stock purchases paid', today.netPurchases),
      MoneyLine('Staff pay (payroll & allowances)', today.netStaffPay, valueKey: const Key('today-staff-pay')),
      MoneyLine("Today's transfers & deposits (not income)", today.netTransfers, valueKey: const Key('today-transfers')),
    ]);
  }
}

class _RecentTransactions extends ConsumerWidget {
  const _RecentTransactions();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(transactionsProvider(null)).value ?? const [];
    return SectionCard(
      title: 'Recent transactions',
      icon: Icons.receipt_long_outlined,
      trailing: TextButton(onPressed: () => context.go(AppRoutes.financeTransactions), child: const Text('All')),
      children: [
        if (list.isEmpty) const Text('No transactions yet.'),
        for (final t in list.take(8))
          TransactionTile(transaction: t, onTap: () => context.go(AppRoutes.financeTransaction(t.transactionId))),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

class AccountsScreen extends ConsumerWidget {
  const AccountsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manage = canDo(ref, Permission.financeAccountsManage);
    return Column(children: [
      ScreenHeader('Accounts',
          onBack: () => context.go(AppRoutes.finance),
          action: manage
              ? IconButton(
                  key: const Key('add-account-button'),
                  tooltip: 'Add bank / mobile money account',
                  icon: const Icon(Icons.add),
                  onPressed: () => showFormSheet<void>(context, const AccountFormSheet()),
                )
              : null),
      Expanded(
        child: switch (ref.watch(financialAccountsProvider)) {
          AsyncData(:final value) => ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
              children: [
                if (manage && value.any((a) => !a.exists))
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.info_outline),
                      title: const Text('Some default accounts are not set up yet'),
                      subtitle: const Text('They are created automatically on first use, or now.'),
                      trailing: TextButton(
                        key: const Key('setup-accounts-button'),
                        onPressed: () async {
                          final r = await ref.read(financeActionsProvider).ensureDefaultAccounts();
                          if (context.mounted) reportResult(context, r, 'Default accounts are ready.');
                        },
                        child: const Text('Set up'),
                      ),
                    ),
                  ),
                for (final type in AccountType.values) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.sm),
                    child: Text(type.label, style: Theme.of(context).textTheme.titleSmall),
                  ),
                  for (final a in value.where((a) => a.type == type))
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                        child: AccountBalanceTile(account: a, onTap: () => context.go(AppRoutes.financeAccount(a.accountId))),
                      ),
                    ),
                ],
              ],
            ),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }
}

class AccountDetailScreen extends ConsumerWidget {
  const AccountDetailScreen({super.key, required this.accountId});
  final String accountId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manage = canDo(ref, Permission.financeAccountsManage);
    final txnsAllowed = canDo(ref, Permission.financeTransactionsView);
    return switch (ref.watch(financialAccountProvider(accountId))) {
      AsyncData(value: final FinancialAccount a) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
          children: [
            ScreenHeader(a.name, subtitle: a.type.label, onBack: () => context.go(AppRoutes.financeAccounts)),
            SectionCard(title: 'Balance', icon: AccountBalanceTile.iconFor(a.type), children: [
              MoneyLine('Current balance', a.balance, emphasis: true, valueKey: const Key('account-balance')),
              if (a.type == AccountType.cash) MoneyLine('of which awaiting banking', a.awaitingBanking),
              if (a.openingBalanceRecorded) MoneyLine('Opening balance', a.openingBalance),
              InfoRow('Provider', a.provider),
              InfoRow('Account number', a.accountNumber),
              InfoRow('Status', a.active ? 'Active' : 'Inactive'),
              InfoRow('Notes', a.notes),
              if (a.lastTransactionAt != null) InfoRow('Last movement', DateTimeFormatter.dateTime(a.lastTransactionAt!)),
            ]),
            const SizedBox(height: AppSpacing.sm),
            Wrap(spacing: AppSpacing.xs, runSpacing: AppSpacing.xs, children: [
              if (manage && !a.openingBalanceRecorded && a.active)
                OutlinedButton.icon(
                  key: const Key('opening-balance-button'),
                  icon: const Icon(Icons.flag_outlined),
                  label: const Text('Opening balance'),
                  onPressed: () => showFormSheet<void>(context, OpeningBalanceSheet(account: a)),
                ),
              if (canDo(ref, Permission.financeReconcile))
                OutlinedButton.icon(
                  key: const Key('reconcile-button'),
                  icon: const Icon(Icons.fact_check_outlined),
                  label: const Text('Reconcile'),
                  onPressed: () => showFormSheet<void>(context, ReconcileSheet(initialAccountId: a.accountId)),
                ),
              if (manage && a.exists)
                OutlinedButton.icon(
                  key: const Key('edit-account-button'),
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('Edit'),
                  onPressed: () => showFormSheet<void>(context, AccountFormSheet(existing: a)),
                ),
              if (manage && a.exists && !a.isPermanent)
                OutlinedButton.icon(
                  icon: Icon(a.active ? Icons.block : Icons.check_circle_outline),
                  label: Text(a.active ? 'Deactivate' : 'Activate'),
                  onPressed: () async {
                    String? reason;
                    if (a.active) {
                      reason = await showReasonDialog(context,
                          title: 'Deactivate ${a.name}?',
                          message: 'Only an account with a zero balance can be deactivated. Its history is kept.',
                          confirmLabel: 'Deactivate',
                          destructive: true);
                      if (reason == null) return;
                    }
                    final r = await ref.read(financeActionsProvider).updateAccount(a.accountId, active: !a.active, reason: reason);
                    if (context.mounted) reportResult(context, r, a.active ? 'Account deactivated.' : 'Account activated.');
                  },
                ),
            ]),
            if (txnsAllowed) ...[
              const SizedBox(height: AppSpacing.md),
              Text('Statement', style: Theme.of(context).textTheme.titleMedium),
              ...switch (ref.watch(accountTransactionsProvider(accountId))) {
                AsyncData(:final value) when value.isEmpty => [const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No movements yet.'))],
                AsyncData(:final value) => [
                    for (final t in value)
                      TransactionTile(transaction: t, accountId: accountId, onTap: () => context.go(AppRoutes.financeTransaction(t.transactionId))),
                  ],
                AsyncError(:final error) => [InlineError(ErrorMapper.map(error).message)],
                _ => [const LoadingView()],
              },
            ],
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.account_balance_outlined, title: 'Account not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

class TransactionsScreen extends ConsumerStatefulWidget {
  const TransactionsScreen({super.key, this.initialType, this.standalone = false});
  final TransactionType? initialType;

  /// Opened from the Transactions module (auditors) rather than inside Finance.
  final bool standalone;

  @override
  ConsumerState<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends ConsumerState<TransactionsScreen> {
  late TransactionType? _type = widget.initialType;

  @override
  Widget build(BuildContext context) {
    if (!canDo(ref, Permission.financeTransactionsView)) {
      return const EmptyView(icon: Icons.lock_outline, title: 'No access', message: 'You do not have permission to view transactions.');
    }
    final list = ref.watch(transactionsProvider(_type));
    return Column(children: [
      ScreenHeader('Transactions', onBack: widget.standalone ? null : () => context.go(AppRoutes.finance)),
      FilterChips<TransactionType?>(
        values: const [null, ...TransactionType.values],
        selected: _type,
        label: (t) => t?.label ?? 'All',
        keyPrefix: 'txn-type',
        onSelected: (t) => setState(() => _type = t),
      ),
      Expanded(
        child: switch (list) {
          AsyncData(:final value) when value.isEmpty =>
            const EmptyView(icon: Icons.receipt_long_outlined, title: 'No transactions', message: 'Nothing has been posted of this type yet.'),
          AsyncData(:final value) => ListView(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
              children: [
                for (final t in value) TransactionTile(transaction: t, onTap: () => context.go(AppRoutes.financeTransaction(t.transactionId))),
                if (value.length >= 100) const Text('Showing the latest 100.'),
              ],
            ),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }
}

class TransactionDetailScreen extends ConsumerWidget {
  const TransactionDetailScreen({super.key, required this.transactionId});
  final String transactionId;

  bool _canReverse(WidgetRef ref, FinancialTransaction t) {
    if (!t.canReverse) return false;
    final spending = t.type == TransactionType.expensePayment || t.type == TransactionType.inventoryPurchasePayment;
    return canDo(ref, spending ? Permission.expensesAdjust : Permission.financeAdjust);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return switch (ref.watch(transactionProvider(transactionId))) {
      AsyncData(value: final FinancialTransaction t) => ListView(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
          children: [
            ScreenHeader(t.transactionNumber, subtitle: t.label, onBack: () => context.go(AppRoutes.financeTransactions)),
            if (t.reversed)
              const Padding(
                padding: EdgeInsets.only(bottom: AppSpacing.xs),
                child: StatusChip('REVERSED', color: AppColors.danger, icon: Icons.undo),
              ),
            SectionCard(title: 'Details', children: [
              MoneyLine('Amount', t.amount, emphasis: true),
              InfoRow('Type', t.label),
              InfoRow('Revenue', t.isRevenue ? 'Yes — customer payment' : 'No'),
              InfoRow('From', t.sourceAccountName),
              InfoRow('To', t.destinationAccountName),
              InfoRow('Reference', t.reference),
              InfoRow('Description', t.description),
              InfoRow('Reason', t.reason),
              InfoRow('Invoice', t.invoiceNumber),
              InfoRow('Expense', t.expenseNumber),
              InfoRow('Purchase', t.purchaseNumber),
              InfoRow('Deposit', t.depositNumber),
              InfoRow('Recorded by', t.createdByName),
              if (t.createdAt != null) InfoRow('Recorded', DateTimeFormatter.transaction(t.createdAt!)),
              if (t.reversed) InfoRow('Reversal reason', t.reversalReason),
            ]),
            const SizedBox(height: AppSpacing.sm),
            SectionCard(title: 'Account movements', children: [
              for (final l in t.lines)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(l.accountName, overflow: TextOverflow.ellipsis),
                        Text('Balance after: ${l.balanceAfter.format()}', style: Theme.of(context).textTheme.bodySmall),
                      ]),
                    ),
                    SignedAmount(l.delta),
                  ]),
                ),
            ]),
            if (t.type == TransactionType.customerPayment && t.invoiceId != null) ...[
              const SizedBox(height: AppSpacing.sm),
              OutlinedButton(onPressed: () => context.go(AppRoutes.invoiceDetail(t.invoiceId!)), child: const Text('Open invoice')),
              const Text('Customer payments are reversed from their invoice.'),
            ],
            if (t.reversalOfTransactionId != null)
              OutlinedButton(
                onPressed: () => context.go(AppRoutes.financeTransaction(t.reversalOfTransactionId!)),
                child: const Text('Open the original transaction'),
              ),
            if (_canReverse(ref, t)) ...[
              const SizedBox(height: AppSpacing.sm),
              OutlinedButton.icon(
                key: const Key('reverse-transaction-button'),
                style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger),
                icon: const Icon(Icons.undo),
                label: const Text('Reverse'),
                onPressed: () async {
                  final reason = await showReasonDialog(context,
                      title: 'Reverse ${t.transactionNumber}?',
                      message: 'A reversal entry moves ${t.amount.format()} back. Both entries stay in the ledger.',
                      confirmLabel: 'Reverse',
                      destructive: true);
                  if (reason == null || !context.mounted) return;
                  final r = await ref.read(financeActionsProvider).reverse(t.transactionId, reason);
                  if (context.mounted) reportResult(context, r, 'Transaction reversed.');
                },
              ),
            ],
          ],
        ),
      AsyncData() => const EmptyView(icon: Icons.receipt_long_outlined, title: 'Transaction not found'),
      AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
      _ => const LoadingView(),
    };
  }
}

// ---------------------------------------------------------------------------
// Transfers, banking, reconciliation
// ---------------------------------------------------------------------------

class TransfersScreen extends ConsumerWidget {
  const TransfersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canView = canDo(ref, Permission.financeTransactionsView);
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
      children: [
        ScreenHeader('Transfers', subtitle: 'Moving money between accounts is not income.', onBack: () => context.go(AppRoutes.finance)),
        if (canDo(ref, Permission.financeTransfer))
          FilledButton.icon(
            key: const Key('new-transfer-button'),
            icon: const Icon(Icons.swap_horiz),
            label: const Text('New transfer'),
            onPressed: () => showFormSheet<void>(context, const TransferSheet()),
          ),
        const SizedBox(height: AppSpacing.sm),
        if (canView)
          ...switch (ref.watch(transactionsProvider(TransactionType.accountTransfer))) {
            AsyncData(:final value) when value.isEmpty => [const Center(child: Text('No transfers yet.'))],
            AsyncData(:final value) => [
                for (final t in value) TransactionTile(transaction: t, onTap: () => context.go(AppRoutes.financeTransaction(t.transactionId))),
              ],
            AsyncError(:final error) => [InlineError(ErrorMapper.map(error).message)],
            _ => [const LoadingView()],
          },
      ],
    );
  }
}

class BankingScreen extends ConsumerWidget {
  const BankingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accounts = ref.watch(financialAccountsProvider).value ?? const [];
    final summary = FundsSummary.of(accounts);
    final canView = canDo(ref, Permission.financeTransactionsView) || canDo(ref, Permission.financeDeposit);
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
      children: [
        ScreenHeader('Banking', onBack: () => context.go(AppRoutes.finance)),
        MoneyCard(
          title: 'Cash awaiting banking',
          footer: 'Cash collected from customers and not yet deposited. It is already inside Cash at Hand — '
              'depositing it moves it to a bank; it is not income.',
          lines: [
            MoneyLine('Awaiting banking', summary.awaitingBanking, emphasis: true, color: AppColors.warning, valueKey: const Key('banking-awaiting')),
            for (final a in accounts.where((a) => a.type == AccountType.cash)) MoneyLine('${a.name} (total)', a.balance),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        if (canDo(ref, Permission.financeDeposit))
          FilledButton.icon(
            key: const Key('new-deposit-button'),
            icon: const Icon(Icons.account_balance_outlined),
            label: const Text('Record bank deposit'),
            onPressed: () => showFormSheet<void>(context, DepositSheet(suggested: summary.awaitingBanking)),
          ),
        const SizedBox(height: AppSpacing.sm),
        if (canView) ...[
          Text('Deposits', style: Theme.of(context).textTheme.titleMedium),
          ...switch (ref.watch(depositsProvider)) {
            AsyncData(:final value) when value.isEmpty => [const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No deposits yet.'))],
            AsyncData(:final value) => [
                for (final d in value)
                  Card(
                    key: Key('deposit-${d.depositId}'),
                    child: ListTile(
                      onTap: d.transactionId == null || !canDo(ref, Permission.financeTransactionsView)
                          ? null
                          : () => context.go(AppRoutes.financeTransaction(d.transactionId!)),
                      leading: const Icon(Icons.account_balance_outlined),
                      title: Text('${d.depositNumber} · ${d.amount.format()}',
                          style: d.reversed ? const TextStyle(decoration: TextDecoration.lineThrough) : null),
                      subtitle: Text([
                        '${d.sourceAccountName} → ${d.bankAccountName}',
                        ?d.bankReference,
                        if (d.depositDate != null) DateTimeFormatter.date(d.depositDate!),
                        ?d.createdByName,
                        if (d.reversed) 'Reversed',
                      ].join(' · ')),
                    ),
                  ),
              ],
            AsyncError(:final error) => [InlineError(ErrorMapper.map(error).message)],
            _ => [const LoadingView()],
          },
        ],
      ],
    );
  }
}

class ReconciliationScreen extends ConsumerWidget {
  const ReconciliationScreen({super.key, this.standalone = false});
  final bool standalone;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canView = canDo(ref, Permission.financeTransactionsView) || canDo(ref, Permission.financeReconcile);
    final canAdjust = canDo(ref, Permission.financeAdjust);
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
      children: [
        ScreenHeader('Reconciliation',
            subtitle: 'Compare counted cash or statements with the system. Differences are never hidden.',
            onBack: standalone ? null : () => context.go(AppRoutes.finance)),
        if (canDo(ref, Permission.financeReconcile))
          FilledButton.icon(
            key: const Key('new-reconciliation-button'),
            icon: const Icon(Icons.fact_check_outlined),
            label: const Text('Reconcile an account'),
            onPressed: () => showFormSheet<void>(context, const ReconcileSheet()),
          ),
        const SizedBox(height: AppSpacing.sm),
        if (!canView)
          const Text('You do not have permission to view reconciliations.')
        else
          ...switch (ref.watch(reconciliationsProvider(null))) {
            AsyncData(:final value) when value.isEmpty => [const Padding(padding: EdgeInsets.all(AppSpacing.md), child: Text('No reconciliations yet.'))],
            AsyncData(:final value) => [
                for (final r in value)
                  Card(
                    key: Key('reconciliation-${r.reconciliationId}'),
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        Row(children: [
                          Expanded(child: Text('${r.reconciliationNumber} · ${r.accountName}', style: Theme.of(context).textTheme.titleSmall)),
                          StatusChip(r.status.label,
                              color: switch (r.status) {
                                ReconciliationStatus.balanced => AppColors.success,
                                ReconciliationStatus.adjusted => AppColors.info,
                                ReconciliationStatus.discrepancy => AppColors.danger,
                              }),
                        ]),
                        MoneyLine('System balance', r.systemBalance),
                        MoneyLine('Counted / statement', r.actualBalance),
                        Row(children: [const Expanded(child: Text('Difference')), SignedAmount(r.difference)]),
                        Text([
                          if (r.reconciliationDate != null) DateTimeFormatter.date(r.reconciliationDate!),
                          ?r.reconciledByName,
                          ?r.notes,
                        ].join(' · '), style: Theme.of(context).textTheme.bodySmall),
                        if (r.status == ReconciliationStatus.discrepancy && canAdjust)
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton(
                              key: Key('adjust-${r.reconciliationId}'),
                              onPressed: () => showFormSheet<void>(context, AdjustmentSheet(reconciliation: r)),
                              child: const Text('Record adjustment'),
                            ),
                          ),
                      ]),
                    ),
                  ),
              ],
            AsyncError(:final error) => [InlineError(ErrorMapper.map(error).message)],
            _ => [const LoadingView()],
          },
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

class FinanceReportsScreen extends ConsumerStatefulWidget {
  const FinanceReportsScreen({super.key});

  @override
  ConsumerState<FinanceReportsScreen> createState() => _FinanceReportsScreenState();
}

class _FinanceReportsScreenState extends ConsumerState<FinanceReportsScreen> {
  FinancePeriod _period = FinancePeriod.month;

  @override
  Widget build(BuildContext context) {
    final days = ref.watch(periodSummariesProvider(_period));
    final categories = canDo(ref, Permission.expensesView) ? ref.watch(expenseCategoriesProvider).value ?? const <ExpenseCategory>[] : const <ExpenseCategory>[];
    return Column(children: [
      ScreenHeader('Financial reports', subtitle: 'Totals kept by the server with every posting.', onBack: () => context.go(AppRoutes.finance)),
      FilterChips<FinancePeriod>(
        values: FinancePeriod.values,
        selected: _period,
        label: (p) => p.label,
        keyPrefix: 'finance-period',
        onSelected: (p) => setState(() => _period = p),
      ),
      Expanded(
        child: switch (days) {
          AsyncData(:final value) => () {
              final t = DailyFinanceSummary.combine(_period.label, value);
              final net = t.netIncome - t.netExpenses - t.netPurchases - t.netStaffPay;
              return ListView(
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                children: [
                  MoneyCard(title: 'Money in and out', lines: [
                    MoneyLine('Income (customer payments, net of reversals)', t.netIncome, valueKey: const Key('report-income')),
                    MoneyLine('Expenses paid', t.netExpenses, valueKey: const Key('report-expenses')),
                    MoneyLine('Stock purchases paid', t.netPurchases),
                    MoneyLine('Staff pay (payroll & allowances)', t.netStaffPay, valueKey: const Key('report-staff-pay')),
                    const Divider(),
                    MoneyLine('Net cash from operations', net, emphasis: true, color: net.isNegative ? AppColors.danger : AppColors.success),
                  ], footer: 'Credit sales are not included until paid. Stock purchases and staff pay are shown separately from expenses.'),
                  const SizedBox(height: AppSpacing.sm),
                  if (!t.netShareCapital.isZero || !t.netDividends.isZero) ...[
                    MoneyCard(title: 'Owners\' money (not income, not operating expenses)', lines: [
                      MoneyLine('Share capital received', t.netShareCapital, valueKey: const Key('report-share-capital')),
                      MoneyLine('Dividends paid (distributions)', t.netDividends, valueKey: const Key('report-dividends')),
                    ], footer: 'Share capital is owners\' money, not revenue. Dividends are distributions to shareholders, not operating expenses.'),
                    const SizedBox(height: AppSpacing.sm),
                  ],
                  MoneyCard(title: 'Movements between accounts (not income)', lines: [
                    MoneyLine('Transfers', t.transfers),
                    MoneyLine('Bank deposits', t.deposits),
                    MoneyLine('Adjustments in', t.adjustmentsIn),
                    MoneyLine('Adjustments out', t.adjustmentsOut),
                  ]),
                  if (t.expensesByCategory.values.any((m) => !m.isZero)) ...[
                    const SizedBox(height: AppSpacing.sm),
                    MoneyCard(title: 'Expenses paid by category', lines: [
                      for (final e in t.expensesByCategory.entries)
                        if (!e.value.isZero) MoneyLine(ExpenseCategory.nameOf(e.key, categories), e.value),
                    ]),
                  ],
                  const SizedBox(height: AppSpacing.sm),
                  SectionCard(title: 'Daily totals', children: [
                    if (value.isEmpty) const Text('No postings in this period.'),
                    for (final d in value.reversed)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(children: [
                          Expanded(child: Text(d.day)),
                          Text('in ${d.netIncome.formatAmount()}', style: const TextStyle(color: AppColors.success)),
                          const SizedBox(width: AppSpacing.sm),
                          Text('out ${(d.netExpenses + d.netPurchases + d.netStaffPay).formatAmount()}', style: const TextStyle(color: AppColors.danger)),
                        ]),
                      ),
                  ]),
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

/// A Money difference as text: `+UGX 500` / `−UGX 2,000`.
String signed(Money m) => m.isNegative ? '−${(-m).format()}' : '+${m.format()}';
