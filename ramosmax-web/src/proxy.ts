import { NextResponse, type NextRequest } from 'next/server';
import { readSessionToken, SESSION_COOKIE } from '@/lib/server/session';

/**
 * Route protection.
 *
 * Next.js 16 renames the `middleware` convention to `proxy`, which runs on the
 * Node.js runtime. The Phase A plan assumed `middleware.ts`; this is the
 * corrected form.
 *
 * This is a REDIRECTOR, not a security boundary. It decides which page to show
 * someone who has no session, or whose session is stale. What a person may
 * actually READ or WRITE is decided by RLS and by the SECURITY DEFINER
 * functions, every time, regardless of what this file allows through.
 *
 * It deliberately does no database work: a cookie signature check only. The
 * account decision (active, expired, forced password change) belongs to the
 * page, which reads the profile under the caller's own authority.
 */

const PUBLIC_PATHS = ['/login'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/icons')
  ) {
    return NextResponse.next();
  }

  const session = readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  const isPublic = PUBLIC_PATHS.includes(pathname);

  if (!session && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Where they were heading, so they land there after signing in.
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (session && isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
