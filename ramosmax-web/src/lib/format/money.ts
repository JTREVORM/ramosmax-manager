/**
 * Money is always WHOLE Ugandan shillings, held as an integer.
 *
 * The Phase 9 reference implementation stores and calculates every amount in
 * whole UGX on the server; the client never computes a figure that matters. We
 * keep the same rule here: these helpers format and parse, they never do
 * arithmetic on money for business purposes.
 */

/**
 * Grouping only. The currency is prefixed by hand, exactly as
 * `Money.format()` does in the reference implementation:
 *
 *     String format() => '$currencyCode ${formatAmount()}';
 *
 * `Intl.NumberFormat` with `style: 'currency'` renders UGX as the ICU symbol
 * "USh", joined with a non-breaking space. RamosMAX shows "UGX" everywhere,
 * receipts included, so the code is written rather than resolved.
 */
const PLAIN = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const CURRENCY_CODE = 'UGX';

/** `UGX 1,250,000`. Pass whole shillings. */
export function formatUgx(amount: number): string {
  return `${CURRENCY_CODE} ${formatAmount(amount)}`;
}

/** `1,250,000` — for table cells where the column header already says UGX. */
export function formatAmount(amount: number): string {
  const value = Math.trunc(amount);
  return value < 0 ? `-${PLAIN.format(-value)}` : PLAIN.format(value);
}

/**
 * Parses typed input into whole shillings. Returns null when the text is not a
 * valid whole amount, so a caller must handle it rather than silently
 * rounding — an amount is never guessed.
 */
export function parseUgx(input: string): number | null {
  const cleaned = input.replace(/[\s,]/g, '');
  if (cleaned === '' || !/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}
