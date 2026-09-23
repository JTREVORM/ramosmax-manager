// ===========================================================================
// RamosMAX Cloud Functions - entry point
// ===========================================================================
// Callable functions for sign-in, user administration, operations, billing,
// loyalty, finance, expenses, inventory, attendance, allowances, payroll and
// losses. Except for
// `signInWithPhonePassword` (which is how a session starts), the caller's
// identity comes from the verified Firebase ID token that the Functions
// runtime checks before our code runs. Everything else is decided on the
// server in ./user_admin.js and ./session.js.
//
// Region: europe-west1, next to Firestore (eur3). The Flutter client calls the
// same region (lib/core/config/app_environment.dart -> functionsRegion).
//
// Secret: RAMOSMAX_AUTH_API_KEY - a Google Cloud API key restricted to the
// Identity Toolkit API, used only to verify passwords server-side. Set it per
// project with `firebase functions:secrets:set RAMOSMAX_AUTH_API_KEY`
// (docs/ADMIN_PROVISIONING.md). It never ships in the app.
// ===========================================================================

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';

import { makeNotifier } from './notify.js';
import * as allowances from './allowances.js';
import * as attendance from './attendance.js';
import * as billing from './billing.js';
import * as expenses from './expenses.js';
import * as finance from './finance.js';
import * as inventory from './inventory.js';
import * as jobs from './jobs.js';
import * as losses from './losses.js';
import * as loyalty from './loyalty.js';
import * as ops from './operations.js';
import * as payroll from './payroll.js';
import * as session from './session.js';
import * as admin from './user_admin.js';
import * as workforce from './workforce.js';

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const authApiKey = defineSecret('RAMOSMAX_AUTH_API_KEY');

let deps;
function dependencies() {
  if (!deps) {
    const db = getFirestore();
    deps = { db, auth: getAuth(), notify: makeNotifier(db, getMessaging()) };
  }
  return deps;
}

function withVerifier() {
  return { ...dependencies(), verifyPassword: session.makePasswordVerifier({ apiKey: authApiKey.value() }) };
}

/** Hides unexpected errors: logged server-side, generic message to the app. */
async function safely(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    // Log only the code/message - never request data (it may hold passwords).
    logger.error(`${name} failed`, { code: e?.code, message: e?.message });
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
}

/** Signed-in callable. */
function callable(name, handler, { secrets = [], useVerifier = false } = {}) {
  return onCall({ enforceAppCheck: false, secrets }, async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Your session has ended. Please sign in again.');
    }
    return safely(name, () => handler(useVerifier ? withVerifier() : dependencies(), request.auth.uid, request.data));
  });
}

// Sign-in: the only callable open to signed-out callers. Brute force is
// limited per phone number (session.js) and by Firebase Auth itself.
export const signInWithPhonePassword = onCall({ enforceAppCheck: false, secrets: [authApiKey] },
  (request) => safely('signInWithPhonePassword', () => session.signInWithPhonePassword(withVerifier(), request.data)));

export const changeOwnPassword = callable('changeOwnPassword', session.changeOwnPassword,
  { secrets: [authApiKey], useVerifier: true });

export const createUser = callable('createUser', admin.createUser);
export const updateUserProfile = callable('updateUserProfile', admin.updateUserProfile);
export const changeUserPhone = callable('changeUserPhone', admin.changeUserPhone);
export const resetUserPassword = callable('resetUserPassword', admin.resetUserPassword);
export const setUserRole = callable('setUserRole', admin.setUserRole);
export const setUserActive = callable('setUserActive', admin.setUserActive);
export const setUserPermissions = callable('setUserPermissions', admin.setUserPermissions);
export const grantTemporaryPermission = callable('grantTemporaryPermission', admin.grantTemporaryPermission);
export const revokeTemporaryPermission = callable('revokeTemporaryPermission', admin.revokeTemporaryPermission);
export const linkStaff = callable('linkStaff', admin.linkStaff);

