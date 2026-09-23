import '../core/money/money.dart';
import 'firestore_converters.dart';

/// Kinds of financial account. Mirrors ACCOUNT_TYPES in functions/src/finance.js.
enum AccountType {
  cash('cash', 'Cash'),
  mobileMoney('mobile_money', 'Mobile money'),
  bank('bank', 'Bank');

  const AccountType(this.key, this.label);
  final String key;
  final String label;

  static AccountType parse(Object? v) => values.firstWhere((t) => t.key == v, orElse: () => bank);
}

/// The accounts every installation has (created by the server on first use).
/// Mirrors DEFAULT_ACCOUNTS in functions/src/finance.js.
abstract final class DefaultAccounts {
  static const String cashAtHand = 'cash_at_hand';
  static const String mtnMerchant = 'mtn_merchant';
  static const String airtelMerchant = 'airtel_merchant';
  static const String bank1 = 'bank_1';

  static const Map<String, (String, AccountType)> all = {
    cashAtHand: ('Cash at Hand', AccountType.cash),
    mtnMerchant: ('MTN Merchant', AccountType.mobileMoney),
    airtelMerchant: ('Airtel Merchant', AccountType.mobileMoney),
    bank1: ('Bank Account 1', AccountType.bank),
  };

  /// Customer-payment accounts; the server never lets them be deactivated.
  static const Set<String> permanent = {cashAtHand, mtnMerchant, airtelMerchant};
}

/// `financial_accounts/{id}`. [balance] and [awaitingBanking] are written
/// only by the Cloud Functions, together with the ledger entry that explains
/// the change; the app only displays them.
class FinancialAccount {
  const FinancialAccount({
    required this.accountId,
    required this.name,
    required this.type,
    required this.balance,
    required this.active,
    this.awaitingBanking = Money.zero,
    this.provider,
    this.accountNumber,
    this.openingBalance = Money.zero,
    this.openingBalanceRecorded = false,
    this.isDefault = false,
    this.notes,
    this.transactionCount = 0,
    this.lastTransactionAt,
    this.exists = true,
  });

  final String accountId;
  final String name;
  final AccountType type;
  final Money balance;

  /// Cash collected from customers and not yet banked — part of [balance],
  /// never additional money. Cash accounts only.
  final Money awaitingBanking;
  final bool active;
  final String? provider;
  final String? accountNumber;
  final Money openingBalance;
  final bool openingBalanceRecorded;
  final bool isDefault;
  final String? notes;
  final int transactionCount;
  final DateTime? lastTransactionAt;

  /// False for a default account the server has not created yet (zero balance).
  final bool exists;

  bool get isPermanent => DefaultAccounts.permanent.contains(accountId);

  static FinancialAccount fromFirestore(String id, Map<String, dynamic> d) => FinancialAccount(
        accountId: id,
        name: d['name'] as String? ?? id,
        type: AccountType.parse(d['type']),
        balance: Money((d['balanceUgx'] as num?)?.toInt() ?? 0),
        awaitingBanking: Money((d['awaitingBankingUgx'] as num?)?.toInt() ?? 0),
        active: d['active'] == true,
        provider: d['provider'] as String?,
        accountNumber: d['accountNumber'] as String?,
        openingBalance: Money((d['openingBalanceUgx'] as num?)?.toInt() ?? 0),
        openingBalanceRecorded: d['openingBalanceRecorded'] == true,
        isDefault: d['isDefault'] == true,
        notes: d['notes'] as String?,
        transactionCount: (d['transactionCount'] as num?)?.toInt() ?? 0,
        lastTransactionAt: FirestoreConverters.toDateTime(d['lastTransactionAt']),
      );

  /// A default account that has no document yet: shown with a zero balance.
  static FinancialAccount placeholder(String id) {
    final (name, type) = DefaultAccounts.all[id]!;
    return FinancialAccount(accountId: id, name: name, type: type, balance: Money.zero, active: true, isDefault: true, exists: false);
  }

  /// Every stored account plus any default not created yet, in display order:
  /// the defaults (Cash, MTN, Airtel, Bank Account 1), then others by type and name.
  static List<FinancialAccount> withDefaults(Iterable<FinancialAccount> stored) {
    final byId = {for (final a in stored) a.accountId: a};
    for (final id in DefaultAccounts.all.keys) {
      byId.putIfAbsent(id, () => placeholder(id));
    }
    final list = byId.values.toList()
      ..sort((a, b) {
        const order = [DefaultAccounts.cashAtHand, DefaultAccounts.mtnMerchant, DefaultAccounts.airtelMerchant, DefaultAccounts.bank1];
        int rank(FinancialAccount x) => order.contains(x.accountId) ? order.indexOf(x.accountId) : order.length + x.type.index;
        final r = rank(a).compareTo(rank(b));
        if (r != 0) return r;
        return a.name.toLowerCase().compareTo(b.name.toLowerCase());
      });
    return list;
  }
}

