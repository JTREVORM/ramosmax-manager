'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { normalizePhone } from '@/lib/auth/phone';

/**
 * Sign-in form.
 *
 * People sign in with a PHONE NUMBER and a password — never an email. The
 * hidden Supabase Auth identity is a server-side detail and is never shown or
 * typed here.
 *
 * The form checks the phone number locally for immediate feedback, but the
 * server is authoritative: it normalises the number again, applies the
 * throttle, and answers every credential failure with the SAME message so the
 * response never reveals whether a number is registered.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [phoneError, setPhoneError] = React.useState<string>();
  const [failure, setFailure] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(undefined);

    const e164 = normalizePhone(phone);
    if (!e164) {
      setPhoneError('Enter a valid phone number, e.g. 0772 123 456.');
      return;
    }
    setPhoneError(undefined);
    if (password.length === 0) {
      setFailure('Incorrect phone number or password.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      });
      const result = await response.json();

      if (!result.ok) {
        setFailure(result.message ?? 'Incorrect phone number or password.');
        setPassword('');
        return;
      }

      // A forced change is the only thing such an account may do.
      if (result.mustChangePassword) {
        router.replace('/change-password');
        return;
      }
      const next = searchParams.get('next');
      router.replace(next && next.startsWith('/') ? next : '/');
      router.refresh();
    } catch {
      setFailure('Could not reach RamosMAX. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Field
        label="Phone number"
        htmlFor="phone"
        hint="The number registered for your RamosMAX account."
        error={phoneError}
      >
        <Input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          autoFocus
          placeholder="0772 123 456"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <div className="relative">
          <Input
            name="password"
            type={reveal ? 'text' : 'password'}
            autoComplete="current-password"
            className="pr-12"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? 'Hide password' : 'Show password'}
            className="text-muted-foreground hover:bg-surface-muted absolute top-1/2 right-1 flex size-10 -translate-y-1/2 items-center justify-center rounded"
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Field>

      {failure && (
        <p
          role="alert"
          id="sign-in-error"
          className="bg-danger-bg text-danger rounded-[var(--radius)] px-3 py-2 text-sm"
        >
          {failure}
        </p>
      )}

      <Button type="submit" size="lg" block disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>

      <p className="text-muted-foreground pt-2 text-center text-xs">
        Forgotten your password? Ask an administrator to reset it.
      </p>
    </form>
  );
}
