/**
 * Labels shared by the ownership screens.
 *
 * These live outside the `'use client'` table modules on purpose: a server
 * component that imports a value from a client module receives a client
 * reference proxy, which throws the moment a property is read. Anything both
 * sides need belongs here.
 */

export const TXN_LABELS: Record<string, string> = {
  shares_issued: 'Issue',
  shares_transferred: 'Transfer',
  shares_adjusted: 'Adjustment',
  reversal: 'Reversal',
};

export const DIVIDEND_METHOD_LABELS: Record<string, string> = {
  pool: 'Pool shared by ownership',
  per_share: 'A declared amount per share',
};

export const CONTRIBUTION_SOURCE_LABELS: Record<string, string> = {
  account: 'Into a business account',
  prior_record: 'Paid before RamosMAX',
};
