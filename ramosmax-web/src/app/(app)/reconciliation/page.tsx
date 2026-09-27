import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUgx } from '@/lib/format/money';
import { formatDate } from '@/lib/format/date';
import { listAccounts, listReconciliations } from '@/lib/server/finance';
import { currentUser } from '@/lib/server/auth-service';
import { requireAnyPermission } from '@/lib/server/guard';
import { ReconciliationPanels } from './reconciliation-panels';

export const metadata: Metadata = { title: 'Reconciliation' };

export default async function ReconciliationPage() {
  await requireAnyPermission('finance.reconcile', 'finance.transactions.view');
  const [accounts, history, user] = await Promise.all([
    listAccounts(),
    listReconciliations(),
    currentUser(),
  ]);
  const permissions = user?.permissions ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reconciliation"
        subtitle="What the system holds against what was counted."
      />

      <ReconciliationPanels
        accounts={accounts.filter((a) => a.is_active)}
        open={history.filter((r) => r.status === 'discrepancy')}
        permissions={permissions}
      />

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {history.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-medium">{r.account_name}</p>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                      {r.reconciliation_number} · {formatDate(r.reconciliation_date)}
                      {r.reconciled_by_name ? ` · ${r.reconciled_by_name}` : ''}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      System {formatUgx(r.system_balance_ugx)} · counted{' '}
                      {formatUgx(r.actual_balance_ugx)}
                    </p>
                    {r.notes && <p className="text-muted-foreground mt-0.5 text-xs">{r.notes}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`tabular block text-sm font-medium ${
                        r.difference_ugx === 0
                          ? 'text-success'
                          : r.difference_ugx > 0
                            ? 'text-warning'
                            : 'text-danger'
                      }`}
                    >
                      {r.difference_ugx > 0 ? '+' : r.difference_ugx < 0 ? '−' : ''}
                      {formatUgx(Math.abs(r.difference_ugx))}
                    </span>
                    <StatusBadge status={r.status} />
                  </div>
                </div>
              </li>
            ))}
            {history.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                Nothing has been reconciled yet.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <p className="text-muted-foreground text-sm">
            A reconciliation never changes a balance. A difference is closed by an explicit
            adjustment, which is recorded in the{' '}
            <Link href="/transactions" className="text-primary hover:underline">
              ledger
            </Link>{' '}
            like any other movement.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
