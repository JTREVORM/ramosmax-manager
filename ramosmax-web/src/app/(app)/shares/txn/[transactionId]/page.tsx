import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { listPickableAccounts } from '@/lib/server/finance';
import { businessToday } from '@/lib/server/workforce';
import { getShareTransaction, listContributions, transactionLines } from '@/lib/server/ownership';
import { TXN_LABELS } from '@/lib/format/ownership';
import { TransactionActions } from './txn-actions';

export const metadata: Metadata = { title: 'Share transaction' };

export default async function ShareTransactionPage({
  params,
}: {
  params: Promise<{ transactionId: string }>;
}) {
  const granted = await requireAnyPermission('shares.view');
  const { transactionId } = await params;
  const transaction = await getShareTransaction(transactionId);
  if (!transaction) notFound();

  const [lines, contributions, accounts, today] = await Promise.all([
    transactionLines(transactionId),
    listContributions(transactionId),
    granted.has('shares.issue') ? listPickableAccounts() : Promise.resolve([]),
    businessToday(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={transaction.transaction_number}
        subtitle={`${TXN_LABELS[transaction.type] ?? transaction.type} · ${transaction.class_code}`}
        back={{ href: '/shares', label: 'Shares' }}
        action={<StatusBadge status={transaction.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Shares" value={Number(transaction.shares).toLocaleString('en-US')} strong />
          {transaction.value_per_share_ugx !== null && (
            <Row label="Value per share" value={formatUgx(transaction.value_per_share_ugx)} />
          )}
          {transaction.committed_ugx !== null && (
            <Row label="Commitment" value={formatUgx(transaction.committed_ugx)} />
          )}
          {transaction.type === 'shares_issued' && (
            <>
              <Row label="Received" value={formatUgx(transaction.paid_ugx)} />
              <Row label="Outstanding" value={formatUgx(transaction.outstanding_ugx)} />
            </>
          )}
          <Row label="Effective" value={formatDate(transaction.effective_date)} />
          <Row label="Requested by" value={transaction.requested_by_name ?? '—'} />
          {transaction.approved_by_name && (
            <Row label="Approved by" value={transaction.approved_by_name} />
          )}
          {transaction.rejected_by_name && (
            <Row label="Rejected by" value={transaction.rejected_by_name} />
          )}
          {transaction.reference && <Row label="Reference" value={transaction.reference} />}
          {transaction.reason && <Row label="Reason" value={transaction.reason} />}
          {transaction.decision_reason && (
            <Row label="Decision" value={transaction.decision_reason} />
          )}
          {transaction.reversal_of_number && (
            <Row label="Reverses" value={transaction.reversal_of_number} />
          )}
          {transaction.reversed_by_number && (
            <Row label="Reversed by" value={transaction.reversed_by_number} />
          )}
          {transaction.reversal_reason && (
            <Row label="Reversal reason" value={transaction.reversal_reason} />
          )}
        </CardBody>
      </Card>

      {transaction.status === 'pending_approval' && (
        <Card className="bg-surface-muted">
          <CardBody>
            <p className="text-muted-foreground text-sm">
              Nothing has moved. No ownership has changed and no money has been received: this is a
              request waiting for a second person.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Ownership lines</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="space-y-2">
            {lines.map((line) => (
              <li key={line.shareholder_id} className="flex justify-between gap-3 text-sm">
                <Link
                  href={`/shareholders/${line.shareholder_id}`}
                  className="text-primary hover:underline"
                >
                  {line.shareholder_name}
                </Link>
                <span className="tabular">
                  {line.delta_shares > 0 ? '+' : ''}
                  {Number(line.delta_shares).toLocaleString('en-US')}
                  {line.shares_after !== null && (
                    <span className="text-muted-foreground ml-2 text-xs">
                      → {Number(line.shares_after).toLocaleString('en-US')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-3 text-xs">
            These lines are frozen once the entry is applied. Ownership on any date is the sum of
            every applied line effective on or before it.
          </p>
        </CardBody>
      </Card>

      <TransactionActions
        transaction={transaction}
        contributions={contributions}
        accounts={accounts}
        permissions={[...granted]}
        today={today}
      />

      {contributions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {contributions.map((c) => (
                <li key={c.id} className="flex justify-between gap-3 text-sm">
                  <span>
                    {c.contribution_number} ·{' '}
                    {c.source === 'prior_record' ? 'paid before RamosMAX' : (c.account_name ?? 'account')}
                    {c.status === 'reversed' ? ' · reversed' : ''}
                  </span>
                  <span className="tabular">
                    {formatUgx(c.amount_ugx)}
                    <span className="text-muted-foreground ml-2 text-xs">
                      {formatDateTime(c.created_at)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className={`tabular text-sm ${strong ? 'text-foreground font-semibold' : 'text-foreground'}`}>
        {value}
      </span>
    </div>
  );
}
