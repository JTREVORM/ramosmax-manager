// ===========================================================================
// RamosMAX after-hours operations and cash handovers (Phase 8)
// ===========================================================================
//
// Authorisation (RMX-AH-000001, `after_hours_access`)
//   A holder of after_hours.approve authorises a person who holds the base
//   permission after_hours.request, for a window (start → expiry, server
//   clock). The authorisation hands out ONLY permissions from
//   AFTER_HOURS_GRANTABLE, through the Phase 2 temporary-permission
//   mechanism (profile `temporaryPermissions` + users/{uid}/temporary_grants),
//   so they stop at expiry in the rules and on the server with no job
//   running, and are removed at once on revocation. They never become
//   permanent (access.AUTHORIZATION_ONLY guards the permanent editors).
//
// Session (RMX-AHS-000001, `after_hours_sessions`)
//   open ──close──► handover_pending ──handover received / discrepancy resolved──► reconciled
//     │               (or closed, when there is no cash to hand over)
//     └──cancel (nothing collected, no float)──► cancelled
//   At most one open session per person (`unique_keys/after_hours_open_session_{uid}`).
//   Payments, intakes, invoices and completed jobs recorded while it is open
//   (and the authorisation is live) carry isAfterHours / afterHoursSessionId /
//   afterHoursWorkerUid. Nothing is duplicated: the payment stays the Phase 4
//   payment and the Phase 5 ledger entry stays the only money record.
//
// Custody (RMX-AHC-000001, `after_hours_cash`)
//   Operational sub-ledger of cash the worker is holding - NOT a financial
//   account. One entry per opening float, after-hours payment and reversal:
//     expected cash = opening float + cash payments − cash payments reversed while the session was open
//   The session's figure is maintained with every payment and recalculated
//   from the payments themselves when the session closes; it is then frozen
//   on the handover and can never be edited.
//
// Handover (RMX-HO-000001, `cash_handovers`)
//   pending (session closed) ──worker submits count──► submitted ──manager counts and receives──►
//     received     (actual = expected)
//     discrepancy  (actual ≠ expected; RMX-AHD-000001 opened, explanation required) ──resolved / waived──► reconciled
//   difference = actual − expected. Neither value is ever changed afterwards.
//   Receiving moves custody from the worker to Cash at Hand, where the
//   customer payments were ALREADY posted: no ledger entry, no new revenue.
//
// Discrepancy (`cash_discrepancies`): open → under_review → resolved | waived.
//   Resolving may (explicitly) report a Phase 6 loss incident for a shortage
//   (recovery then follows the normal review → decision → schedule; nothing is
//   deducted automatically) and/or post the Phase 5 `adjustment` that aligns
//   Cash at Hand with the counted cash (finance.adjust).
// ===========================================================================

import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';

import {
  deny, invalid, isAccountLive, optionalText, permanentPermissions, precondition, requireCanAdminister, requirePermission, requireReason,
  requireTemporaryWindow,
} from './access.js';
import { audit, freshActor, notFound, requireDocId, stamp, uniqueRef } from './operations.js';
import { dayStart, holdersOf, openLedger, readCounter, readRequest, requireAmount, requireChoice, requireRequestId, saveRequest } from './finance.js';
import { prepareLossIncident } from './losses.js';
import { NotificationType, TEMP_GRANTS, notifySafely, requireObject, requireUid } from './user_admin.js';

export const AUTHORIZATIONS = 'after_hours_access';
export const SESSIONS = 'after_hours_sessions';
export const CUSTODY = 'after_hours_cash';
export const HANDOVERS = 'cash_handovers';
export const DISCREPANCIES = 'cash_discrepancies';
export const POLICY_DOC = ['settings', 'after_hours_policy'];
const USERS = 'users';
const PAYMENTS = 'payments';

/**
 * Everything an authorisation may hand out. Anything else - user, role or
 * password administration, salaries, payroll, finance configuration,
 * reversals, discounts, prices, shareholders, dividends, settings, audit -
 * is refused, because it is not on this list.
 */
export const AFTER_HOURS_GRANTABLE = Object.freeze([
  'after_hours.operate', 'after_hours.cash.collect',
  'jobs.view', 'jobs.create', 'jobs.assign',
  'invoices.view', 'invoices.create',
  'customers.view', 'customers.manage', 'vehicles.manage',
]);

/** What an authorisation grants when the approver does not choose. */
export const DEFAULT_GRANTS = Object.freeze([
  'after_hours.operate', 'after_hours.cash.collect', 'jobs.view', 'jobs.create', 'jobs.assign', 'invoices.view', 'invoices.create',
]);

export const PAYMENT_METHOD_KEYS = Object.freeze(['cash', 'mtn_merchant', 'airtel_merchant', 'bank']);
export const MAX_CASH_UGX = 2_000_000_000;

/** Defaults until an Administrator saves `settings/after_hours_policy`. Bank payments are off after hours. */
export const DEFAULT_POLICY = Object.freeze({
  allowedPaymentMethods: Object.freeze(['cash', 'mtn_merchant', 'airtel_merchant']),
  maxAuthorizationHours: 16,
  maxOpeningFloatUgx: 1_000_000,
});

export const SESSION_STATUSES = Object.freeze(['open', 'closed', 'handover_pending', 'reconciled', 'cancelled']);
export const HANDOVER_STATUSES = Object.freeze(['pending', 'submitted', 'received', 'discrepancy', 'reconciled']);
export const DISCREPANCY_STATUSES = Object.freeze(['open', 'under_review', 'resolved', 'waived']);

const ms = (t) => t?.toMillis?.() ?? null;
const nameOf = (actor) => actor.data.fullName ?? null;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function policyFrom(data) {
  const p = { ...DEFAULT_POLICY };
  if (Array.isArray(data?.allowedPaymentMethods)) p.allowedPaymentMethods = data.allowedPaymentMethods.filter((m) => PAYMENT_METHOD_KEYS.includes(m));
  if (Number.isInteger(data?.maxAuthorizationHours)) p.maxAuthorizationHours = data.maxAuthorizationHours;
  if (Number.isInteger(data?.maxOpeningFloatUgx)) p.maxOpeningFloatUgx = data.maxOpeningFloatUgx;
  return p;
}

