import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { getItem, highValueThreshold, listMovementsForItem } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { StockActions } from './stock-actions';

export const metadata: Metadata = { title: 'Item' };

const TYPE_LABELS: Record<string, string> = {
  stock_in: 'Stock in',
  usage: 'Used',
  stock_out: 'Stock out',
  return: 'Returned',
  adjustment_in: 'Count up',
  adjustment_out: 'Count down',
  reversal: 'Reversal',
};

export default async function ItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  await requireAnyPermission('inventory.view');
  const { itemId } = await params;
  const [item, movements, threshold, user] = await Promise.all([
    getItem(itemId),
    listMovementsForItem(itemId),
    highValueThreshold(),
    currentUser(),
  ]);
  if (!item) notFound();

  return (
    <div className="space-y-4">
      <PageHeader
        title={item.name}
        subtitle={`${item.sku} · ${item.category.replace(/_/g, ' ')}`}
        back={{ href: '/inventory', label: 'Inventory' }}
        action={<StatusBadge status={item.stock_status} />}
      />

      <Card>
        <CardBody className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground text-sm">In stock</span>
            <span className="tabular text-foreground text-lg font-semibold">
              {item.quantity} {item.unit}
            </span>
          </div>
          <Row label="Minimum" value={String(item.minimum_stock)} />
          <Row label="Reorder level" value={String(item.reorder_level)} />
          <Row
            label="Last unit cost"
            value={item.last_unit_cost_ugx == null ? '—' : formatUgx(item.last_unit_cost_ugx)}
          />
          {item.preferred_supplier_name && (
            <Row label="Preferred supplier" value={item.preferred_supplier_name} />
          )}
          {item.last_counted_at && (
            <Row
              label="Last counted"
              value={`${item.last_counted_quantity} on ${formatDateTime(item.last_counted_at)}`}
            />
          )}
          {!item.active && <Badge tone="neutral">Inactive</Badge>}
        </CardBody>
      </Card>

      <StockActions
        item={item}
        threshold={threshold}
        permissions={user?.permissions ?? []}
        movements={movements}
      />

      <Card>
        <CardHeader>
          <CardTitle>Movements</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {movements.map((m) => (
              <li key={m.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground text-sm font-medium">
                        {TYPE_LABELS[m.type] ?? m.type}
                      </span>
                      {m.status === 'reversed' && <Badge tone="danger">Reversed</Badge>}
                      {m.approved_by && <Badge tone="info">Approved</Badge>}
                    </div>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                      {m.movement_number} · {formatDateTime(m.created_at)}
                      {m.created_by_name ? ` · ${m.created_by_name}` : ''}
                    </p>
                    {m.reason && <p className="text-muted-foreground mt-0.5 text-xs">{m.reason}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`tabular block text-sm font-medium ${
                        m.quantity_change < 0 ? 'text-danger' : 'text-success'
                      }`}
                    >
                      {m.quantity_change > 0 ? '+' : '−'}
                      {Math.abs(m.quantity_change)}
                    </span>
                    <span className="tabular text-muted-foreground block text-xs">
                      {m.quantity_before} → {m.quantity_after}
                    </span>
                  </div>
                </div>
              </li>
            ))}
            {movements.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                Nothing has moved yet.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="tabular text-foreground text-sm">{value}</span>
    </div>
  );
}
