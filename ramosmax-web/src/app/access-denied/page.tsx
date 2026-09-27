import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser, SESSION_ENDED } from '@/lib/server/auth-service';
import { SignOutButton } from '@/components/shell/sign-out-button';

export const metadata: Metadata = { title: 'Access unavailable' };

/**
 * Shown when a signed-in person's account has been deactivated or their access
 * period has ended. The wording follows the reference implementation and
 * distinguishes the two, because the remedy differs.
 *
 * This page deliberately sits OUTSIDE the (app) route group. The app layout
 * redirects an inactive user here, so if this page inherited that layout the
 * two would redirect to each other forever.
 */
export default async function AccessDeniedPage() {
  const user = await currentUser();
  if (!user) redirect(SESSION_ENDED);
  if (user.active && !user.accessExpired) redirect('/');

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center px-4 text-center">
      <h1 className="text-foreground text-lg font-semibold">RamosMAX access unavailable</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {user.accessExpired
          ? 'Your RamosMAX access period has ended. Please contact an administrator.'
          : 'Your RamosMAX account is inactive. Please contact an administrator.'}
      </p>
      <div className="mt-6">
        <SignOutButton />
      </div>
    </div>
  );
}
