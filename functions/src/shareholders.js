// ===========================================================================
// RamosMAX shareholders - profiles, share classes, the share / dividend
// policies, the register summary and shareholder self-service (Phase 7).
// ===========================================================================
// Same pattern as every other module: the caller comes from the verified ID
// token, permissions are re-read inside the transaction (freshActor), every
// input is validated here, and each change is written together with its
// audit entry in ONE transaction. firebase/firestore.rules deny every client
// write to these collections.
//
//   shareholders/{id}            profile + server-maintained totals (shares,
//                                ownership %, committed / paid / outstanding)
//   share_classes/{code}         ORDINARY, PREFERENCE ... value per share and
//                                server-maintained issued totals
//   shareholdings/{sh}_{class}   one shareholder's holding in one class
//   share_register/current       register-level totals and the ownership
//                                distribution (no contact or identity data)
//   settings/share_policy        approval and payment rules for shares
//   settings/dividend_policy     approval rule for dividends
//
// Nothing here is deleted: a shareholder who leaves becomes EXITED (only with
// no shares and nothing outstanding) and keeps their history.
// ===========================================================================

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import {
  deny, invalid, maskPhone, normalizePhone, optionalEmail, optionalText, precondition, requireName, requirePermission, requireReason,
} from './access.js';
import { alreadyExists, audit, freshActor, nextNumber, notFound, requireDocId, searchTokens, stamp, uniqueRef } from './operations.js';
import { dayKey, readRequest, requireAmount, requireBusinessDate, requireChoice, requireRequestId, requireText, saveRequest } from './finance.js';
import { loadActor, requireObject, requireUid } from './user_admin.js';

export const SHAREHOLDERS = 'shareholders';
export const SHARE_CLASSES = 'share_classes';
export const HOLDINGS = 'shareholdings';
export const SHARE_TXNS = 'share_transactions';
export const CONTRIBUTIONS = 'share_contributions';
export const DIVIDENDS = 'dividends';
export const ALLOCATIONS = 'dividend_allocations';
export const REGISTER_DOC = ['share_register', 'current'];
export const SHARE_POLICY_DOC = ['settings', 'share_policy'];
export const DIVIDEND_POLICY_DOC = ['settings', 'dividend_policy'];

/** The brief's ACTIVE / INACTIVE / SUSPENDED / EXITED, stored lower-case like every other status. */
export const SHAREHOLDER_STATUSES = Object.freeze(['active', 'inactive', 'suspended', 'exited']);
export const ID_TYPES = Object.freeze(['national_id', 'passport', 'company_registration', 'other']);

export const MAX_SHARES = 1_000_000_000;
export const MAX_VALUE_PER_SHARE_UGX = 100_000_000;
/** Largest commitment / dividend pool the system records (UGX). */
export const MAX_CAPITAL_UGX = 1_000_000_000_000;

/**
 * Defaults until an Administrator saves `settings/share_policy`. Shares are
 * paid in full when issued and every ownership change needs a second person's
 * approval; part-paid and unpaid (committed) shares are off unless the
 * business turns them on.
 */
export const DEFAULT_SHARE_POLICY = Object.freeze({
  requireApproval: true,
  allowUnpaidShares: false,
  allowPartialPayment: false,
});

/** Defaults until an Administrator saves `settings/dividend_policy`. */
export const DEFAULT_DIVIDEND_POLICY = Object.freeze({
  requireAdminApproval: true,
});

export const registerRef = (db) => db.collection(REGISTER_DOC[0]).doc(REGISTER_DOC[1]);
export const nameOf = (actor) => actor.data.fullName ?? null;

function policyFrom(defaults, data) {
  const p = { ...defaults };
  for (const k of Object.keys(defaults)) if (typeof data?.[k] === 'boolean') p[k] = data[k];
  return p;
}

export async function readSharePolicy(tx, db) {
  const snap = await tx.get(db.collection(SHARE_POLICY_DOC[0]).doc(SHARE_POLICY_DOC[1]));
  return policyFrom(DEFAULT_SHARE_POLICY, snap.exists ? snap.data() : null);
}

export async function readDividendPolicy(tx, db) {
  const snap = await tx.get(db.collection(DIVIDEND_POLICY_DOC[0]).doc(DIVIDEND_POLICY_DOC[1]));
  return policyFrom(DEFAULT_DIVIDEND_POLICY, snap.exists ? snap.data() : null);
}

