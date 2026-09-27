import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { listSettings, type SettingRow } from '@/lib/server/user-admin';
import { backend } from '@/lib/server/db';
import { pushConfigured } from '@/lib/server/push';

export const metadata: Metadata = { title: 'Settings' };

/**
 * Where each policy is CHANGED.
 *
 * Nothing on this screen is a second copy of a setting: every value shown is
 * read from the one row the rest of RamosMAX reads, and every change is made
 * on the screen that owns the work it governs, by the function that owns it.
 */
const POLICIES: Record<string, { title: string; href: string; note: string }> = {
  payroll_policy: {
    title: 'Attendance and pay',
    href: '/payroll?tab=policy',
    note: 'Reporting time, the grace period, what a late day costs and the daily allowance.',
  },
  after_hours_policy: {
    title: 'After hours',
    href: '/after-hours?tab=policy',
    note: 'How long a window may run for, how much float may go out and which payment methods may be taken.',
  },
  share_policy: {
    title: 'Shares',
    href: '/shares?tab=policy',
    note: 'Whether a share movement needs a second person, and whether shares may be issued before they are paid for.',
  },
  dividend_policy: {
    title: 'Dividends',
    href: '/shares?tab=policy',
    note: 'Whether a declared dividend needs an Administrator before it is paid.',
  },
  loyalty: {
    title: 'Loyalty',
    href: '/loyalty',
    note: 'Points per qualifying wash and the reward. Fixed in this release — changing it would reprice rewards customers have already earned.',
  },
};

const LABELS: Record<string, string> = {
  reportingTime: 'Reporting time',
  graceMinutes: 'Grace period (minutes)',
  latePolicy: 'A late day',
  dailyAllowanceUgx: 'Daily allowance (UGX)',
  maxWindowHours: 'Longest window (hours)',
  maxFloatUgx: 'Most float (UGX)',
  paymentMethods: 'Payment methods',
  requireApproval: 'Needs a second person',
  allowUnpaidShares: 'Shares before payment',
  allowPartialPayment: 'Part payment',
  requireAdminApproval: 'Needs an Administrator',
  pointsPerQualifyingService: 'Points per qualifying wash',
  rewardThreshold: 'Points for a reward',
  nearThresholdPoints: 'Nearly there at',
  rewardDiscountPercent: 'Reward discount (%)',
  pointsConsumedOnRedemption: 'Points used by a reward',
};

export default async function SettingsPage() {
  const granted = await requireAnyPermission('settings.view');
  const settings = await listSettings();
  const stored = new Map(settings.map((s) => [s.key, s]));
  const supabase = backend() === 'supabase';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        subtitle={granted.has('settings.manage') ? 'What the rules are, and where each is changed' : 'What the rules are'}
      />

      <Card>
        <CardHeader>
          <CardTitle>This installation</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1.5">
          <Row
            label="Database"
            value={supabase ? 'Hosted Supabase project' : 'Direct PostgreSQL connection'}
          />
          <Row label="Sign-in" value={supabase ? 'Supabase Auth' : 'Local credentials'} />
          <Row
            label="Push notifications"
            value={pushConfigured() ? 'Configured' : 'Not configured — the in-app inbox still works'}
          />
          <p className="text-muted-foreground pt-2 text-xs">
            Money is held in whole shillings and every time is East Africa Time. Neither is a
            setting: changing either would change what past records mean.
          </p>
        </CardBody>
      </Card>

      {Object.entries(POLICIES).map(([key, policy]) => (
        <Card key={key}>
          <CardHeader>
            <CardTitle>{policy.title}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2">
            <PolicyValues row={stored.get(key)} />
            <p className="text-muted-foreground text-sm">{policy.note}</p>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link href={policy.href} className="text-primary text-sm hover:underline">
                {granted.has('settings.manage') ? 'Change it where it is used' : 'See it where it is used'}
              </Link>
              <Provenance row={stored.get(key)} />
            </div>
          </CardBody>
        </Card>
      ))}

      <Card className="bg-surface-muted">
        <CardBody>
          <p className="text-muted-foreground text-sm">
            Every change here is written to the{' '}
            <Link href="/audit" className="text-primary hover:underline">
              audit trail
            </Link>{' '}
            with who made it and when. A policy change applies from the moment it is made: it never
            reaches back and re-decides something already recorded.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function PolicyValues({ row }: { row?: SettingRow }) {
  if (!row) {
    return (
      <p className="text-muted-foreground text-sm">
        Never changed — the built-in rule applies.
      </p>
    );
  }
  const entries = Object.entries(row.value);
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing set.</p>;
  }
  return (
    <dl className="space-y-1.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex justify-between gap-3">
          <dt className="text-muted-foreground text-sm">{LABELS[key] ?? key}</dt>
          <dd className="text-foreground tabular text-sm">{describe(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Provenance({ row }: { row?: SettingRow }) {
  if (!row?.updated_at) return null;
  return (
    <span className="text-muted-foreground text-xs">
      {row.updated_by_name ? `${row.updated_by_name} · ` : ''}
      {formatDateTime(row.updated_at)}
    </span>
  );
}

function describe(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'number') return value.toLocaleString('en-US');
  if (value === null || value === undefined) return '—';
  return String(value);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-foreground text-sm">{value}</span>
    </div>
  );
}