/// Totals across accounts, from server-maintained balances.
class FundsSummary {
  const FundsSummary({required this.total, required this.awaitingBanking, required this.byType});
  final Money total;
  final Money awaitingBanking;
  final Map<AccountType, Money> byType;

  static FundsSummary of(Iterable<FinancialAccount> accounts) {
    final byType = {for (final t in AccountType.values) t: Money.zero};
    var total = Money.zero;
    var waiting = Money.zero;
    for (final a in accounts) {
      if (!a.active) continue;
      total += a.balance;
      byType[a.type] = byType[a.type]! + a.balance;
      if (a.type == AccountType.cash) waiting += a.awaitingBanking;
    }
    return FundsSummary(total: total, awaitingBanking: waiting, byType: byType);
  }
}

/// Ledger entry kinds. Mirrors TXN_TYPES in functions/src/finance.js.
enum TransactionType {
  customerPayment('customer_payment', 'Customer payment'),
  expensePayment('expense_payment', 'Expense payment'),
  inventoryPurchasePayment('inventory_purchase_payment', 'Stock purchase payment'),
  accountTransfer('account_transfer', 'Transfer'),
  bankDeposit('bank_deposit', 'Bank deposit'),
  adjustment('adjustment', 'Adjustment'),
  openingBalance('opening_balance', 'Opening balance'),
  reversal('reversal', 'Reversal'),
  // Phase 6: staff pay - outflows, never revenue.
  allowancePayment('allowance_payment', 'Allowance payment'),
  payrollPayment('payroll_payment', 'Payroll payment'),
  // Phase 7: owners' money - share capital is never revenue, dividends are
  // never operating expenses.
  shareCapitalContribution('share_capital_contribution', 'Share capital contribution'),
  dividendPayment('dividend_payment', 'Dividend payment');

  const TransactionType(this.key, this.label);
  final String key;
  final String label;

  static TransactionType parse(Object? v) => values.firstWhere((t) => t.key == v, orElse: () => adjustment);
}

class LedgerLine {
  const LedgerLine(this.accountId, this.accountName, this.delta, this.balanceAfter);
  final String accountId;
  final String accountName;
  final Money delta;
  final Money balanceAfter;
}

/// `financial_transactions/{id}` — immutable; a mistake gets a [TransactionType.reversal].
class FinancialTransaction {
  const FinancialTransaction({
    required this.transactionId,
    required this.transactionNumber,
    required this.type,
    required this.amount,
    required this.lines,
    required this.reversed,
    this.reversalOfType,
    this.sourceAccountId,
    this.sourceAccountName,
    this.destinationAccountId,
    this.destinationAccountName,
    this.reference,
    this.description,
    this.reason,
    this.invoiceId,
    this.invoiceNumber,
    this.expenseId,
    this.expenseNumber,
    this.purchaseId,
    this.purchaseNumber,
    this.depositNumber,
    this.payrollNumber,
    this.shareholderNumber,
    this.contributionNumber,
    this.dividendNumber,
    this.reversalOfTransactionId,
    this.reversedByTransactionId,
    this.reversalReason,
    this.createdByName,
    this.createdAt,
    this.transactionDate,
  });

  final String transactionId;
  final String transactionNumber;
  final TransactionType type;
  final TransactionType? reversalOfType;
  final Money amount;
  final List<LedgerLine> lines;
  final bool reversed;
  final String? sourceAccountId;
  final String? sourceAccountName;
  final String? destinationAccountId;
  final String? destinationAccountName;
  final String? reference;
  final String? description;
  final String? reason;
  final String? invoiceId;
  final String? invoiceNumber;
  final String? expenseId;
  final String? expenseNumber;
  final String? purchaseId;
  final String? purchaseNumber;
  final String? depositNumber;
  final String? payrollNumber;

  /// Phase 7 references (share capital contributions and dividend payments).
  final String? shareholderNumber;
  final String? contributionNumber;
  final String? dividendNumber;
  final String? reversalOfTransactionId;
  final String? reversedByTransactionId;
  final String? reversalReason;
  final String? createdByName;
  final DateTime? createdAt;
  final DateTime? transactionDate;

  /// Only customer payments are revenue; transfers and deposits never are.
  bool get isRevenue => type == TransactionType.customerPayment;