export async function readShareholder(tx, db, id) {
  const ref = db.collection(SHAREHOLDERS).doc(requireDocId(id, 'shareholder'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That shareholder could not be found.', 'shareholder_not_found');
  return { ref, data: snap.data() };
}

export async function readShareClass(tx, db, id) {
  const ref = db.collection(SHARE_CLASSES).doc(requireDocId(id, 'share class'));
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound('That share class could not be found.', 'share_class_not_found');
  return { ref, data: snap.data() };
}

/**
 * The latest record date (EAT day start, millis) of a dividend whose
 * allocations have been calculated and not cancelled. Ownership on or before
 * it is frozen: no share transaction may take effect on or before that day.
 */
export async function lockedRecordDate(tx, db) {
  const snap = await tx.get(db.collection(DIVIDENDS).where('recordLocked', '==', true));
  let latest = -Infinity;
  for (const d of snap.docs) latest = Math.max(latest, d.get('recordDate')?.toMillis?.() ?? -Infinity);
  return latest;
}

export function requireRecordDateOpen(effectiveMs, lockMs) {
  if (effectiveMs <= lockMs) {
    throw precondition(`Ownership up to ${dayKey(lockMs)} is fixed by a calculated dividend. Use a later effective date, or cancel that dividend first.`,
      'record_date_locked');
  }
}

// ---------------------------------------------------------------------------
// Shareholder profiles
// ---------------------------------------------------------------------------

const PROFILE_FIELDS = ['fullName', 'phoneNumber', 'email', 'address', 'idType', 'idNumber', 'notes', 'joinDate'];

function optionalPhone(input) {
  if (input == null || input === '') return null;
  const phone = normalizePhone(input);
  if (!phone) throw invalid('Enter a valid phone number, e.g. 0772 123 456.', 'phone');
  return phone;
}

function shareholderInput(data, now, { partial }) {
  const out = {};
  if (!partial || 'fullName' in data) out.fullName = requireName(data.fullName);
  if (!partial || 'phoneNumber' in data) out.phoneNumber = optionalPhone(data.phoneNumber);
  if (!partial || 'email' in data) out.email = optionalEmail(data.email);
  if (!partial || 'address' in data) out.address = optionalText(data.address, 'Address', 200);
  if (!partial || 'idType' in data || 'idNumber' in data) {
    const type = data.idType == null || data.idType === '' ? null
      : requireChoice(data.idType, ID_TYPES, 'Choose a valid identification type.', 'identification');
    const number = optionalText(data.idNumber, 'Identification number', 40);
    if (Boolean(type) !== Boolean(number)) throw invalid('Enter both the identification type and number, or neither.', 'identification');
    if (number && !/^[A-Za-z0-9][A-Za-z0-9 /-]{2,39}$/.test(number)) {
      throw invalid('Use letters, digits, spaces, dashes or slashes for the identification number.', 'identification');
    }
    out.idType = type;
    out.idNumber = number ? number.toUpperCase().replace(/\s+/g, '') : null;
  }
  if (!partial || 'notes' in data) out.notes = optionalText(data.notes, 'Notes', 500);
  if (!partial || 'joinDate' in data) out.joinDate = requireBusinessDate(data.joinDate, now, { field: 'join date' });
  return out;
}

/** Reservations that make a phone number / identification belong to one shareholder. */
function reservations(db, p) {
  const out = [];
  if (p.phoneNumber) {
    out.push({ ref: uniqueRef(db, 'shareholder_phone', p.phoneNumber), kind: 'shareholder_phone',
      message: 'A shareholder with this phone number already exists.', reason: 'duplicate_phone' });
  }
  if (p.idNumber) {
    out.push({ ref: uniqueRef(db, 'shareholder_id', `${p.idType}_${p.idNumber.replace(/[^A-Z0-9]/g, '')}`), kind: 'shareholder_id',
      message: 'A shareholder with this identification number already exists.', reason: 'duplicate_identification' });
  }
  return out;
}

/** Audit-safe copy: phone and identification numbers are masked. */
function auditView(values) {
  const out = { ...values };
  if ('phoneNumber' in out) out.phoneNumber = maskPhone(out.phoneNumber);
  if ('idNumber' in out && out.idNumber) out.idNumber = `••${out.idNumber.slice(-3)}`;
  if (out.joinDate instanceof Timestamp) out.joinDate = dayKey(out.joinDate.toMillis());
  return out;
}

export async function createShareholder(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const input = shareholderInput(data, now, { partial: false });
  const requestId = requireRequestId(data.requestId);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shareholders.create');
    const request = await readRequest(tx, db, requestId, actor.uid, 'shareholder_create');
    if (request.earlier) return request.earlier;
    const keys = reservations(db, input);
    for (const k of keys) {
      const s = await tx.get(k.ref);
      if (s.exists) throw alreadyExists(k.message, k.reason, { shareholderId: s.get('shareholderId') });
    }
    const number = await nextNumber(tx, db, 'shareholders', 'RMX-SHR-', 6);
    const ref = db.collection(SHAREHOLDERS).doc();
    number.commit();
    tx.set(ref, {
      shareholderId: ref.id,
      shareholderNumber: number.value,
      ...input,
      searchTokens: searchTokens(input.fullName, number.value),
      status: 'active',
      statusReason: null,
      linkedUid: null,
      totalShares: 0,
      ownershipPercent: 0,
      committedUgx: 0,
      paidUgx: 0,
      outstandingUgx: 0,
      dividendsPaidUgx: 0,
      createdAt: stamp(),
      updatedAt: stamp(),
      createdBy: actor.uid,
      createdByName: nameOf(actor),
      updatedBy: actor.uid,
    });
    for (const k of keys) tx.set(k.ref, { kind: k.kind, shareholderId: ref.id });
    tx.set(registerRef(db), {
      shareholderCount: FieldValue.increment(1), statusCounts: { active: FieldValue.increment(1) }, updatedAt: stamp(),
    }, { merge: true });
    audit(tx, db, actor, 'shareholders', 'shareholder.created', ref.id, {
      newValue: auditView({ shareholderNumber: number.value, ...input }),
    });
    const result = { shareholderId: ref.id, shareholderNumber: number.value };
    saveRequest(tx, request.ref, 'shareholder_create', actor.uid, result);
    return result;
  });
}

