import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { getToday, listAccounts, listLedger } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';

export const metadata: Metadata = { title: 'Finance' };

const TYPE_LABELS: Record<string, string> = {
  customer_payment: 'Customer payment',
  expense_payment: 'Expense',
  inventory_purchase_payment: 'Stock purchase',
  account_transfer: 'Transfer',
  bank_deposit: 'Bank deposit',
  adjustment: 'Adjustment',
  opening_balance: 'Opening balance',
  reversal: 'Reversal',
};

export default async function FinancePage() {
  await requireAnyPermission('finance.view');

  const [accounts, today, recent, user] = await Promise.all([
    listAccounts(),
    getToday(),
    listLedger('all'),
    currentUser(),
  ]);
  const can = (p: string) => user?.permissions.includes(p) ?? false;

  const totalFunds = accounts
    .filter((a) => a.is_active)
    .reduce((sum, a) => sum + Number(a.balance_ugx), 0);
  const awaiting = accounts.reduce((sum, a) => sum + Number(a.awaiting_banking_ugx), 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Finance" subtitle="Balances, today's movements and the accounts." />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-xs">Total funds</p>
            <p className="tabular text-foreground mt-1 text-2xl font-semibold">
              {formatUgx(totalFunds)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Across {accounts.filter((a) => a.is_active).length} active accounts
            </p>
          </CardBody>
        </Card>
        <Card className={awaiting > 0 ? 'bg-warning-bg' : undefined}>
          <CardBody>
            <p className={`text-xs ${awaiting > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
              Cash awaiting banking
            </p>
            <p className="tabular text-foreground mt-1 text-2xl font-semibold">
              {formatUgx(awaiting)}
            </p>
            {can('finance.deposit') && (
              <Link href="/finance/banking" className="text-primary mt-1 inline-block text-xs hover:underline">
                Record a bank deposit
              </Link>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Today</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Total label="Customer payments" value={today?.payments_in_ugx ?? 0} />
            <Total label="Expenses paid" value={today?.expenses_paid_ugx ?? 0} />
            <Total label="Stock purchases" value={today?.purchases_paid_ugx ?? 0} />
            <Total label="Transfers" value={today?.transfers_ugx ?? 0} />
            <Total label="Bank deposits" value={today?.deposits_ugx ?? 0} />
            <Total label="Reversals" value={today?.reversals_ugx ?? 0} />
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            These are the server&rsquo;s own totals, written with each ledger entry. Nothing here is
            added up in the browser.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Accounts</CardTitle>
          {can('finance.transfer') && (
            <Link href="/finance/transfers" className="text-primary text-xs hover:underline">
              Transfer funds
            </Link>
          )}
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {accounts.map((account) => (
              <li key={account.id}>
                <Link
                  href={`/finance/accounts/${account.id}`}
                  className="active:bg-surface-muted hover:bg-surface-muted flex items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="min-w-0">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {account.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {account.type.replace(/_/g, ' ')}
                      {account.account_number_masked ? ` · ${account.account_number_masked}` : ''}
                      {account.is_active ? '' : ' · inactive'}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular text-foreground block text-sm font-medium">
                      {formatUgx(account.balance_ugx)}
                    </span>
                    {account.awaiting_banking_ugx > 0 && (
                      <span className="text-warning block text-xs">
                        {formatUgx(account.awaiting_banking_ugx)} to bank
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {can('finance.transactions.view') && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Recent movements</CardTitle>
            <Link href="/transactions" className="text-primary text-xs hover:underline">
              All transactions
            </Link>
          </CardHeader>
          <CardBody className="p-0">
            <ul className="divide-border divide-y">
              {recent.slice(0, 8).map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0">
                    <span className="text-foreground block truncate text-sm">
                      {TYPE_LABELS[entry.entry_type] ?? entry.entry_type}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {entry.transaction_number} · {formatDateTime(entry.created_at)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular text-foreground block text-sm">
                      {formatUgx(entry.amount_ugx)}
                    </span>
                    {entry.status === 'reversed' && <Badge tone="danger">Reversed</Badge>}
                  </span>
                </li>
              ))}
              {recent.length === 0 && (
                <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                  Nothing has moved yet.
                </li>
              )}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="tabular text-foreground text-sm font-medium">{formatUgx(value)}</dd>
    </div>
  );
}
