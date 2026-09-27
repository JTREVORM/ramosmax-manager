import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

export function PageHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-4">
      {back && (
        <Link
          href={back.href}
          className="text-muted-foreground hover:text-foreground mb-2 inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-foreground text-lg font-semibold">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-0.5 text-sm">{subtitle}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}
