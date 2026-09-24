import { NextResponse } from 'next/server';
import { changeOwnPassword } from '@/lib/server/auth-service';

export async function POST(request: Request) {
  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid request.' }, { status: 400 });
  }

  const result = await changeOwnPassword(
    typeof body.currentPassword === 'string' ? body.currentPassword : '',
    typeof body.newPassword === 'string' ? body.newPassword : '',
  );

  if (!result.ok) {
    const status = result.reason === 'unauthenticated' ? 401 : 400;
    return NextResponse.json(
      { ok: false, reason: result.reason, message: result.message },
      { status },
    );
  }
  return NextResponse.json({ ok: true });
}