  /// The change this entry made to [accountId] (zero if it did not touch it).
  Money deltaFor(String accountId) {
    for (final l in lines) {
      if (l.accountId == accountId) return l.delta;
    }
    return Money.zero;
  }

  /// Staff pay (Phase 6), reversed from the allowance / payroll screens.
  bool get isStaffPay => type == TransactionType.allowancePayment || type == TransactionType.payrollPayment;

  /// Owners' money (Phase 7), reversed from the share-contribution and
  /// dividend screens so the shareholder records stay consistent.
  bool get isOwnership => type == TransactionType.shareCapitalContribution || type == TransactionType.dividendPayment;

  /// Reversible from the finance screens (customer payments are reversed
  /// from their invoice, staff pay from its allowance or payroll, owners'
  /// money from the shareholder screens).
  bool get canReverse =>
      !reversed && type != TransactionType.reversal && type != TransactionType.customerPayment && !isStaffPay && !isOwnership;

  String get label => type == TransactionType.reversal && reversalOfType != null ? 'Reversal of ${reversalOfType!.label.toLowerCase()}' : type.label;

  static FinancialTransaction fromFirestore(String id, Map<String, dynamic> d) => FinancialTransaction(
        transactionId: id,
        transactionNumber: d['transactionNumber'] as String? ?? '',
        type: TransactionType.parse(d['type']),
        reversalOfType: d['reversalOfType'] == null ? null : TransactionType.parse(d['reversalOfType']),
        amount: Money((d['amountUgx'] as num?)?.toInt() ?? 0),
        lines: [
          for (final e in (d['entries'] as List? ?? const []))
            if (e is Map)
              LedgerLine(e['accountId'] as String? ?? '', e['accountName'] as String? ?? '',
                  Money((e['deltaUgx'] as num?)?.toInt() ?? 0), Money((e['balanceAfterUgx'] as num?)?.toInt() ?? 0)),
        ],
        reversed: d['status'] == 'reversed',
        sourceAccountId: d['sourceAccountId'] as String?,
        sourceAccountName: d['sourceAccountName'] as String?,
        destinationAccountId: d['destinationAccountId'] as String?,
        destinationAccountName: d['destinationAccountName'] as String?,
        reference: d['reference'] as String?,
        description: d['description'] as String?,
        reason: d['reason'] as String?,
        invoiceId: d['invoiceId'] as String?,
        invoiceNumber: d['invoiceNumber'] as String?,
        expenseId: d['expenseId'] as String?,
        expenseNumber: d['expenseNumber'] as String?,
        purchaseId: d['purchaseId'] as String?,
        purchaseNumber: d['purchaseNumber'] as String?,
        depositNumber: d['depositNumber'] as String?,
        payrollNumber: d['payrollNumber'] as String?,
        shareholderNumber: d['shareholderNumber'] as String?,
        contributionNumber: d['contributionNumber'] as String?,
        dividendNumber: d['dividendNumber'] as String?,
        reversalOfTransactionId: d['reversalOfTransactionId'] as String?,
        reversedByTransactionId: d['reversedByTransactionId'] as String?,
        reversalReason: d['reversalReason'] as String?,
        createdByName: d['createdByName'] as String?,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        transactionDate: FirestoreConverters.toDateTime(d['transactionDate']),
      );
}

/// `finance_daily_summaries/{yyyy-mm-dd}` — totals the server adds to in the
/// same transaction as each ledger entry. Reversals count on the day they
/// are made.
class DailyFinanceSummary {
  const DailyFinanceSummary({
    required this.day,
    this.customerPayments = Money.zero,
    this.expensesPaid = Money.zero,
    this.purchasesPaid = Money.zero,
    this.transfers = Money.zero,
    this.deposits = Money.zero,
    this.adjustmentsIn = Money.zero,
    this.adjustmentsOut = Money.zero,
    this.allowancesPaid = Money.zero,
    this.payrollPaid = Money.zero,
    this.shareCapitalIn = Money.zero,
    this.dividendsPaid = Money.zero,
    this.reversals = const {},
    this.expensesByCategory = const {},
    this.transactionCount = 0,
    this.dayStart,
  });

  final String day;
  final DateTime? dayStart;
  final Money customerPayments;
  final Money expensesPaid;
  final Money purchasesPaid;
  final Money transfers;
  final Money deposits;
  final Money adjustmentsIn;
  final Money adjustmentsOut;

  /// Staff pay (Phase 6): allowances paid directly, and payrolls paid.
  final Money allowancesPaid;
  final Money payrollPaid;

  /// Owners' money (Phase 7): share capital received and dividends paid.
  /// Neither is income nor an operating expense.
  final Money shareCapitalIn;
  final Money dividendsPaid;

