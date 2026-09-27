import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { requireAnyPermission } from '@/lib/server/guard';
import { sessionUserId } from '@/lib/server/session';
import { getSession, listCustody } from '@/lib/server/after-hours';
import { CustodyList } from '../../after-hours-tables';
import { SessionActions } from './session-actions';

export const metadata: Metadata = { title: 'After-hours session' };

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const granted = await requireAnyPermission(
    'after_hours.view', 'after_hours.approve', 'after_hours.request',
    'cash_handover.approve', 'after_hours.discrepancy.review',
  );
  const { sessionId } = await params;
  const [session, viewer] = await Promise.all([getSession(sessionId), sessionUserId()]);
  if (!session) notFound();
  const custody = await listCustody(sessionId);

  return (
    <div className="space-y-4">
      <PageHeader
        title={session.session_number}
        subtitle={`${session.staff_name} · ${session.authorization_number}`}
        back={{ href: '/after-hours?tab=sessions', label: 'After-hours' }}
        action={<StatusBadge status={session.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>What the cash is made up of</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1.5">
          <Row label="Opening float" value={formatUgx(session.opening_float_ugx)} />
          <Row label="Cash taken" value={formatUgx(session.cash_collected_ugx)} />
          {session.cash_reversed_ugx > 0 && (
            <Row label="Cash reversed in the session" value={`− ${formatUgx(session.cash_reversed_ugx)}`} />
          )}
          <Row label="Expected in hand" value={formatUgx(session.expected_cash_ugx)} strong />
          <Row
            label="Mobile money"
            value={`${formatUgx(session.non_cash_collected_ugx)} · straight to the merchant account`}
          />
          {session.post_close_reversals_ugx > 0 && (
            <Row
              label="Reversed after the close"
              value={`${formatUgx(session.post_close_reversals_ugx)} · from Cash at Hand`}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-1.5">
          <Row label="Opened" value={formatDateTime(session.opened_at)} />
          {session.closed_at && (
            <Row
              label="Closed"
              value={`${session.closed_by_name ?? '—'} · ${formatDateTime(session.closed_at)}`}
            />
          )}
          <Row label="Authorisation ends" value={formatDateTime(session.authorization_expires_at)} />
          <Row label="Authorised by" value={session.supervisor_name ?? '—'} />
          <Row
            label="Work done"
            value={`${session.intakes_created} intakes · ${session.invoices_created} invoices · ${session.jobs_completed} jobs`}
          />
          <Row label="Payments" value={`${session.payment_count} taken · ${session.reversal_count} reversed`} />
          {session.close_notes && <Row label="Close notes" value={session.close_notes} />}
          {session.cancel_reason && <Row label="Cancelled because" value={session.cancel_reason} />}
        </CardBody>
      </Card>

      {session.handover_id && (
        <Card>
          <CardBody>
            <Link
              href={`/after-hours/handover/${session.handover_id}`}
              className="text-primary text-sm hover:underline"
            >
              Handover {session.handover_number} · {session.handover_status}
            </Link>
          </CardBody>
        </Card>
      )}

      <SessionActions
        session={session}
        permissions={[...granted]}
        viewerUid={viewer ?? ''}
      />

      <Card>
        <CardHeader>
          <CardTitle>Custody entries</CardTitle>
        </CardHeader>
        <CardBody>
          {custody.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing has passed through yet.</p>
          ) : (
            <CustodyList rows={custody} />
          )}
          <p className="text-muted-foreground mt-3 text-xs">
            This is an operational record of cash in somebody&apos;s hands — not a financial
            account. Every payment above was posted to the business ledger when it was collected.
          </p>
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
