/**
 * Money is always WHOLE Ugandan shillings, held as an integer.
 *
 * The Phase 9 reference implementation stores and calculates every amount in
 * whole UGX on the server; the client never computes a figure that matters. We
 * keep the same rule here: these helpers format and parse, they never do
 * arithmetic on money for business purposes.
 */

const FORMATTER = new Intl.NumberFormat('en-UG', {
  style: 'currency',
  currency: 'UGX',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const PLAIN = new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 });

/** `UGX 1,250,000`. Pass whole shillings. */
export function formatUgx(amount: number): string {
  return FORMATTER.format(Math.trunc(amount));
}

/** `1,250,000` — for table cells where the column header already says UGX. */
export function formatAmount(amount: number): string {
  return PLAIN.format(Math.trunc(amount));
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
