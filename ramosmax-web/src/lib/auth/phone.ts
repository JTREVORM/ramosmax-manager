/**
 * Phone number handling, ported EXACTLY from `normalizePhone` in
 * functions/src/access.js (mirrored by lib/core/utils/phone_numbers.dart).
 *
 * People sign in with a phone number, never an email. Uganda numbers may be
 * typed as 0772123456, 256772123456 or +256772123456 and all normalise to
 * +256772123456; the subscriber prefix is restricted to 3, 4 or 7. Numbers
 * from other countries must already be E.164.
 *
 * The SERVER is authoritative (app.normalize_phone in SQL). This copy exists
 * so the form can give immediate feedback, and it must not diverge.
 */

export function normalizePhone(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) {
    if (!/^\+[1-9]\d{7,14}$/.test(digits)) return null;
    if (digits.startsWith('+256') && !/^\+256[347]\d{8}$/.test(digits)) return null;
    return digits;
  }

  if (digits.startsWith('256') && digits.length > 9) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return /^[347]\d{8}$/.test(digits) ? `+256${digits}` : null;
}

/** `+256 772 123 456` — for display only; never send this to the server. */
export function formatPhoneForDisplay(e164: string): string {
  const m = /^\+256(\d{3})(\d{3})(\d{3})$/.exec(e164);
  return m ? `+256 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
