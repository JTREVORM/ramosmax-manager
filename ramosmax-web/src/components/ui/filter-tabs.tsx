'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';

/** Status filters. Horizontally scrollable on a phone rather than wrapped. */
export function FilterTabs({
  options,
  param = 'status',
  defaultValue,
}: {
  options: { value: string; label: string }[];
  param?: string;
  defaultValue: string;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = search.get(param) ?? defaultValue;

  return (
    <nav aria-label="Filter" className="-mx-4 overflow-x-auto px-4">
      <ul className="flex w-max gap-2">
        {options.map((option) => {
          const next = new URLSearchParams(search.toString());
          if (option.value === defaultValue) next.delete(param);
          else next.set(param, option.value);
          const query = next.toString();
          const active = current === option.value;
          return (
            <li key={option.value}>
              <Link
                href={query ? `${pathname}?${query}` : pathname}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'inline-flex h-9 items-center rounded-full px-3 text-sm whitespace-nowrap',
                  active
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'bg-surface-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
