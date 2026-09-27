import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_ONLY_PERMISSIONS,
  AUTHORIZATION_ONLY_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  canAdminister,
  canResetPassword,
  effectivePermissions,
  isAccountEnabled,
  isAccountLive,
  type AccessProfile,
} from './index';

const repoRoot = resolve(__dirname, '../../../..');
const webRoot = resolve(__dirname, '../../..');

const base: AccessProfile = {
  role: 'worker',
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
};

// ---------------------------------------------------------------------------
// Drift: the generated catalogue must still match the Phase 9 reference.
// This is the web replacement for the Dart/rules/catalogue three-way test.
// ---------------------------------------------------------------------------

describe('catalogue parity with the Phase 9 reference implementation', () => {
  const reference = JSON.parse(
    readFileSync(resolve(repoRoot, 'functions/src/access_catalog.json'), 'utf8'),
  );

  it('has exactly the reference permissions', () => {
    expect([...PERMISSIONS].sort()).toEqual([...reference.permissions].sort());
  });

  it('has exactly the reference roles', () => {
    expect([...ROLES].sort()).toEqual(Object.keys(reference.roles).sort());
  });

  it('gives every non-admin role exactly its reference defaults', () => {
    for (const role of ROLES) {
      if (reference.roles[role] === '*') {
        expect(ROLE_PERMISSIONS[role]).toBe('*');
        continue;
      }
      expect([...(ROLE_PERMISSIONS[role] as readonly string[])].sort()).toEqual(
        [...reference.roles[role]].sort(),
      );
    }
  });

  it('marks the same admin-only and authorization-only permissions', () => {
    expect([...ADMIN_ONLY_PERMISSIONS].sort()).toEqual([...reference.adminOnlyPermissions].sort());
    expect([...AUTHORIZATION_ONLY_PERMISSIONS].sort()).toEqual(
      [...reference.authorizationOnlyPermissions].sort(),
    );
  });

  it('regenerates byte-identically (the committed output is not stale)', () => {
    const path = resolve(webRoot, 'src/lib/permissions/catalogue.generated.ts');
    const before = readFileSync(path, 'utf8');
    execFileSync('node', ['scripts/generate-permission-catalogue.mjs'], { cwd: webRoot });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Effective permissions — ports access.js effectivePermissions()
// ---------------------------------------------------------------------------

describe('effectivePermissions', () => {
  it('gives an admin the entire catalogue', () => {
    expect(effectivePermissions({ ...base, role: 'admin' }).size).toBe(PERMISSIONS.length);
  });

  it('gives a role its defaults', () => {
    const granted = effectivePermissions(base);
    expect(granted.has('jobs.view.own')).toBe(true);
    expect(granted.has('jobs.view')).toBe(false);
  });

  it('adds direct grants', () => {
    expect(
      effectivePermissions({ ...base, permissions: ['finance.view'] }).has('finance.view'),
    ).toBe(true);
  });

  it('ignores a direct grant that is not in the catalogue', () => {
    expect(
      effectivePermissions({ ...base, permissions: ['not.a.permission'] }).has(
        'not.a.permission' as never,
      ),
    ).toBe(false);
  });

  it('subtracts denials, even from a role default', () => {
    expect(
      effectivePermissions({ ...base, deniedPermissions: ['jobs.view.own'] }).has('jobs.view.own'),
    ).toBe(false);
  });

  it('subtracts denials from an admin too', () => {
    const granted = effectivePermissions({
      ...base,
      role: 'admin',
      deniedPermissions: ['finance.adjust'],
    });
    expect(granted.has('finance.adjust')).toBe(false);
  });

  it('is EMPTY while a password change is pending, whatever the role', () => {
    expect(effectivePermissions({ ...base, role: 'admin', mustChangePassword: true }).size).toBe(0);
  });

  it('is EMPTY for an inactive account', () => {
    expect(effectivePermissions({ ...base, role: 'admin', active: false }).size).toBe(0);
  });

  it('is EMPTY once accessExpiresAt has passed', () => {
    const expired = {
      ...base,
      role: 'admin' as const,
      accessExpiresAt: new Date(Date.now() - 1000),
    };
    expect(effectivePermissions(expired).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Temporary grants expire by TIME COMPARISON — never by a cleanup job.
// ---------------------------------------------------------------------------

describe('temporary grants', () => {
  const now = Date.now();
  const grant = (from: number, to: number) => ({
    permissionKey: 'payments.record',
    startsAt: new Date(now + from),
    expiresAt: new Date(now + to),
  });

  it('is honoured inside its window', () => {
    const granted = effectivePermissions({ ...base, temporaryGrants: [grant(-1000, 60_000)] }, now);
    expect(granted.has('payments.record')).toBe(true);
  });

  it('is NOT honoured before it starts', () => {
    const granted = effectivePermissions(
      { ...base, temporaryGrants: [grant(60_000, 120_000)] },
      now,
    );
    expect(granted.has('payments.record')).toBe(false);
  });

  it('stops being honoured the moment it expires, with no sweep', () => {
    const profile = { ...base, temporaryGrants: [grant(-60_000, 1000)] };
    expect(effectivePermissions(profile, now).has('payments.record')).toBe(true);
    expect(effectivePermissions(profile, now + 2000).has('payments.record')).toBe(false);
  });

  it('is NOT honoured once revoked', () => {
    const granted = effectivePermissions(
      { ...base, temporaryGrants: [{ ...grant(-1000, 60_000), revokedAt: new Date(now) }] },
      now,
    );
    expect(granted.has('payments.record')).toBe(false);
  });

  it('is still beaten by an explicit denial', () => {
    const granted = effectivePermissions(
      { ...base, temporaryGrants: [grant(-1000, 60_000)], deniedPermissions: ['payments.record'] },
      now,
    );
    expect(granted.has('payments.record')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

describe('account state', () => {
  it('lets someone with a temporary password sign in but not use the system', () => {
    const pending = { ...base, mustChangePassword: true };
    expect(isAccountEnabled(pending)).toBe(true);
    expect(isAccountLive(pending)).toBe(false);
  });

  it('refuses an expired access period', () => {
    expect(isAccountEnabled({ ...base, accessExpiresAt: new Date(Date.now() - 1) })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Administration guards — ports access.js requireCanAdminister / ResetPassword
// ---------------------------------------------------------------------------

describe('administration guards', () => {
  it('lets an admin administer anyone', () => {
    for (const role of ROLES) expect(canAdminister('admin', role)).toBe(true);
  });

  it('never lets a non-admin administer an admin', () => {
    expect(canAdminister('manager', 'admin')).toBe(false);
  });

  it('refuses a peer rank (manager cannot administer an auditor)', () => {
    expect(canAdminister('manager', 'auditor')).toBe(false);
  });

  it('lets a manager administer a junior role', () => {
    expect(canAdminister('manager', 'worker')).toBe(true);
    expect(canAdminister('manager', 'cashier')).toBe(true);
  });

  it('lets a manager reset a Worker password but NOT a Cashier one', () => {
    expect(canResetPassword('manager', 'worker')).toBe(true);
    expect(canResetPassword('manager', 'cashier')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Role menus: the documented shape of each role's access
// ---------------------------------------------------------------------------

describe('role access shape (docs/ROADMAP.md)', () => {
  it('gives a worker no report permission at all', () => {
    const granted = effectivePermissions({ ...base, role: 'worker' });
    expect([...granted].filter((p) => p.startsWith('reports.'))).toEqual([]);
  });

  it('gives a shareholder only their OWN shareholding, never the register', () => {
    const granted = effectivePermissions({ ...base, role: 'shareholder' });
    expect(granted.has('shareholders.view.own')).toBe(true);
    expect(granted.has('shareholders.view')).toBe(false);
    expect(granted.has('shares.view')).toBe(false);
  });

  it('gives a cashier no business-wide balance view', () => {
    const granted = effectivePermissions({ ...base, role: 'cashier' });
    expect(granted.has('finance.view')).toBe(false);
    expect(granted.has('expenses.create')).toBe(true);
    expect(granted.has('expenses.approve')).toBe(false);
  });

  it('gives an auditor read access and nothing that writes', () => {
    const granted = effectivePermissions({ ...base, role: 'auditor' });
    expect(granted.has('audit.view')).toBe(true);
    for (const p of granted) {
      expect(p.endsWith('.view') || p.endsWith('.view.own')).toBe(true);
    }
  });

  // "Admin-only" constrains who may GRANT a permission (access.js
  // requireCanGrant), not who may hold it. A Manager legitimately holds
  // users.permissions.temporary and users.passwords.reset by role default —
  // that is how a Manager gives a Worker after-hours access and resets their
  // password without being able to create users or change roles.
  it('gives a manager exactly the two admin-only permissions the reference does', () => {
    const granted = effectivePermissions({ ...base, role: 'manager' });
    const held = ADMIN_ONLY_PERMISSIONS.filter((p) => granted.has(p));
    expect([...held].sort()).toEqual(['users.passwords.reset', 'users.permissions.temporary']);
  });

  it('gives a manager no power to create users, change roles or edit permanent permissions', () => {
    const granted = effectivePermissions({ ...base, role: 'manager' });
    for (const p of [
      'users.create',
      'users.edit',
      'users.roles.manage',
      'users.permissions.manage',
      'settings.manage',
    ] as const) {
      expect(granted.has(p)).toBe(false);
    }
  });

  it('gives cashiers, workers, shareholders and auditors no admin-only permission at all', () => {
    for (const role of ROLES) {
      if (role === 'admin' || role === 'manager') continue;
      const granted = effectivePermissions({ ...base, role });
      for (const adminOnly of ADMIN_ONLY_PERMISSIONS) {
        expect(granted.has(adminOnly)).toBe(false);
      }
    }
  });

  it('never gives ANY role an authorization-only permission by default', () => {
    for (const role of ROLES) {
      if (role === 'admin') continue;
      const granted = effectivePermissions({ ...base, role });
      for (const p of AUTHORIZATION_ONLY_PERMISSIONS) expect(granted.has(p)).toBe(false);
    }
  });
});
