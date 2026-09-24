'use client';

import * as React from 'react';
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
 * Phase A delivers the form, its validation and its responsive layout. The
 * credential exchange, the 5-per-15-minutes throttle, the uniform failure
 * message and the forced password change are Phase B, so submitting here
 * reports that plainly rather than pretending to sign anyone in.
 */
export function LoginForm() {
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [phoneError, setPhoneError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setNotice(undefined);

    const e164 = normalizePhone(phone);
    if (!e164) {
      setPhoneError('Enter a valid phone number, e.g. 0772 123 456.');
      return;
    }
    setPhoneError(undefined);
    if (password.length === 0) return;

    setBusy(true);
    try {
      setNotice('Sign-in is delivered in Phase B. The form and its checks are in place.');
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

      {notice && (
        <p role="status" className="bg-info-bg text-info rounded-[var(--radius)] px-3 py-2 text-sm">
          {notice}
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
