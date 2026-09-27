import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

/**
 * Server Supabase client, bound to the caller's session cookies.
 *
 * Queries run as the SIGNED-IN USER, so RLS applies to server-rendered pages
 * exactly as it does in the browser. This is deliberate: a Server Component
 * must never be a way around a policy.
 *
 * Note: in Next.js 16 `cookies()` is async — synchronous access was removed.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // proxy.ts refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  );
}
