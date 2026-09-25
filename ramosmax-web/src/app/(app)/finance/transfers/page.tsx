import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUgx } from '@/lib/format/money';
import { formatDateTime } from '@/lib/format/date';
import { listAccounts, listLedger } from '@/lib/server/finance';
import { requireAnyPermission } from '@/lib/server/guard';
import { TransferForm } from './transfer-form';

export const metadata: Metadata = { title: 'Transfers' };

export default async function TransfersPage() {
  await requireAnyPermission('finance.transfer');
  const [accounts, transfers] = await Promise.all([listAccounts(), listLedger('account_transfer')]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Transfers"
        subtitle="Moving money between accounts. Never income."
        back={{ href: '/finance', label: 'Finance' }}
      />

      <Card>
        <CardHeader>
          <CardTitle>New transfer</CardTitle>
        </CardHeader>
        <CardBody>
          <TransferForm accounts={accounts.filter((a) => a.is_active)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent transfers</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-border divide-y">
            {transfers.map((t) => (
              <li key={t.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm">
                      {t.source_account_name} → {t.destination_account_name}
                    </p>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                      {t.transaction_number} · {formatDateTime(t.created_at)}
                      {t.created_by_name ? ` · ${t.created_by_name}` : ''}
                    </p>
                    {t.reason && <p className="text-muted-foreground mt-0.5 text-xs">{t.reason}</p>}
                  </div>
                  <span
                    className={`tabular shrink-0 text-sm font-medium ${
                      t.status === 'reversed' ? 'text-muted-foreground line-through' : 'text-foreground'
                    }`}
                  >
                    {formatUgx(t.amount_ugx)}
                  </span>
                </div>
              </li>
            ))}
            {transfers.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                No transfers yet.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
