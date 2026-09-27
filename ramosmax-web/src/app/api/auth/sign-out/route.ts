import { NextResponse } from 'next/server';
import { signOut } from '@/lib/server/auth-service';

export async function POST() {
  await signOut();
  return NextResponse.json({ ok: true });
}

/**
 * Clears the session and returns to the sign-in page.
 *
 * This exists because a cookie can be validly SIGNED yet no longer USABLE —
 * the account was deactivated, or the session was issued before a password
 * change and has therefore been revoked. `proxy.ts` only checks the signature
 * (deliberately: it does no database work), so without this a stale cookie
 * would loop forever between the proxy sending /login -> / and the page
 * sending / -> /login. Redirecting through here clears the cookie once and
 * breaks the cycle.
 */
export async function GET(request: Request) {
  await signOut();
  const target = new URL(request.url);
  const next = target.searchParams.get('redirect');
  const destination = new URL(next && next.startsWith('/') ? next : '/login', target.origin);
  return NextResponse.redirect(destination, { status: 303 });
}
