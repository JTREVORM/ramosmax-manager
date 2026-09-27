'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client.
 *
 * Reads ONLY the publishable anon key. The service-role key must never reach
 * the browser: privileged work goes through a Next.js Route Handler or an Edge
 * Function. Everything this client can see is bounded by RLS.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
