import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Card, CardBody } from '@/components/ui/card';
import { formatUgx } from '@/lib/format/money';
import { requireAnyPermission } from '@/lib/server/guard';
import { businessToday } from '@/lib/server/workforce';
import {
  afterHoursPolicy, grantableAfterHours, handoverTotals, listAuthorizations, listDiscrepancies,
  listEligibleStaff, listHandovers, listSessions, overview,
} from '@/lib/server/after-hours';
import {
  AuthorizationsTable, DiscrepanciesTable, HandoversTable, HandoverTotalsTable, SessionsTable,
} from './after-hours-tables';
import { AfterHoursPolicyCard, AuthorizeCard, RevokeCard } from './after-hours-forms';

export const metadata: Metadata = { title: 'After-hours' };

export default async function AfterHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; filter?: string; from?: string; to?: string }>;
}) {
  const granted = await requireAnyPermission(
    'after_hours.view', 'after_hours.approve', 'cash_handover.approve',
    'after_hours.discrepancy.review',
  );
  const can = (p: string) => granted.has(p);
  const params = await searchParams;
  const tab = params.tab ?? 'overview';

  const [counts, policy, today] = await Promise.all([
    overview(), afterHoursPolicy(), businessToday(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="After-hours"
        subtitle={
          counts.open_sessions > 0
            ? `${counts.open_sessions} session${counts.open_sessions === 1 ? '' : 's'} open now`
            : 'Authorisations, sessions, cash'
        }
      />

      <FilterTabs
        param="tab"
        defaultValue="overview"
        options={[
          { value: 'overview', label: 'Overview' },
          ...(can('after_hours.approve') ? [{ value: 'authorisations', label: 'Authorisations' }] : []),
          { value: 'sessions', label: 'Sessions' },
          { value: 'handovers', label: `Handovers (${counts.handovers_to_receive})` },
          { value: 'discrepancies', label: `Discrepancies (${counts.open_discrepancies})` },
          { value: 'reports', label: 'Reports' },
          { value: 'policy', label: 'Policy' },
        ]}
      />

      {tab === 'overview' && <Overview counts={counts} />}

      {tab === 'authorisations' && (
        <Authorisations
          filter={params.filter}
          policy={policy}
          canApprove={can('after_hours.approve')}
        />
      )}

      {tab === 'sessions' && <Sessions filter={params.filter} />}

      {tab === 'handovers' && <Handovers filter={params.filter} />}

      {tab === 'discrepancies' && <Discrepancies filter={params.filter} />}

      {tab === 'reports' && <Reports from={params.from} to={params.to} today={today} />}

      {tab === 'policy' && (
        <AfterHoursPolicyCard policy={policy} canManage={can('settings.manage')} />
      )}
    </div>
  );
}

function Overview({
  counts,
}: {
  counts: {
    live_authorizations: number;
    open_sessions: number;
    handovers_to_receive: number;
    open_discrepancies: number;
  };
}) {
  const tiles = [
    { label: 'Authorisations in force', value: counts.live_authorizations, href: '?tab=authorisations&filter=live' },
    { label: 'Sessions open', value: counts.open_sessions, href: '?tab=sessions&filter=open' },
    { label: 'Handovers to receive', value: counts.handovers_to_receive, href: '?tab=handovers&filter=outstanding' },
    { label: 'Discrepancies open', value: counts.open_discrepancies, href: '?tab=discrepancies&filter=open' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Link key={tile.label} href={tile.href} className="block">
          <Card className="h-full">
            <CardBody>
              <p className="text-muted-foreground text-sm">{tile.label}</p>
              <p className="tabular text-foreground mt-1 text-2xl font-semibold">{tile.value}</p>
            </CardBody>
          </Card>
        </Link>
      ))}
    </div>
  );
}