export async function updateShareholder(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const changes = shareholderInput(data, now, { partial: true });
  const reason = requireReason(data.reason, { required: false });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shareholders.update');
    const { ref, data: before } = await readShareholder(tx, db, data.shareholderId);
    const changed = PROFILE_FIELDS.filter((k) => k in changes && !sameValue(changes[k], before[k]));
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');
    const next = { ...before, ...changes };
    const oldKeys = reservations(db, before);
    const newKeys = reservations(db, next).filter((k) => !oldKeys.some((o) => o.ref.path === k.ref.path));
    for (const k of newKeys) {
      const s = await tx.get(k.ref);
      if (s.exists && s.get('shareholderId') !== ref.id) throw alreadyExists(k.message, k.reason, { shareholderId: s.get('shareholderId') });
    }
    const renamed = changed.includes('fullName');
    const holdings = renamed ? await tx.get(db.collection(HOLDINGS).where('shareholderId', '==', ref.id)) : null;
    const register = renamed ? await tx.get(registerRef(db)) : null;

    // Writes.
    for (const k of oldKeys) if (!reservations(db, next).some((n) => n.ref.path === k.ref.path)) tx.delete(k.ref);
    for (const k of newKeys) tx.set(k.ref, { kind: k.kind, shareholderId: ref.id });
    const update = Object.fromEntries(changed.map((k) => [k, changes[k]]));
    if (renamed) update.searchTokens = searchTokens(next.fullName, before.shareholderNumber);
    tx.update(ref, { ...update, updatedAt: stamp(), updatedBy: actor.uid });
    if (renamed) {
      for (const h of holdings.docs) tx.update(h.ref, { shareholderName: next.fullName, updatedAt: stamp() });
      if (register?.exists) {
        const holders = (register.get('holders') ?? []).map((h) => (h.shareholderId === ref.id ? { ...h, shareholderName: next.fullName } : h));
        tx.update(register.ref, { holders, updatedAt: stamp() });
      }
    }
    audit(tx, db, actor, 'shareholders', 'shareholder.updated', ref.id, {
      previousValue: auditView(Object.fromEntries(changed.map((k) => [k, before[k] ?? null]))),
      newValue: auditView(update),
      reason,
    });
    return { shareholderId: ref.id, changed };
  });
}

