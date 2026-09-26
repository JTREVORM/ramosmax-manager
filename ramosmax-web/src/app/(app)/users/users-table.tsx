'use client';

import { DataView, type DataColumn } from '@/components/data/data-view';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/format/date';
import type { UserRow } from '@/lib/server/user-admin';

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  cashier: 'Cashier',
  worker: 'Worker',
  shareholder: 'Shareholder',
  auditor: 'Auditor',
};

/** What the badge should say, worst news first. */
function standing(user: UserRow): string {
  if (!user.active) return 'inactive';
  if (user.access_expired) return 'expired';
  if (user.must_change_password) return 'pending_password';
  return 'active';
}

const columns: DataColumn<UserRow>[] = [
  { id: 'name', header: 'Name', role: 'primary', cell: (u) => u.full_name },
  {
    id: 'role',
    header: 'Role',
    role: 'secondary',
    cell: (u) => ROLE_LABELS[u.role] ?? u.role,
  },
  {
    id: 'standing',
    header: 'Standing',
    role: 'status',
    cell: (u) => <StatusBadge status={standing(u)} />,
  },
  // The masked number, never the whole one: a user list is read over
  // somebody's shoulder more often than anything else in the product.
  { id: 'phone', header: 'Phone', cell: (u) => u.phone_masked },
  { id: 'staff', header: 'Staff ID', cell: (u) => u.staff_id ?? '—' },
  {
    id: 'extra',
    header: 'Extra access',
    numeric: true,
    cell: (u) => {
      const parts = [];
      if (u.permissions.length > 0) parts.push(`+${u.permissions.length}`);
      if (u.denied_permissions.length > 0) parts.push(`−${u.denied_permissions.length}`);
      if (u.temporary_count > 0) parts.push(`${u.temporary_count} temporary`);
      return parts.length > 0 ? parts.join(' · ') : '—';
    },
  },
  {
    id: 'seen',
    header: 'Last signed in',
    cell: (u) => (u.last_login_at ? formatDate(u.last_login_at) : 'Never'),
  },
];

export function UsersTable({ rows }: { rows: UserRow[] }) {
  return (
    <DataView
      rows={rows}
      columns={columns}
      rowKey={(u) => u.id}
      href={(u) => `/users/${u.id}`}
      caption="People"
      empty="No account matches this filter."
    />
  );
}
