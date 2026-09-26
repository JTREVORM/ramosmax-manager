'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/forms/action-form';
import { Field, Input } from '@/components/ui/field';
import {
  changeUserPhoneAction, grantTemporaryPermissionAction, linkStaffAction,
  resetUserPasswordAction, revokeTemporaryPermissionAction, setUserActiveAction,
  setUserPermissionsAction, setUserRoleAction, updateUserProfileAction,
} from '@/lib/server/user-admin-actions';
import type { ActionResult } from '@/lib/server/operations-actions';
import type { TemporaryGrantRow, UserRow } from '@/lib/server/user-admin';
import { ROLE_LABELS } from '../users-table';

const selectClass =
  'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base';

export function UserActions({
  user,
  grants,
  permissions,
  assignableRoles,
  grantablePermissions,
  viewerUid,
  canAdminister,
  canResetPassword,
}: {
  user: UserRow;
  grants: TemporaryGrantRow[];
  permissions: string[];
  assignableRoles: string[];
  grantablePermissions: string[];
  viewerUid: string;
  canAdminister: boolean;
  canResetPassword: boolean;
}) {
  const can = (p: string) => permissions.includes(p);
  const [panel, setPanel] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState<string>();
  const isSelf = user.id === viewerUid;

  const mayEdit = can('users.edit') && (isSelf || canAdminister);
  const mayManage = can('users.manage') && canAdminister && !isSelf;
  const mayPermissions = can('users.permissions.manage') && canAdminister && !isSelf;
  const mayTemporary = can('users.permissions.temporary') && canAdminister && !isSelf;
  const mayReset = can('users.passwords.reset') && canResetPassword && !isSelf;

  if (!mayEdit && !mayManage && !mayPermissions && !mayTemporary && !mayReset) {
    return (
      <Card className="bg-surface-muted">
        <CardBody>
          <p className="text-muted-foreground text-sm">
            {isSelf
              ? 'Change your own password from your profile.'
              : 'You may look at this account but not change it.'}
          </p>
        </CardBody>
      </Card>
    );
  }

  const live = grants.filter((g) => g.live);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        {password && (
          <div className="bg-success-bg text-success rounded-[var(--radius)] px-3 py-3 text-sm">
            <p className="font-semibold">Temporary password: {password}</p>
            <p className="mt-1">
              Give it to them in person. It is not stored anywhere and cannot be shown again, and
              they will be asked to change it when they sign in.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {mayEdit && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(toggle(panel, 'profile'))}>
              Edit profile
            </Button>
          )}
          {mayManage && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setPanel(toggle(panel, 'role'))}>
                Change role
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'active'))}>
                {user.active ? 'Turn access off' : 'Turn access on'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'phone'))}>
                Change phone number
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'staff'))}>
                {user.staff_id ? 'Change staff ID' : 'Link staff ID'}
              </Button>
            </>
          )}
          {mayPermissions && (
            <Button size="sm" variant="secondary" onClick={() => setPanel(toggle(panel, 'access'))}>
              Extra access
            </Button>
          )}
          {mayTemporary && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'temporary'))}>
              Temporary access
            </Button>
          )}
          {mayReset && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(toggle(panel, 'password'))}>
              Reset password
            </Button>
          )}
        </div>

        {panel === 'profile' && (
          <ActionForm action={updateUserProfileAction} submitLabel="Save profile">
            <input type="hidden" name="user_id" value={user.id} />
            <div className="space-y-3">
              <Field label="Full name" htmlFor="edit-name">
                <Input id="edit-name" name="full_name" defaultValue={user.full_name} />
              </Field>
              <Field label="Email" htmlFor="edit-email" hint="Optional.">
                <Input id="edit-email" name="email" type="email" defaultValue={user.email ?? ''} />
              </Field>
              <Field label="Position" htmlFor="edit-position">
                <Input id="edit-position" name="position" defaultValue={user.position ?? ''} />
              </Field>
              <Field label="Department" htmlFor="edit-department">
                <Input id="edit-department" name="department" defaultValue={user.department ?? ''} />
              </Field>
              {user.role === 'worker' && (
                <Field label="Specialisation" htmlFor="edit-specialization">
                  <Input
                    id="edit-specialization"
                    name="specialization"
                    defaultValue={user.specialization ?? ''}
                  />
                </Field>
              )}
              <p className="text-muted-foreground text-xs">
                The phone number is how they sign in, so it has its own action and its own entry in
                the audit trail.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'role' && (
          <ActionForm action={setUserRoleAction} submitLabel="Change role">
            <input type="hidden" name="user_id" value={user.id} />
            <div className="space-y-3">
              <Field label="Role" htmlFor="edit-role">
                <select id="edit-role" name="role" required className={selectClass}
                  defaultValue={user.role}>
                  {assignableRoles.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role] ?? role}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Why" htmlFor="role-reason" hint="Required.">
                <Input id="role-reason" name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'active' && (
          <ActionForm
            action={setUserActiveAction}
            submitLabel={user.active ? 'Turn access off' : 'Turn access on'}
          >
            <input type="hidden" name="user_id" value={user.id} />
            <input type="hidden" name="active" value={user.active ? 'false' : 'true'} />
            <Field label="Why" htmlFor="active-reason" hint="Required.">
              <Input id="active-reason" name="reason" required />
            </Field>
            {user.active && (
              <p className="text-muted-foreground mt-2 text-xs">
                They are signed out at once and cannot sign in again. Nothing they recorded is
                removed.
              </p>
            )}
          </ActionForm>
        )}

        {panel === 'phone' && (
          <ActionForm action={changeUserPhoneAction} submitLabel="Change phone number">
            <input type="hidden" name="user_id" value={user.id} />
            <div className="space-y-3">
              <Field label="New phone number" htmlFor="new-phone-number">
                <Input id="new-phone-number" name="phone_number" inputMode="tel" required />
              </Field>
              <Field label="Why" htmlFor="phone-reason">
                <Input id="phone-reason" name="reason" />
              </Field>
              <p className="text-muted-foreground text-xs">
                Every session they have open ends. They sign in again with the new number and the
                password they already have.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'staff' && (
          <ActionForm action={linkStaffAction} submitLabel="Save staff ID">
            <input type="hidden" name="user_id" value={user.id} />
            <div className="space-y-3">
              <Field
                label="Staff ID"
                htmlFor="staff-id"
                hint="Capital letters, digits and dashes, e.g. RMX-STF-0001. Leave empty to unlink."
              >
                <Input id="staff-id" name="staff_id" defaultValue={user.staff_id ?? ''} />
              </Field>
              <p className="text-muted-foreground text-xs">
                A staff ID belongs to one person. A profile photo does not follow somebody to a
                different one.
              </p>
            </div>
          </ActionForm>
        )}

        {panel === 'access' && (
          <ActionForm action={setUserPermissionsAction} submitLabel="Save access">
            <input type="hidden" name="user_id" value={user.id} />
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">
                Extra access on top of the role, or access taken away from it. Everything else
                comes from the role itself.
              </p>
              <PermissionPicker
                name="granted"
                label="Also allowed"
                options={grantablePermissions}
                selected={user.permissions}
              />
              <PermissionPicker
                name="denied"
                label="Never allowed"
                options={grantablePermissions}
                selected={user.denied_permissions}
              />
              <Field label="Why" htmlFor="access-reason" hint="Required.">
                <Input id="access-reason" name="reason" required />
              </Field>
            </div>
          </ActionForm>
        )}

        {panel === 'temporary' && (
          <div className="space-y-3">
            <ActionForm action={grantTemporaryPermissionAction} submitLabel="Grant for a while">
              <input type="hidden" name="user_id" value={user.id} />
              <div className="space-y-3">
                <Field label="Permission" htmlFor="temp-permission">
                  <select id="temp-permission" name="permission" required className={selectClass}>
                    <option value="">Choose…</option>
                    {grantablePermissions.map((key) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="For how long" htmlFor="temp-hours">
                  <select id="temp-hours" name="hours" defaultValue="4" className={selectClass}>
                    {[1, 2, 4, 8, 12, 24, 72, 168].map((hours) => (
                      <option key={hours} value={hours}>
                        {hours < 24 ? `${hours} hours` : `${hours / 24} days`}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Why" htmlFor="temp-reason">
                  <Input id="temp-reason" name="reason" />
                </Field>
                <p className="text-muted-foreground text-xs">
                  It ends by itself at the time above — nothing has to run for that to happen.
                </p>
              </div>
            </ActionForm>

            {live.length > 0 && (
              <ActionForm action={revokeTemporaryPermissionAction} submitLabel="End it now">
                <input type="hidden" name="user_id" value={user.id} />
                <div className="space-y-3">
                  <Field label="Which one" htmlFor="revoke-grant">
                    <select id="revoke-grant" name="grant_id" required className={selectClass}>
                      <option value="">Choose…</option>
                      {live.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.permission_key}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Why" htmlFor="revoke-reason">
                    <Input id="revoke-reason" name="reason" />
                  </Field>
                </div>
              </ActionForm>
            )}
          </div>
        )}

        {panel === 'password' && (
          <ActionForm
            action={resetUserPasswordAction}
            submitLabel="Issue a temporary password"
            onDone={(result: ActionResult) => {
              setPassword(result.id);
              setPanel(null);
            }}
          >
            <input type="hidden" name="user_id" value={user.id} />
            <Field label="Why" htmlFor="password-reason">
              <Input id="password-reason" name="reason" />
            </Field>
            <p className="text-muted-foreground mt-2 text-xs">
              Their current password stops working at once, and the new one is shown to you once.
              The password itself is never written to the audit trail.
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

const toggle = (current: string | null, next: string) => (current === next ? null : next);

function PermissionPicker({
  name,
  label,
  options,
  selected,
}: {
  name: string;
  label: string;
  options: string[];
  selected: string[];
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-muted-foreground text-sm">{label}</legend>
      <div className="border-border max-h-56 overflow-y-auto rounded-[var(--radius)] border p-2">
        {options.map((key) => (
          <label key={key} className="flex items-center gap-2 py-0.5 text-sm">
            <input type="checkbox" name={name} value={key} defaultChecked={selected.includes(key)} />
            <span className="truncate">{key}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