function sameValue(a, b) {
  if (a instanceof Timestamp || b instanceof Timestamp) return a?.toMillis?.() === b?.toMillis?.();
  return (a ?? null) === (b ?? null);
}

/** ACTIVE / INACTIVE / SUSPENDED / EXITED, with a reason. EXITED needs no shares and nothing outstanding. */
export async function setShareholderStatus(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const status = requireChoice(data.status, SHAREHOLDER_STATUSES, 'Choose active, inactive, suspended or exited.', 'status');
  const reason = requireReason(data.reason);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shareholders.manage');
    const { ref, data: sh } = await readShareholder(tx, db, data.shareholderId);
    if (sh.status === status) throw precondition(`This shareholder is already ${status}.`, 'no_changes');
    if (status === 'exited') {
      if ((sh.totalShares ?? 0) > 0) throw precondition('Transfer or adjust this shareholder\'s shares to zero before marking them exited.', 'holds_shares');
      if ((sh.outstandingUgx ?? 0) > 0) throw precondition('This shareholder still has an unpaid share commitment.', 'outstanding_commitment');
      const pending = await tx.get(db.collection(SHARE_TXNS).where('shareholderIds', 'array-contains', ref.id));
      if (pending.docs.some((d) => d.get('status') === 'pending_approval')) {
        throw precondition('Decide this shareholder\'s pending share transactions first.', 'pending_transactions');
      }
    }
    tx.update(ref, { status, statusReason: reason, statusChangedAt: stamp(), updatedAt: stamp(), updatedBy: actor.uid });
    tx.set(registerRef(db), {
      statusCounts: { [sh.status]: FieldValue.increment(-1), [status]: FieldValue.increment(1) }, updatedAt: stamp(),
    }, { merge: true });
    audit(tx, db, actor, 'shareholders', 'shareholder.status_changed', ref.id, {
      previousValue: { status: sh.status }, newValue: { status }, reason,
    });
    return { shareholderId: ref.id, status };
  });
}

/**
 * Links (or unlinks, uid null) the RamosMAX sign-in of the person who IS this
 * shareholder, so they can see their own shareholding (shareholders.view.own).
 */
export async function linkShareholderAccount(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const uid = data.uid == null ? null : requireUid(data.uid);
  const reason = requireReason(data.reason, { required: false });

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shareholders.manage');
    const { ref, data: sh } = await readShareholder(tx, db, data.shareholderId);
    if ((sh.linkedUid ?? null) === uid) throw precondition('Nothing has changed.', 'no_changes');
    let userName = null;
    if (uid) {
      const user = await tx.get(db.collection('users').doc(uid));
      if (!user.exists) throw notFound('That user could not be found.', 'user_not_found');
      userName = user.get('fullName') ?? null;
      const key = await tx.get(uniqueRef(db, 'shareholder_uid', uid));
      if (key.exists && key.get('shareholderId') !== ref.id) {
        throw alreadyExists('That user is already linked to another shareholder.', 'duplicate_link');
      }
    }
    if (sh.linkedUid) tx.delete(uniqueRef(db, 'shareholder_uid', sh.linkedUid));
    if (uid) tx.set(uniqueRef(db, 'shareholder_uid', uid), { kind: 'shareholder_uid', shareholderId: ref.id });
    tx.update(ref, { linkedUid: uid, linkedUserName: userName, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'shareholders', uid ? 'shareholder.account_linked' : 'shareholder.account_unlinked', ref.id, {
      previousValue: { linkedUid: sh.linkedUid ?? null }, newValue: { linkedUid: uid }, reason,
    });
    return { shareholderId: ref.id, linkedUid: uid };
  });
}

// ---------------------------------------------------------------------------
// Share classes
// ---------------------------------------------------------------------------

const CLASS_CODE = /^[A-Z][A-Z0-9_]{1,19}$/;

export function requireValuePerShare(input) {
  return requireAmount(input, { field: 'value per share', max: MAX_VALUE_PER_SHARE_UGX });
}

/**
 * A configurable class of shares (e.g. ORDINARY). Only business fields are
 * kept - no voting or other legal rights are modelled.
 */