  /// Reversed amounts by original transaction type key.
  final Map<String, Money> reversals;
  final Map<String, Money> expensesByCategory;
  final int transactionCount;

  Money _rev(TransactionType t) => reversals[t.key] ?? Money.zero;

  /// Customer payments less payment reversals made that day.
  Money get netIncome => customerPayments - _rev(TransactionType.customerPayment);
  Money get netExpenses => expensesPaid - _rev(TransactionType.expensePayment);
  Money get netPurchases => purchasesPaid - _rev(TransactionType.inventoryPurchasePayment);

  /// Staff pay out (allowances + payroll) less reversals made that day.
  Money get netStaffPay =>
      allowancesPaid + payrollPaid - _rev(TransactionType.allowancePayment) - _rev(TransactionType.payrollPayment);

  /// Share capital received less contribution reversals made that day.
  Money get netShareCapital => shareCapitalIn - _rev(TransactionType.shareCapitalContribution);

  /// Dividends paid less dividend-payment reversals made that day.
  Money get netDividends => dividendsPaid - _rev(TransactionType.dividendPayment);

  /// Money moved between accounts (transfers + deposits) — never income.
  Money get netTransfers =>
      transfers + deposits - _rev(TransactionType.accountTransfer) - _rev(TransactionType.bankDeposit);

  static DailyFinanceSummary empty(String day) => DailyFinanceSummary(day: day);

  static DailyFinanceSummary fromFirestore(String id, Map<String, dynamic> d) {
    Money m(Object? v) => Money((v as num?)?.toInt() ?? 0);
    Map<String, Money> map(Object? v) => {
          if (v is Map)
            for (final e in v.entries)
              if (e.value is num) e.key.toString(): m(e.value),
        };
    final rev = <String, Money>{};
    if (d['reversals'] is Map) {
      for (final e in (d['reversals'] as Map).entries) {
        final key = e.key.toString();
        if (key.endsWith('Ugx')) rev[key.substring(0, key.length - 3)] = m(e.value);
      }
    }
    return DailyFinanceSummary(
      day: id,
      dayStart: FirestoreConverters.toDateTime(d['dayStart']),
      customerPayments: m(d['customerPaymentsUgx']),
      expensesPaid: m(d['expensesPaidUgx']),
      purchasesPaid: m(d['purchasesPaidUgx']),
      transfers: m(d['transfersUgx']),
      deposits: m(d['depositsUgx']),
      adjustmentsIn: m(d['adjustmentsInUgx']),
      adjustmentsOut: m(d['adjustmentsOutUgx']),
      allowancesPaid: m(d['allowancesPaidUgx']),
      payrollPaid: m(d['payrollPaidUgx']),
      shareCapitalIn: m(d['shareCapitalInUgx']),
      dividendsPaid: m(d['dividendsPaidUgx']),
      reversals: rev,
      expensesByCategory: map(d['expensesByCategory']),
      transactionCount: (d['transactionCount'] as num?)?.toInt() ?? 0,
    );
  }

  /// Adds several days together (reports over a period).
  static DailyFinanceSummary combine(String label, Iterable<DailyFinanceSummary> days) {
    var r = DailyFinanceSummary(day: label);
    for (final d in days) {
      Map<String, Money> add(Map<String, Money> a, Map<String, Money> b) =>
          {...a, for (final e in b.entries) e.key: (a[e.key] ?? Money.zero) + e.value};
      r = DailyFinanceSummary(
        day: label,
        customerPayments: r.customerPayments + d.customerPayments,
        expensesPaid: r.expensesPaid + d.expensesPaid,
        purchasesPaid: r.purchasesPaid + d.purchasesPaid,
        transfers: r.transfers + d.transfers,
        deposits: r.deposits + d.deposits,
        adjustmentsIn: r.adjustmentsIn + d.adjustmentsIn,
        adjustmentsOut: r.adjustmentsOut + d.adjustmentsOut,
        allowancesPaid: r.allowancesPaid + d.allowancesPaid,
        payrollPaid: r.payrollPaid + d.payrollPaid,
        shareCapitalIn: r.shareCapitalIn + d.shareCapitalIn,
        dividendsPaid: r.dividendsPaid + d.dividendsPaid,
        reversals: add(r.reversals, d.reversals),
        expensesByCategory: add(r.expensesByCategory, d.expensesByCategory),
        transactionCount: r.transactionCount + d.transactionCount,
      );
    }
    return r;
  }
}

