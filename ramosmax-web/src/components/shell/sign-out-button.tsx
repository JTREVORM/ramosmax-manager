'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Signing out clears the session cookie server-side. On a shared handset this
 * must leave nothing behind, so it also drops any per-viewer browser storage.
 */
export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function onClick() {
    setBusy(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' });
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // Blocked or unavailable storage is not a reason to stay signed in.
      }
      router.replace('/login');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label="Sign out"
        className="hover:bg-surface-muted flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)]"
      >
        <LogOut className="size-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <Button type="button" variant="secondary" onClick={onClick} disabled={busy}>
      <LogOut aria-hidden="true" />
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