export async function readAfterHoursPolicy(tx, db) {
  const snap = await tx.get(db.collection(POLICY_DOC[0]).doc(POLICY_DOC[1]));
  return policyFrom(snap.exists ? snap.data() : null);
}

function validatePolicy(p) {
  if (!Array.isArray(p.allowedPaymentMethods) || p.allowedPaymentMethods.length === 0
      || p.allowedPaymentMethods.some((m) => !PAYMENT_METHOD_KEYS.includes(m))) {
    throw invalid('Choose at least one valid payment method for after-hours work.', 'policy');
  }
  p.allowedPaymentMethods = PAYMENT_METHOD_KEYS.filter((m) => p.allowedPaymentMethods.includes(m));
  if (!Number.isInteger(p.maxAuthorizationHours) || p.maxAuthorizationHours < 1 || p.maxAuthorizationHours > 24) {
    throw invalid('An authorisation can last between 1 and 24 hours.', 'policy');
  }
  requireAmount(p.maxOpeningFloatUgx, { field: 'maximum opening float', min: 0, max: 10_000_000 });
  return p;
}

/** settings.manage: payment methods allowed after hours, longest window, largest float. */
export async function updateAfterHoursPolicy(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  const changes = requireObject(data.changes ?? {});
  if (Object.keys(changes).some((k) => !(k in DEFAULT_POLICY))) throw invalid('One of the settings is not recognised.', 'policy');
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'settings.manage');
    const before = await readAfterHoursPolicy(tx, db);
    const next = validatePolicy({ ...before, ...changes });
    const changed = Object.keys(DEFAULT_POLICY).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');
    tx.set(db.collection(POLICY_DOC[0]).doc(POLICY_DOC[1]), { ...next, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'after_hours', 'after_hours_policy.updated', POLICY_DOC[1], {
      previousValue: Object.fromEntries(changed.map((k) => [k, before[k]])),
      newValue: Object.fromEntries(changed.map((k) => [k, next[k]])),
      reason,
    });
    return { changed };
  });
}

// ---------------------------------------------------------------------------
// Authorisations
// ---------------------------------------------------------------------------

export function requireGrantList(input) {
  if (input == null) return [...DEFAULT_GRANTS];
  if (!Array.isArray(input) || input.some((p) => typeof p !== 'string')) throw invalid('Choose the after-hours permissions.', 'permission');
  const list = [...new Set(input)];
  const refused = list.filter((p) => !AFTER_HOURS_GRANTABLE.includes(p));
  if (refused.length > 0) {
    throw invalid(`After-hours work cannot include ${refused.join(', ')}.`, 'permission_not_allowed');
  }
  if (!list.includes('after_hours.operate')) list.unshift('after_hours.operate');
  return AFTER_HOURS_GRANTABLE.filter((p) => list.includes(p));
}

/** An authorisation in force at [now] (server clock). */
export const isLive = (auth, now) => auth?.status === 'active' && ms(auth.startsAt) <= now && ms(auth.expiresAt) > now;

