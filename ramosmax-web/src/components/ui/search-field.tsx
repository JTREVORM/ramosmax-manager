'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from './field';

/**
 * Search box, debounced so a plate typed letter by letter does not fire a
 * query per keystroke. The search term lives in the URL, so a result can be
 * shared or reloaded.
 */
export function SearchField({
  placeholder,
  label,
  debounceMs = 350,
}: {
  placeholder: string;
  label: string;
  debounceMs?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = React.useState(params.get('q') ?? '');

  React.useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (value.trim()) next.set('q', value.trim());
      else next.delete('q');
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    }, debounceMs);
    return () => clearTimeout(timer);
    // `params` is intentionally omitted: including it would re-run on every
    // replace and fight the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, debounceMs, pathname, router]);

  return (
    <div className="relative">
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        type="search"
        inputMode="search"
        aria-label={label}
        placeholder={placeholder}
        className="pl-10"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </div>
  );
}
