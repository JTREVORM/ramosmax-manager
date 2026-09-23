#!/usr/bin/env node
// ===========================================================================
// RamosMAX admin provisioning CLI (trusted, server-side)
// ===========================================================================
// Break-glass and bootstrap tool. Day-to-day user management happens IN THE
// APP, through Cloud Functions that authorise the caller. This CLI is for:
//   * creating the very first Administrator (bootstrap-admin);
//   * recovery if every Administrator is locked out;
//   * migrating accounts from the retired SMS sign-in (list-legacy, reset-password);
//   * scripted maintenance.
//
// Sign-in is phone number + password. Passwords are generated here with a
// CSPRNG, printed ONCE to this terminal, and handed to Firebase Auth. They are
// never written to Firestore, the audit log or any file.
//
// Runs with the Firebase Admin SDK and a service-account key stored OUTSIDE
// the repository (never in the app):
//
//   set GOOGLE_APPLICATION_CREDENTIALS=C:\secure\ramosmax-dev-admin.json
//   node tool/admin/provision.mjs bootstrap-admin --env dev --phone 0772123456 --name "Jane Doe"
//
// Commands
//   bootstrap-admin --phone --name [--staff-id]       first Admin (typed confirmation)
//   create-user     --phone --role --name [--staff-id] [--specialization] [--expires ISO]
//   reset-password  --phone --reason                  new temporary password (also migrates SMS accounts)
//   set-role        --phone --role --reason           refuses to demote the last active Admin
//   deactivate      --phone --reason                  refuses the last active Admin
//   activate        --phone
//   grant-temp      --phone --permission --hours --reason
//   revoke-temp     --phone --permission
//   show            --phone
//   list-legacy                                       accounts still without a password
//
// Every write records an audit_logs entry attributed to "admin-cli:<user>".
// Production writes require --confirm-production; bootstrap-admin in
// production also requires typing the project ID.
// ===========================================================================

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';

import { generatePassword, isSignInIdentity, newSignInIdentity } from '../../functions/src/passwords.js';

const PROJECTS = { dev: 'ramos1-c0862', prod: 'ramosmax-prod' };
// Shared with the Cloud Functions so the CLI can never drift from the app.
const CATALOG = JSON.parse(readFileSync(new URL('../../functions/src/access_catalog.json', import.meta.url), 'utf8'));
const ROLES = Object.keys(CATALOG.roles);
const SPECIALIZATIONS = CATALOG.specializations;
const PERMISSIONS = new Set(CATALOG.permissions);
const HEADER_LINES = 37;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { _command: command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i++;
    }
  }
  return args;
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Mirrors PhoneNumbers.toE164 for Uganda; other countries must be given in E.164. */
function toE164(input) {
  let digits = String(input).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    if (!/^\+\d{8,15}$/.test(digits)) fail(`Invalid phone number: ${input}`);
    if (digits.startsWith('+256') && !/^\+256[347]\d{8}$/.test(digits)) fail(`Invalid Ugandan number: ${input}`);
    return digits;
  }
  if (digits.startsWith('256')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[347]\d{8}$/.test(digits)) fail(`Invalid Ugandan number: ${input}. Use E.164 (+...) for other countries.`);
  return `+256${digits}`;
}

function normalizeStaffId(input) {
  const id = String(input).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(id)) fail(`Invalid staff ID: ${input} (e.g. RMX-STF-0001)`);
  return id;
}

