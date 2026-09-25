import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import {
  getShareholder, listAllocationsFor, listContributions, listHoldings, listLinkableUsers,
  listShareTransactionsFor,
} from '@/lib/server/ownership';
import { ShareholderActions } from '../shareholder-forms';

export const metadata: Metadata = { title: 'Shareholder' };

export default async function ShareholderPage({
  params,
}: {
  params: Promise<{ shareholderId: string }>;
}) {
  const granted = await requireAnyPermission('shareholders.view');
  const { shareholderId } = await params;
  const shareholder = await getShareholder(shareholderId);
  if (!shareholder) notFound();

  const [holdings, transactions, contributions, allocations, users] = await Promise.all([
    granted.has('shares.view') ? listHoldings(shareholderId) : Promise.resolve([]),
    granted.has('shares.view') ? listShareTransactionsFor(shareholderId) : Promise.resolve([]),
    granted.has('shares.view') ? listContributions() : Promise.resolve([]),
    granted.has('dividends.view') ? listAllocationsFor(shareholderId) : Promise.resolve([]),
    granted.has('shareholders.manage') ? listLinkableUsers() : Promise.resolve([]),
  ]);
  const mine = contributions.filter((c) => c.shareholder_id === shareholderId);

  return (
    <div className="space-y-4">
      <PageHeader
        title={shareholder.full_name}
        subtitle={shareholder.shareholder_number}
        back={{ href: '/shareholders?tab=people', label: 'Shareholders' }}
        action={<StatusBadge status={shareholder.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Shares" value={Number(shareholder.total_shares).toLocaleString('en-US')} strong />
          <Row label="Ownership" value={`${Number(shareholder.ownership_percent).toFixed(4)}%`} />
          <Row label="Committed" value={formatUgx(shareholder.committed_ugx)} />
          <Row label="Received" value={formatUgx(shareholder.paid_ugx)} />
          <Row label="Outstanding" value={formatUgx(shareholder.outstanding_ugx)} />
          <Row label="Dividends paid" value={formatUgx(shareholder.dividends_paid_ugx)} />
          <Row label="Joined" value={formatDate(shareholder.join_date)} />
          {shareholder.phone_number && <Row label="Phone" value={shareholder.phone_number} />}
          {shareholder.email && <Row label="Email" value={shareholder.email} />}
          {shareholder.address && <Row label="Address" value={shareholder.address} />}
          {shareholder.id_number && (
            <Row label="Identification" value={`${shareholder.id_type} · ${shareholder.id_number}`} />
          )}
          {shareholder.linked_user_name && (
            <Row label="Sign-in" value={shareholder.linked_user_name} />
          )}
          {shareholder.status_reason && <Row label="Status reason" value={shareholder.status_reason} />}
          {shareholder.notes && <Row label="Notes" value={shareholder.notes} />}
        </CardBody>
      </Card>

      <ShareholderActions shareholder={shareholder} permissions={[...granted]} users={users} />

      {holdings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Holdings</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {holdings.map((h) => (
                <li key={h.class_id} className="flex justify-between gap-3 text-sm">
                  <span>{h.class_code}</span>
                  <span className="tabular">
                    {Number(h.shares).toLocaleString('en-US')} · {formatUgx(h.paid_ugx)} of{' '}
                    {formatUgx(h.committed_ugx)}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {transactions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Share history ({transactions.length})</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {transactions.map((t) => (
                <li key={t.id} className="text-sm">
                  <Link href={`/shares/txn/${t.id}`} className="text-primary hover:underline">
                    {t.transaction_number}
                  </Link>{' '}
                  <span className="text-muted-foreground">
                    {label(t.type)} · {t.class_code} ·{' '}
                    {Number(t.shares).toLocaleString('en-US')} shares ·{' '}
                    {formatDate(t.effective_date)} · {t.status.replace('_', ' ')}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {mine.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Contributions</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {mine.map((c) => (
                <li key={c.id} className="flex justify-between gap-3 text-sm">
                  <span>
                    {c.contribution_number}
                    {c.source === 'prior_record' ? ' · paid before RamosMAX' : ''}
                    {c.status === 'reversed' ? ' · reversed' : ''}
                  </span>
                  <span className="tabular">{formatUgx(c.amount_ugx)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {allocations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Dividends</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {allocations.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 text-sm">
                  <span>
                    {a.allocation_number} · {formatDate(a.record_date)} ·{' '}
                    {Number(a.shares_at_record_date).toLocaleString('en-US')} shares
                  </span>
                  <span className="tabular">
                    {formatUgx(a.net_ugx)} · {a.payment_status}
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

function label(type: string): string {
  return {
    shares_issued: 'Issued',
    shares_transferred: 'Transferred',
    shares_adjusted: 'Adjusted',
    reversal: 'Reversal',
  }[type] ?? type;
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