async function readAuthorization(tx, db, id) {
  const ref = db.collection(AUTHORIZATIONS).doc(requireDocId(id, 'authorisation'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That after-hours authorisation could not be found.', 'authorization_not_found');
  return { ref, auth: snap.data() };
}

export async function authorizeAfterHours(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const uid = requireUid(data.staffUid);
  const reason = requireReason(data.reason);
  const requestId = requireRequestId(data.requestId);
  const permissions = requireGrantList(data.permissions);
  const { startsAt, expiresAt } = requireTemporaryWindow(data.startsAt, data.expiresAt, now);
  const float = data.openingFloatUgx == null ? 0 : requireAmount(data.openingFloatUgx, { field: 'opening float', min: 0, max: 10_000_000 });

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.approve');
    const request = await readRequest(tx, db, requestId, actor.uid, 'after_hours_authorization');
    if (request.earlier) return { result: request.earlier, notify: false };
    if (uid === actor.uid) throw deny('You cannot authorise yourself for after-hours work.', 'self_authorization');
    const policy = await readAfterHoursPolicy(tx, db);
    if (expiresAt - startsAt > policy.maxAuthorizationHours * 3600_000) {
      throw invalid(`An after-hours authorisation can last at most ${policy.maxAuthorizationHours} hours.`, 'window');
    }
    if (float > policy.maxOpeningFloatUgx) {
      throw invalid(`The opening float can be at most UGX ${policy.maxOpeningFloatUgx.toLocaleString('en-US')}.`, 'float');
    }
    const userRef = db.collection(USERS).doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw notFound('That user could not be found.', 'user_not_found');
    const target = userSnap.data();
    requireCanAdminister(actor.data, target);
    if (!isAccountLive(target, now)) throw precondition('This account is not active.', 'target_inactive');
    const permanent = permanentPermissions(target);
    if (!permanent.has('after_hours.request')) {
      throw precondition(`${target.fullName ?? 'This person'} is not eligible for after-hours work (after_hours.request).`, 'not_eligible');
    }
    const denied = new Set(target.deniedPermissions ?? []);
    if (denied.has('after_hours.operate')) throw precondition('After-hours operation is explicitly denied for this person.', 'denied');
    const existing = await tx.get(db.collection(AUTHORIZATIONS).where('staffUid', '==', uid));
    const clash = existing.docs.map((d) => d.data())
      .find((a) => a.status === 'active' && ms(a.expiresAt) > now && ms(a.startsAt) < expiresAt && ms(a.expiresAt) > startsAt);
    if (clash) throw precondition(`${clash.authorizationNumber} already covers part of this time. Revoke it first.`, 'authorization_overlaps');
    const toGrant = permissions.filter((p) => !permanent.has(p) && !denied.has(p));
    const grantsCol = userRef.collection(TEMP_GRANTS);
    const superseded = [];
    for (const p of toGrant) {
      const indexed = (target.temporaryPermissions ?? {})[p];
      if (!indexed?.grantId) continue;
      const s = await tx.get(grantsCol.doc(indexed.grantId));
      if (s.exists && s.get('status') === 'active') superseded.push(s);
    }
    const numbers = await readCounter(tx, db, 'after_hours_access', 'RMX-AH-', 6);

    // Writes.
    const number = numbers.next();
    numbers.commit();
    const ref = db.collection(AUTHORIZATIONS).doc();
    const starts = Timestamp.fromMillis(startsAt);
    const expires = Timestamp.fromMillis(expiresAt);
    const grants = [];
    const updates = [];
    for (const p of toGrant) {
      const g = grantsCol.doc();
      tx.set(g, {
        grantId: g.id, uid, permission: p, startsAt: starts, expiresAt: expires, reason: `After-hours ${number}: ${reason}`,
        status: 'active', grantedBy: actor.uid, grantedByName: nameOf(actor), grantedByRole: actor.data.role, createdAt: stamp(),
        // The authorisation sends its own "ending soon" notice - one, not one per permission.
        expiryNotified: true,
        source: 'after_hours', authorizationId: ref.id, authorizationNumber: number,
      });
      grants.push({ permission: p, grantId: g.id });
      updates.push(new FieldPath('temporaryPermissions', p), { startsAt: starts, expiresAt: expires, grantId: g.id });
    }
    for (const s of superseded) {
      tx.update(s.ref, { status: 'superseded', endedAt: stamp(), endedBy: actor.uid, supersededByAuthorizationId: ref.id });
    }
    if (updates.length > 0) {
      tx.update(userRef, ...updates, 'lastAccessChangeAt', stamp(), 'lastAccessChangeBy', actor.uid, 'updatedAt', stamp(), 'updatedBy', actor.uid);
    }
    tx.set(ref, {
      authorizationId: ref.id,
      authorizationNumber: number,
      staffUid: uid,
      staffId: target.staffId ?? null,
      staffName: target.fullName ?? uid,
      staffRole: target.role,
      startsAt: starts,
      expiresAt: expires,
      reason,
      permissions,
      grants,
      openingFloatUgx: float,
      floatSessionId: null,
      status: 'active',
      sessionIds: [],
      grantedBy: actor.uid,
      grantedByName: nameOf(actor),
      revokedAt: null, revokedBy: null, revokedByName: null, revokeReason: null,
      expiryNotified: false,
      requestId,
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    audit(tx, db, actor, 'after_hours', 'after_hours.authorized', ref.id, {
      newValue: {
        authorizationNumber: number, staffUid: uid, startsAt: new Date(startsAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
        permissions, temporaryGrants: toGrant, openingFloatUgx: float,
      },
      reason,
    });
    const result = { authorizationId: ref.id, authorizationNumber: number, granted: toGrant };
    saveRequest(tx, request.ref, 'after_hours_authorization', actor.uid, result);
    return { result, notify: true };
  });
  if (out.notify) await notifySafely(deps, uid, NotificationType.afterHoursAuthorized, out.result.authorizationId);
  return out.result;
}

/** Ends an authorisation now: its temporary permissions are removed at once. */
export async function revokeAfterHours(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.approve');
    const { ref, auth } = await readAuthorization(tx, db, data.authorizationId);
    if (auth.status !== 'active' || ms(auth.expiresAt) <= now) throw precondition('This authorisation has already ended.', 'not_active');
    const userRef = db.collection(USERS).doc(auth.staffUid);
    const user = await tx.get(userRef);
    if (user.exists) requireCanAdminister(actor.data, user.data());
    const grantSnaps = [];
    for (const g of auth.grants ?? []) grantSnaps.push({ g, snap: await tx.get(userRef.collection(TEMP_GRANTS).doc(g.grantId)) });

    const removals = [];
    for (const { g, snap } of grantSnaps) {
      if (snap.exists && snap.get('status') === 'active') {
        tx.update(snap.ref, { status: 'revoked', endedAt: stamp(), endedBy: actor.uid, endReason: reason });
      }
      if (user.exists && (user.get('temporaryPermissions') ?? {})[g.permission]?.grantId === g.grantId) {
        removals.push(new FieldPath('temporaryPermissions', g.permission), FieldValue.delete());
      }
    }
    if (removals.length > 0) {
      tx.update(userRef, ...removals, 'lastAccessChangeAt', stamp(), 'lastAccessChangeBy', actor.uid, 'updatedAt', stamp(), 'updatedBy', actor.uid);
    }
    tx.update(ref, { status: 'revoked', revokedAt: stamp(), revokedBy: actor.uid, revokedByName: nameOf(actor), revokeReason: reason, updatedAt: stamp() });
    audit(tx, db, actor, 'after_hours', 'after_hours.revoked', ref.id, {
      previousValue: { status: 'active' }, newValue: { status: 'revoked', authorizationNumber: auth.authorizationNumber, staffUid: auth.staffUid }, reason,
    });
    return { authorizationId: ref.id, status: 'revoked' };
  });
}

// ---------------------------------------------------------------------------
// Session context (used by billing.js and jobs.js inside their transactions)
// ---------------------------------------------------------------------------

const openKey = (db, uid) => uniqueRef(db, 'after_hours_open_session', uid);

/**
 * The caller's open after-hours session, if any: {sessionRef, session,
 * authRef, auth, live}. `live` = the session is open AND its authorisation is
 * in force now (server clock, not revoked). Reads only.
 */
export async function readAfterHoursContext(tx, db, uid, now) {
  const key = await tx.get(openKey(db, uid));
  if (!key.exists) return null;
  const sessionRef = db.collection(SESSIONS).doc(key.get('sessionId'));
  const sessionSnap = await tx.get(sessionRef);
  if (!sessionSnap.exists || sessionSnap.get('status') !== 'open') return null;
  const session = sessionSnap.data();
  const authRef = db.collection(AUTHORIZATIONS).doc(session.authorizationId);
  const authSnap = await tx.get(authRef);
  const auth = authSnap.exists ? authSnap.data() : null;
  return { sessionRef, session, authRef, auth, live: isLive(auth, now) };
}

/** Fields that mark a record as created in an after-hours session. */
export function afterHoursTags(ctx) {
  if (!ctx?.live) return { isAfterHours: false, afterHoursSessionId: null, afterHoursSessionNumber: null, afterHoursWorkerUid: null };
  return {
    isAfterHours: true,
    afterHoursSessionId: ctx.session.sessionId,
    afterHoursSessionNumber: ctx.session.sessionNumber,
    afterHoursWorkerUid: ctx.session.staffUid,
  };
}

/** Counts one more intake / invoice / completed job on a live session. */
export function countOnSession(tx, ctx, field) {
  if (!ctx?.live) return;
  tx.update(ctx.sessionRef, { [field]: FieldValue.increment(1), lastActivityAt: stamp(), updatedAt: stamp() });
}

/**
 * Payment rules (billing.recordPayment, before any write). With an open
 * session the payment is an after-hours payment: the authorisation must be
 * in force and the method allowed by the policy. Without one, only a
 * permanent `payments.record` holder may record payments.
 */
export async function requireAfterHoursPaymentAllowed(tx, db, actor, ctx, method, now) {
  if (!ctx) {
    if (!actor.perms.has('payments.record')) {
      throw deny('Open your after-hours session before collecting payments.', 'after_hours_session_required');
    }
    return null;
  }
  if (!ctx.live) {
    throw precondition('Your after-hours authorisation has ended or was revoked. Close your session and hand over the cash.', 'after_hours_expired');
  }
  const policy = await readAfterHoursPolicy(tx, db);
  if (!policy.allowedPaymentMethods.includes(method)) {
    throw deny('This payment method is not allowed after hours.', 'method_not_allowed');
  }
  return readCounter(tx, db, 'after_hours_cash', 'RMX-AHC-', 6);
}

/** Writes the custody entry and session totals for an after-hours payment. Call after all reads. */
export function recordPaymentCustody(tx, db, ctx, numbers, actor, payment) {
  const cash = payment.method === 'cash' ? payment.amountUgx : 0;
  const ref = db.collection(CUSTODY).doc();
  const entryNumber = numbers.next();
  numbers.commit();
  tx.set(ref, {
    entryId: ref.id, entryNumber, kind: 'payment',
    sessionId: ctx.session.sessionId, sessionNumber: ctx.session.sessionNumber, staffUid: ctx.session.staffUid, staffName: ctx.session.staffName,
    paymentId: payment.paymentId, receiptNumber: payment.receiptNumber, invoiceNumber: payment.invoiceNumber, numberPlate: payment.numberPlate,
    method: payment.method, amountUgx: payment.amountUgx, cashDeltaUgx: cash, affectsExpected: cash > 0,
    createdBy: actor.uid, createdAt: stamp(),
  });
  tx.update(ctx.sessionRef, {
    paymentCount: FieldValue.increment(1),
    cashCollectedUgx: FieldValue.increment(cash),
    nonCashCollectedUgx: FieldValue.increment(payment.amountUgx - cash),
    expectedCashUgx: FieldValue.increment(cash),
    lastActivityAt: stamp(),
    updatedAt: stamp(),
  });
  audit(tx, db, actor, 'after_hours', 'after_hours.payment_linked', payment.paymentId, {
    newValue: { sessionNumber: ctx.session.sessionNumber, receiptNumber: payment.receiptNumber, method: payment.method, amountUgx: payment.amountUgx, custodyEntry: entryNumber },
  });
}

/** Reads what reversing an after-hours payment needs (billing.reversePayment, before writes). */
export async function readReversalCustody(tx, db, payment) {
  if (!payment.afterHoursSessionId) return null;
  const sessionRef = db.collection(SESSIONS).doc(payment.afterHoursSessionId);
  const snap = await tx.get(sessionRef);
  if (!snap.exists) return null;
  return { sessionRef, session: snap.data(), numbers: await readCounter(tx, db, 'after_hours_cash', 'RMX-AHC-', 6) };
}

/**
 * A reversal while the session is OPEN reduces the cash the worker holds (the
 * refund came out of it). After the session closed, the expected amount is
 * frozen on the handover: the reversal is recorded for the trail only.
 */
export function recordReversalCustody(tx, db, rc, actor, payment, reason) {
  if (!rc) return;
  const open = rc.session.status === 'open';
  const cash = payment.method === 'cash' ? payment.amountUgx : 0;
  const ref = db.collection(CUSTODY).doc();
  const entryNumber = rc.numbers.next();
  rc.numbers.commit();
  tx.set(ref, {
    entryId: ref.id, entryNumber, kind: 'payment_reversal',
    sessionId: rc.session.sessionId, sessionNumber: rc.session.sessionNumber, staffUid: rc.session.staffUid, staffName: rc.session.staffName,
    paymentId: payment.paymentId, receiptNumber: payment.receiptNumber, invoiceNumber: payment.invoiceNumber, numberPlate: payment.numberPlate,
    method: payment.method, amountUgx: -payment.amountUgx, cashDeltaUgx: open ? -cash : 0, affectsExpected: open && cash > 0,
    afterSessionClosed: !open, reason, createdBy: actor.uid, createdAt: stamp(),
  });
  if (open) {
    tx.update(rc.sessionRef, {
      reversalCount: FieldValue.increment(1),
      cashReversedUgx: FieldValue.increment(cash),
      nonCashReversedUgx: FieldValue.increment(payment.amountUgx - cash),
      expectedCashUgx: FieldValue.increment(-cash),
      updatedAt: stamp(),
    });
  } else {
    tx.update(rc.sessionRef, { postCloseReversalsUgx: FieldValue.increment(payment.amountUgx), updatedAt: stamp() });
  }
  audit(tx, db, actor, 'after_hours', 'after_hours.payment_reversal_linked', payment.paymentId, {
    newValue: { sessionNumber: rc.session.sessionNumber, amountUgx: payment.amountUgx, method: payment.method, affectsExpected: open && cash > 0 },
    reason,
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Pure: expected cash from the session's payments (the authoritative records). */
export function expectedFromPayments(openingFloatUgx, payments) {
  let cash = 0;
  let nonCash = 0;
  let reversedCash = 0;
  for (const p of payments) {
    if (p.method === 'cash') {
      if (p.status === 'reversed') reversedCash += p.amountUgx;
      else cash += p.amountUgx;
    } else if (p.status !== 'reversed') nonCash += p.amountUgx;
  }
  return { expectedCashUgx: openingFloatUgx + cash, cashCollectedNetUgx: cash, reversedCashUgx: reversedCash, nonCashUgx: nonCash };
}

async function readSession(tx, db, id) {
  const ref = db.collection(SESSIONS).doc(requireDocId(id, 'session'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That after-hours session could not be found.', 'session_not_found');
  return { ref, s: snap.data() };
}

/** The worker's own session, or (after_hours.approve) anyone's. */
function requireOwnerOrApprover(actor, s, what) {
  if (s.staffUid === actor.uid) return;
  if (!actor.perms.has('after_hours.approve')) throw deny(`You can only ${what} your own after-hours session.`, 'not_owner');
}

export async function openAfterHoursSession(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData ?? {});
  const requestId = requireRequestId(data.requestId);
  const notes = optionalText(data.notes, 'Notes', 500);

  return db.runTransaction(async (tx) => {
    // after_hours.operate exists only while an authorisation's temporary grant is live.
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.operate');
    requirePermission(actor.perms, 'after_hours.request');
    const request = await readRequest(tx, db, requestId, actor.uid, 'after_hours_session');
    if (request.earlier) return request.earlier;
    const key = await tx.get(openKey(db, actor.uid));
    if (key.exists) throw precondition('You already have an after-hours session open.', 'session_already_open', { sessionId: key.get('sessionId') });
    const auths = await tx.get(db.collection(AUTHORIZATIONS).where('staffUid', '==', actor.uid));
    const authSnap = auths.docs.find((d) => isLive(d.data(), now));
    if (!authSnap) throw deny('You have no after-hours authorisation in force now.', 'no_authorization');
    const auth = authSnap.data();
    const float = auth.floatSessionId == null ? auth.openingFloatUgx ?? 0 : 0;
    const numbers = await readCounter(tx, db, 'after_hours_sessions', 'RMX-AHS-', 6);
    const custody = float > 0 ? await readCounter(tx, db, 'after_hours_cash', 'RMX-AHC-', 6) : null;

    const ref = db.collection(SESSIONS).doc();
    const number = numbers.next();
    numbers.commit();
    tx.set(ref, {
      sessionId: ref.id,
      sessionNumber: number,
      staffUid: actor.uid,
      staffName: nameOf(actor) ?? actor.uid,
      authorizationId: authSnap.id,
      authorizationNumber: auth.authorizationNumber,
      authorizationExpiresAt: auth.expiresAt,
      supervisorUid: auth.grantedBy,
      supervisorName: auth.grantedByName ?? null,
      status: 'open',
      openedAt: Timestamp.fromMillis(now),
      closedAt: null, closedBy: null, closedByName: null, closeNotes: null,
      openingFloatUgx: float,
      cashCollectedUgx: 0, nonCashCollectedUgx: 0, cashReversedUgx: 0, nonCashReversedUgx: 0,
      paymentCount: 0, reversalCount: 0, postCloseReversalsUgx: 0,
      expectedCashUgx: float,
      intakesCreated: 0, invoicesCreated: 0, jobsCompleted: 0,
      handoverId: null, handoverNumber: null, handoverStatus: null, actualReceivedUgx: null, differenceUgx: null,
      notes,
      requestId,
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    tx.set(openKey(db, actor.uid), { kind: 'after_hours_open_session', sessionId: ref.id, staffUid: actor.uid });
    tx.update(authSnap.ref, {
      sessionIds: FieldValue.arrayUnion(ref.id), ...(float > 0 ? { floatSessionId: ref.id } : {}), updatedAt: stamp(),
    });
    if (custody) {
      const c = db.collection(CUSTODY).doc();
      const entryNumber = custody.next();
      custody.commit();
      tx.set(c, {
        entryId: c.id, entryNumber, kind: 'opening_float', sessionId: ref.id, sessionNumber: number, staffUid: actor.uid, staffName: nameOf(actor),
        paymentId: null, method: 'cash', amountUgx: float, cashDeltaUgx: float, affectsExpected: true, createdBy: actor.uid, createdAt: stamp(),
      });
    }
    audit(tx, db, actor, 'after_hours', 'after_hours.session_opened', ref.id, {
      newValue: { sessionNumber: number, authorizationNumber: auth.authorizationNumber, openingFloatUgx: float },
    });
    const result = { sessionId: ref.id, sessionNumber: number };
    saveRequest(tx, request.ref, 'after_hours_session', actor.uid, result);
    return result;
  });
}

/**
 * Ends a session: the expected cash is recalculated from the session's
 * payments and frozen on a new handover (when there is cash to hand over).
 * Works after the authorisation has ended - the worker must still hand over.
 */
export async function closeAfterHoursSession(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const notes = optionalText(data.notes, 'Notes', 500);

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.request', 'after_hours.approve');
    const { ref, s } = await readSession(tx, db, data.sessionId);
    requireOwnerOrApprover(actor, s, 'close');
    if (s.status !== 'open') throw precondition('This session is not open.', 'session_not_open');
    const payments = await tx.get(db.collection(PAYMENTS).where('afterHoursSessionId', '==', ref.id));
    const calc = expectedFromPayments(s.openingFloatUgx ?? 0, payments.docs.map((d) => d.data()));
    const numbers = calc.expectedCashUgx > 0 ? await readCounter(tx, db, 'cash_handovers', 'RMX-HO-', 6) : null;

    const at = Timestamp.fromMillis(now);
    let handover = null;
    if (numbers) {
      const h = db.collection(HANDOVERS).doc();
      handover = { handoverId: h.id, handoverNumber: numbers.next() };
      numbers.commit();
      tx.set(h, {
        ...handover,
        sessionId: ref.id,
        sessionNumber: s.sessionNumber,
        authorizationId: s.authorizationId,
        staffUid: s.staffUid,
        staffName: s.staffName,
        openingFloatUgx: s.openingFloatUgx ?? 0,
        cashCollectedUgx: calc.cashCollectedNetUgx,
        cashReversedUgx: calc.reversedCashUgx,
        nonCashCollectedUgx: calc.nonCashUgx,
        paymentCount: payments.size,
        // Frozen here, from the payments themselves. Never edited afterwards.
        expectedCashUgx: calc.expectedCashUgx,
        declaredAmountUgx: null,
        actualAmountUgx: null,
        differenceUgx: null,
        status: 'pending',
        destinationAccountId: 'cash_at_hand',
        submittedBy: null, submittedByName: null, submittedAt: null, submitNotes: null,
        receivedBy: null, receivedByName: null, receivedAt: null, receiveNotes: null, explanation: null,
        discrepancyId: null, discrepancyNumber: null,
        reconciledAt: null, reconciledBy: null,
        createdAt: stamp(),
        updatedAt: stamp(),
      });
    }
    tx.update(ref, {
      status: handover ? 'handover_pending' : 'closed',
      closedAt: at, closedBy: actor.uid, closedByName: nameOf(actor), closeNotes: notes,
      expectedCashUgx: calc.expectedCashUgx,
      cashCollectedUgx: calc.cashCollectedNetUgx + calc.reversedCashUgx,
      cashReversedUgx: calc.reversedCashUgx,
      handoverId: handover?.handoverId ?? null, handoverNumber: handover?.handoverNumber ?? null, handoverStatus: handover ? 'pending' : null,
      updatedAt: stamp(),
    });
    tx.delete(openKey(db, s.staffUid));
    audit(tx, db, actor, 'after_hours', 'after_hours.session_closed', ref.id, {
      previousValue: { status: 'open', runningExpectedCashUgx: s.expectedCashUgx },
      newValue: { status: handover ? 'handover_pending' : 'closed', expectedCashUgx: calc.expectedCashUgx, handoverNumber: handover?.handoverNumber ?? null },
      reason: notes,
    });
    return { result: { sessionId: ref.id, expectedCashUgx: calc.expectedCashUgx, ...(handover ?? {}) }, staffUid: s.staffUid };
  });
  if (out.result.handoverId) {
    if (out.staffUid !== callerUid) await notifySafely(deps, out.staffUid, NotificationType.cashHandoverPending, out.result.handoverId);
    for (const uid of await holdersOf(db, ['cash_handover.approve'], now)) {
      if (uid !== out.staffUid && uid !== callerUid) await notifySafely(deps, uid, NotificationType.cashHandoverPending, out.result.handoverId);
    }
  }
  return out.result;
}

/** A session opened by mistake: nothing collected and no float, with a reason. */
export async function cancelAfterHoursSession(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const reason = requireReason(data.reason);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.request', 'after_hours.approve');
    const { ref, s } = await readSession(tx, db, data.sessionId);
    requireOwnerOrApprover(actor, s, 'cancel');
    if (s.status !== 'open') throw precondition('Only an open session can be cancelled.', 'session_not_open');
    const payments = await tx.get(db.collection(PAYMENTS).where('afterHoursSessionId', '==', ref.id));
    if (!payments.empty) throw precondition('Payments were recorded in this session. Close it and hand over instead.', 'has_payments');
    if ((s.openingFloatUgx ?? 0) > 0) throw precondition('This session holds an opening float. Close it and hand the float back.', 'has_float');
    tx.update(ref, { status: 'cancelled', cancelledAt: stamp(), cancelledBy: actor.uid, cancelReason: reason, updatedAt: stamp() });
    tx.delete(openKey(db, s.staffUid));
    audit(tx, db, actor, 'after_hours', 'after_hours.session_cancelled', ref.id, { previousValue: { status: 'open' }, newValue: { status: 'cancelled' }, reason });
    return { sessionId: ref.id, status: 'cancelled' };
  });
}

// ---------------------------------------------------------------------------
// Handovers
// ---------------------------------------------------------------------------

async function readHandover(tx, db, id) {
  const ref = db.collection(HANDOVERS).doc(requireDocId(id, 'handover'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That cash handover could not be found.', 'handover_not_found');
  return { ref, h: snap.data() };
}

/**
 * The worker (or a cash_handover.submit holder on their behalf) states what
 * they are handing over. Informational: the manager's count decides.
 */
export async function submitCashHandover(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const declared = requireAmount(data.declaredAmountUgx, { field: 'amount handed over', min: 0, max: MAX_CASH_UGX });
  const notes = optionalText(data.notes, 'Notes', 500);
  const requestId = requireRequestId(data.requestId);

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.request', 'cash_handover.submit');
    const request = await readRequest(tx, db, requestId, actor.uid, 'cash_handover_submit');
    if (request.earlier) return { result: request.earlier, notify: false };
    const { ref, h } = await readHandover(tx, db, data.handoverId);
    if (h.staffUid !== actor.uid && !actor.perms.has('cash_handover.submit')) {
      throw deny('You can only submit your own cash handover.', 'not_owner');
    }
    if (h.status === 'submitted') throw precondition('This handover has already been submitted.', 'already_submitted');
    if (h.status !== 'pending') throw precondition('This handover has already been received.', 'invalid_status');
    tx.update(ref, {
      status: 'submitted', declaredAmountUgx: declared, submittedBy: actor.uid, submittedByName: nameOf(actor), submittedAt: Timestamp.fromMillis(now),
      submitNotes: notes, updatedAt: stamp(),
    });
    tx.update(db.collection(SESSIONS).doc(h.sessionId), { handoverStatus: 'submitted', updatedAt: stamp() });
    audit(tx, db, actor, 'cash_handover', 'cash_handover.submitted', ref.id, {
      newValue: { handoverNumber: h.handoverNumber, expectedCashUgx: h.expectedCashUgx, declaredAmountUgx: declared }, reason: notes,
    });
    const result = { handoverId: ref.id, status: 'submitted' };
    saveRequest(tx, request.ref, 'cash_handover_submit', actor.uid, result);
    return { result, notify: true, staffUid: h.staffUid };
  });
  if (out.notify) {
    for (const uid of await holdersOf(db, ['cash_handover.approve'], now)) {
      if (uid !== callerUid && uid !== out.staffUid) await notifySafely(deps, uid, NotificationType.cashHandoverSubmitted, out.result.handoverId);
    }
  }
  return out.result;
}

/** Pure: difference = actual − expected; kind of discrepancy. */
export function compareCash(expectedUgx, actualUgx) {
  const differenceUgx = actualUgx - expectedUgx;
  return { differenceUgx, kind: differenceUgx === 0 ? 'balanced' : differenceUgx < 0 ? 'shortage' : 'excess' };
}

/**
 * The manager counts the cash and records what was received. Equal → received
 * (session reconciled). Different → a discrepancy is opened with the
 * explanation; expected and actual are never changed afterwards.
 */
export async function receiveCashHandover(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const actual = requireAmount(data.actualAmountUgx, { field: 'amount received', min: 0, max: MAX_CASH_UGX });
  const notes = optionalText(data.notes, 'Notes', 500);
  const requestId = requireRequestId(data.requestId);

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'cash_handover.approve');
    const request = await readRequest(tx, db, requestId, actor.uid, 'cash_handover_receive');
    if (request.earlier) return { result: request.earlier, notify: null };
    const { ref, h } = await readHandover(tx, db, data.handoverId);
    if (h.staffUid === actor.uid) throw deny('Someone else must receive your cash handover.', 'self_receipt');
    if (!['pending', 'submitted'].includes(h.status)) throw precondition('This handover has already been received.', 'already_received');
    const { differenceUgx, kind } = compareCash(h.expectedCashUgx, actual);
    const explanation = requireReason(data.explanation, { required: differenceUgx !== 0 });
    const numbers = differenceUgx !== 0 ? await readCounter(tx, db, 'cash_discrepancies', 'RMX-AHD-', 6) : null;

    const at = Timestamp.fromMillis(now);
    let discrepancy = null;
    if (numbers) {
      const d = db.collection(DISCREPANCIES).doc();
      discrepancy = { discrepancyId: d.id, discrepancyNumber: numbers.next() };
      numbers.commit();
      tx.set(d, {
        ...discrepancy,
        handoverId: ref.id, handoverNumber: h.handoverNumber, sessionId: h.sessionId, sessionNumber: h.sessionNumber,
        staffUid: h.staffUid, staffName: h.staffName,
        expectedCashUgx: h.expectedCashUgx, declaredAmountUgx: h.declaredAmountUgx ?? null, actualAmountUgx: actual, differenceUgx, kind,
        reason: explanation,
        reportedBy: actor.uid, reportedByName: nameOf(actor), reportedAt: at,
        status: 'open',
        reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNotes: null,
        outcome: null, resolution: null, resolvedBy: null, resolvedByName: null, resolvedAt: null,
        lossIncidentId: null, lossNumber: null, adjustmentTransactionId: null, adjustmentTransactionNumber: null,
        createdAt: stamp(), updatedAt: stamp(),
      });
      audit(tx, db, actor, 'cash_handover', 'cash_discrepancy.created', d.id, {
        newValue: { discrepancyNumber: discrepancy.discrepancyNumber, handoverNumber: h.handoverNumber, expectedCashUgx: h.expectedCashUgx, actualAmountUgx: actual, differenceUgx },
        reason: explanation,
      });
    }
    const status = discrepancy ? 'discrepancy' : 'received';
    tx.update(ref, {
      status, actualAmountUgx: actual, differenceUgx, explanation,
      receivedBy: actor.uid, receivedByName: nameOf(actor), receivedAt: at, receiveNotes: notes,
      discrepancyId: discrepancy?.discrepancyId ?? null, discrepancyNumber: discrepancy?.discrepancyNumber ?? null,
      ...(discrepancy ? {} : { reconciledAt: at, reconciledBy: actor.uid }),
      updatedAt: stamp(),
    });
    tx.update(db.collection(SESSIONS).doc(h.sessionId), {
      status: discrepancy ? 'handover_pending' : 'reconciled', handoverStatus: status, actualReceivedUgx: actual, differenceUgx, updatedAt: stamp(),
    });
    audit(tx, db, actor, 'cash_handover', 'cash_handover.received', ref.id, {
      previousValue: { status: h.status },
      newValue: { status, handoverNumber: h.handoverNumber, expectedCashUgx: h.expectedCashUgx, actualAmountUgx: actual, differenceUgx, destinationAccountId: 'cash_at_hand' },
      reason: explanation ?? notes,
    });
    const result = { handoverId: ref.id, status, differenceUgx, ...(discrepancy ?? {}) };
    saveRequest(tx, request.ref, 'cash_handover_receive', actor.uid, result);
    return { result, notify: discrepancy ? h.staffUid : null };
  });
  if (out.notify) {
    await notifySafely(deps, out.notify, NotificationType.cashDiscrepancyDetected, out.result.discrepancyId);
    for (const uid of await holdersOf(db, ['after_hours.discrepancy.review'], now)) {
      if (uid !== callerUid && uid !== out.notify) await notifySafely(deps, uid, NotificationType.cashDiscrepancyDetected, out.result.discrepancyId);
    }
  }
  return out.result;
}

