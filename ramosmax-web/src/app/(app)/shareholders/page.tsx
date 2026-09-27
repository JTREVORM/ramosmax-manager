import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { SearchField } from '@/components/ui/search-field';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUgx } from '@/lib/format/money';
import { requireAnyPermission } from '@/lib/server/guard';
import { businessToday } from '@/lib/server/workforce';
import {
  listRegister, listShareClasses, listShareholders, ownershipAsOf, registerTotals,
} from '@/lib/server/ownership';
import { RegisterTable, ShareholdersTable } from './shareholders-tables';
import { AddShareholderCard } from './shareholder-forms';

export const metadata: Metadata = { title: 'Shareholders' };

export default async function ShareholdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; status?: string; q?: string; date?: string }>;
}) {
  const granted = await requireAnyPermission(
    'shareholders.view', 'shareholders.reports.view', 'shares.view',
  );
  const can = (p: string) => granted.has(p);
  const params = await searchParams;
  const seesPeople = can('shareholders.view');
  const tab = params.tab ?? (seesPeople ? 'register' : 'register');

  const [totals, register, classes, today] = await Promise.all([
    registerTotals(), listRegister(), listShareClasses(), businessToday(),
  ]);
  const people = seesPeople && tab === 'people'
    ? await listShareholders(params.status, params.q)
    : [];
  const asOf = tab === 'reports' ? await ownershipAsOf(params.date ?? null) : [];

  const tabs = [
    { value: 'register', label: 'Register' },
    ...(seesPeople ? [{ value: 'people', label: 'Shareholders' }] : []),
    { value: 'reports', label: 'Reports' },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Shareholders"
        subtitle={
          totals
            ? `${totals.holder_count} holder${totals.holder_count === 1 ? '' : 's'} · ${Number(totals.total_shares).toLocaleString('en-US')} shares`
            : undefined
        }
      />

      {!seesPeople && (
        <Card className="bg-surface-muted">
          <CardBody>
            <p className="text-muted-foreground text-sm">
              Register totals and the ownership distribution. No contact detail or identification
              appears here.
            </p>
          </CardBody>
        </Card>
      )}

      <FilterTabs param="tab" defaultValue="register" options={tabs} />

      {tab === 'register' && (
        <>
          {totals && (
            <Card>
              <CardBody className="space-y-1.5">
                <Row label="Shareholders" value={String(totals.shareholder_count)} />
                <Row label="Active" value={String(totals.active_count)} />
                <Row label="Holders" value={String(totals.holder_count)} />
                <Row label="Total shares" value={Number(totals.total_shares).toLocaleString('en-US')} />
                <Row label="Share capital committed" value={formatUgx(totals.total_committed_ugx)} />
                <Row label="Received" value={formatUgx(totals.total_paid_ugx)} strong />
                <Row label="Outstanding" value={formatUgx(totals.outstanding_ugx)} />
                {totals.pending_approvals > 0 && (
                  <Row label="Awaiting approval" value={String(totals.pending_approvals)} />
                )}
              </CardBody>
            </Card>
          )}
          <RegisterTable rows={register} />
        </>
      )}

      {tab === 'people' && seesPeople && (
        <>
          {can('shareholders.create') && <AddShareholderCard today={today} />}
          <SearchField label="Search shareholders" placeholder="Name or number" />
          <FilterTabs
            defaultValue="all"
            options={[
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'suspended', label: 'Suspended' },
              { value: 'exited', label: 'Exited' },
            ]}
          />
          <ShareholdersTable rows={people} />
        </>
      )}

      {tab === 'reports' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Share capital</CardTitle>
            </CardHeader>
            <CardBody className="space-y-1.5">
              {classes.map((c) => (
                <Row
                  key={c.id}
                  label={`${c.code} · ${Number(c.issued_shares).toLocaleString('en-US')} shares at ${formatUgx(c.value_per_share_ugx)}`}
                  value={`${formatUgx(c.paid_ugx)} of ${formatUgx(c.committed_ugx)}`}
                />
              ))}
              {classes.length === 0 && (
                <p className="text-muted-foreground text-sm">No share classes yet.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Ownership on a date</CardTitle>
            </CardHeader>
            <CardBody>
              <form method="get" className="mb-3 max-w-xs">
                <input type="hidden" name="tab" value="reports" />
                <label className="text-muted-foreground mb-1 block text-sm" htmlFor="date">
                  End of day
                </label>
                <input
                  id="date"
                  name="date"
                  type="date"
                  defaultValue={params.date ?? today}
                  max={today}
                  className="border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base"
                />
                <noscript>
                  <button type="submit" className="text-primary mt-2 text-sm">Show</button>
                </noscript>
              </form>
              <p className="text-muted-foreground mb-3 text-sm">
                Read from the ownership ledger. A transaction made later never changes this answer.
              </p>
              <ul className="space-y-2">
                {asOf.map((row) => (
                  <li key={row.shareholder_id} className="flex justify-between gap-3 text-sm">
                    <span>
                      {row.shareholder_name} · {row.shareholder_number}
                    </span>
                    <span className="tabular">
                      {Number(row.shares).toLocaleString('en-US')} ·{' '}
                      {Number(row.ownership_percent).toFixed(4)}%
                    </span>
                  </li>
                ))}
                {asOf.length === 0 && (
                  <li className="text-muted-foreground text-sm">Nobody held shares on that day.</li>
                )}
              </ul>
            </CardBody>
          </Card>
        </>
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