function needArgs(args, ...names) {
  for (const n of names) if (!args[n] || args[n] === true) fail(`--${n} is required`);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The only place a password is ever displayed by this tool. */
function showPasswordOnce(phone, password) {
  console.log('\n  ┌──────────────────────────────────────────────────────────');
  console.log(`  │ Temporary password for ${phone}:`);
  console.log(`  │     ${password}`);
  console.log('  │ Shown ONCE. Hand it to the person securely. They must');
  console.log('  │ choose their own password when they first sign in.');
  console.log('  └──────────────────────────────────────────────────────────\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args._command || args.help) {
    const header = readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, HEADER_LINES);
    console.log(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }

  needArgs(args, 'env');
  const projectId = PROJECTS[args.env];
  if (!projectId) fail(`--env must be one of: ${Object.keys(PROJECTS).join(', ')}`);
  if (args.env === 'prod' && !args['confirm-production']) {
    fail('Refusing to modify PRODUCTION without --confirm-production.');
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    fail('Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key stored outside the repository.');
  }

  initializeApp({ credential: applicationDefault(), projectId });
  const auth = getAuth();
  const db = getFirestore();
  const actor = `admin-cli:${os.userInfo().username}`;
  const stamp = () => FieldValue.serverTimestamp();

  if (args._command === 'list-legacy') {
    // Profiles whose Auth account has no password yet (SMS-era accounts).
    const users = await db.collection('users').get();
    let count = 0;
    for (const doc of users.docs) {
      let record = null;
      try {
        record = await auth.getUser(doc.id);
      } catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
      }
      if (!record || !isSignInIdentity(record.email)) {
        count++;
        console.log(`  ${doc.get('phoneNumber') ?? '(no phone)'}  ${doc.get('role')}  ${doc.get('fullName') ?? ''}` +
          `${record ? '' : '  [no Firebase Auth account]'}`);
      }
    }
    console.log(count === 0
      ? '✔ Every RamosMAX account has a password.'
      : `\n${count} account(s) need a password: run reset-password for each (or reset from the app).`);
    return;
  }

  needArgs(args, 'phone');
  const phone = toE164(args.phone);

  async function authRecord() {
    try {
      return await auth.getUserByPhoneNumber(phone);
    } catch (e) {
      if (e.code === 'auth/user-not-found') return null;
      throw e;
    }
  }

  async function existingRef() {
    const record = await authRecord();
    if (!record) fail(`No Firebase Auth account for ${phone}.`);
    return db.collection('users').doc(record.uid);
  }

  function audit(batchOrTx, uid, action, { previousValue = null, newValue = null, description = null, reason = null } = {}) {
    batchOrTx.set(db.collection('audit_logs').doc(), {
      userId: actor,
      userRole: 'admin',
      action,
      module: 'users',
      recordId: uid,
      targetUserId: uid,
      description,
      reason,
      previousValue,
      newValue,
      source: 'admin_cli',
      timestamp: stamp(),
    });
  }

  async function requireAnotherActiveAdmin(tx, uid) {
    const admins = await tx.get(db.collection('users').where('role', '==', 'admin').where('active', '==', true));
    if (admins.docs.every((d) => d.id === uid)) fail('Refusing: RamosMAX must keep at least one active Administrator.');
  }

  /** Creates the Auth account (phone + hidden password identity) and profile. */
  async function createAccount({ role, name, staffId, specialization, expires }) {
    if (!ROLES.includes(role)) fail(`--role must be one of: ${ROLES.join(', ')}`);
    if (specialization && !SPECIALIZATIONS.includes(specialization)) {
      fail(`--specialization must be one of: ${SPECIALIZATIONS.join(', ')}`);
    }
    if (specialization && role !== 'worker') fail('--specialization applies to workers only');

    const password = generatePassword();
    let record = await authRecord();
    if (record) {
      if ((await db.collection('users').doc(record.uid).get()).exists) {
        fail(`A profile already exists for ${phone} (uid ${record.uid}).`);
      }
      record = await auth.updateUser(record.uid, {
        email: isSignInIdentity(record.email) ? record.email : newSignInIdentity(),
        password,
      });
    } else {
      record = await auth.createUser({ phoneNumber: phone, email: newSignInIdentity(), password });
    }
    const ref = db.collection('users').doc(record.uid);

    await db.runTransaction(async (tx) => {
      const staffRef = staffId ? db.collection('staff').doc(staffId) : null;
      const staff = staffRef ? await tx.get(staffRef) : null;
      if (staff?.exists && staff.get('linkedUid') && staff.get('linkedUid') !== ref.id) {
        fail(`Staff ID ${staffId} is already linked to another user.`);
      }
      tx.set(ref, {
        uid: ref.id,
        phoneNumber: phone,
        role,
        active: true,
        fullName: name,
        email: null,
        staffId: staffId ?? null,
        position: null,
        department: null,
        specialization: specialization ?? null,
        profilePhotoPath: null,
        permissions: [],
        deniedPermissions: [],
        temporaryPermissions: {},
        accessExpiresAt: expires ? Timestamp.fromDate(new Date(expires)) : null,
        passwordSet: true,
        mustChangePassword: true,
        passwordChangedAt: null,
        passwordResetAt: stamp(),
        passwordResetBy: actor,
        fcmTokens: [],
        statusReason: null,
        statusChangedAt: stamp(),
        statusChangedBy: actor,
        lastAccessChangeAt: stamp(),
        lastAccessChangeBy: actor,
        createdAt: stamp(),
        updatedAt: stamp(),
        createdBy: actor,
        updatedBy: actor,
        lastLoginAt: null,
      });
      if (staffRef) {
        if (staff.exists) {
          tx.update(staffRef, { linkedUid: ref.id, updatedAt: stamp(), updatedBy: actor });
        } else {
          tx.set(staffRef, {
            staffId, fullName: name, phoneNumber: phone, email: null, position: null, department: null,
            specialization: specialization ?? null, profilePhotoPath: null, employmentStatus: 'active',
            linkedUid: ref.id, createdAt: stamp(), createdBy: actor, updatedAt: stamp(), updatedBy: actor,
          });
        }
        audit(tx, ref.id, 'staff.linked', { newValue: { staffId, uid: ref.id } });
      }
      audit(tx, ref.id, 'user.created', { newValue: { role, active: true, staffId: staffId ?? null }, description: `Provisioned ${role}` });
    });
    return { ref, password };
  }

  switch (args._command) {
    case 'bootstrap-admin': {
      needArgs(args, 'name');
      const admins = await db.collection('users').where('role', '==', 'admin').where('active', '==', true).get();
      if (!admins.empty) {
        console.log(`ℹ ${admins.size} active Administrator(s) already exist in ${projectId}.`);
        console.log('  Additional users should be added from the app (User Management).');
        if (!args.force) fail('Refusing to bootstrap another Administrator. Pass --force for break-glass recovery.');
      }
      console.log(`\nAbout to create an ADMINISTRATOR with full access to ${projectId}:`);
      console.log(`  Name:  ${args.name}\n  Phone: ${phone}\n`);
      const expected = args.env === 'prod' ? projectId : 'yes';
      const typed = await ask(`Type "${expected}" to confirm: `);
      if (typed !== expected) fail('Confirmation did not match. Nothing was changed.');
      const { ref, password } = await createAccount({
        role: 'admin', name: args.name, staffId: args['staff-id'] ? normalizeStaffId(args['staff-id']) : null,
      });
      console.log(`✔ Administrator created (uid ${ref.id}). Sign in with ${phone} and:`);
      showPasswordOnce(phone, password);
      break;
    }
    case 'create':
    case 'create-user': {
      needArgs(args, 'role', 'name');
      if (args.role === 'admin') fail('Use bootstrap-admin for the first Administrator; add others from the app.');
      const { ref, password } = await createAccount({
        role: args.role, name: args.name, specialization: args.specialization, expires: args.expires,
        staffId: args['staff-id'] ? normalizeStaffId(args['staff-id']) : null,
      });
      console.log(`✔ Created ${args.role} profile for ${phone} (uid ${ref.id}) in ${projectId}`);
      showPasswordOnce(phone, password);
      break;
    }
    case 'reset-password': {
      needArgs(args, 'reason');
      const record = await authRecord();
      if (!record) fail(`No Firebase Auth account for ${phone}.`);
      const ref = db.collection('users').doc(record.uid);
      if (!(await ref.get()).exists) fail(`No RamosMAX profile for ${phone}.`);
      const password = generatePassword();
      const migrated = !isSignInIdentity(record.email);
      // Same UID: the profile, staff link and history are untouched.
      await auth.updateUser(record.uid, { ...(migrated ? { email: newSignInIdentity() } : {}), password });
      const batch = db.batch();
      batch.update(ref, {
        passwordSet: true, mustChangePassword: true, passwordResetAt: stamp(), passwordResetBy: actor,
        updatedAt: stamp(), updatedBy: actor,
      });
      audit(batch, ref.id, 'password.reset', {
        newValue: { mustChangePassword: true, ...(migrated ? { migratedFromSms: true } : {}) },
        reason: args.reason,
      });
      await batch.commit();
      await auth.revokeRefreshTokens(record.uid);
      console.log(`✔ ${migrated ? 'Password set (migrated from SMS sign-in)' : 'Password reset'} for ${phone}.`);
      showPasswordOnce(phone, password);
      break;
    }
    case 'set-role': {
      needArgs(args, 'role', 'reason');
      if (!ROLES.includes(args.role)) fail(`--role must be one of: ${ROLES.join(', ')}`);
      const ref = await existingRef();
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) fail(`No RamosMAX profile for ${phone}.`);
        const previous = snap.get('role');
        if (previous === args.role) fail(`${phone} is already ${args.role}.`);
        if (previous === 'admin' && snap.get('active') === true) await requireAnotherActiveAdmin(tx, ref.id);
        tx.update(ref, {
          role: args.role,
          ...(args.role === 'worker' ? {} : { specialization: null }),
          lastAccessChangeAt: stamp(), lastAccessChangeBy: actor, updatedAt: stamp(), updatedBy: actor,
        });
        audit(tx, ref.id, 'user.role_changed', { previousValue: { role: previous }, newValue: { role: args.role }, reason: args.reason });
      });
      console.log(`✔ ${phone} is now ${args.role}`);
      break;
    }
    case 'activate':
    case 'deactivate': {
      const active = args._command === 'activate';
      if (!active) needArgs(args, 'reason');
      const ref = await existingRef();
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) fail(`No RamosMAX profile for ${phone}.`);
        if (!active && snap.get('role') === 'admin') await requireAnotherActiveAdmin(tx, ref.id);
        const reason = typeof args.reason === 'string' ? args.reason : null;
        tx.update(ref, {
          active,
          statusReason: reason,
          statusChangedAt: stamp(),
          statusChangedBy: actor,
          lastAccessChangeAt: stamp(),
          lastAccessChangeBy: actor,
          updatedAt: stamp(),
          updatedBy: actor,
        });
        audit(tx, ref.id, active ? 'user.activated' : 'user.deactivated',
          { previousValue: { active: snap.get('active') === true }, newValue: { active }, reason });
      });
      // The Auth account is kept (so the person can be reactivated); only
      // their sessions are ended.
      if (!active) await auth.revokeRefreshTokens(ref.id);
      console.log(`✔ ${phone} is now ${active ? 'ACTIVE' : 'INACTIVE'}`);
      break;
    }
    case 'grant-temp': {
      needArgs(args, 'permission', 'hours', 'reason');
      if (!PERMISSIONS.has(args.permission)) fail(`Unknown permission: ${args.permission}`);
      const hours = Number(args.hours);
      if (!(hours > 0 && hours <= 24 * 30)) fail('--hours must be between 0 and 720');
      const ref = await existingRef();
      if (!(await ref.get()).exists) fail(`No RamosMAX profile for ${phone}.`);
      const startsAt = Timestamp.now();
      const expiresAt = Timestamp.fromMillis(startsAt.toMillis() + hours * 3600_000);
      const grantRef = ref.collection('temporary_grants').doc();
      const batch = db.batch();
      batch.set(grantRef, {
        grantId: grantRef.id, uid: ref.id, permission: args.permission, startsAt, expiresAt,
        reason: args.reason, status: 'active', grantedBy: actor, grantedByName: 'Provisioning tool',
        grantedByRole: 'admin', createdAt: stamp(), expiryNotified: false,
      });
      // FieldPath, not a dotted string: permission keys contain dots.
      batch.update(ref, new FieldPath('temporaryPermissions', args.permission), { startsAt, expiresAt, grantId: grantRef.id },
        'lastAccessChangeAt', stamp(), 'lastAccessChangeBy', actor, 'updatedAt', stamp(), 'updatedBy', actor);
      audit(batch, ref.id, 'permission.temporary_granted', {
        newValue: { permission: args.permission, grantId: grantRef.id, expiresAt: expiresAt.toDate().toISOString() },
        reason: args.reason,
      });
      await batch.commit();
      console.log(`✔ Granted ${args.permission} to ${phone} until ${expiresAt.toDate().toISOString()}`);
      break;
    }
    case 'revoke-temp': {
      needArgs(args, 'permission');
      const ref = await existingRef();
      const snap = await ref.get();
      const entry = (snap.get('temporaryPermissions') ?? {})[args.permission];
      const batch = db.batch();
      batch.update(ref, new FieldPath('temporaryPermissions', args.permission), FieldValue.delete(),
        'lastAccessChangeAt', stamp(), 'lastAccessChangeBy', actor, 'updatedAt', stamp(), 'updatedBy', actor);
      if (entry?.grantId) {
        batch.update(ref.collection('temporary_grants').doc(entry.grantId),
          { status: 'revoked', endedAt: stamp(), endedBy: actor, endReason: 'Revoked with the admin CLI' });
      }
      audit(batch, ref.id, 'permission.temporary_revoked', { previousValue: { permission: args.permission } });
      await batch.commit();
      console.log(`✔ Revoked ${args.permission} from ${phone}`);
      break;
    }
    case 'show': {
      const ref = await existingRef();
      const snap = await ref.get();
      if (!snap.exists) fail(`No RamosMAX profile for ${phone} (auth uid ${ref.id}).`);
      const { fcmTokens, ...safe } = snap.data();
      const record = await auth.getUser(ref.id);
      console.log(JSON.stringify({
        ...safe,
        fcmTokens: `${(fcmTokens ?? []).length} device(s)`,
        signIn: isSignInIdentity(record.email) ? 'password' : 'NO PASSWORD (legacy SMS account)',
      }, null, 2));
      break;
    }
    default:
      fail(`Unknown command: ${args._command}. Run with --help.`);
  }
}

main().catch((e) => fail(e.message ?? String(e)));