// ---------------------------------------------------------------------------
// Discrepancies
// ---------------------------------------------------------------------------

async function readDiscrepancy(tx, db, id) {
  const ref = db.collection(DISCREPANCIES).doc(requireDocId(id, 'discrepancy'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That discrepancy could not be found.', 'discrepancy_not_found');
  return { ref, d: snap.data() };
}

function requireNotAboutSelf(actor, d) {
  if (d.staffUid === actor.uid) throw deny('You cannot review or resolve a discrepancy about your own handover.', 'self_action');
}

export async function reviewCashDiscrepancy(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const notes = requireReason(data.notes);
  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.discrepancy.review');
    const { ref, d } = await readDiscrepancy(tx, db, data.discrepancyId);
    requireNotAboutSelf(actor, d);
    if (d.status !== 'open') throw precondition('Only an open discrepancy can be put under review.', 'invalid_status');
    tx.update(ref, { status: 'under_review', reviewedBy: actor.uid, reviewedByName: nameOf(actor), reviewedAt: Timestamp.fromMillis(now), reviewNotes: notes, updatedAt: stamp() });
    audit(tx, db, actor, 'cash_handover', 'cash_discrepancy.reviewed', ref.id, { previousValue: { status: 'open' }, newValue: { status: 'under_review' }, reason: notes });
    return { discrepancyId: ref.id, status: 'under_review' };
  });
}