/// `bank_deposits/{id}`.
class BankDeposit {
  const BankDeposit({
    required this.depositId,
    required this.depositNumber,
    required this.amount,
    required this.sourceAccountName,
    required this.bankAccountName,
    required this.reversed,
    this.bankReference,
    this.description,
    this.depositDate,
    this.createdByName,
    this.transactionId,
    this.attachmentPath,
  });

  final String depositId;
  final String depositNumber;
  final Money amount;
  final String sourceAccountName;
  final String bankAccountName;
  final bool reversed;
  final String? bankReference;
  final String? description;
  final DateTime? depositDate;
  final String? createdByName;
  final String? transactionId;
  final String? attachmentPath;

  static BankDeposit fromFirestore(String id, Map<String, dynamic> d) => BankDeposit(
        depositId: id,
        depositNumber: d['depositNumber'] as String? ?? '',
        amount: Money((d['amountUgx'] as num?)?.toInt() ?? 0),
        sourceAccountName: d['sourceAccountName'] as String? ?? '',
        bankAccountName: d['bankAccountName'] as String? ?? '',
        reversed: d['status'] == 'reversed',
        bankReference: d['bankReference'] as String?,
        description: d['description'] as String?,
        depositDate: FirestoreConverters.toDateTime(d['depositDate']),
        createdByName: d['createdByName'] as String?,
        transactionId: d['transactionId'] as String?,
        attachmentPath: d['attachmentPath'] as String?,
      );
}

enum ReconciliationStatus {
  balanced('balanced', 'Balanced'),
  discrepancy('discrepancy', 'Difference'),
  adjusted('adjusted', 'Adjusted');

  const ReconciliationStatus(this.key, this.label);
  final String key;
  final String label;

  static ReconciliationStatus parse(Object? v) => values.firstWhere((s) => s.key == v, orElse: () => discrepancy);
}

/// `reconciliations/{id}`: a count or statement compared with the system
/// balance. It never changes the balance by itself.
class Reconciliation {
  const Reconciliation({
    required this.reconciliationId,
    required this.reconciliationNumber,
    required this.accountId,
    required this.accountName,
    required this.systemBalance,
    required this.actualBalance,
    required this.difference,
    required this.status,
    this.notes,
    this.reconciledByName,
    this.reconciliationDate,
    this.createdAt,
    this.adjustmentTransactionId,
    this.attachmentPath,
  });

  final String reconciliationId;
  final String reconciliationNumber;
  final String accountId;
  final String accountName;
  final Money systemBalance;
  final Money actualBalance;

  /// Actual − system: positive means more money than recorded.
  final Money difference;
  final ReconciliationStatus status;
  final String? notes;
  final String? reconciledByName;
  final DateTime? reconciliationDate;
  final DateTime? createdAt;
  final String? adjustmentTransactionId;
  final String? attachmentPath;

  /// Same formula as the server, for the live preview.
  static Money differenceOf(Money actual, Money system) => actual - system;

  static Reconciliation fromFirestore(String id, Map<String, dynamic> d) => Reconciliation(
        reconciliationId: id,
        reconciliationNumber: d['reconciliationNumber'] as String? ?? '',
        accountId: d['accountId'] as String? ?? '',
        accountName: d['accountName'] as String? ?? '',
        systemBalance: Money((d['systemBalanceUgx'] as num?)?.toInt() ?? 0),
        actualBalance: Money((d['actualBalanceUgx'] as num?)?.toInt() ?? 0),
        difference: Money((d['differenceUgx'] as num?)?.toInt() ?? 0),
        status: ReconciliationStatus.parse(d['status']),
        notes: d['notes'] as String?,
        reconciledByName: d['reconciledByName'] as String?,
        reconciliationDate: FirestoreConverters.toDateTime(d['reconciliationDate']),
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
        adjustmentTransactionId: d['adjustmentTransactionId'] as String?,
        attachmentPath: d['attachmentPath'] as String?,
      );
}

/// One entry of `settings/payment_accounts`: a bank a cashier may choose
/// for a bank payment (no balance).
class PaymentAccountOption {
  const PaymentAccountOption({required this.accountId, required this.name, this.provider, this.accountNumberMasked});
  final String accountId;
  final String name;
  final String? provider;
  final String? accountNumberMasked;

  String get label => [name, ?accountNumberMasked].join(' ');

  static List<PaymentAccountOption> listFrom(Map<String, dynamic>? d) => [
        for (final b in (d?['banks'] as List? ?? const []))
          if (b is Map && b['accountId'] is String)
            PaymentAccountOption(
              accountId: b['accountId'] as String,
              name: b['name'] as String? ?? b['accountId'] as String,
              provider: b['provider'] as String?,
              accountNumberMasked: b['accountNumberMasked'] as String?,
            ),
      ];
}
