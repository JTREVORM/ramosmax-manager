'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Field wires a label, hint and error message to its control.
 *
 * It does NOT clone its child: a control is often wrapped (a password field
 * with a reveal button, an amount field with a UGX prefix), and cloning would
 * put the id and aria attributes on the wrapper, leaving the real input
 * unlabelled. Instead the ids travel through context and Input picks them up
 * wherever it sits in the subtree.
 */
interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, id, ...props }, ref) => {
  const field = React.useContext(FieldContext);
  return (
    <input
      ref={ref}
      id={id ?? field?.id}
      aria-describedby={props['aria-describedby'] ?? field?.describedBy}
      aria-invalid={props['aria-invalid'] ?? (field?.invalid || undefined)}
      className={cn(
        // 16px base font stops iOS Safari zooming the page on focus.
        'border-border bg-surface text-foreground h-12 w-full rounded-[var(--radius)] border px-3 text-base',
        'placeholder:text-muted-foreground disabled:opacity-50',
        'aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = 'Input';

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;
  const value = React.useMemo(
    () => ({ id: htmlFor, describedBy, invalid: Boolean(error) }),
    [htmlFor, describedBy, error],
  );

  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-foreground block text-sm font-medium">
        {label}
      </label>
      <FieldContext.Provider value={value}>{children}</FieldContext.Provider>
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="text-danger text-xs font-medium">
          {error}
        </p>
      )}
    </div>
  );
}