async function Authorisations({
  filter,
  policy,
  canApprove,
}: {
  filter?: string;
  policy: { maxAuthorizationHours: number; maxOpeningFloatUgx: number };
  canApprove: boolean;
}) {
  const [rows, staff, grantable] = await Promise.all([
    listAuthorizations(filter),
    canApprove ? listEligibleStaff() : Promise.resolve([]),
    grantableAfterHours(),
  ]);
  return (
    <>
      <AuthorizeCard
        staff={staff}
        grantable={grantable.all}
        defaults={grantable.defaults}
        maxHours={policy.maxAuthorizationHours}
        maxFloatUgx={policy.maxOpeningFloatUgx}
        canApprove={canApprove}
      />
      <RevokeCard authorizations={rows} canApprove={canApprove} />
      <FilterTabs
        param="filter"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'live', label: 'In force' },
          { value: 'ended', label: 'Ended' },
        ]}
      />
      <AuthorizationsTable rows={rows} />
    </>
  );
}

async function Sessions({ filter }: { filter?: string }) {
  const rows = await listSessions(filter);
  return (
    <>
      <FilterTabs
        param="filter"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'handover_pending', label: 'Awaiting handover' },
          { value: 'reconciled', label: 'Reconciled' },
          { value: 'closed', label: 'Closed' },
          { value: 'cancelled', label: 'Cancelled' },
        ]}
      />
      <SessionsTable rows={rows} />
    </>
  );
}

async function Handovers({ filter }: { filter?: string }) {
  const rows = await listHandovers(filter ?? 'all');
  return (
    <>
      <FilterTabs
        param="filter"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'outstanding', label: 'To receive' },
          { value: 'submitted', label: 'Submitted' },
          { value: 'discrepancy', label: 'In discrepancy' },
          { value: 'reconciled', label: 'Reconciled' },
        ]}
      />
      <HandoversTable rows={rows} />
    </>
  );
}

async function Discrepancies({ filter }: { filter?: string }) {
  const rows = await listDiscrepancies(filter);
  return (
    <>
      <FilterTabs
        param="filter"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
        ]}
      />
      <DiscrepanciesTable rows={rows} />
    </>
  );
}

async function Reports({ from, to, today }: { from?: string; to?: string; today: string }) {
  const rows = await handoverTotals(from, to);
  const totals = rows.reduce(
    (sum, r) => ({
      expected: sum.expected + Number(r.expected_ugx),
      received: sum.received + Number(r.received_ugx),
      shortage: sum.shortage + Number(r.shortage_ugx),
      excess: sum.excess + Number(r.excess_ugx),
    }),
    { expected: 0, received: 0, shortage: 0, excess: 0 },
  );

  return (
    <>
      <Card>
        <CardBody>
          <form className="flex flex-wrap items-end gap-3" method="get">
            <input type="hidden" name="tab" value="reports" />
            <label className="text-sm">
              <span className="text-muted-foreground block">From</span>
              <input
                type="date"
                name="from"
                defaultValue={from}
                max={today}
                className="border-border bg-surface text-foreground h-12 rounded-[var(--radius)] border px-3"
              />
            </label>
            <label className="text-sm">
              <span className="text-muted-foreground block">To</span>
              <input
                type="date"
                name="to"
                defaultValue={to}
                max={today}
                className="border-border bg-surface text-foreground h-12 rounded-[var(--radius)] border px-3"
              />
            </label>
            <button
              type="submit"
              className="bg-primary text-primary-foreground h-12 rounded-[var(--radius)] px-4 text-sm font-medium"
            >
              Show
            </button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Expected" value={formatUgx(totals.expected)} />
          <Row label="Received" value={formatUgx(totals.received)} strong />
          <Row label="Short" value={formatUgx(totals.shortage)} />
          <Row label="Over" value={formatUgx(totals.excess)} />
          <p className="text-muted-foreground pt-2 text-xs">
            Counted handovers only. A handover nobody has received yet has no counted figure to
            report.
          </p>
        </CardBody>
      </Card>

      <HandoverTotalsTable rows={rows} />
    </>
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
