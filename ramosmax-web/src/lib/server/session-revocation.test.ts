import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE HOSTED MALFORMED-JWT FAILURE.
 *
 * `POST /api/auth/change-password` returned 500 against the hosted project:
 *
 *   invalid JWT: unable to parse or verify signature, token is malformed:
 *   token contains an invalid number of segments
 *
 * `AuthProvider.revokeSessions(userId)` called
 * `supabase.auth.admin.signOut(userId, 'global')`. The first argument of that
 * method is a logged-in JWT — "@param jwt A valid, logged-in JWT" in
 * `@supabase/auth-js` — and a uuid has no dots, so GoTrue counted one segment
 * where it wanted three.
 *
 * It could not be caught by a database test, because no database was involved,
 * and not by the local development path, whose `revokeSessions` was an empty
 * function with a comment explaining that cookies are revoked by refusing
 * them. The hosted branch was the only one that did anything, and what it did
 * was wrong.
 *
 * These tests read the source. That is deliberate: what has to be prevented is
 * a shape — an app-level user id reaching a credential-store API that wants a
 * token — and the only way to assert a shape is to look at it.
 */

const read = (file: string) => readFileSync(join(process.cwd(), 'src/lib/server', file), 'utf8');

describe('the credential store is never handed a user id as a token', () => {
  it('has no revokeSessions on the AuthProvider seam', () => {
    const provider = read('auth-provider.ts');
    // Ending a session is an application concern: the session is this
    // application's own signed cookie and the browser never holds a Supabase
    // token. Putting it on the credential store is what made it possible to
    // pass the wrong kind of value.
    expect(provider).not.toMatch(/revokeSessions/);
  });

  it('never passes anything but an access token to admin.signOut', () => {
    const provider = read('auth-provider.ts');
    const calls = [...provider.matchAll(/admin\s*\n?\s*\.signOut\(\s*([^,)]+)/g)]
      .map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const argument of calls) {
      // A JWT, from the session GoTrue just issued — never a uuid.
      expect(argument, argument).toMatch(/access_token/);
      expect(argument, argument).not.toMatch(/\buser(Id)?\b/i);
    }
  });

  it('signs out only the throwaway session it created, never every session', () => {
    const provider = read('auth-provider.ts');
    // Verifying a password must not sign somebody out of their other devices.
    expect(provider).toMatch(/signOut\([^)]*,\s*'local'\)/);
    expect(provider).not.toMatch(/signOut\([^)]*,\s*'global'\)/);
  });
});

describe('revocation goes through the stamp that actually governs a cookie', () => {
  it('changing your own password ends the other sessions, then issues a new cookie', () => {
    const service = read('auth-service.ts');
    const change = service.slice(service.indexOf('export async function changeOwnPassword'));
    const setPassword = change.indexOf('provider.setPassword(');
    const complete = change.indexOf("complete_password_change");
    const revoke = change.indexOf('endOtherSessions(');
    const start = change.indexOf('startSession(');

    for (const [label, at] of Object.entries({ setPassword, complete, revoke, start })) {
      expect(at, `${label} must be present`).toBeGreaterThan(-1);
    }
    // The credential first, then the profile, then the revocation — and the
    // fresh cookie LAST, because a cookie issued before the stamp would
    // invalidate itself.
    expect(setPassword).toBeLessThan(complete);
    expect(complete).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(start);
  });

  it('reads both stamps when deciding whether a cookie is still good', () => {
    const service = read('auth-service.ts');
    // Reading only `password_changed_at` is why a phone-number change used to
    // audit that it had ended every session while leaving every cookie working.
    expect(service).toMatch(/password_changed_at/);
    expect(service).toMatch(/sessions_valid_from/);
  });

  it('resets a password through the server-only path, not as the browser', () => {
    const admin = read('user-admin-actions.ts');
    // `prepare_password_reset` and `create_user` are revoked from
    // `authenticated`. Calling them with `callRpc`, which drops to that role,
    // was refused outright — before the JWT bug could even be reached.
    for (const fn of ['prepare_password_reset', 'create_user']) {
      // The quoted form is the CALL; the bare name also appears in the comment
      // above it explaining why the call has to look like this.
      const at = admin.indexOf(`'${fn}'`);
      expect(at, `${fn} must be called`).toBeGreaterThan(-1);
      const call = admin.slice(Math.max(0, at - 200), at);
      expect(call, fn).toMatch(/serverRpcAsUser/);
    }
    expect(admin).toMatch(/endOtherSessions\(/);
  });
});

describe('the server-only call path keeps the caller’s identity', () => {
  it('sets the claim before deciding whether to drop the role', () => {
    const db = read('db.ts');
    const claim = db.indexOf("set_config('request.jwt.claims'");
    const role = db.indexOf("set local role authenticated");
    expect(claim).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(-1);
    // The claim is always set. Only the role switch is conditional, so a
    // server-only function still sees the real caller through auth.uid() and
    // still applies its own permission checks.
    expect(claim).toBeLessThan(role);
    expect(db).toMatch(/keepOwnerRights/);
  });
});
