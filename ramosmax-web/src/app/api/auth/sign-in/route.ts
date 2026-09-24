import { NextResponse } from 'next/server';
import { signIn } from '@/lib/server/auth-service';

/**
 * Sign in with a phone number and a password.
 *
 * Nothing about the outcome is decided here: the service applies the Phase 9
 * rules and returns the answer. The response deliberately carries the same
 * generic message for every credential failure.
 */
export async function POST(request: Request) {
  let body: { phone?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 });
  }

  const phone = typeof body.phone === 'string' ? body.phone : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const result = await signIn(phone, password);

  if (!result.ok) {
    const status =
      result.reason === 'too_many_attempts'
        ? 429
        : result.reason === 'invalid_credentials'
          ? 401
          : result.reason === 'phone'
            ? 400
            : 403;
    return NextResponse.json(
      { ok: false, reason: result.reason, message: result.message },
      { status },
    );
  }

  return NextResponse.json({ ok: true, mustChangePassword: result.mustChangePassword });
}