/**
 * Closes a discrepancy as resolved or waived, with the resolution text. The
 * original expected / actual / difference stay exactly as recorded. Optional,
 * explicit follow-ups:
 *   recoverFromWorker (shortage, losses.create): reports a Phase 6 loss
 *     incident about the worker - recovery still needs its own approval.
 *   postAdjustment (finance.adjust): posts the Phase 5 `adjustment` that makes
 *     Cash at Hand match the counted cash (out for a shortage, in for an excess).
 */
export async function resolveCashDiscrepancy(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const outcome = requireChoice(data.outcome, ['resolved', 'waived'], 'Choose resolved or waived.', 'outcome');
  const resolution = requireReason(data.resolution);
  const recover = data.recoverFromWorker === true;
  const adjust = data.postAdjustment === true;
  const requestId = requireRequestId(data.requestId);
  if (recover && outcome === 'waived') throw invalid('A waived discrepancy is not recovered from the worker.', 'outcome');

  const out = await db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'after_hours.discrepancy.review');
    const request = await readRequest(tx, db, requestId, actor.uid, 'cash_discrepancy_resolve');
    if (request.earlier) return { result: request.earlier, notify: [] };
    const { ref, d } = await readDiscrepancy(tx, db, data.discrepancyId);
    requireNotAboutSelf(actor, d);
    if (!['open', 'under_review'].includes(d.status)) throw precondition('This discrepancy has already been closed.', 'already_resolved');
    const amount = Math.abs(d.differenceUgx);
    let loss = null;
    if (recover) {
      if (d.differenceUgx >= 0) throw precondition('Only a shortage can be recovered from the worker.', 'not_a_shortage');
      requirePermission(actor.perms, 'losses.create');
      loss = await prepareLossIncident(tx, db, actor, {
        staffUid: d.staffUid, type: 'worker_related_loss', amount, date: Timestamp.fromMillis(dayStart(now)),
        description: `After-hours cash shortage ${d.discrepancyNumber} (handover ${d.handoverNumber}): expected UGX ${d.expectedCashUgx.toLocaleString('en-US')}, received UGX ${d.actualAmountUgx.toLocaleString('en-US')}.`,
        notes: resolution, requestId, source: { type: 'cash_discrepancy', id: ref.id, number: d.discrepancyNumber },
      });
    }
    let ledger = null;
    if (adjust) {
      requirePermission(actor.perms, 'finance.adjust');
      ledger = await openLedger(tx, db, ['cash_at_hand'], now);
      ledger.requireActive('cash_at_hand', actor.uid);
    }

    // Writes.
    let adjustment = { transactionId: null, transactionNumber: null };
    if (ledger) {
      adjustment = ledger.post({
        type: 'adjustment', amountUgx: amount, actor,
        ...(d.differenceUgx < 0 ? { fromId: 'cash_at_hand' } : { toId: 'cash_at_hand' }),
        fields: {
          reason: `Cash handover discrepancy ${d.discrepancyNumber}: ${resolution}`,
          description: `Adjustment ${d.differenceUgx < 0 ? '−' : '+'} (after-hours handover ${d.handoverNumber})`,
          discrepancyId: ref.id, discrepancyNumber: d.discrepancyNumber, handoverId: d.handoverId, handoverNumber: d.handoverNumber,
          approvedBy: actor.uid, requestId,
        },
      });
      ledger.commit(actor.uid);
    }
    const incident = loss ? loss() : null;
    const at = Timestamp.fromMillis(now);
    tx.update(ref, {
      status: outcome, outcome, resolution, resolvedBy: actor.uid, resolvedByName: nameOf(actor), resolvedAt: at,
      lossIncidentId: incident?.incidentId ?? null, lossNumber: incident?.lossNumber ?? null,
      adjustmentTransactionId: adjustment.transactionId, adjustmentTransactionNumber: adjustment.transactionNumber,
      updatedAt: stamp(),
    });
    tx.update(db.collection(HANDOVERS).doc(d.handoverId), { status: 'reconciled', reconciledAt: at, reconciledBy: actor.uid, updatedAt: stamp() });
    tx.update(db.collection(SESSIONS).doc(d.sessionId), { status: 'reconciled', handoverStatus: 'reconciled', updatedAt: stamp() });
    audit(tx, db, actor, 'cash_handover', `cash_discrepancy.${outcome}`, ref.id, {
      previousValue: { status: d.status },
      newValue: {
        status: outcome, differenceUgx: d.differenceUgx, lossNumber: incident?.lossNumber ?? null,
        adjustmentTransactionNumber: adjustment.transactionNumber,
      },
      reason: resolution,
    });
    audit(tx, db, actor, 'cash_handover', 'cash_handover.reconciled', d.handoverId, {
      previousValue: { status: 'discrepancy' }, newValue: { status: 'reconciled', discrepancyNumber: d.discrepancyNumber },
    });
    const result = { discrepancyId: ref.id, status: outcome, ...(incident ?? {}), ...adjustment };
    saveRequest(tx, request.ref, 'cash_discrepancy_resolve', actor.uid, result);
    return { result, notify: [d.staffUid, d.reportedBy] };
  });
  for (const uid of new Set(out.notify)) if (uid && uid !== callerUid) await notifySafely(deps, uid, NotificationType.cashDiscrepancyResolved, out.result.discrepancyId);
  return out.result;
}