// Customers, vehicles, service catalogue and service intake (Phase 3).
export const createCustomer = callable('createCustomer', ops.createCustomer);
export const updateCustomer = callable('updateCustomer', ops.updateCustomer);
export const createVehicle = callable('createVehicle', ops.createVehicle);
export const updateVehicle = callable('updateVehicle', ops.updateVehicle);
export const createService = callable('createService', ops.createService);
export const updateService = callable('updateService', ops.updateService);

// Jobs and worker orders, billing and loyalty (Phase 4).
export const createServiceIntake = callable('createServiceIntake', jobs.createServiceIntake);
export const updateServiceIntake = callable('updateServiceIntake', jobs.updateServiceIntake);
export const assignWorkerOrder = callable('assignWorkerOrder', jobs.assignWorkerOrder);
export const reassignWorkerOrder = callable('reassignWorkerOrder', jobs.reassignWorkerOrder);
export const cancelWorkerOrder = callable('cancelWorkerOrder', jobs.cancelWorkerOrder);
export const updateWorkerOrderStatus = callable('updateWorkerOrderStatus', jobs.updateWorkerOrderStatus);
export const createInvoice = callable('createInvoice', billing.createInvoice);
export const applyInvoiceDiscount = callable('applyInvoiceDiscount', billing.applyInvoiceDiscount);
export const applyLoyaltyReward = callable('applyLoyaltyReward', billing.applyLoyaltyReward);
export const recordPayment = callable('recordPayment', billing.recordPayment);
export const reversePayment = callable('reversePayment', billing.reversePayment);
export const markInvoiceCredit = callable('markInvoiceCredit', billing.markInvoiceCredit);
export const cancelInvoice = callable('cancelInvoice', billing.cancelInvoice);
export const adjustLoyaltyPoints = callable('adjustLoyaltyPoints', loyalty.adjustLoyaltyPoints);
export const reverseLoyaltyTransaction = callable('reverseLoyaltyTransaction', loyalty.reverseLoyaltyTransaction);

// Finance, expenses and inventory (Phase 5).
export const ensureDefaultFinancialAccounts = callable('ensureDefaultFinancialAccounts', finance.ensureDefaultFinancialAccounts);
export const createFinancialAccount = callable('createFinancialAccount', finance.createFinancialAccount);
export const updateFinancialAccount = callable('updateFinancialAccount', finance.updateFinancialAccount);
export const recordOpeningBalance = callable('recordOpeningBalance', finance.recordOpeningBalance);
export const transferFunds = callable('transferFunds', finance.transferFunds);
export const recordBankDeposit = callable('recordBankDeposit', finance.recordBankDeposit);
export const reconcileAccount = callable('reconcileAccount', finance.reconcileAccount);
export const recordAccountAdjustment = callable('recordAccountAdjustment', finance.recordAccountAdjustment);
export const reverseFinancialTransaction = callable('reverseFinancialTransaction', finance.reverseFinancialTransaction);
export const createExpenseCategory = callable('createExpenseCategory', expenses.createExpenseCategory);
export const updateExpenseCategory = callable('updateExpenseCategory', expenses.updateExpenseCategory);
export const createExpense = callable('createExpense', expenses.createExpense);
export const updateExpense = callable('updateExpense', expenses.updateExpense);
export const updateExpenseStatus = callable('updateExpenseStatus', expenses.updateExpenseStatus);
export const payExpense = callable('payExpense', expenses.payExpense);
export const createRecurringExpense = callable('createRecurringExpense', expenses.createRecurringExpense);
export const updateRecurringExpense = callable('updateRecurringExpense', expenses.updateRecurringExpense);
export const createInventoryItem = callable('createInventoryItem', inventory.createInventoryItem);
export const updateInventoryItem = callable('updateInventoryItem', inventory.updateInventoryItem);
export const recordStockMovement = callable('recordStockMovement', inventory.recordStockMovement);
export const adjustStock = callable('adjustStock', inventory.adjustStock);
export const reverseStockMovement = callable('reverseStockMovement', inventory.reverseStockMovement);
export const createSupplier = callable('createSupplier', inventory.createSupplier);
export const updateSupplier = callable('updateSupplier', inventory.updateSupplier);
export const createPurchase = callable('createPurchase', inventory.createPurchase);
export const updatePurchaseStatus = callable('updatePurchaseStatus', inventory.updatePurchaseStatus);
export const receivePurchase = callable('receivePurchase', inventory.receivePurchase);
export const payPurchase = callable('payPurchase', inventory.payPurchase);

