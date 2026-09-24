import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/app-shell';
import { currentUser, SESSION_ENDED } from '@/lib/server/auth-service';

/**
 * Authenticated shell.
 *
 * The profile is read on the SERVER, and the navigation is built from the
 * user's effective permissions as the database computes them — not from a
 * role, and never from anything the browser supplied.
 *
 * This decides what is SHOWN. It is not the security boundary: RLS and the
 * SECURITY DEFINER functions refuse anything this page lets through by
 * mistake.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();

  if (!user) redirect(SESSION_ENDED);
  // A pending temporary password blocks everything except replacing it.
  if (user.mustChangePassword) redirect('/change-password');
  if (!user.active || user.accessExpired) redirect('/access-denied');

  return (
    <AppShell
      user={{ fullName: user.fullName, role: user.role, staffId: user.staffId }}
      granted={new Set(user.permissions)}
    >
      {children}
    </AppShell>
  );
}
