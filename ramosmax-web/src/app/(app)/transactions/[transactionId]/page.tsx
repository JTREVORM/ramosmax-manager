import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { getLedgerEntry, listMovements } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { ReverseTransaction } from './reverse-transaction';
import { TYPE_LABELS } from '../ledger-table';

export const metadata: Metadata = { title: 'Transaction' };

export default async function TransactionPage({
  params,
}: {
  params: Promise<{ transactionId: string }>;
}) {
  await requireAnyPermission('finance.transactions.view');
  const { transactionId } = await params;
  const [entry, movements, user] = await Promise.all([
    getLedgerEntry(transactionId),
    listMovements(transactionId),
    currentUser(),
  ]);
  if (!entry) notFound();

  const permissions = user?.permissions ?? [];
  const spending = ['expense_payment', 'inventory_purchase_payment'].includes(entry.entry_type);
  const canReverse =
    entry.status === 'posted' &&
    entry.entry_type !== 'reversal' &&
    entry.entry_type !== 'customer_payment' &&
    permissions.includes(spending ? 'expenses.adjust' : 'finance.adjust');

  return (
    <div className="space-y-4">
      <PageHeader
        title={entry.transaction_number}
        subtitle={TYPE_LABELS[entry.entry_type] ?? entry.entry_type}
        back={{ href: '/transactions', label: 'Transactions' }}
        action={
          entry.status === 'reversed' ? <Badge tone="danger">Reversed</Badge> : <Badge tone="success">Posted</Badge>
        }
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Amount" value={formatUgx(entry.amount_ugx)} strong />
          <Row label="Business day" value={formatDate(entry.business_day)} />
          <Row label="Dated" value={formatDate(entry.transaction_date)} />
          <Row label="Posted" value={formatDateTime(entry.created_at)} />
          {entry.created_by_name && <Row label="By" value={entry.created_by_name} />}
          {entry.reference && <Row label="Reference" value={entry.reference} />}
          <Row label="Revenue" value={entry.is_revenue ? 'Yes' : 'No'} />
        </CardBody>
      </Card>

      {entry.description && (
        <Card>
          <CardBody>
            <p className="text-foreground text-sm">{entry.description}</p>
            {entry.reason && <p className="text-muted-foreground mt-1 text-sm">{entry.reason}</p>}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Account movements</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {movements.map((m) => (
              <li key={m.account_id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-foreground min-w-0 truncate text-sm">{m.account_name}</span>
                <span className="shrink-0 text-right">
                  <span
                    className={`tabular block text-sm font-medium ${
                      m.delta_ugx < 0 ? 'text-danger' : 'text-success'
                    }`}
                  >
                    {m.delta_ugx < 0 ? '−' : '+'} {formatUgx(Math.abs(m.delta_ugx))}
                  </span>
                  <span className="tabular text-muted-foreground block text-xs">
                    balance {formatUgx(m.balance_after_ugx)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {(entry.reverses_id || entry.reversed_by_id) && (
        <Card>
          <CardBody className="text-sm">
            {entry.reverses_id && (
              <Link href={`/transactions/${entry.reverses_id}`} className="text-primary hover:underline">
                This reverses an earlier transaction
              </Link>
            )}
            {entry.reversed_by_id && (
              <Link href={`/transactions/${entry.reversed_by_id}`} className="text-primary hover:underline">
                This was reversed — open the reversal
              </Link>
            )}
          </CardBody>
        </Card>
      )}

      {canReverse && <ReverseTransaction transactionId={entry.id} />}

      {entry.entry_type === 'customer_payment' && entry.status === 'posted' && (
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">
              A customer payment is reversed from its invoice, so the invoice and its loyalty points
              are put back at the same time.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}>
        {value}
      </span>
    </div>
  );
}
