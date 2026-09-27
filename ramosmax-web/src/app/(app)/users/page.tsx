import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { FilterTabs } from '@/components/ui/filter-tabs';
import { Card, CardBody } from '@/components/ui/card';
import { requireAnyPermission } from '@/lib/server/guard';
import { listUsers } from '@/lib/server/user-admin';
import { ROLES, assignableRoles } from '@/lib/permissions';
import { currentUser } from '@/lib/server/auth-service';
import { UsersTable } from './users-table';
import { AddUserCard } from './user-forms';

export const metadata: Metadata = { title: 'User management' };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; q?: string }>;
}) {
  const granted = await requireAnyPermission('users.view');
  const params = await searchParams;
  const [users, me] = await Promise.all([
    listUsers(params.role, params.q),
    currentUser(),
  ]);

  const inactive = users.filter((u) => !u.active).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="User management"
        subtitle={`${users.length} account${users.length === 1 ? '' : 's'}${inactive > 0 ? `, ${inactive} inactive` : ''}`}
      />

      <AddUserCard
        assignableRoles={me ? [...assignableRoles(me.role as never)] : []}
        canCreate={granted.has('users.create')}
      />

      <Card>
        <CardBody>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="flex-1 text-sm">
              <span className="text-muted-foreground block">Search by name or number</span>
              <input
                type="search"
                name="q"
                defaultValue={params.q}
                className="border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3"
              />
            </label>
            <button
              type="submit"
              className="bg-primary text-primary-foreground h-12 rounded-[var(--radius)] px-4 text-sm font-medium"
            >
              Search
            </button>
          </form>
        </CardBody>
      </Card>

      <FilterTabs
        param="role"
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          ...ROLES.map((role) => ({
            value: role,
            label: role.charAt(0).toUpperCase() + role.slice(1),
          })),
        ]}
      />

      <UsersTable rows={users} />
    </div>
  );
}
