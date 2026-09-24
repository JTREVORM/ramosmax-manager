import * as React from 'react';
import Link from 'next/link';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90',
        secondary: 'bg-surface-muted text-foreground border border-border hover:bg-border/40',
        ghost: 'text-foreground hover:bg-surface-muted',
        danger: 'bg-danger text-white hover:opacity-90',
      },
      size: {
        // 44px minimum on touch, per the responsive architecture.
        md: 'h-11 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
        sm: 'h-9 px-3 text-sm',
        icon: 'h-11 w-11',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, ...props }, ref) => (
    <button ref={ref} className={cn(button({ variant, size, block }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

/**
 * A link that looks like a button. Kept separate from Button rather than using
 * an `asChild` slot: navigation is an anchor and should stay one, so it keeps
 * middle-click, "open in new tab" and prefetching.
 */
export interface LinkButtonProps
  extends React.ComponentProps<typeof Link>, VariantProps<typeof button> {}

export function LinkButton({ className, variant, size, block, ...props }: LinkButtonProps) {
  return <Link className={cn(button({ variant, size, block }), className)} {...props} />;
}
