import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser, SESSION_ENDED } from '@/lib/server/auth-service';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change your password' };

export default async function ChangePasswordPage() {
  const user = await currentUser();
  if (!user) redirect(SESSION_ENDED);
  if (!user.active || user.accessExpired) redirect('/access-denied');

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6">
        <h1 className="text-foreground text-lg font-semibold">
          {user.mustChangePassword ? 'Choose a new password' : 'Change your password'}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {user.mustChangePassword
            ? 'Your temporary password must be replaced before you can use RamosMAX.'
            : 'Signing in on other devices will end.'}
        </p>
      </div>
      <ChangePasswordForm
        forced={user.mustChangePassword}
        fullName={user.fullName}
        staffId={user.staffId}
      />
    </div>
  );
}
