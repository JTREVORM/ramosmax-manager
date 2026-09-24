import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';
import { passwordProblems } from './password-policy';

/**
 * These cases are taken from the Phase 9 test suite
 * (test/unit/phone_number_test.dart, test/unit/password_auth_test.dart,
 * functions/test/session.test.js) so the web port provably agrees with the
 * reference implementation.
 */

describe('normalizePhone', () => {
  it('normalises the three Ugandan forms to one E.164 number', () => {
    for (const input of ['0772123456', '256772123456', '+256772123456', '0772 123 456']) {
      expect(normalizePhone(input)).toBe('+256772123456');
    }
  });

  it('accepts the 3, 4 and 7 prefixes', () => {
    expect(normalizePhone('0772123456')).toBe('+256772123456');
    expect(normalizePhone('0392123456')).toBe('+256392123456');
    expect(normalizePhone('0412123456')).toBe('+256412123456');
  });

  it('rejects a Ugandan number with an invalid prefix', () => {
    expect(normalizePhone('0552123456')).toBeNull();
    expect(normalizePhone('+256552123456')).toBeNull();
  });

  it('rejects the wrong length', () => {
    expect(normalizePhone('077212345')).toBeNull();
    expect(normalizePhone('07721234567')).toBeNull();
  });

  it('accepts a valid non-Ugandan E.164 number', () => {
    expect(normalizePhone('+254712345678')).toBe('+254712345678');
  });

  it('rejects junk', () => {
    for (const input of ['', 'not a phone', '+', '++256772123456']) {
      expect(normalizePhone(input)).toBeNull();
    }
  });
});

describe('passwordProblems', () => {
  it('accepts a policy-compliant password', () => {
    expect(passwordProblems('Rm!7xQp2วz'.replace('ว', 'a'))).toEqual([]);
    expect(passwordProblems('Str0ng!Pass')).toEqual([]);
  });

  it('requires each character class', () => {
    expect(passwordProblems('alllower1!')).toContain('Add an uppercase letter.');
    expect(passwordProblems('ALLUPPER1!')).toContain('Add a lowercase letter.');
    expect(passwordProblems('NoDigits!!')).toContain('Add a number.');
    expect(passwordProblems('NoSymbol12')).toContain('Add a symbol, e.g. ! @ # $ %.');
  });

  it('enforces the length bounds', () => {
    expect(passwordProblems('Aa1!')).toContain('Use at least 8 characters.');
    expect(passwordProblems('Aa1!'.repeat(40))).toContain('Use at most 128 characters.');
  });

  it('rejects guessable passwords', () => {
    expect(passwordProblems('Password1!')).toContain('This password is too easy to guess.');
    expect(passwordProblems('RamosMax1!')).toContain('This password is too easy to guess.');
  });

  it('rejects a password containing the phone number', () => {
    expect(passwordProblems('Ab!123456xy', { phoneNumber: '+256772123456' })).toContain(
      'Do not use your phone number.',
    );
  });

  it('rejects a password containing the staff ID', () => {
    expect(passwordProblems('Xy!rmxstf0001', { staffId: 'RMX-STF-0001' })).toContain(
      'Do not use your staff ID.',
    );
  });

  it('rejects a password containing part of the name', () => {
    expect(passwordProblems('Musoke!99x', { fullName: 'John Musoke' })).toContain(
      'Do not use your name.',
    );
  });

  it('ignores name parts shorter than four characters', () => {
    expect(passwordProblems('Str0ng!Pass', { fullName: 'Jo Li' })).toEqual([]);
  });
});
