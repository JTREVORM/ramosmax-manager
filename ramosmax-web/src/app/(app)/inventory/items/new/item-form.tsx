'use client';

import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import { createItemAction } from '@/lib/server/finance-actions';
import type { SupplierRow } from '@/lib/server/finance';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

const CATEGORIES = [
  'chemicals', 'soaps_shampoo', 'wax_polish', 'towels_cloths',
  'brushes_tools', 'cleaning_materials', 'spare_parts', 'other',
];
const UNITS = ['piece', 'bottle', 'litre', 'kg', 'pack', 'box', 'roll', 'pair', 'set', 'can', 'other'];

const label = (value: string) => value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function ItemForm({ suppliers }: { suppliers: SupplierRow[] }) {
  return (
    <ActionForm
      action={createItemAction}
      submitLabel="Create item"
      redirectTo={(result) => (result.id ? `/inventory/items/${result.id}` : '/inventory')}
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="name">
          <Input name="name" required maxLength={60} />
        </Field>

        <Field label="Category" htmlFor="category" hint="The SKU is allocated from the category.">
          <select id="category" name="category" className={selectClass} required>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{label(c)}</option>
            ))}
          </select>
        </Field>

        <Field label="Unit" htmlFor="unit" hint="Record liquids per container, not in millilitres.">
          <select id="unit" name="unit" className={selectClass} required>
            {UNITS.map((u) => (
              <option key={u} value={u}>{label(u)}</option>
            ))}
          </select>
        </Field>

        <Field label="Minimum stock" htmlFor="minimum_stock">
          <Input name="minimum_stock" type="number" min={0} defaultValue={0} className="tabular" />
        </Field>

        <Field label="Reorder level" htmlFor="reorder_level" hint="Cannot be below the minimum.">
          <Input name="reorder_level" type="number" min={0} defaultValue={0} className="tabular" />
        </Field>

        <Field label="Opening quantity" htmlFor="opening_quantity" hint="Recorded as a stock-in.">
          <Input name="opening_quantity" type="number" min={0} defaultValue={0} className="tabular" />
        </Field>

        <Field label="Unit cost (UGX)" htmlFor="last_unit_cost_ugx" hint="Optional. Used to value high-value stock-outs.">
          <Input name="last_unit_cost_ugx" type="number" inputMode="numeric" min={0} className="tabular" />
        </Field>

        <Field label="Preferred supplier" htmlFor="preferred_supplier_id" hint="Optional">
          <select id="preferred_supplier_id" name="preferred_supplier_id" className={selectClass}>
            <option value="">None</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Description" htmlFor="description" hint="Optional">
          <Input name="description" />
        </Field>
      </div>
    </ActionForm>
  );
}
