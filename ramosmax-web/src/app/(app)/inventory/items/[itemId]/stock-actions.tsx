'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import {
  adjustStockAction, recordMovementAction, reverseMovementAction, updateItemAction,
} from '@/lib/server/finance-actions';
import type { ItemRow, MovementRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

/**
 * Stock in, usage, stock out, a physical count and corrections.
 *
 * The quantity shown is the server's. The warning about a high-value stock-out
 * is a courtesy: the server applies the threshold itself and refuses anyone
 * without `inventory.stock.adjust`.
 */
export function StockActions({
  item,
  threshold,
  permissions,
  movements,
}: {
  item: ItemRow;
  threshold: number;
  permissions: string[];
  movements: MovementRow[];
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);

  const canIn = can('inventory.stock.in') && item.active;
  const canOut = can('inventory.stock.out') && item.quantity > 0;
  const canCount = can('inventory.stock.adjust');
  const canEdit = can('inventory.manage');
  const reversible = movements.filter(
    (m) => m.status === 'posted' && m.type !== 'reversal' && m.purchase_id === null,
  );

  if (!canIn && !canOut && !canCount && !canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {canOut && (
            <Button size="sm" onClick={() => setPanel(panel === 'use' ? null : 'use')}>
              Use / stock out
            </Button>
          )}
          {canIn && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'in' ? null : 'in')}>
              Stock in
            </Button>
          )}
          {canCount && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(panel === 'count' ? null : 'count')}>
              Count / adjust
            </Button>
          )}
          {canCount && reversible.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'reverse' ? null : 'reverse')}>
              Reverse a movement
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'edit' ? null : 'edit')}>
              Edit details
            </Button>
          )}
        </div>

        {panel === 'use' && <OutPanel item={item} threshold={threshold} permissions={permissions} />}
        {panel === 'in' && <InPanel item={item} />}
        {panel === 'count' && <CountPanel item={item} />}
        {panel === 'reverse' && <ReversePanel item={item} movements={reversible} />}
        {panel === 'edit' && <EditPanel item={item} />}
      </CardBody>
    </Card>
  );
}