export async function createShareClass(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
  if (!CLASS_CODE.test(code)) throw invalid('Use 2–20 capital letters, digits or underscores for the class code, e.g. ORDINARY.', 'class_code');
  const name = requireText(data.name, 'Class name', 60);
  const value = requireValuePerShare(data.valuePerShareUgx);
  const description = optionalText(data.description, 'Description', 300);

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shareholders.manage');
    const ref = db.collection(SHARE_CLASSES).doc(code.toLowerCase());
    if ((await tx.get(ref)).exists) throw alreadyExists(`A share class with code ${code} already exists.`, 'duplicate_class');
    tx.set(ref, {
      classId: ref.id, code, name, description, valuePerShareUgx: value, active: true,
      issuedShares: 0, committedUgx: 0, paidUgx: 0, outstandingUgx: 0,
      createdAt: stamp(), updatedAt: stamp(), createdBy: actor.uid, updatedBy: actor.uid,
    });
    audit(tx, db, actor, 'shareholders', 'share_class.created', ref.id, { newValue: { code, name, valuePerShareUgx: value } });
    return { classId: ref.id };
  });
}

/** Name, description, value per share (for FUTURE issues only) and active flag. */
export async function updateShareClass(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const changes = {};
  if ('name' in data) changes.name = requireText(data.name, 'Class name', 60);
  if ('description' in data) changes.description = optionalText(data.description, 'Description', 300);
  if ('valuePerShareUgx' in data) changes.valuePerShareUgx = requireValuePerShare(data.valuePerShareUgx);
  if ('active' in data) changes.active = data.active === true;

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'shareholders.manage');
    const { ref, data: before } = await readShareClass(tx, db, data.classId);
    const changed = Object.keys(changes).filter((k) => (changes[k] ?? null) !== (before[k] ?? null));
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');
    const reason = requireReason(data.reason, { required: changed.includes('valuePerShareUgx') || changed.includes('active') });
    tx.update(ref, { ...Object.fromEntries(changed.map((k) => [k, changes[k]])), updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'shareholders', 'share_class.updated', ref.id, {
      previousValue: Object.fromEntries(changed.map((k) => [k, before[k] ?? null])),
      newValue: Object.fromEntries(changed.map((k) => [k, changes[k]])),
      reason,
    });
    return { classId: ref.id, changed };
  });
}

// ---------------------------------------------------------------------------
// Policies (settings.manage)
// ---------------------------------------------------------------------------

export async function updateShareholdingPolicy(deps, callerUid, rawData, now = Date.now()) {
  const { db } = deps;
  const data = requireObject(rawData);
  const which = requireChoice(data.policy, ['share', 'dividend'], 'Choose the share or dividend policy.', 'policy');
  const reason = requireReason(data.reason);
  const changes = requireObject(data.changes ?? {});
  const defaults = which === 'share' ? DEFAULT_SHARE_POLICY : DEFAULT_DIVIDEND_POLICY;
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in defaults) || typeof v !== 'boolean') throw invalid('One of the settings is not recognised.', 'policy');
  }
  const path = which === 'share' ? SHARE_POLICY_DOC : DIVIDEND_POLICY_DOC;

  return db.runTransaction(async (tx) => {
    const actor = await freshActor(tx, db, callerUid, now, 'settings.manage');
    const before = which === 'share' ? await readSharePolicy(tx, db) : await readDividendPolicy(tx, db);
    const next = { ...before, ...changes };
    const changed = Object.keys(defaults).filter((k) => next[k] !== before[k]);
    if (changed.length === 0) throw precondition('Nothing has changed.', 'no_changes');
    tx.set(db.collection(path[0]).doc(path[1]), { ...next, updatedAt: stamp(), updatedBy: actor.uid });
    audit(tx, db, actor, 'shareholders', `${which}_policy.updated`, path[1], {
      previousValue: Object.fromEntries(changed.map((k) => [k, before[k]])),
      newValue: Object.fromEntries(changed.map((k) => [k, next[k]])),
      reason,
    });
    return { changed };
  });
}

// ---------------------------------------------------------------------------
// Self-service (shareholders.view.own)
// ---------------------------------------------------------------------------

const ms = (t) => t?.toMillis?.() ?? null;

