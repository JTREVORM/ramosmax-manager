/**
 * Labels shared by the after-hours screens.
 *
 * These live outside the `'use client'` table modules on purpose: a server
 * component that imports a value from a client module receives a client
 * reference proxy, which throws the moment a property is read.
 */

export const CUSTODY_KIND_LABELS: Record<string, string> = {
  opening_float: 'Opening float',
  payment: 'Payment taken',
  payment_reversal: 'Payment reversed',
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  mtn_merchant: 'MTN Merchant',
  airtel_merchant: 'Airtel Merchant',
  bank: 'Bank',
};

export const DISCREPANCY_KIND_LABELS: Record<string, string> = {
  shortage: 'Shortage',
  excess: 'Excess',
};

/** What an after-hours permission means to the person reading the screen. */
export const GRANT_LABELS: Record<string, string> = {
  'after_hours.operate': 'Run the session',
  'after_hours.cash.collect': 'Collect customer payments',
  'jobs.view': 'See jobs',
  'jobs.create': 'Book a vehicle in',
  'jobs.assign': 'Assign work',
  'invoices.view': 'See invoices',
  'invoices.create': 'Raise an invoice',
  'customers.view': 'See customers',
  'customers.manage': 'Add and edit customers',
  'vehicles.manage': 'Add and edit vehicles',
};

/** A difference, written the way a manager says it out loud. */
export function difference(ugx: number | null): string {
  if (ugx === null || ugx === 0) return 'Balanced';
  const amount = Math.abs(ugx).toLocaleString('en-US');
  return ugx < 0 ? `UGX ${amount} short` : `UGX ${amount} over`;
}
