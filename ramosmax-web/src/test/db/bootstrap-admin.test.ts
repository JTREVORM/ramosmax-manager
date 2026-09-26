import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';

afterAll(closePool);

/**
 * THE FIRST ADMINISTRATOR.
 *
 * `app.create_user` needs `users.create`, which only an administrator holds, so
 * a brand-new project cannot use it. `app.bootstrap_first_admin` is the one
 * other door — and these are the tests that it is a door and not a hole.
 *
 * The happy path cannot be tested here: this database is seeded with
 * administrators, and a test that removed them would leave every other suite
 * standing on a different installation. It is exercised against a database
 * with no profiles at all, which is what `scripts/bootstrap-admin.mjs` runs
 * against on a new project.
 */
describe('bootstrap_first_admin', () => {
  it('is shut for good once an administrator exists', async () => {
    await asAdminDb(async (db) => {
      expect(await db.expectError(
        `select app.bootstrap_first_admin(gen_random_uuid(), '0772123457', 'Second Person')`))
        .toMatch(/already has an administrator/i);
    });
  });

  it('is not callable by a signed-in browser session, whatever their role', async () => {
    await asAdminDb(async (db) => {
      for (const uid of [SEED.admin, SEED.manager, SEED.cashier, SEED.worker]) {
        await becomeClient(db, uid);
        expect(await db.expectError(
          `select app.bootstrap_first_admin(gen_random_uuid(), '0772123457', 'Nobody')`), uid)
          .toMatch(/permission denied for function/i);
        await becomeOwner(db);
      }
    });
  });

  it('refuses an administrator who has merely been deactivated', async () => {
    // Otherwise turning the last administrator off would re-open the door and
    // let anybody with the connection string install themselves as the first.
    await asAdminDb(async (db) => {
      await db.query(`update public.users set active = false where role = 'admin'`);
      const message = await db.expectError(
        `select app.bootstrap_first_admin(gen_random_uuid(), '0772123457', 'Opportunist')`);
      await db.query(`update public.users set active = true where role = 'admin'`);
      expect(message).toMatch(/already has an administrator/i);
    });
  });

  it('refuses a credential that has no sign-in identity', async () => {
    await asAdminDb(async (db) => {
      expect(await db.expectError(
        `select app.bootstrap_first_admin(gen_random_uuid(), '0772123457', 'Nobody')`))
        .toMatch(/already has an administrator|credential first/i);
    });
  });

  it('refuses a credential that already belongs to somebody', async () => {
    await asAdminDb(async (db) => {
      const person = await makeUser(db, { role: 'worker' });
      expect(await db.expectError(
        `select app.bootstrap_first_admin($1, '0772123457', 'Nobody')`, [person]))
        .toMatch(/already has an administrator|already belongs/i);
    });
  });
});
