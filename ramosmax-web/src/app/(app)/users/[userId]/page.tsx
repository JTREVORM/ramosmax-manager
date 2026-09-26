import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format/date';
import { requireSignedIn } from '@/lib/server/guard';
import { currentUser } from '@/lib/server/auth-service';
import {
  effectivePermissionsOf, getUser, listTemporaryGrants,
} from '@/lib/server/user-admin';
import {
  PERMISSIONS, assignableRoles, canAdminister, canResetPassword, isAdminOnly,
  isAuthorizationOnly, permanentPermissions, type Role,
} from '@/lib/permissions';
import { ROLE_LABELS } from '../users-table';
import { UserActions } from './user-actions';

export const metadata: Metadata = { title: 'Account' };

export default async function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const granted = await requireSignedIn();
  const { userId } = await params;
  const [user, me] = await Promise.all([getUser(userId), currentUser()]);
  // RLS returns nothing for somebody else's record without `users.view`, so a
  // missing row is "not yours to see" as much as "does not exist" — both are
  // the same answer here on purpose.
  if (!user || !me) notFound();

  const actorRole = me.role as Role;
  const targetRole = user.role as Role;
  const mayAdminister = canAdminister(actorRole, targetRole);
  const isSelf = user.id === me.id;

  // Your own access is always yours to read; somebody else's needs users.view,
  // which is what `app.user_access` itself re-checks.
  const mayReadAccess = granted.has('users.view') || isSelf;
  const [grants, effective] = await Promise.all([
    mayReadAccess ? listTemporaryGrants(user.id) : Promise.resolve([]),
    mayReadAccess ? effectivePermissionsOf(user.id) : Promise.resolve([]),
  ]);

  const permanent = permanentPermissions({
    role: targetRole,
    active: user.active,
    permissions: user.permissions,
    deniedPermissions: user.denied_permissions,
  });
  const live = grants.filter((g) => g.live);

  // Nobody may hand out access they do not hold themselves, and the two
  // reserved groups are never handed out from this screen at all.
  const grantable = PERMISSIONS.filter(
    (key) =>
      granted.has(key) &&
      !isAuthorizationOnly(key) &&
      (actorRole === 'admin' || !isAdminOnly(key)),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={user.full_name}
        subtitle={`${ROLE_LABELS[user.role] ?? user.role}${user.staff_id ? ` · ${user.staff_id}` : ''}`}
        back={{ href: '/users', label: 'Users' }}
        action={
          <Badge tone={user.active && !user.access_expired ? 'success' : 'neutral'}>
            {!user.active ? 'No access' : user.access_expired ? 'Expired' : 'Active'}
          </Badge>
        }
      />

      <Card>
        <CardBody className="space-y-1.5">
          <Row
            label="Phone"
            value={granted.has('users.view') || isSelf ? user.phone_number : user.phone_masked}
          />
          <Row label="Email" value={user.email ?? '—'} />
          <Row label="Position" value={user.position ?? '—'} />
          <Row label="Department" value={user.department ?? '—'} />
          {user.specialization && <Row label="Specialisation" value={user.specialization} />}
          <Row label="Staff ID" value={user.staff_id ?? 'Not linked'} />
          <Row label="Last signed in" value={user.last_login_at ? formatDateTime(user.last_login_at) : 'Never'} />
          <Row label="Account created" value={formatDateTime(user.created_at)} />
          {user.access_expires_at && (
            <Row label="Access ends" value={formatDateTime(user.access_expires_at)} />
          )}
          {user.must_change_password && (
            <Row label="Password" value="Must be changed at next sign-in" />
          )}
        </CardBody>
      </Card>

      {mayReadAccess && (
        <Card>
          <CardHeader>
            <CardTitle>Access</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {effective.length} of {PERMISSIONS.length} things this account may do right now:{' '}
              {permanent.size} from the role and what has been set for them
              {live.length > 0 ? `, ${live.length} for a while longer` : ''}.
            </p>

            {user.permissions.length > 0 && (
              <KeyList label="Also allowed" keys={user.permissions} tone="success" />
            )}
            {user.denied_permissions.length > 0 && (
              <KeyList label="Never allowed" keys={user.denied_permissions} tone="danger" />
            )}

            {grants.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-muted-foreground text-sm">Temporary access</h3>
                <ul className="space-y-2">
                  {grants.map((grant) => (
                    <li
                      key={grant.id}
                      className="border-border flex flex-wrap items-baseline justify-between gap-2 rounded-[var(--radius)] border px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{grant.permission_key}</span>
                      <span className="text-muted-foreground text-xs">
                        {grant.live ? 'until ' : 'ended '}
                        {formatDateTime(grant.expires_at)}
                        {grant.granted_by_name ? ` · ${grant.granted_by_name}` : ''}
                        {grant.authorization_id ? ' · after hours' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">
                  Temporary access ends at the time shown by itself. Nothing has to run for that to
                  happen.
                </p>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <UserActions
        user={user}
        grants={grants}
        permissions={[...granted]}
        assignableRoles={[...assignableRoles(actorRole)]}
        grantablePermissions={[...grantable]}
        viewerUid={me.id}
        canAdminister={mayAdminister}
        canResetPassword={canResetPassword(actorRole, targetRole)}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-foreground tabular text-sm">{value}</span>
    </div>
  );
}

function KeyList({
  label,
  keys,
  tone,
}: {
  label: string;
  keys: string[];
  tone: 'success' | 'danger';
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-muted-foreground text-sm">{label}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {keys.map((key) => (
          <li key={key}>
            <Badge tone={tone}>{key}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