// Attendance, allowances, salary, payroll, losses and deductions (Phase 6).
export const updatePayrollPolicy = callable('updatePayrollPolicy', workforce.updatePayrollPolicy);
export const recordAttendance = callable('recordAttendance', attendance.recordAttendance);
export const clockOut = callable('clockOut', attendance.clockOut);
export const verifyAttendance = callable('verifyAttendance', attendance.verifyAttendance);
export const correctAttendance = callable('correctAttendance', attendance.correctAttendance);
export const calculateAllowances = callable('calculateAllowances', allowances.calculateAllowances);
export const reviewAllowance = callable('reviewAllowance', allowances.reviewAllowance);
export const payAllowances = callable('payAllowances', allowances.payAllowances);
export const reverseAllowancePayment = callable('reverseAllowancePayment', allowances.reverseAllowancePayment);
export const cancelAllowance = callable('cancelAllowance', allowances.cancelAllowance);
export const setSalaryProfile = callable('setSalaryProfile', payroll.setSalaryProfile);
export const createPayroll = callable('createPayroll', payroll.createPayroll);
export const preparePayroll = callable('preparePayroll', payroll.preparePayroll);
export const correctPayroll = callable('correctPayroll', payroll.correctPayroll);
export const addPayrollEarning = callable('addPayrollEarning', payroll.addPayrollEarning);
export const removePayrollEarning = callable('removePayrollEarning', payroll.removePayrollEarning);
export const updatePayrollStatus = callable('updatePayrollStatus', payroll.updatePayrollStatus);
export const payPayroll = callable('payPayroll', payroll.payPayroll);
export const reversePayrollPayment = callable('reversePayrollPayment', payroll.reversePayrollPayment);
export const lockPayroll = callable('lockPayroll', payroll.lockPayroll);
export const cancelPayroll = callable('cancelPayroll', payroll.cancelPayroll);
export const createLossIncident = callable('createLossIncident', losses.createLossIncident);
export const reviewLossIncident = callable('reviewLossIncident', losses.reviewLossIncident);
export const decideLossIncident = callable('decideLossIncident', losses.decideLossIncident);
export const scheduleLossRecovery = callable('scheduleLossRecovery', losses.scheduleLossRecovery);
export const cancelLossIncident = callable('cancelLossIncident', losses.cancelLossIncident);
export const createSalaryDeduction = callable('createSalaryDeduction', losses.createSalaryDeduction);
export const decideSalaryDeduction = callable('decideSalaryDeduction', losses.decideSalaryDeduction);
export const cancelSalaryDeduction = callable('cancelSalaryDeduction', losses.cancelSalaryDeduction);

// Recurring bills: creates due items (draft expenses) and reminders. Never pays.
export const sweepRecurringExpenses = onSchedule(
  { schedule: 'every day 06:00', timeZone: 'Africa/Kampala' },
  async () => {
    const result = await expenses.sweepRecurringExpenses(dependencies());
    logger.info('recurring expense sweep', result);
  },
);

export const sweepTemporaryGrants = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'Africa/Kampala' },
  async () => {
    const result = await admin.sweepTemporaryGrants(dependencies());
    logger.info('temporary grant sweep', result);
  },
);
