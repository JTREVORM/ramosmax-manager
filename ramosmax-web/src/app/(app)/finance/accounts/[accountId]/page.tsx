import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { getAccount, listLedger } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { AccountActions } from './account-actions';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  await requireAnyPermission('finance.view');
  const { accountId } = await params;
  const [account, user] = await Promise.all([getAccount(accountId), currentUser()]);
  if (!account) notFound();

  const permissions = user?.permissions ?? [];
  const statement = permissions.includes('finance.transactions.view')
    ? await listLedger('all', accountId)
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={account.name}
        subtitle={`${account.type.replace(/_/g, ' ')}${
          account.provider ? ` · ${account.provider}` : ''
        }`}
        back={{ href: '/finance', label: 'Finance' }}
        action={account.is_active ? undefined : <Badge tone="neutral">Inactive</Badge>}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground text-sm">Balance</span>
            <span className="tabular text-foreground text-lg font-semibold">
              {formatUgx(account.balance_ugx)}
            </span>
          </div>
          {account.type === 'cash' && (
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">Awaiting banking</span>
              <span className="tabular text-warning text-sm">
                {formatUgx(account.awaiting_banking_ugx)}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground text-sm">Opening balance</span>
            <span className="tabular text-foreground text-sm">
              {account.opening_balance_recorded ? formatUgx(account.opening_balance_ugx) : 'Not recorded'}
            </span>
          </div>
          {account.account_number_masked && (
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">Number</span>
              <span className="tabular text-foreground text-sm">{account.account_number_masked}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground text-sm">Movements</span>
            <span className="tabular text-foreground text-sm">{account.transaction_count}</span>
          </div>
        </CardBody>
      </Card>

      <AccountActions account={account} permissions={permissions} />

      {permissions.includes('finance.transactions.view') && (
        <Card>
          <CardHeader>
            <CardTitle>Statement</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            <ul className="divide-border divide-y">
              {statement.map((entry) => {
                const outward = entry.source_account_name === account.name;
                return (
                  <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0">
                      <span className="text-foreground block truncate text-sm">
                        {entry.description ?? entry.entry_type.replace(/_/g, ' ')}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {entry.transaction_number} · {formatDateTime(entry.created_at)}
                      </span>
                    </span>
                    <span
                      className={`tabular shrink-0 text-sm ${
                        outward ? 'text-danger' : 'text-success'
                      }`}
                    >
                      {outward ? '−' : '+'} {formatUgx(entry.amount_ugx)}
                    </span>
                  </li>
                );
              })}
              {statement.length === 0 && (
                <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                  Nothing has moved through this account yet.
                </li>
              )}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
