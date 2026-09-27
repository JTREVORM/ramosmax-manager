import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { myShareholding } from '@/lib/server/ownership';
import { TXN_LABELS } from '@/lib/format/ownership';

export const metadata: Metadata = { title: 'My shareholding' };

/**
 * A shareholder's own record, and nothing else.
 *
 * Every figure comes from `app.my_shareholding()`, which the database serves
 * from the caller's own sign-in. The register, the ledger and other people's
 * allocations are closed to this role at the table, so there is nothing here
 * to filter and nothing a modified client could ask for instead.
 */
export default async function MySharesPage() {
  await requireAnyPermission('shareholders.view.own');
  const mine = await myShareholding();

  if (!mine.linked || !mine.shareholder) {
    return (
      <div className="space-y-4">
        <PageHeader title="My shareholding" />
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">
              Your sign-in is not linked to a shareholder record yet. An Administrator can link it.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const me = mine.shareholder;
  const holdings = mine.holdings ?? [];
  const transactions = mine.transactions ?? [];
  const contributions = mine.contributions ?? [];
  const dividends = mine.dividends ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="My shareholding"
        subtitle={`${me.fullName} · ${me.shareholderNumber}`}
        action={<StatusBadge status={me.status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Shares held" value={Number(me.totalShares).toLocaleString('en-US')} strong />
          <Row label="Ownership" value={`${Number(me.ownershipPercent).toFixed(2)}%`} strong />
          <Row label="Committed" value={formatUgx(me.committedUgx)} />
          <Row label="Paid" value={formatUgx(me.paidUgx)} />
          <Row label="Outstanding" value={formatUgx(me.outstandingUgx)} />
          <Row label="Dividends received" value={formatUgx(me.dividendsPaidUgx)} />
          <Row label="Shareholder since" value={formatDate(me.joinDate)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By share class</CardTitle>
        </CardHeader>
        <CardBody>
          {holdings.length === 0 ? (
            <p className="text-muted-foreground text-sm">You hold no shares yet.</p>
          ) : (
            <ul className="space-y-2">
              {holdings.map((h) => (
                <li key={h.classId} className="flex justify-between gap-3 text-sm">
                  <span>{h.classCode}</span>
                  <span className="tabular">
                    {Number(h.shares).toLocaleString('en-US')} shares
                    {h.outstandingUgx > 0 && (
                      <span className="text-warning ml-2 text-xs">
                        {formatUgx(h.outstandingUgx)} outstanding
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>My dividends</CardTitle>
        </CardHeader>
        <CardBody>
          {dividends.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No dividend has been approved for you yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {dividends.map((d) => (
                <li key={d.allocationNumber} className="flex justify-between gap-3 text-sm">
                  <span>
                    {d.financialPeriod}
                    <span className="text-muted-foreground block text-xs">
                      {d.dividendNumber} · {Number(d.sharesAtRecordDate).toLocaleString('en-US')}{' '}
                      shares on {formatDate(d.recordDate)}
                    </span>
                  </span>
                  <span className="tabular text-right">
                    {formatUgx(d.netUgx)}
                    <span className="block">
                      <StatusBadge status={d.paymentStatus} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>My share history</CardTitle>
        </CardHeader>
        <CardBody>
          {transactions.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            <ul className="space-y-2">
              {transactions.map((t) => (
                <li key={t.transactionNumber} className="flex justify-between gap-3 text-sm">
                  <span>
                    {TXN_LABELS[t.type] ?? t.type}
                    <span className="text-muted-foreground block text-xs">
                      {t.transactionNumber} · {t.classCode} · {formatDate(t.effectiveDate)}
                    </span>
                  </span>
                  <span className="tabular">
                    {t.deltaShares !== null && Number(t.deltaShares) > 0 ? '+' : ''}
                    {t.deltaShares === null ? '—' : Number(t.deltaShares).toLocaleString('en-US')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground mt-3 text-xs">
            A transfer shows your own side only. The other party is not named.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>My payments</CardTitle>
        </CardHeader>
        <CardBody>
          {contributions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No payment has been recorded.</p>
          ) : (
            <ul className="space-y-2">
              {contributions.map((c) => (
                <li key={c.contributionNumber} className="flex justify-between gap-3 text-sm">
                  <span>
                    {c.contributionNumber}
                    <span className="text-muted-foreground block text-xs">
                      {c.classCode ?? '—'}
                      {c.paymentDate ? ` · ${formatDate(c.paymentDate)}` : ''}
                      {c.source === 'prior_record' ? ' · paid before RamosMAX' : ''}
                    </span>
                  </span>
                  <span className="tabular">
                    {formatUgx(c.amountUgx)}
                    {c.status === 'reversed' && (
                      <span className="text-muted-foreground ml-2 text-xs">reversed</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
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
