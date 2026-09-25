'use client';

import * as React from 'react';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { formatUgx } from '@/lib/format/money';
import { newRequestId } from '@/lib/online';
import { createPurchaseAction } from '@/lib/server/finance-actions';
import type { ItemRow, SupplierRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

interface Line {
  itemId: string;
  quantity: number;
  unitCostUgx: number;
}

/**
 * Raising a purchase.
 *
 * The form sends WHAT was bought, how many and at what unit cost. The total
 * shown is a preview; the server prices every line and computes the total
 * itself, and that is the figure that is stored.
 */
export function PurchaseForm({
  suppliers,
  items,
}: {
  suppliers: SupplierRow[];
  items: ItemRow[];
}) {
  const [requestId] = React.useState(newRequestId);
  const [lines, setLines] = React.useState<Line[]>([
    { itemId: items[0]?.id ?? '', quantity: 1, unitCostUgx: items[0]?.last_unit_cost_ugx ?? 0 },
  ]);

  const preview = lines.reduce((sum, l) => sum + l.quantity * l.unitCostUgx, 0);
  const update = (index: number, change: Partial<Line>) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));

  return (
    <ActionForm
      action={createPurchaseAction}
      submitLabel="Raise purchase"
      redirectTo={(result) =>
        result.id ? `/inventory/purchases/${result.id}` : '/inventory/purchases'}
    >
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="items" value={JSON.stringify(lines)} />
      <div className="space-y-4">
        <Field label="Supplier" htmlFor="supplier_id">
          <select id="supplier_id" name="supplier_id" className={selectClass} required>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Purchase date" htmlFor="purchase_date">
          <Input
            name="purchase_date"
            type="date"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
        </Field>

        <Field label="Supplier invoice / reference" htmlFor="supplier_reference" hint="Optional">
          <Input name="supplier_reference" />
        </Field>

        <div className="space-y-3">
          <p className="text-foreground text-sm font-medium">Items</p>
          {lines.map((line, index) => {
            const item = items.find((i) => i.id === line.itemId);
            return (
              <div key={index} className="border-border space-y-2 rounded-[var(--radius)] border p-3">
                <select
                  aria-label={`Item ${index + 1}`}
                  className={selectClass}
                  value={line.itemId}
                  onChange={(e) => {
                    const next = items.find((i) => i.id === e.target.value);
                    update(index, {
                      itemId: e.target.value,
                      unitCostUgx: next?.last_unit_cost_ugx ?? line.unitCostUgx,
                    });
                  }}
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <label className="flex-1">
                    <span className="text-muted-foreground block text-xs">
                      Quantity{item ? ` (${item.unit})` : ''}
                    </span>
                    <input
                      type="number"
                      min={1}
                      className="border-border bg-surface text-foreground tabular h-12 w-full rounded-[var(--radius)] border px-3"
                      value={line.quantity}
                      onChange={(e) => update(index, { quantity: Number(e.target.value) })}
                    />
                  </label>
                  <label className="flex-1">
                    <span className="text-muted-foreground block text-xs">Unit cost (UGX)</span>
                    <input
                      type="number"
                      min={0}
                      className="border-border bg-surface text-foreground tabular h-12 w-full rounded-[var(--radius)] border px-3"
                      value={line.unitCostUgx}
                      onChange={(e) => update(index, { unitCostUgx: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <p className="text-muted-foreground text-xs">
                  {formatUgx(line.quantity * line.unitCostUgx)}
                </p>
                {lines.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLines(lines.filter((_, i) => i !== index))}
                  >
                    Remove line
                  </Button>
                )}
              </div>
            );
          })}
          {lines.length < 30 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setLines([
                  ...lines,
                  { itemId: items[0]?.id ?? '', quantity: 1, unitCostUgx: items[0]?.last_unit_cost_ugx ?? 0 },
                ])
              }
            >
              Add another item
            </Button>
          )}
        </div>

        <div className="bg-surface-muted rounded-[var(--radius)] px-4 py-3">
          <p className="text-foreground text-sm font-medium">Indicative total {formatUgx(preview)}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            The server prices the purchase from the quantities and unit costs; this preview is not
            what gets stored.
          </p>
        </div>

        <Field label="Notes" htmlFor="notes" hint="Optional">
          <Input name="notes" />
        </Field>
      </div>
    </ActionForm>
  );
}
