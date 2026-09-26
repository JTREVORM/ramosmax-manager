import { afterAll, describe, expect, it } from 'vitest';
import { closePool, SEED } from './harness';
import { asAdminDb, becomeClient, becomeOwner, requestId } from './billing-helpers';
import {
  authorize, closeSession, eligibleWorker, makeUser, openSession, supervisor,
} from './after-hours-helpers';
import { effectivePermissions, ROLES, type AccessProfile, type Role } from '@/lib/permissions';

afterAll(closePool);

/**
 * RPC PERMISSION PARITY for after-hours work and cash handovers.
 *
 * Knowing the name of a function is not permission to call it. Every role
 * calls every after-hours RPC directly against the database, and the outcome
 * is compared with the Phase 9 permission catalogue.
 *
 * `after_hours.operate` and `after_hours.cash.collect` are deliberately absent
 * from every role: they exist ONLY inside an authorisation, which is why
 * `open_after_hours_session` is refused to all six roles here.
 */

const profile = (role: Role): AccessProfile => ({
  role,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
});

interface Fixtures {
  staff: string;
  authorization: string;
  session: string;
  handover: string;
  discrepancy: string;
}

interface RpcCase {
  name: string;
  requires: string[];
  call: (f: Fixtures) => [string, unknown[]];
}

const RPCS: RpcCase[] = [
  // --- policy ---
  { name: 'update_after_hours_policy', requires: ['settings.manage'],
    call: () => [`select app.update_after_hours_policy('{"maxAuthorizationHours":12}'::jsonb,
                    'Parity reason')`, []] },
  // --- authorisations ---
  { name: 'authorize_after_hours', requires: ['after_hours.approve'],
    call: ({ staff }) => [
      `select * from app.authorize_after_hours($1, now() + interval '2 hours', 'Parity', $2)`,
      [staff, requestId('parity-auth')]] },
  { name: 'revoke_after_hours', requires: ['after_hours.approve'],
    call: ({ authorization }) => [
      `select app.revoke_after_hours($1, 'Parity reason')`, [authorization]] },
  // --- sessions ---
  { name: 'open_after_hours_session', requires: ['after_hours.operate'],
    call: () => [`select * from app.open_after_hours_session($1)`, [requestId('parity-open')]] },
  { name: 'close_after_hours_session', requires: ['after_hours.request', 'after_hours.approve'],
    call: ({ session }) => [`select * from app.close_after_hours_session($1)`, [session]] },
  { name: 'cancel_after_hours_session', requires: ['after_hours.request', 'after_hours.approve'],
    call: ({ session }) => [
      `select app.cancel_after_hours_session($1, 'Parity reason')`, [session]] },
  // --- handovers ---
  { name: 'submit_cash_handover', requires: ['after_hours.request', 'cash_handover.submit'],
    call: ({ handover }) => [
      `select * from app.submit_cash_handover($1, 1000, $2)`,
      [handover, requestId('parity-submit')]] },
  { name: 'receive_cash_handover', requires: ['cash_handover.approve'],
    call: ({ handover }) => [
      `select * from app.receive_cash_handover($1, 1000, $2, 'Parity reason')`,
      [handover, requestId('parity-receive')]] },
  // --- discrepancies ---
  { name: 'review_cash_discrepancy', requires: ['after_hours.discrepancy.review'],
    call: ({ discrepancy }) => [
      `select app.review_cash_discrepancy($1, 'Parity reason')`, [discrepancy]] },
  { name: 'resolve_cash_discrepancy', requires: ['after_hours.discrepancy.review'],
    call: ({ discrepancy }) => [
      `select * from app.resolve_cash_discrepancy($1, 'waived', 'Parity reason', $2)`,
      [discrepancy, requestId('parity-resolve')]] },
  // --- self-service and housekeeping ---
  { name: 'my_after_hours', requires: ['after_hours.request', 'after_hours.view'],
    call: () => [`select app.my_after_hours()`, []] },
  { name: 'sweep_after_hours', requires: ['after_hours.approve', 'settings.manage'],
    call: () => [`select * from app.sweep_after_hours()`, []] },
];

async function fixtures(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]): Promise<Fixtures> {
  const staff = await eligibleWorker(db);
  const boss = await supervisor(db);
  const counter = await makeUser(db, { role: 'manager', permissions: ['cash_handover.approve'] });
  const auth = await authorize(db, { staff, by: boss, floatUgx: 50_000 });
  const session = await openSession(db, staff);

  // A second worker, so the handover and discrepancy under test belong to
  // somebody nobody in ROLES is.
  const other = await eligibleWorker(db);
  await authorize(db, { staff: other, by: boss, floatUgx: 40_000 });
  const otherSession = await openSession(db, other);
  const closed = await closeSession(db, otherSession.session_id, other);

  await becomeClient(db, counter);
  const { rows } = await db.query<{ discrepancy_id: string }>(
    `select * from app.receive_cash_handover($1, 35000, $2, 'Parity shortage')`,
    [closed.handover_id, requestId('parity-fixture')]);
  await becomeOwner(db);

  // A second handover, still pending, for submit and receive.
  const third = await eligibleWorker(db);
  await authorize(db, { staff: third, by: boss, floatUgx: 30_000 });
  const thirdSession = await openSession(db, third);
  const pending = await closeSession(db, thirdSession.session_id, third);

  return {
    staff,
    authorization: auth.authorization_id,
    session: session.session_id,
    handover: pending.handover_id!,
    discrepancy: rows[0].discrepancy_id,
  };
}

describe('every after-hours RPC refuses every role that lacks its permission', () => {
  for (const rpc of RPCS) {
    for (const role of ROLES) {
      const granted = effectivePermissions(profile(role));
      const allowed = rpc.requires.some((p) => granted.has(p as never));

      it(`${role} ${allowed ? 'MAY' : 'may NOT'} call ${rpc.name} (${rpc.requires.join(' / ')})`,
        async () => {
          await asAdminDb(async (db) => {
            const f = await fixtures(db);
            const [sql, params] = rpc.call(f);

            await becomeClient(db, SEED[role]);
            const error = await db.expectError(sql, params);

            if (allowed) {
              // It may fail on a business rule, but NEVER on permission.
              expect(error ?? '', `${role} -> ${rpc.name}`).not.toMatch(/do not have permission/);
            } else {
              expect(error, `${role} -> ${rpc.name}`).toMatch(/do not have permission|not active/);
            }
          });
        });
    }
  }
});
