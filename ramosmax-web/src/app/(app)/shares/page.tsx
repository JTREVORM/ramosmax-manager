import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { requireAnyPermission } from '@/lib/server/guard';
import { listPickableAccounts } from '@/lib/server/finance';
import { businessToday } from '@/lib/server/workforce';
import {
  listContributions, listShareClasses, listShareholders, listShareTransactions,
  ownershipPolicies,
} from '@/lib/server/ownership';
import { ContributionsTable, ShareClassesTable, ShareTransactionsTable } from './shares-tables';
import { NewTransactionCard, ShareClassForms, SharePolicyCard } from './share-forms';

export const metadata: Metadata = { title: 'Shares' };

export default async function SharesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; filter?: string }>;
}) {
  const granted = await requireAnyPermission('shares.view');
  const can = (p: string) => granted.has(p);
  const params = await searchParams;
  const tab = params.tab ?? 'transactions';

  const [transactions, classes, contributions, policies, today, accounts, shareholders] =
    await Promise.all([
      listShareTransactions(params.filter),
      listShareClasses(),
      tab === 'contributions' ? listContributions() : Promise.resolve([]),
      ownershipPolicies(),
      businessToday(),
      can('shares.issue') ? listPickableAccounts() : Promise.resolve([]),
      can('shareholders.view') ? listShareholders() : Promise.resolve([]),
    ]);

  const pending = transactions.filter((t) => t.status === 'pending_approval').length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Shares"
        subtitle={pending > 0 ? `${pending} awaiting approval` : 'The ownership ledger'}
      />

      <FilterTabs
        param="tab"
        defaultValue="transactions"
        options={[
          { value: 'transactions', label: 'Transactions' },
          { value: 'classes', label: 'Share classes' },
          { value: 'contributions', label: 'Contributions' },
          ...(can('settings.manage') || can('settings.view') ? [{ value: 'policy', label: 'Policy' }] : []),
        ]}
      />

      {tab === 'transactions' && (
        <>
          <NewTransactionCard
            shareholders={shareholders}
            classes={classes}
            accounts={accounts}
            permissions={[...granted]}
            today={today}
            approvalRequired={policies.share.requireApproval}
          />
          <FilterTabs
            param="filter"
            defaultValue="all"
            options={[
              { value: 'all', label: 'All' },
              { value: 'pending', label: `Pending (${pending})` },
              { value: 'shares_issued', label: 'Issues' },
              { value: 'shares_transferred', label: 'Transfers' },
              { value: 'shares_adjusted', label: 'Adjustments' },
              { value: 'reversal', label: 'Reversals' },
            ]}
          />
          <ShareTransactionsTable rows={transactions} />
        </>
      )}

      {tab === 'classes' && (
        <>
          {can('shareholders.manage') && <ShareClassForms classes={classes} />}
          <ShareClassesTable rows={classes} />
        </>
      )}

      {tab === 'contributions' && <ContributionsTable rows={contributions} />}

      {tab === 'policy' && (
        <SharePolicyCard policy={policies.share} dividendPolicy={policies.dividend} />
      )}
    </div>
  );
}
