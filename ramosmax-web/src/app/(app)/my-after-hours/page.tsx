import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { difference, GRANT_LABELS } from '@/lib/format/after-hours';
import { requireAnyPermission } from '@/lib/server/guard';
import { myAfterHours } from '@/lib/server/after-hours';
import { CloseSessionCard, StartSessionCard, SubmitHandoverCard } from './my-session';

export const metadata: Metadata = { title: 'My after-hours' };

/**
 * A worker's own after-hours record, and nothing else.
 *
 * Everything comes from `app.my_after_hours()`, which the database serves
 * from the caller's own sign-in. The expected cash is a figure to read: there
 * is no field for it here, and no function would accept one.
 */
export default async function MyAfterHoursPage() {
  await requireAnyPermission('after_hours.request', 'after_hours.view');
  const mine = await myAfterHours();

  const authorization = mine.authorization;
  const session = mine.session;
  const pending = mine.handovers.filter((h) => h.status === 'pending');

  return (
    <div className="space-y-4">
      <PageHeader
        title="My after-hours"
        subtitle={session ? `Session ${session.sessionNumber} is open` : 'Your shifts and your cash'}
      />

      {authorization ? (
        <Card>
          <CardHeader>
            <CardTitle>You are authorised</CardTitle>
          </CardHeader>
          <CardBody className="space-y-1.5">
            <Row label="Reference" value={authorization.authorizationNumber} />
            <Row label="Until" value={formatDateTime(authorization.expiresAt)} strong />
            <Row label="Authorised by" value={authorization.supervisorName ?? '—'} />
            {authorization.openingFloatUgx > 0 && (
              <Row
                label="Opening float"
                value={`${formatUgx(authorization.openingFloatUgx)}${authorization.floatTaken ? ' · already taken' : ''}`}
              />
            )}
            <div className="pt-2">
              <p className="text-muted-foreground text-sm">What you may do tonight</p>
              <ul className="mt-1 space-y-1">
                {authorization.permissions.map((p) => (
                  <li key={p} className="text-sm">
                    {GRANT_LABELS[p] ?? p}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-muted-foreground pt-2 text-xs">
              These end by themselves at the time above.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody>
            <p className="text-muted-foreground text-sm">
              You have no after-hours authorisation in force. A manager can authorise you.
            </p>
          </CardBody>
        </Card>
      )}

      {session ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Session {session.sessionNumber}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-1.5">
              <Row label="Opened" value={formatDateTime(session.openedAt)} />
              <Row label="Opening float" value={formatUgx(session.openingFloatUgx)} />
              <Row label="Cash taken" value={formatUgx(session.cashCollectedUgx)} />
              {session.cashReversedUgx > 0 && (
                <Row label="Cash reversed" value={`− ${formatUgx(session.cashReversedUgx)}`} />
              )}
              <Row label="To hand over" value={formatUgx(session.expectedCashUgx)} strong />
              <Row
                label="Mobile money"
                value={`${formatUgx(session.nonCashCollectedUgx)} · not in your hands`}
              />
              <Row
                label="Work done"
                value={`${session.intakesCreated} intakes · ${session.invoicesCreated} invoices · ${session.paymentCount} payments`}
              />
              <p className="text-muted-foreground pt-2 text-xs">
                The amount to hand over is worked out by the system from your payments. You can see
                it; you cannot change it.
              </p>
            </CardBody>
          </Card>

          <CloseSessionCard sessionId={session.sessionId} />

          <Card>
            <CardHeader>
              <CardTitle>Every note that passed through</CardTitle>
            </CardHeader>
            <CardBody>
              {mine.custody.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing yet.</p>
              ) : (
                <ul className="space-y-2" aria-label="My custody entries">
                  {mine.custody.map((c) => (
                    <li key={c.entryNumber} className="flex justify-between gap-3 text-sm">
                      <span>
                        {c.kind === 'opening_float'
                          ? 'Opening float'
                          : c.kind === 'payment'
                            ? `Payment ${c.receiptNumber ?? ''}`.trim()
                            : 'Payment reversed'}
                        <span className="text-muted-foreground block text-xs">
                          {c.numberPlate ?? c.entryNumber}
                        </span>
                      </span>
                      <span className="tabular">
                        {c.cashDeltaUgx === 0 ? '—' : formatUgx(Math.abs(c.cashDeltaUgx))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      ) : (
        <StartSessionCard canStart={Boolean(authorization)} />
      )}

      {pending.map((h) => (
        <SubmitHandoverCard
          key={h.handoverId}
          handoverId={h.handoverId}
          expectedUgx={h.expectedCashUgx}
        />
      ))}

      <Card>
        <CardHeader>
          <CardTitle>My handovers</CardTitle>
        </CardHeader>
        <CardBody>
          {mine.handovers.length === 0 ? (
            <p className="text-muted-foreground text-sm">You have handed over nothing yet.</p>
          ) : (
            <ul className="space-y-2" aria-label="My handovers">
              {mine.handovers.map((h) => (
                <li key={h.handoverId} className="flex justify-between gap-3 text-sm">
                  <Link
                    href={`/after-hours/handover/${h.handoverId}`}
                    className="text-primary hover:underline"
                  >
                    {h.handoverNumber}
                    <span className="text-muted-foreground block text-xs">
                      {h.sessionNumber} · expected {formatUgx(h.expectedCashUgx)}
                    </span>
                  </Link>
                  <span className="text-right">
                    <StatusBadge status={h.status} />
                    {h.differenceUgx !== null && (
                      <span className="text-muted-foreground block text-xs">
                        {difference(h.differenceUgx)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {mine.discrepancies.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Differences on my handovers</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2" aria-label="My discrepancies">
              {mine.discrepancies.map((d) => (
                <li key={d.discrepancyId} className="flex justify-between gap-3 text-sm">
                  <Link
                    href={`/after-hours/discrepancy/${d.discrepancyId}`}
                    className="text-primary hover:underline"
                  >
                    {d.discrepancyNumber}
                    <span className="text-muted-foreground block text-xs">{d.reason}</span>
                  </Link>
                  <span className="text-right">
                    {difference(d.differenceUgx)}
                    <span className="block">
                      <StatusBadge status={d.status} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-3 text-xs">
              Somebody else reviews these. Nothing is taken from your pay unless a loss is reported,
              reviewed, approved and separately authorised.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>My shifts</CardTitle>
        </CardHeader>
        <CardBody>
          {mine.sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            <ul className="space-y-2" aria-label="My sessions">
              {mine.sessions.map((s) => (
                <li key={s.sessionId} className="flex justify-between gap-3 text-sm">
                  <span>
                    {s.sessionNumber}
                    <span className="text-muted-foreground block text-xs">
                      {formatDateTime(s.openedAt)}
                    </span>
                  </span>
                  <span className="text-right">
                    {formatUgx(s.expectedCashUgx)}
                    <span className="block">
                      <StatusBadge status={s.status} />
                    </span>
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