/**
 * The caller's OWN shareholding: the shareholder profile linked to their
 * sign-in, their holdings, their share history (without the other party's
 * identity), their contributions and their approved dividends. Read on the
 * server so a shareholder never queries the register directly.
 */
export async function getMyShareholding(deps, callerUid, _rawData, now = Date.now()) {
  const { db } = deps;
  const actor = await loadActor(db, callerUid, now);
  requirePermission(actor.perms, 'shareholders.view.own', 'shareholders.view');
  const found = await db.collection(SHAREHOLDERS).where('linkedUid', '==', callerUid).limit(1).get();
  if (found.empty) return { linked: false };
  const sh = found.docs[0].data();
  const id = sh.shareholderId;
  const [holdings, txns, contributions, allocations] = await Promise.all([
    db.collection(HOLDINGS).where('shareholderId', '==', id).get(),
    db.collection(SHARE_TXNS).where('shareholderIds', 'array-contains', id).get(),
    db.collection(CONTRIBUTIONS).where('shareholderId', '==', id).get(),
    db.collection(ALLOCATIONS).where('shareholderId', '==', id).get(),
  ]);
  const visibleDividend = new Set(['approved', 'partially_paid', 'paid']);
  return {
    linked: true,
    shareholder: {
      shareholderId: id,
      shareholderNumber: sh.shareholderNumber,
      fullName: sh.fullName,
      status: sh.status,
      joinDate: ms(sh.joinDate),
      totalShares: sh.totalShares ?? 0,
      ownershipPercent: sh.ownershipPercent ?? 0,
      committedUgx: sh.committedUgx ?? 0,
      paidUgx: sh.paidUgx ?? 0,
      outstandingUgx: sh.outstandingUgx ?? 0,
      dividendsPaidUgx: sh.dividendsPaidUgx ?? 0,
    },
    holdings: holdings.docs.map((d) => d.data()).filter((h) => h.shares > 0 || h.committedUgx > 0).map((h) => ({
      classId: h.classId, classCode: h.classCode, shares: h.shares, committedUgx: h.committedUgx, paidUgx: h.paidUgx, outstandingUgx: h.outstandingUgx,
    })),
    transactions: txns.docs.map((d) => d.data()).filter((t) => t.applied === true)
      .sort((a, b) => (ms(b.effectiveDate) - ms(a.effectiveDate)) || (ms(b.createdAt) - ms(a.createdAt)))
      .slice(0, 100)
      .map((t) => ({
        transactionNumber: t.transactionNumber,
        type: t.type,
        reversalOfType: t.reversalOfType ?? null,
        status: t.status,
        classCode: t.classCode,
        effectiveDate: ms(t.effectiveDate),
        // Only this shareholder's own line - never the counterparty.
        deltaShares: t.lines.filter((l) => l.shareholderId === id).reduce((s, l) => s + l.deltaShares, 0),
      })),
    contributions: contributions.docs.map((d) => d.data())
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
      .map((c) => ({
        contributionNumber: c.contributionNumber, amountUgx: c.amountUgx, status: c.status, paymentDate: ms(c.paymentDate),
        source: c.source, classCode: c.classCode,
      })),
    dividends: allocations.docs.map((d) => d.data()).filter((a) => a.current === true && visibleDividend.has(a.dividendStatus))
      .sort((a, b) => ms(b.recordDate) - ms(a.recordDate))
      .map((a) => ({
        allocationNumber: a.allocationNumber, dividendNumber: a.dividendNumber, financialPeriod: a.financialPeriod,
        recordDate: ms(a.recordDate), sharesAtRecordDate: a.sharesAtRecordDate, dividendPerShareUgx: a.dividendPerShareUgx,
        grossUgx: a.grossUgx, deductionsUgx: a.deductionsUgx, netUgx: a.netUgx, paymentStatus: a.paymentStatus, paidAt: ms(a.paidAt),
      })),
  };
}

/** Refuses an approver acting on a shareholding that is their own (Administrators excepted). */
export function requireNotOwnShareholding(actor, shareholders, what) {
  if (actor.data.role === 'admin') return;
  if (shareholders.some((s) => s?.linkedUid && s.linkedUid === actor.uid)) {
    throw deny(`You cannot ${what} your own shareholding.`, 'own_shareholding');
  }
}
