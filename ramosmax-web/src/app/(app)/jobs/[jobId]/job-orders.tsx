'use client';

import * as React from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatDateTime } from '@/lib/format/date';
import {
  assignWorkerOrderAction,
  cancelWorkerOrderAction,
  reassignWorkerOrderAction,
} from '@/lib/server/operations-actions';
import type { OrderRow, WorkerOption } from '@/lib/server/operations';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * The Work section: one card per worker order, with its assignment history and
 * the actions a manager may take. Which actions are legal is decided by the
 * server — these controls only choose which to offer.
 */
export function JobOrders({
  jobId,
  orders,
  workers,
  canAssign,
  canManage,
}: {
  jobId: string;
  orders: OrderRow[];
  workers: WorkerOption[];
  canAssign: boolean;
  canManage: boolean;
}) {
  return (
    <section>
      <h2 className="text-foreground mb-2 text-sm font-semibold">Work</h2>
      <ul className="space-y-2">
        {orders.map((order) => (
          <li key={order.id}>
            <OrderCard
              jobId={jobId}
              order={order}
              workers={workers}
              canAssign={canAssign}
              canManage={canManage}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OrderCard({
  jobId,
  order,
  workers,
  canAssign,
  canManage,
}: {
  jobId: string;
  order: OrderRow;
  workers: WorkerOption[];
  canAssign: boolean;
  canManage: boolean;
}) {
  const [panel, setPanel] = React.useState<'assign' | 'reassign' | 'cancel' | null>(null);

  const finished = order.status === 'completed' || order.status === 'cancelled';
  const canBeAssigned = order.status === 'pending';
  const canBeReassigned = ['assigned', 'accepted', 'in_progress', 'paused'].includes(order.status);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          {order.order_number} · {order.service_name}
        </CardTitle>
        <StatusBadge status={order.status} />
      </CardHeader>
      <CardBody className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {[
            ['Worker', order.worker_name ?? 'Unassigned'],
            ['Assigned', order.assigned_at ? formatDateTime(order.assigned_at) : '—'],
            ['Completed', order.completed_at ? formatDateTime(order.completed_at) : '—'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground text-xs">{label}</dt>
              <dd className="text-foreground text-sm">{value}</dd>
            </div>
          ))}
        </dl>

        {order.pause_reason && <p className="text-warning text-sm">Paused: {order.pause_reason}</p>}
        {order.completion_notes && (
          <p className="text-muted-foreground text-sm">Notes: {order.completion_notes}</p>
        )}

        {(order.assignment_history?.length ?? 0) > 1 && (
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer">Assignment history</summary>
            <ul className="text-muted-foreground mt-2 space-y-1">
              {order.assignment_history!.map((entry, index) => (
                <li key={index}>
                  {entry.workerName} — {formatDateTime(entry.assignedAt)}
                  {entry.endedAt ? ` → ended (${entry.reason ?? 'no reason'})` : ' (current)'}
                </li>
              ))}
            </ul>
          </details>
        )}

        {!finished && (canAssign || canManage) && (
          <div className="flex flex-wrap gap-2">
            {canAssign && canBeAssigned && (
              <Button
                type="button"
                size="sm"
                onClick={() => setPanel(panel === 'assign' ? null : 'assign')}
              >
                Assign
              </Button>
            )}
            {canAssign && canBeReassigned && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setPanel(panel === 'reassign' ? null : 'reassign')}
              >
                Reassign
              </Button>
            )}
            {canManage && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}
              >
                Cancel service
              </Button>
            )}
          </div>
        )}

        {panel === 'assign' && (
          <ActionForm action={assignWorkerOrderAction} submitLabel="Assign worker">
            <input type="hidden" name="order_id" value={order.id} />
            <input type="hidden" name="job_id" value={jobId} />
            <WorkerPicker id={`assign-worker-${order.id}`} workers={workers} />
            <div className="mt-4">
              <Field label="Notes for the worker" htmlFor={`notes-${order.id}`} hint="Optional">
                <Input name="notes" />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'reassign' && (
          <ActionForm action={reassignWorkerOrderAction} submitLabel="Reassign worker">
            <input type="hidden" name="order_id" value={order.id} />
            <input type="hidden" name="job_id" value={jobId} />
            <WorkerPicker
              id={`reassign-worker-${order.id}`}
              workers={workers.filter((w) => w.id !== order.worker_id)}
            />
            <div className="mt-4">
              <Field
                label="Reason"
                htmlFor={`reassign-reason-${order.id}`}
                hint="Required, and kept in the audit trail."
              >
                <Input name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'cancel' && (
          <ActionForm
            action={cancelWorkerOrderAction}
            submitLabel="Cancel this service"
            confirm="Cancel this service? This cannot be undone."
          >
            <input type="hidden" name="order_id" value={order.id} />
            <input type="hidden" name="job_id" value={jobId} />
            <Field
              label="Reason"
              htmlFor={`cancel-reason-${order.id}`}
              hint="Required, and kept in the audit trail."
            >
              <Input name="reason" required />
            </Field>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Workers first, then anyone else who may carry out jobs.
 *
 * The id is passed in because several pickers appear on one page, one per
 * worker order, and duplicate element ids would break the label association.
 */
function WorkerPicker({ id, workers }: { id: string; workers: WorkerOption[] }) {
  return (
    <Field label="Worker" htmlFor={id}>
      <select id={id} name="worker_id" required className={selectClass} defaultValue="">
        <option value="" disabled>
          Choose a worker
        </option>
        {workers.map((worker) => (
          <option key={worker.id} value={worker.id}>
            {worker.full_name}
            {worker.role === 'worker' ? '' : ` (${worker.role})`}
          </option>
        ))}
      </select>
    </Field>
  );
}
