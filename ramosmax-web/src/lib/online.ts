/**
 * The online guard for business mutations.
 *
 * RamosMAX policy, preserved verbatim from the Phase 9 implementation
 * (docs/OFFLINE.md, `runOnline` in lib/core/services/callables.dart):
 *
 *   Operational reads work offline. Money movements do not.
 *   NOTHING IS EVER QUEUED.
 *
 * This is a financial control, not a limitation. An offline device must never
 * post against a stale balance or a stale stock level, and an offline clock-in
 * must never be back-dated. Do not add Background Sync, a retry queue or an
 * optimistic write to anything that goes through here.
 *
 * Phase A establishes the primitive; Phases B-I route every mutation through it.
 */

export class OfflineError extends Error {
  readonly reason = 'offline' as const;
  constructor(message = 'This needs an internet connection. Nothing was sent.') {
    super(message);
    this.name = 'OfflineError';
  }
}

/**
 * A command was sent but its answer never arrived (timeout, dropped
 * connection, the tab was backgrounded).
 *
 * The message must say the action MAY ALREADY HAVE BEEN SAVED — never that it
 * failed. Retrying with the same requestId is safe and returns the first
 * result. Reporting a lost answer as a failure is how a business ends up
 * charging a customer twice.
 */
export class UnconfirmedError extends Error {
  readonly reason = 'unconfirmed' as const;
  constructor(
    message = 'The connection was lost before we heard back. This may already have been saved — check before trying again.',
  ) {
    super(message);
    this.name = 'UnconfirmedError';
  }
}

/** Runs `fn` only when the browser believes it is online. Never queues. */
export async function runOnline<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new OfflineError();
  }
  return fn();
}

/**
 * A request id for one form instance.
 *
 * Generate it ONCE when the form opens and reuse it for every retry, so a
 * retried submission after a lost response is recorded once. Generating a new
 * id per attempt defeats the whole mechanism.
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}
