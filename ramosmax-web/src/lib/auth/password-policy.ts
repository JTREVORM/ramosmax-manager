/**
 * Password policy, ported EXACTLY from functions/src/passwords.js.
 *
 * The server is authoritative; this copy drives the form so someone is not
 * told "too weak" only after a round trip. The two must not diverge — the
 * parity tests check the same cases against both.
 *
 * No password, plain or hashed, is ever stored by RamosMAX. Supabase Auth
 * holds credentials.
 */

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

const COMMON = new Set([
  'password',
  'password1',
  'passw0rd',
  'qwerty',
  'qwerty123',
  '12345678',
  '123456789',
  'abc12345',
  'letmein',
  'welcome',
  'welcome1',
  'admin123',
  'ramosmax',
  'ramos123',
  'ramosmax1',
  'changeme',
]);

export interface PasswordContext {
  phoneNumber?: string | null;
  staffId?: string | null;
  fullName?: string | null;
}

/** Policy failures for `password`. An empty array means acceptable. */
export function passwordProblems(password: string, context: PasswordContext = {}): string[] {
  if (typeof password !== 'string') return ['Enter a password.'];
  const problems: string[] = [];

  if (password.length < MIN_LENGTH) problems.push(`Use at least ${MIN_LENGTH} characters.`);
  if (password.length > MAX_LENGTH) problems.push(`Use at most ${MAX_LENGTH} characters.`);
  if (!/[A-Z]/.test(password)) problems.push('Add an uppercase letter.');
  if (!/[a-z]/.test(password)) problems.push('Add a lowercase letter.');
  if (!/\d/.test(password)) problems.push('Add a number.');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Add a symbol, e.g. ! @ # $ %.');

  const lower = password.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (COMMON.has(lower) || COMMON.has(compact) || /^(ramos|password|qwerty)/.test(compact)) {
    problems.push('This password is too easy to guess.');
  }

  const phoneDigits = String(context.phoneNumber ?? '').replace(/\D/g, '');
  if (phoneDigits.length >= 6 && password.replace(/\D/g, '').includes(phoneDigits.slice(-6))) {
    problems.push('Do not use your phone number.');
  }
  if (
    context.staffId &&
    compact.includes(
      String(context.staffId)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ''),
    )
  ) {
    problems.push('Do not use your staff ID.');
  }
  for (const part of String(context.fullName ?? '')
    .toLowerCase()
    .split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) {
      problems.push('Do not use your name.');
      break;
    }
  }
  return problems;
}
