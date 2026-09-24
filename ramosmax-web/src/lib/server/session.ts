import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { backend } from './db';

/**
 * Session cookies.
 *
 * The session is held in an httpOnly, SameSite=Lax, Secure cookie. It is NOT
 * readable from JavaScript, which is stronger than the reference
 * implementation's on-device token store: a cross-site script cannot exfiltrate
 * it, and nothing sensitive is handed to client-side code.
 *
 * In development (no Supabase project configured) the cookie is a signed
 * statement of { sub, iat }. `iat` is what makes revocation work: a cookie
 * issued before the user's password_changed_at is rejected, so changing a
 * password ends every other session — the behaviour session.js gets from
 * revokeRefreshTokens().
 */

export const SESSION_COOKIE = 'ramosmax_session';

function signingKey(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production' && backend() === 'supabase') {
    throw new Error('SESSION_SECRET must be set.');
  }
  return 'development-only-session-secret';
}

interface SessionPayload {
  sub: string;
  iat: number;
}

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token: string): SessionPayload | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = createHmac('sha256', signingKey()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    return typeof payload.sub === 'string' && typeof payload.iat === 'number' ? payload : null;
  } catch {
    return null;
  }
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  // 12 hours: a forecourt shift, not a fortnight. A shared handset must not
  // stay signed in overnight.
  maxAge: 12 * 60 * 60,
};

export async function startSession(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, sign({ sub: userId, iat: Date.now() }), COOKIE_OPTIONS);
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
}

/** The signed-in user id, or null. Does NOT decide whether they may use the app. */
export async function sessionUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verify(token)?.sub ?? null;
}

/** When the current session was issued, for the revocation check. */
export async function sessionIssuedAt(): Promise<number | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verify(token)?.iat ?? null;
}

export function readSessionToken(token: string | undefined): SessionPayload | null {
  return token ? verify(token) : null;
}
