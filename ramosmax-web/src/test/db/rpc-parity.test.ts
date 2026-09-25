import { afterAll, describe, expect, it } from 'vitest';
import { asClient, closePool, SEED } from './harness';
import { asAdminDb, becomeClient, invoicedJob, requestId } from './billing-helpers';
import { effectivePermissions, ROLES, type AccessProfile, type Role } from '@/lib/permissions';

afterAll(closePool);

/**
 * RPC PERMISSION PARITY.
 *
 * Knowing the name of a function must not be enough to call it. For every
 * money-moving RPC, each of the six roles is made to call it DIRECTLY against
 * the database — no UI, no route, no navigation — and the outcome is compared
 * with what the Phase 9 permission catalogue says it should be.
 *
 * The expectations are derived from the catalogue, not hand-written, so they
 * cannot drift from it.
 */

const profile = (role: Role): AccessProfile => ({
  role,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
});

/**
 * Each Phase D RPC, the permission it requires, and a call that reaches the
 * permission check. The arguments are deliberately such that an AUTHORISED
 * caller gets past the permission gate — so a "denied" result can only come
 * from the gate itself, never from a bad argument.
 */
interface RpcCase {
  name: string;
  requires: string;
  call: (ids: { invoice: string; vehicle: string; intake: string; payment: string }) => [string, unknown[]];
}

const RPCS: RpcCase[] = [
  {
    name: 'create_invoice',
    requires: 'invoices.create',
    call: ({ intake }) => [`select app.create_invoice($1)`, [intake]],
  },
  {
    name: 'apply_invoice_discount',
    requires: 'discounts.apply',
    call: ({ invoice }) => [
      `select app.apply_invoice_discount($1, 'percentage', 5, 'promotional')`, [invoice]],
  },
  {
    name: 'mark_invoice_credit',
    requires: 'credit.manage',
    call: ({ invoice }) => [`select app.mark_invoice_credit($1, 'Pays on Friday')`, [invoice]],
  },
  {
    name: 'record_payment',
    requires: 'payments.record',
    call: ({ invoice }) => [
      `select * from app.record_payment($1, 1000, 'cash', $2)`, [invoice, requestId('parity')]],
  },
  {
    name: 'reverse_payment',
    requires: 'payments.reverse',
    call: ({ payment }) => [`select * from app.reverse_payment($1, 'Charged in error')`, [payment]],
  },
  {
    name: 'cancel_invoice',
    requires: 'invoices.void',
    call: ({ invoice }) => [`select app.cancel_invoice($1, 'Wrong job')`, [invoice]],
  },
  {
    name: 'apply_loyalty_reward',
    requires: 'loyalty.redeem',
    call: ({ invoice }) => [`select app.apply_loyalty_reward($1, null)`, [invoice]],
  },
  {
    name: 'adjust_loyalty_points',
    requires: 'loyalty.adjust',
    call: ({ vehicle }) => [`select app.adjust_loyalty_points($1, 10, 'Goodwill')`, [vehicle]],
  },
];

