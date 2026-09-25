import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { listAccounts, listDeposits } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { DepositForm } from './deposit-form';

export const metadata: Metadata = { title: 'Banking' };

export default async function BankingPage() {
  await requireAnyPermission('finance.deposit');
  const [accounts, deposits] = await Promise.all([listAccounts(), listDeposits()]);

  const active = accounts.filter((a) => a.is_active);
  const sources = active.filter((a) => a.type !== 'bank');
  const banks = active.filter((a) => a.type === 'bank');
  const awaiting = accounts.reduce((sum, a) => sum + Number(a.awaiting_banking_ugx), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Banking"
        subtitle="Cash waiting to be banked, and the deposits already made."
        back={{ href: '/finance', label: 'Finance' }}
      />

      <Card className={awaiting > 0 ? 'bg-warning-bg' : undefined}>
        <CardBody>
          <p className={`text-xs ${awaiting > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
            Cash awaiting banking
          </p>
          <p className="tabular text-foreground mt-1 text-2xl font-semibold">{formatUgx(awaiting)}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Takings collected in cash that have not yet gone to a bank. This is part of the cash
            balance, not extra money.
          </p>
        </CardBody>
      </Card>

      {banks.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">
              There is no active bank account to deposit into yet.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Record a bank deposit</CardTitle>
          </CardHeader>
          <CardBody>
            <DepositForm sources={sources} banks={banks} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Deposits</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {deposits.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-foreground truncate text-sm">
                    {d.source_account_name} → {d.bank_account_name}
                  </p>
                  <p className="text-muted-foreground mt-0.5 truncate text-xs">
                    {d.deposit_number} · {formatDate(d.deposit_date)} · slip {d.bank_reference}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span
                    className={`tabular block text-sm font-medium ${
                      d.status === 'reversed' ? 'text-muted-foreground line-through' : 'text-foreground'
                    }`}
                  >
                    {formatUgx(d.amount_ugx)}
                  </span>
                  {d.status === 'reversed' && <Badge tone="danger">Reversed</Badge>}
                </div>
              </li>
            ))}
            {deposits.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                No deposits recorded yet.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
