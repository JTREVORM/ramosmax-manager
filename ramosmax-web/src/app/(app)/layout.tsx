import { AppShell } from '@/components/shell/app-shell';
import { effectivePermissions } from '@/lib/permissions';

/**
 * Authenticated shell.
 *
 * Phase A renders the shell against a preview profile so the responsive
 * navigation can be built and reviewed. Phase B replaces `previewProfile`
 * with the signed-in user's profile, read server-side under their own token so
 * RLS applies, and adds the proxy.ts route guard.
 */
const previewProfile = {
  role: 'admin' as const,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const granted = effectivePermissions(previewProfile);

  return (
    <AppShell
      user={{ fullName: 'Preview user', role: 'admin', staffId: 'RMX-STF-0001' }}
      granted={granted as ReadonlySet<string>}
    >
      {children}
    </AppShell>
  );
}
