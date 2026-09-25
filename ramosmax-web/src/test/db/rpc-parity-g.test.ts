import { afterAll, describe, expect, it } from 'vitest';
import { closePool, SEED } from './harness';
import { asAdminDb, becomeClient, becomeOwner, requestId } from './billing-helpers';
import { autoPost, issue, openDay, ownAccount, shareClass, shareholder } from './ownership-helpers';
import { effectivePermissions, ROLES, type AccessProfile, type Role } from '@/lib/permissions';

afterAll(closePool);

/**
 * RPC PERMISSION PARITY for shareholders, shares and dividends.
 *
 * Knowing the name of a function is not permission to call it. Every role
 * calls every ownership RPC directly against the database, and the outcome is
 * compared with the Phase 9 permission catalogue.
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
  john: string;
  mary: string;
  account: string;
  transaction: string;
  pending: string;
  contribution: string;
  dividend: string;
  allocation: string;
  day: string;
}

interface RpcCase {
  name: string;
  requires: string[];
  call: (f: Fixtures) => [string, unknown[]];
}

const RPCS: RpcCase[] = [
  // --- shareholders ---
  { name: 'create_shareholder', requires: ['shareholders.create'],
    call: () => [`select * from app.create_shareholder('Parity Owner', $1)`, [requestId('parity')]] },
  { name: 'update_shareholder', requires: ['shareholders.update'],
    call: ({ john }) => [`select app.update_shareholder($1, 'Renamed Owner')`, [john]] },
  { name: 'set_shareholder_status', requires: ['shareholders.manage'],
    call: ({ john }) => [`select app.set_shareholder_status($1, 'inactive', 'Parity reason')`, [john]] },
  { name: 'link_shareholder_account', requires: ['shareholders.manage'],
    call: ({ john }) => [`select app.link_shareholder_account($1, null, 'Parity')`, [john]] },
  { name: 'create_share_class', requires: ['shareholders.manage'],
    call: () => [`select app.create_share_class('PARITY', 'Parity class', 1000)`, []] },
  { name: 'update_share_class', requires: ['shareholders.manage'],
    call: () => [`select app.update_share_class('ordinary', 'Renamed class')`, []] },
  { name: 'update_shareholding_policy', requires: ['settings.manage'],
    call: () => [`select app.update_shareholding_policy('share',
                    '{"allowUnpaidShares":true}'::jsonb, 'Parity reason')`, []] },

  // --- shares ---
  { name: 'issue_shares', requires: ['shares.issue'],
    call: ({ john, account }) => [
      `select * from app.issue_shares($1, 'ordinary', 1, $2, null, 'account', 100000, $3)`,
      [john, requestId('parity'), account]] },
  { name: 'transfer_shares', requires: ['shares.transfer'],
    call: ({ john, mary }) => [
      `select * from app.transfer_shares($1, $2, 'ordinary', 1, 'Parity reason', $3)`,
      [john, mary, requestId('parity')]] },
  { name: 'adjust_shares', requires: ['shares.adjust'],
    call: ({ john }) => [
      `select * from app.adjust_shares($1, 'ordinary', -1, 'Parity reason', $2)`,
      [john, requestId('parity')]] },
  { name: 'decide_share_transaction', requires: ['shares.approve'],
    call: ({ pending }) => [`select app.decide_share_transaction($1, 'reject', 'Parity reason')`,
                            [pending]] },
  { name: 'record_share_contribution', requires: ['shares.issue'],
    call: ({ transaction, account }) => [
      `select * from app.record_share_contribution($1, 1000, $2, 'account', $3)`,
      [transaction, requestId('parity'), account]] },
  { name: 'reverse_share_contribution', requires: ['shares.adjust'],
    call: ({ contribution }) => [
      `select * from app.reverse_share_contribution($1, 'Parity reason')`, [contribution]] },
  { name: 'reverse_share_transaction', requires: ['shares.adjust'],
    call: ({ transaction }) => [
      `select * from app.reverse_share_transaction($1, 'Parity reason', $2)`,
      [transaction, requestId('parity')]] },
  { name: 'ownership_as_of', requires: ['shares.view', 'shareholders.reports.view'],
    call: ({ day }) => [`select * from app.ownership_as_of($1::date)`, [day]] },
  { name: 'my_shareholding', requires: ['shareholders.view.own', 'shareholders.view'],
    call: () => [`select app.my_shareholding()`, []] },

  // --- dividends ---
  { name: 'create_dividend', requires: ['dividends.create'],
    call: ({ day }) => [
      `select * from app.create_dividend('Parity period', $1::date, $2, 'pool', 1000)`,
      [day, requestId('parity')]] },
  { name: 'update_dividend', requires: ['dividends.create'],
    call: ({ dividend }) => [
      `select app.update_dividend($1, 'Parity renamed')`, [dividend]] },
  { name: 'calculate_dividend', requires: ['dividends.calculate'],
    call: ({ dividend }) => [`select * from app.calculate_dividend($1)`, [dividend]] },
  { name: 'update_dividend_status (declare)', requires: ['dividends.declare'],
    call: ({ dividend }) => [`select app.update_dividend_status($1, 'declare')`, [dividend]] },
  { name: 'update_dividend_status (approve)', requires: ['dividends.approve'],
    call: ({ dividend }) => [`select app.update_dividend_status($1, 'approve')`, [dividend]] },
  { name: 'pay_dividend', requires: ['dividends.pay'],
    call: ({ dividend, allocation, account }) => [
      `select * from app.pay_dividend($1, array[$2]::uuid[], $3, $4)`,
      [dividend, allocation, account, requestId('parity')]] },
  { name: 'reverse_dividend_payment', requires: ['dividends.adjust'],
    call: ({ allocation }) => [
      `select * from app.reverse_dividend_payment($1, 'Parity reason')`, [allocation]] },
  { name: 'cancel_dividend', requires: ['dividends.adjust'],
    call: ({ dividend }) => [`select app.cancel_dividend($1, 'Parity reason')`, [dividend]] },
];

async function fixtures(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]): Promise<Fixtures> {
  await shareClass(db, 'ORDINARY', 100_000);
  await autoPost(db);
  const account = await ownAccount(db, 500_000_000);
  const john = await shareholder(db, 'John Parity', `07729${Math.floor(Math.random() * 90000) + 10000}`);
  const mary = await shareholder(db, 'Mary Parity', `07728${Math.floor(Math.random() * 90000) + 10000}`);

  const day = await openDay(db);
  const issued = await issue(db, {
    shareholder: john, shares: 100, account, amount: 10_000_000, effective: day,
  });
  const { rows: contribution } = await db.query<{ id: string }>(
    `select id from public.share_contributions where share_transaction_id = $1`,
    [issued.transaction_id]);

  // One entry left pending, for the approval case.
  await becomeClient(db, SEED.admin);
  await db.query(
    `select app.update_shareholding_policy('share', '{"requireApproval":true}'::jsonb, 'Parity')`);
  const { rows: pending } = await db.query<{ transaction_id: string }>(
    `select * from app.issue_shares($1, 'ordinary', 10, $2, null, 'account', 1000000, $3)`,
    [mary, requestId('parity-pending'), account]);
  await db.query(
    `select app.update_shareholding_policy('share', '{"requireApproval":false}'::jsonb, 'Parity')`);

  // A calculated dividend with one allocation.
  const { rows: dividend } = await db.query<{ dividend_id: string }>(
    `select * from app.create_dividend('Parity FY', $1::date, $2, 'pool', 1000000)`,
    [day, requestId('parity-div')]);
  await db.query(`select * from app.calculate_dividend($1)`, [dividend[0].dividend_id]);
  const { rows: allocation } = await db.query<{ id: string }>(
    `select id from public.dividend_allocations where dividend_id = $1 and current limit 1`,
    [dividend[0].dividend_id]);
  await becomeOwner(db);

  return {
    john, mary, account,
    transaction: issued.transaction_id,
    pending: pending[0].transaction_id,
    contribution: contribution[0].id,
    dividend: dividend[0].dividend_id,
    allocation: allocation[0].id,
    day,
  };
}

describe('every ownership RPC refuses every role that lacks its permission', () => {
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
