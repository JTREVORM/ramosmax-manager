'use client';

import * as React from 'react';
import { Card, CardBody } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { updateWorkerOrderStatusAction } from '@/lib/server/operations-actions';
import type { OrderRow } from '@/lib/server/operations';

/**
 * One worker order, with the ONE action that is legal from its current state.
 *
 * Offering a single next action mirrors the status flow and keeps the card
 * usable one-handed on a phone. The server refuses anything else regardless,
 * so this is a convenience, not a control.
 */
const NEXT: Record<string, { action: string; label: string; reason?: boolean; notes?: boolean }> = {
  assigned: { action: 'accept', label: 'Accept job' },
  accepted: { action: 'start', label: 'Start work' },
  in_progress: { action: 'complete', label: 'Mark complete', notes: true },
  paused: { action: 'resume', label: 'Resume work' },
};

function workedMinutes(order: OrderRow): number | null {
  if (!order.started_at) return null;
  const end = order.completed_at ? new Date(order.completed_at) : new Date();
  const elapsed = end.getTime() - new Date(order.started_at).getTime();
  return Math.max(0, Math.round((elapsed - Number(order.total_paused_ms ?? 0)) / 60000));
}

export function MyJobCard({ order }: { order: OrderRow }) {
  const [panel, setPanel] = React.useState<'next' | 'pause' | null>(null);
  const next = NEXT[order.status];
  const minutes = workedMinutes(order);

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-foreground text-base font-semibold">{order.number_plate}</div>
            <div className="text-muted-foreground truncate text-sm">
              {order.service_name}
              {order.vehicle_summary ? ` · ${order.vehicle_summary}` : ''}
            </div>
            <div className="text-muted-foreground text-xs">{order.order_number}</div>
          </div>
          <StatusBadge status={order.status} />
        </div>

        {order.notes && <p className="text-muted-foreground text-sm">Notes: {order.notes}</p>}
        {order.pause_reason && <p className="text-warning text-sm">Paused: {order.pause_reason}</p>}
        {minutes !== null && (
          <p className="text-muted-foreground text-xs">
            Worked time: {minutes} minute{minutes === 1 ? '' : 's'}
          </p>
        )}

        {next && panel === null && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setPanel('next')}
              className="bg-primary text-primary-foreground inline-flex h-11 items-center rounded-[var(--radius)] px-4 text-sm font-medium"
            >
              {next.label}
            </button>
            {order.status === 'in_progress' && (
              <button
                type="button"
                onClick={() => setPanel('pause')}
                className="bg-surface-muted text-foreground border-border inline-flex h-11 items-center rounded-[var(--radius)] border px-4 text-sm"
              >
                Pause
              </button>
            )}
          </div>
        )}

        {panel === 'next' && next && (
          <ActionForm
            action={updateWorkerOrderStatusAction}
            submitLabel={next.label}
            onDone={() => setPanel(null)}
          >
            <input type="hidden" name="order_id" value={order.id} />
            <input type="hidden" name="action" value={next.action} />
            {next.notes && (
              <Field label="Notes" htmlFor={`notes-${order.id}`} hint="Optional">
                <Input name="notes" />
              </Field>
            )}
          </ActionForm>
        )}

        {panel === 'pause' && (
          <ActionForm
            action={updateWorkerOrderStatusAction}
            submitLabel="Pause work"
            onDone={() => setPanel(null)}
          >
            <input type="hidden" name="order_id" value={order.id} />
            <input type="hidden" name="action" value="pause" />
            <Field label="Why are you pausing?" htmlFor={`pause-${order.id}`}>
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
