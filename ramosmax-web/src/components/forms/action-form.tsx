'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { OfflineError, runOnline, UnconfirmedError } from '@/lib/online';
import type { ActionResult } from '@/lib/server/operations-actions';

/**
 * A form that submits to a Server Action.
 *
 * It enforces the RamosMAX offline rule for every mutation in this phase:
 * nothing is queued. When the browser is offline the submission is refused
 * outright and nothing is sent. When a submission times out or the connection
 * drops mid-flight, the person is told the change MAY ALREADY HAVE BEEN SAVED
 * — never that it failed, because telling someone a saved change failed is how
 * a business ends up doing it twice.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  busyLabel,
  onDone,
  redirectTo,
  confirm,
  className,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  submitLabel: string;
  busyLabel?: string;
  onDone?: (result: ActionResult) => void;
  redirectTo?: (result: ActionResult) => string;
  confirm?: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string>();
  const [uncertain, setUncertain] = React.useState<string>();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setUncertain(undefined);

    if (confirm && !window.confirm(confirm)) return;

    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await runOnline(() => action(form));
      if (!result.ok) {
        setFailure(result.message ?? 'That could not be saved.');
        return;
      }
      onDone?.(result);
      const target = redirectTo?.(result);
      if (target) router.push(target);
      router.refresh();
    } catch (e) {
      if (e instanceof OfflineError) {
        setFailure(e.message);
        return;
      }
      // The answer never arrived. It may already have been saved.
      setUncertain(new UnconfirmedError().message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className={className}>
      {children}

      {failure && (
        <p
          role="alert"
          data-form-error
          className="bg-danger-bg text-danger mt-4 rounded-[var(--radius)] px-3 py-2 text-sm"
        >
          {failure}
        </p>
      )}
      {uncertain && (
        <p
          role="alert"
          data-form-uncertain
          className="bg-warning-bg text-warning mt-4 rounded-[var(--radius)] px-3 py-2 text-sm"
        >
          {uncertain}
        </p>
      )}

      <div className="bg-surface border-border sticky bottom-16 mt-5 border-t py-3 lg:bottom-0">
        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? (busyLabel ?? 'Saving…') : submitLabel}
        </Button>
      </div>
    </form>
  );
}
