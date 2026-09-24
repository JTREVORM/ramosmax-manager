/**
 * Dates are presented in East Africa Time, which is the business day the
 * server keys attendance, allowances, daily summaries and report periods to.
 * The browser's own timezone is never used for a business day.
 */

export const BUSINESS_TIME_ZONE = 'Africa/Kampala';

const DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const formatDate = (at: Date | string) => DATE.format(new Date(at));
export const formatDateTime = (at: Date | string) => DATE_TIME.format(new Date(at));
export const formatTime = (at: Date | string) => TIME.format(new Date(at));

/** The EAT business day for an instant, as `yyyy-mm-dd`. Mirrors app.eat_day(). */
export function businessDay(at: Date | string = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
  return parts;
}
