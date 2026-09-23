// ===========================================================================
// Password policy, secure generation and the hidden sign-in identity.
// ===========================================================================
// Pure (node:crypto only) so the admin CLI can reuse it. Mirrored for the UI
// by lib/core/auth/password_policy.dart; the server is authoritative.
//
// Credentials are never stored or logged by RamosMAX: Firebase Authentication
// holds them. Nothing in this file writes anywhere.
// ===========================================================================

import { randomInt, randomUUID } from 'node:crypto';

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
export const GENERATED_LENGTH = 12;

// No look-alikes (0/O/o, 1/l/I) so a temporary password can be read out or
// copied from a screen without mistakes.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '!@#$%*?-+=';
const ALL = UPPER + LOWER + DIGITS + SPECIAL;

const COMMON = new Set([
  'password', 'password1', 'passw0rd', 'qwerty', 'qwerty123', '12345678', '123456789', 'abc12345',
  'letmein', 'welcome', 'welcome1', 'admin123', 'ramosmax', 'ramos123', 'ramosmax1', 'changeme',
]);

/**
 * Policy failures for [password] (empty = acceptable). [context] carries
 * values the password must not contain: the phone number, staff ID, name.
 */
export function passwordProblems(password, { phoneNumber = null, staffId = null, fullName = null } = {}) {
  if (typeof password !== 'string') return ['Enter a password.'];
  const problems = [];
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
  const phoneDigits = String(phoneNumber ?? '').replace(/\D/g, '');
  if (phoneDigits.length >= 6 && password.replace(/\D/g, '').includes(phoneDigits.slice(-6))) {
    problems.push('Do not use your phone number.');
  }
  if (staffId && compact.includes(String(staffId).toLowerCase().replace(/[^a-z0-9]/g, ''))) {
    problems.push('Do not use your staff ID.');
  }
  for (const part of String(fullName ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) {
      problems.push('Do not use your name.');
      break;
    }
  }
  return problems;
}

const pick = (chars) => chars[randomInt(chars.length)];

/** Cryptographically random password that always satisfies the policy. */
export function generatePassword(length = GENERATED_LENGTH) {
  for (;;) {
    const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
    while (chars.length < length) chars.push(pick(ALL));
    // Fisher-Yates with a CSPRNG so the class order isn't predictable.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const password = chars.join('');
    if (passwordProblems(password).length === 0) return password;
  }
}

/**
 * The Firebase Email/Password identifier for a RamosMAX account. Random, so
 * it can't be derived from a phone number, and on the reserved `.invalid`
 * domain (RFC 2606), so no mail can ever be delivered for it. Only the
 * server and the Firebase Auth record know it; people sign in with their
 * phone number.
 */
export function newSignInIdentity() {
  return `${randomUUID().replace(/-/g, '')}@users.ramosmax.invalid`;
}

export const isSignInIdentity = (email) => typeof email === 'string' && email.endsWith('@users.ramosmax.invalid');
