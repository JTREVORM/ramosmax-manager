import { describe, expect, it } from 'vitest';
import { formatAmount, formatUgx, parseUgx } from './money';
import { businessDay } from './date';

describe('money is whole Ugandan shillings', () => {
  it('formats with no decimal places', () => {
    expect(formatUgx(1_250_000)).toMatch(/1,250,000/);
    expect(formatUgx(1_250_000)).not.toMatch(/\./);
  });

  it('formats a plain amount with thousands separators', () => {
    expect(formatAmount(5_000)).toBe('5,000');
  });

  it('parses typed amounts, separators and all', () => {
    expect(parseUgx('1,250,000')).toBe(1_250_000);
    expect(parseUgx('  5000 ')).toBe(5000);
    expect(parseUgx('0')).toBe(0);
  });

  it('refuses anything that is not a whole amount rather than rounding it', () => {
    for (const input of ['', 'abc', '1.5', '-100', '1e5']) {
      expect(parseUgx(input)).toBeNull();
    }
  });
});

describe('business day is East Africa Time, never the browser timezone', () => {
  it('uses the EAT date for an instant late in the UTC day', () => {
    // 22:30 UTC is already the next day in EAT (UTC+3).
    expect(businessDay('2026-03-10T22:30:00Z')).toBe('2026-03-11');
  });

  it('uses the EAT date for an instant early in the UTC day', () => {
    expect(businessDay('2026-03-10T06:00:00Z')).toBe('2026-03-10');
  });
});