describe('every Phase D RPC refuses every role that lacks its permission', () => {
  for (const rpc of RPCS) {
    for (const role of ROLES) {
      const granted = effectivePermissions(profile(role));
      const allowed = granted.has(rpc.requires as never);

      it(`${role} ${allowed ? 'MAY' : 'may NOT'} call ${rpc.name} (${rpc.requires})`, async () => {
        await asAdminDb(async (db) => {
          // A fresh, fully set-up invoice with one payment, so every call can
          // get past its arguments and reach the permission gate.
          const { invoice, vehicle, intake } = await invoicedJob(
            db, randomPlate(), ['Body Wash']);
          await becomeClient(db, SEED.cashier);
          const { rows: paid } = await db.query<{ payment_id: string }>(
            `select * from app.record_payment($1, 1000, 'cash', $2)`,
            [invoice, requestId('setup')]);

          const [sql, params] = rpc.call({
            invoice, vehicle, intake, payment: paid[0].payment_id,
          });

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

describe('inactive and locked-out accounts cannot move money', () => {
  const states = [
    { name: 'deactivated', fields: { active: false } },
    { name: 'access expired', fields: { accessExpiresAt: new Date(Date.now() - 60_000).toISOString() } },
    { name: 'pending password change', fields: { mustChangePassword: true } },
  ];

  for (const state of states) {
    it(`a ${state.name} administrator is refused every money RPC`, async () => {
      await asAdminDb(async (db) => {
        const { invoice, vehicle } = await invoicedJob(db, randomPlate());
        const { makeUser } = await import('./harness');
        const uid = await makeUser(db, { role: 'admin', ...(state.fields as object) } as never);
        await becomeClient(db, uid);

        const calls: [string, unknown[]][] = [
          [`select * from app.record_payment($1, 1000, 'cash', $2)`, [invoice, requestId('x')]],
          [`select app.apply_invoice_discount($1, 'percentage', 5, 'promotional')`, [invoice]],
          [`select app.mark_invoice_credit($1, 'Later')`, [invoice]],
          [`select app.cancel_invoice($1, 'Nope')`, [invoice]],
          [`select app.adjust_loyalty_points($1, 10, 'Nope')`, [vehicle]],
        ];
        for (const [sql, params] of calls) {
          expect(await db.expectError(sql, params), sql).toMatch(/not active|do not have permission/);
        }
      });
    });
  }
});

describe('anonymous callers cannot reach any money function or table', () => {
  it('is refused every read', async () => {
    await asClient(null, async (session) => {
      for (const table of ['invoices', 'invoice_items', 'discounts', 'payments', 'receipts',
                           'financial_accounts', 'financial_transactions',
                           'loyalty_accounts', 'loyalty_transactions', 'loyalty_rewards']) {
        expect(await session.denied(`select * from public.${table}`), table).toBe(true);
      }
    });
  });

  it('is refused every money function', async () => {
    await asClient(null, async (session) => {
      for (const call of [
        `select app.create_invoice(gen_random_uuid())`,
        `select * from app.record_payment(gen_random_uuid(), 1, 'cash', 'x')`,
        `select * from app.reverse_payment(gen_random_uuid(), 'x')`,
        `select app.adjust_loyalty_points(gen_random_uuid(), 1, 'x')`,
      ]) {
        expect(await session.denied(call), call).toBe(true);
      }
    });
  });
});

describe('the internal building blocks are not callable by a client', () => {
  // Regression: PostgreSQL grants EXECUTE to PUBLIC by default, and
  // `authenticated` inherits PUBLIC. Revoking from `authenticated` alone left
  // these SECURITY DEFINER internals reachable by name, which let any signed-in
  // user fabricate money or forge a server-attributed audit entry.
  const internals: [string, string][] = [
    ['fabricate a ledger entry',
      `select app.post_ledger_entry(gen_random_uuid(), 'customer_payment', 'in', 1, 'x', null, 'x')`],
    ['forge a server audit entry', `select app.audit('forged', 'billing', 'X')`],
    ['forge an auth audit entry', `select app.audit_auth(gen_random_uuid(), 'forged')`],
    ['bypass idempotency', `select app.claim_request('x', 'y', '{}'::jsonb)`],
    ['complete someone else\'s request', `select app.complete_request('x', '{}'::jsonb)`],
    ['fabricate loyalty points',
      `select app.post_loyalty(gen_random_uuid(), 'earned', 9999, 'x', null)`],
    ['award loyalty directly', `select app.award_invoice_loyalty(gen_random_uuid())`],
    ['grant a reward directly', `select app.refresh_loyalty_reward(gen_random_uuid())`],
    ['burn reference numbers', `select app.next_reference('invoice_number_seq', 'X-')`],
    ['read another user\'s access', `select app.effective_permissions(gen_random_uuid())`],
    ['create a user', `select app.create_user(gen_random_uuid(), '0772000099', 'X', 'admin')`],
    ['reset a password', `select app.prepare_password_reset(gen_random_uuid())`],
  ];

  for (const role of ['admin', 'manager', 'cashier', 'worker', 'auditor'] as const) {
    it(`${role} cannot call any internal function`, async () => {
      await asClient(SEED[role], async (session) => {
        for (const [label, call] of internals) {
          const error = await session.expectError(call);
          expect(error, `${role}: ${label}`).toMatch(/permission denied/i);
        }
      });
    });
  }

  it('still lets the RLS helper functions run, or every policy would fail closed', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query<{ ok: boolean; active: boolean; role: string }>(`
        select app.has_permission('jobs.view.own') as ok,
               app.is_active() as active,
               app.current_role_id() as role`);
      expect(rows[0].ok).toBe(true);
      expect(rows[0].active).toBe(true);
      expect(rows[0].role).toBe('worker');
    });
  });

  it('returns no assignable workers to someone without jobs.assign', async () => {
    await asClient(SEED.worker, async (session) => {
      const { rows } = await session.query(`select * from app.assignable_workers()`);
      expect(rows).toEqual([]);
    });
    await asClient(SEED.manager, async (session) => {
      const { rows } = await session.query(`select * from app.assignable_workers()`);
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});

describe('a client cannot write any money table directly', () => {
  const attacks: [string, string][] = [
    ['insert an invoice', `insert into public.invoices
       (invoice_number, service_intake_id, job_number, vehicle_id, number_plate, subtotal_ugx)
       values ('RMX-INV-000000', gen_random_uuid(), 'X', gen_random_uuid(), 'X', 0)`],
    ['reduce an invoice subtotal', `update public.invoices set subtotal_ugx = 0`],
    ['mark an invoice paid', `update public.invoices set paid_ugx = 999999`],
    ['insert a payment', `insert into public.payments
       (invoice_id, amount_ugx, method, financial_account_id, financial_transaction_id, request_id)
       values (gen_random_uuid(), 1, 'cash', gen_random_uuid(), gen_random_uuid(), 'x')`],
    ['un-reverse a payment', `update public.payments set status = 'active'`],
    ['insert a ledger entry', `insert into public.financial_transactions
       (transaction_number, account_id, entry_type, direction, amount_ugx, balance_after_ugx, business_day)
       values ('RMX-TXN-000000', gen_random_uuid(), 'customer_payment', 'in', 1, 1, current_date)`],
    ['inflate an account balance', `update public.financial_accounts set balance_ugx = 999999999`],
    ['insert a receipt', `insert into public.receipts
       (receipt_number, payment_id, invoice_id, snapshot)
       values ('RMX-RCP-000000', gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)`],
    ['award loyalty points', `update public.loyalty_accounts set points_balance = 99999`],
    ['insert a loyalty entry', `insert into public.loyalty_transactions
       (vehicle_id, type, points, balance_before, balance_after)
       values (gen_random_uuid(), 'earned', 9999, 0, 9999)`],
    ['grant itself a reward', `insert into public.loyalty_rewards
       (vehicle_id, discount_percent, points_cost) values (gen_random_uuid(), 100, 0)`],
    ['edit a discount', `update public.discounts set discount_amount_ugx = 999999`],
  ];

  for (const role of ['admin', 'manager', 'cashier', 'worker', 'auditor'] as const) {
    it(`${role} is refused every direct money write`, async () => {
      await asClient(SEED[role], async (session) => {
        for (const [label, sql] of attacks) {
          expect(await session.denied(sql), `${role}: ${label}`).toBe(true);
        }
      });
    });
  }
});

describe('read access to money follows the catalogue', () => {
  const tables: { name: string; anyOf: string[] }[] = [
    { name: 'invoices', anyOf: ['invoices.view'] },
    { name: 'payments', anyOf: ['payments.view'] },
    { name: 'loyalty_accounts', anyOf: ['loyalty.view'] },
    { name: 'financial_transactions', anyOf: ['finance.transactions.view'] },
  ];

  for (const role of ROLES) {
    const granted = effectivePermissions(profile(role));
    for (const table of tables) {
      const shouldRead = table.anyOf.some((p) => granted.has(p as never));
      it(`${role} ${shouldRead ? 'CAN' : 'cannot'} read ${table.name}`, async () => {
        await asAdminDb(async (db) => {
          const { invoice, subtotal } = await invoicedJob(db, randomPlate());
          await becomeClient(db, SEED.cashier);
          await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
            [invoice, subtotal, requestId('read')]);

          await becomeClient(db, SEED[role]);
          const { rows } = await db.query<{ n: string }>(
            `select count(*)::text as n from public.${table.name}`);
          if (shouldRead) expect(Number(rows[0].n)).toBeGreaterThan(0);
          else expect(Number(rows[0].n)).toBe(0);
        });
      });
    }
  }

  it('lets a cashier record a payment without seeing the business balances', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, randomPlate());
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 1000, 'cash', $2)`,
        [invoice, requestId('blind')]);

      // The payment worked, but the ledger and balances stay closed.
      const ledger = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);
      expect(Number(ledger.rows[0].n)).toBe(0);

      // The account CHOICES are visible, without any balance column.
      const { rows } = await db.query<Record<string, unknown>>(
        `select * from public.payment_accounts limit 1`);
      expect(Object.keys(rows[0])).not.toContain('balance_ugx');
    });
  });
});

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const letter = () => LETTERS[Math.floor(Math.random() * LETTERS.length)];
function randomPlate() {
  return `U${letter()}${letter()} ${String(Math.floor(Math.random() * 900) + 100)}${letter()}`;
}