// ---------------------------------------------------------------------------
// Housekeeping (scheduled with the temporary-grant sweep)
// ---------------------------------------------------------------------------
// Enforcement never depends on this: the temporary permissions stop at expiry
// by themselves and every function checks the window against the server clock.

export const EXPIRY_WARNING_MS = 30 * 60_000;

export async function sweepAfterHours(deps, now = Date.now()) {
  const { db } = deps;
  const nowTs = Timestamp.fromMillis(now);
  let expired = 0;
  let warned = 0;
  const due = await db.collection(AUTHORIZATIONS).where('status', '==', 'active').where('expiresAt', '<=', nowTs).limit(200).get();
  for (const d of due.docs) {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(d.ref);
      if (!s.exists || s.get('status') !== 'active' || ms(s.get('expiresAt')) > now) return;
      tx.update(d.ref, { status: 'expired', expiredAt: stamp(), updatedAt: stamp() });
    });
    expired++;
  }
  const soon = await db.collection(AUTHORIZATIONS).where('status', '==', 'active')
    .where('expiresAt', '>', nowTs).where('expiresAt', '<=', Timestamp.fromMillis(now + EXPIRY_WARNING_MS)).limit(200).get();
  for (const d of soon.docs) {
    if (d.get('expiryNotified') === true || ms(d.get('startsAt')) > now) continue;
    await d.ref.update({ expiryNotified: true });
    await notifySafely(deps, d.get('staffUid'), NotificationType.afterHoursExpiring, d.id);
    warned++;
  }
  return { expired, warned };
}