function OutPanel({
  item,
  threshold,
  permissions,
}: {
  item: ItemRow;
  threshold: number;
  permissions: string[];
}) {
  const [requestId] = React.useState(newRequestId);
  const [type, setType] = React.useState('usage');
  const [quantity, setQuantity] = React.useState('1');

  const amount = Number(quantity);
  const tooMany = Number.isFinite(amount) && amount > item.quantity;
  const value = Number.isFinite(amount) ? amount * Number(item.last_unit_cost_ugx ?? 0) : 0;
  const needsApproval = type === 'stock_out' && value >= threshold;
  const mayApprove = permissions.includes('inventory.stock.adjust');

  return (
    <ActionForm action={recordMovementAction} submitLabel="Record movement">
      <input type="hidden" name="item_id" value={item.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <Field label="What happened" htmlFor="type">
          <select
            id="type"
            name="type"
            className={selectClass}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="usage">Used on a job</option>
            <option value="stock_out">Stock out (damaged, expired, wastage…)</option>
            <option value="return">Returned to the supplier</option>
          </select>
        </Field>

        <Field
          label={`Quantity (${item.unit})`}
          htmlFor="quantity"
          hint={`${item.quantity} available.`}
          error={tooMany ? `Only ${item.quantity} ${item.unit}(s) available.` : undefined}
        >
          <Input
            name="quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={item.quantity}
            required
            className="tabular text-lg"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>

        {type === 'stock_out' && (
          <Field label="Why" htmlFor="reason_code">
            <select id="reason_code" name="reason_code" className={selectClass} required>
              <option value="damaged">Damaged</option>
              <option value="expired">Expired</option>
              <option value="wastage">Wastage</option>
              <option value="internal_use">Internal use</option>
              <option value="other">Other</option>
            </select>
          </Field>
        )}

        <Field label="Reason" htmlFor="movement-reason" hint="Required, and kept with the movement.">
          <Input name="reason" required />
        </Field>

        {needsApproval && (
          <p className={mayApprove ? 'text-warning text-sm' : 'text-danger text-sm'}>
            {formatUgx(value)} is at or above the {formatUgx(threshold)} threshold —{' '}
            {mayApprove
              ? 'this will be recorded as approved by you.'
              : 'this needs a manager and will be refused.'}
          </p>
        )}
      </div>
    </ActionForm>
  );
}

function InPanel({ item }: { item: ItemRow }) {
  const [requestId] = React.useState(newRequestId);
  return (
    <ActionForm action={recordMovementAction} submitLabel="Record stock in">
      <input type="hidden" name="item_id" value={item.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="type" value="stock_in" />
      <div className="space-y-4">
        <Field label={`Quantity (${item.unit})`} htmlFor="quantity">
          <Input name="quantity" type="number" inputMode="numeric" min={1} required className="tabular text-lg" />
        </Field>
        <Field label="Unit cost (UGX)" htmlFor="unit_cost_ugx" hint="Optional. Updates the item's last cost.">
          <Input name="unit_cost_ugx" type="number" inputMode="numeric" min={0} className="tabular" />
        </Field>
        <Field label="Reason" htmlFor="in-reason" hint="Required. A purchase receipt is recorded from the purchase instead.">
          <Input name="reason" required />
        </Field>
        <Field label="Reference" htmlFor="reference" hint="Optional">
          <Input name="reference" />
        </Field>
      </div>
    </ActionForm>
  );
}

function CountPanel({ item }: { item: ItemRow }) {
  const [requestId] = React.useState(newRequestId);
  const [counted, setCounted] = React.useState(String(item.quantity));
  const difference = Number(counted) - item.quantity;

  return (
    <ActionForm action={adjustStockAction} submitLabel="Record the count">
      <input type="hidden" name="item_id" value={item.id} />
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-4">
        <Field
          label={`Counted quantity (${item.unit})`}
          htmlFor="counted_quantity"
          hint={`The system says ${item.quantity}. The DIFFERENCE is what gets recorded.`}
        >
          <Input
            name="counted_quantity"
            type="number"
            inputMode="numeric"
            min={0}
            required
            className="tabular text-lg"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
          />
        </Field>
        {Number.isFinite(difference) && (
          <p className={difference === 0 ? 'text-muted-foreground text-sm' : 'text-warning text-sm'}>
            {difference === 0
              ? 'No difference — the count matches, and nothing will be recorded.'
              : `${difference > 0 ? 'Count up' : 'Count down'} ${Math.abs(difference)} ${item.unit}(s)`}
          </p>
        )}
        <Field label="Reason" htmlFor="count-reason" hint="Required, and kept with the movement.">
          <Input name="reason" required />
        </Field>
      </div>
    </ActionForm>
  );
}

function ReversePanel({ item, movements }: { item: ItemRow; movements: MovementRow[] }) {
  return (
    <ActionForm
      action={reverseMovementAction}
      submitLabel="Reverse movement"
      confirm="Reverse this movement? The mirror movement is recorded and both are kept."
    >
      <input type="hidden" name="item_id" value={item.id} />
      <div className="space-y-4">
        <Field label="Movement" htmlFor="movement_id">
          <select id="movement_id" name="movement_id" className={selectClass} required>
            {movements.map((m) => (
              <option key={m.id} value={m.id}>
                {m.movement_number} · {m.type.replace(/_/g, ' ')} {m.quantity_change > 0 ? '+' : ''}
                {m.quantity_change}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason" htmlFor="reverse-reason" hint="Required, and kept with the movement.">
          <Input name="reason" required />
        </Field>
      </div>
    </ActionForm>
  );
}

function EditPanel({ item }: { item: ItemRow }) {
  return (
    <ActionForm action={updateItemAction} submitLabel="Save changes">
      <input type="hidden" name="item_id" value={item.id} />
      <div className="space-y-4">
        <Field label="Name" htmlFor="name">
          <Input name="name" defaultValue={item.name} />
        </Field>
        <Field label="Minimum stock" htmlFor="minimum_stock">
          <Input name="minimum_stock" type="number" min={0} defaultValue={item.minimum_stock} className="tabular" />
        </Field>
        <Field label="Reorder level" htmlFor="reorder_level" hint="Cannot be below the minimum.">
          <Input name="reorder_level" type="number" min={0} defaultValue={item.reorder_level} className="tabular" />
        </Field>
        <Field label="Description" htmlFor="description">
          <Input name="description" defaultValue={item.description ?? ''} />
        </Field>
        <Field label="Reason" htmlFor="item-reason" hint="Required when deactivating.">
          <Input name="reason" />
        </Field>
        <Field label="Active" htmlFor="active" hint="An inactive item cannot receive stock.">
          <select id="active" name="active" className={selectClass} defaultValue={String(item.active)}>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </Field>
      </div>
    </ActionForm>
  );
}
