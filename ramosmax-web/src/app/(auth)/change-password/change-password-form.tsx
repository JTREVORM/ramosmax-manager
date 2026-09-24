'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { passwordProblems } from '@/lib/auth/password-policy';

/**
 * Changing one's own password, including the forced first change.
 *
 * The policy is checked here for immediate feedback and again on the server,
 * which is authoritative. A forced change cannot be skipped: proxy.ts and this
 * page keep sending the person back until it is done, and the database treats
 * the account as inactive for everything else in the meantime.
 */
export function ChangePasswordForm({
  forced,
  fullName,
  staffId,
}: {
  forced: boolean;
  fullName: string;
  staffId: string | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [failure, setFailure] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);

  const problems = next.length > 0 ? passwordProblems(next, { fullName, staffId }) : [];
  const mismatch = confirm.length > 0 && confirm !== next;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(undefined);
    if (problems.length > 0 || mismatch || current.length === 0) return;

    setBusy(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const result = await response.json();
      if (!result.ok) {
        setFailure(result.message ?? 'Could not change your password.');
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setFailure('Could not reach RamosMAX. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Field label={forced ? 'Temporary password' : 'Current password'} htmlFor="current">
        <Input
          name="current"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>

      <Field
        label="New password"
        htmlFor="next"
        hint="At least 8 characters, with upper and lower case, a number and a symbol."
        error={problems[0]}
      >
        <Input
          name="next"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>

      <Field
        label="Confirm new password"
        htmlFor="confirm"
        error={mismatch ? 'The two passwords do not match.' : undefined}
      >
        <Input
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>

      {failure && (
        <p
          role="alert"
          className="bg-danger-bg text-danger rounded-[var(--radius)] px-3 py-2 text-sm"
        >
          {failure}
        </p>
      )}

      <Button type="submit" size="lg" block disabled={busy}>
        {busy ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  );
}
