import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/core/services/callables.dart';
import 'package:ramosmax_auto_manager/features/billing/application/billing_providers.dart';
import 'package:ramosmax_auto_manager/features/billing/data/billing_api.dart';
import 'package:ramosmax_auto_manager/features/billing/presentation/payment_screens.dart' show receiptText;
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/features/jobs/application/jobs_providers.dart';
import 'package:ramosmax_auto_manager/models/invoice.dart';
import 'package:ramosmax_auto_manager/models/loyalty.dart';
import 'package:ramosmax_auto_manager/models/payment.dart';
import 'package:ramosmax_auto_manager/models/service_intake.dart';
import 'package:ramosmax_auto_manager/models/work_order.dart';

import '../support/fixtures.dart';

Map<String, dynamic> invoiceData({String status = 'unpaid', int subtotal = 35000, int discount = 0, int paid = 0, Map<String, dynamic>? discountMap}) => {
      'invoiceNumber': 'RMX-INV-000001',
      'serviceIntakeId': 'i1',
      'jobNumber': 'RMX-JOB-000001',
      'vehicleId': 'v1',
      'numberPlate': 'UGB 123A',
      'customerName': 'John Doe',
      'items': [
        {'serviceName': 'Full Wash', 'priceUgx': 15000, 'qualifiesForLoyalty': true},
        {'serviceName': 'Interior Cleaning', 'priceUgx': 20000, 'qualifiesForLoyalty': true},
      ],
      'subtotalUgx': subtotal,
      'discountUgx': discount,
      'totalUgx': subtotal - discount,
      'paidUgx': paid,
      'outstandingUgx': subtotal - discount - paid,
      'paymentStatus': status,
      'discount': ?discountMap,
      'issuedAt': Timestamp.fromDate(DateTime.utc(2026, 9, 1)),
    };

void main() {
  group('work orders', () {
    test('status keys round-trip; unknown values fall back safely', () {
      for (final s in WorkOrderStatus.values) {
        expect(WorkOrderStatus.parse(s.key), s);
      }
      expect(WorkOrderStatus.parse('nonsense'), WorkOrderStatus.pending);
    });

    test('each status offers exactly the worker actions the server allows', () {
      expect(WorkerAction.availableFor(WorkOrderStatus.assigned), [WorkerAction.accept]);
      expect(WorkerAction.availableFor(WorkOrderStatus.accepted), [WorkerAction.start]);
      expect(WorkerAction.availableFor(WorkOrderStatus.inProgress), [WorkerAction.pause, WorkerAction.complete]);
      expect(WorkerAction.availableFor(WorkOrderStatus.paused), [WorkerAction.resume]);
      for (final s in [WorkOrderStatus.pending, WorkOrderStatus.completed, WorkOrderStatus.cancelled]) {
        expect(WorkerAction.availableFor(s), isEmpty, reason: s.key);
      }
    });

    test('worked time excludes pauses and stops at completion', () {
      final start = DateTime.utc(2026, 9, 21, 8);
      final o = WorkOrder.fromFirestore('o1', {
        'status': 'completed',
        'startedAt': Timestamp.fromDate(start),
        'completedAt': Timestamp.fromDate(start.add(const Duration(minutes: 30))),
        'totalPausedMs': const Duration(minutes: 5).inMilliseconds,
        'assignmentHistory': [
          {'workerId': 'w1', 'workerName': 'Wendy', 'reason': 'Went home'},
          {'workerId': 'w2', 'workerName': 'Walter'},
        ],
      });
      expect(o.workedTime(start.add(const Duration(hours: 5))), const Duration(minutes: 25));
      expect(o.assignmentHistory.map((h) => h.workerName), ['Wendy', 'Walter']);
      expect(o.assignmentHistory.first.reason, 'Went home');
    });

    test('a job parses its number, order summary and invoice link', () {
      final job = ServiceIntake.fromFirestore('i1', {
        'jobNumber': 'RMX-JOB-000001',
        'numberPlate': 'UGB 123A',
        'status': 'completed',
        'orders': [
          {'workerOrderId': 'o1', 'orderNumber': 'RMX-JOB-000001/1', 'serviceName': 'Wash', 'status': 'completed', 'workerName': 'Wendy'},
          {'workerOrderId': 'o2', 'orderNumber': 'RMX-JOB-000001/2', 'serviceName': 'Wax', 'status': 'cancelled'},
        ],
        'invoiceId': null,
      });
      expect(job.status, IntakeStatus.completed);
      expect((job.completedOrders, job.liveOrders), (1, 1));
      expect(job.awaitingInvoice, isTrue);
      expect(jobMatches(job, 'ugb123a'), isTrue);
      expect(jobMatches(job, 'JOB-000001'), isTrue);
      expect(jobMatches(job, 'wendy'), isTrue);
      expect(jobMatches(job, 'UAX'), isFalse);
      expect(jobMatches(job, '  '), isTrue);
    });
  });

  group('invoices and discounts', () {
    test('amounts are whole shillings and consistent', () {
      final i = Invoice.fromFirestore('inv1', invoiceData(paid: 10000));
      expect(i.subtotal, const Money(35000));
      expect(i.total, const Money(35000));
      expect(i.outstanding, const Money(25000));
      expect(i.items.map((x) => x.price.ugx), [15000, 20000]);
      expect(i.canPay, isTrue);
      expect(i.canDiscount, isFalse, reason: 'no discount after a payment');
      expect(i.canCancel, isFalse, reason: 'reverse payments first');
    });

    test('status parsing and which statuses count as owed', () {
      for (final s in PaymentStatus.values) {
        expect(PaymentStatus.parse(s.key), s);
      }
      expect(PaymentStatus.outstanding.every((s) => s.isOutstanding), isTrue);
      expect(PaymentStatus.paid.isOutstanding, isFalse);
      expect(PaymentStatus.cancelled.isOutstanding, isFalse);
    });

    test('discount preview matches the server formula and refuses invalid values', () {
      const sub = Money(35000);
      expect(previewDiscount(sub, DiscountType.percentage, 10), const Money(3500));
      expect(previewDiscount(sub, DiscountType.percentage, 100), sub);
      expect(previewDiscount(sub, DiscountType.percentage, 101), isNull);
      expect(previewDiscount(sub, DiscountType.fixed, 35000), sub);
      expect(previewDiscount(sub, DiscountType.fixed, 35001), isNull, reason: 'never a negative total');
      expect(previewDiscount(sub, DiscountType.fixed, 0), isNull);
      // Half-up rounding, as in functions/src/billing.js percentOf().
      expect(percentOf(const Money(15002), 25), const Money(3751));
      expect(percentOf(const Money(15001), 25), const Money(3750));
    });

    test('a stored discount keeps who, why and how much', () {
      final i = Invoice.fromFirestore('inv1', invoiceData(discount: 3500, discountMap: {
        'discountType': 'percentage', 'discountValue': 10, 'discountAmount': 3500, 'reasonCode': 'other',
        'reason': 'Regular customer', 'approvedBy': 'mgr', 'createdBy': 'mgr',
      }));
      expect(i.discount!.amount, const Money(3500));
      expect(i.discount!.label, '10% · Regular customer');
      expect(i.discount!.approvedBy, 'mgr');
      expect(i.total, const Money(31500));
      expect(DiscountReason.manual, isNot(contains(DiscountReason.loyaltyReward)));
    });

    test('credit summary: totals and debt-age buckets', () {
      final now = DateTime.utc(2026, 9, 21, 12);
      Invoice owed(int days, int ugx, {String status = 'unpaid'}) => Invoice.fromFirestore('x$days', {
            ...invoiceData(subtotal: ugx, status: status),
            'issuedAt': Timestamp.fromDate(now.subtract(Duration(days: days, hours: 1))),
          });
      final s = CreditSummary.of([owed(0, 1000), owed(3, 2000), owed(10, 4000, status: 'credit'), owed(60, 8000),
        owed(1, 9999, status: 'paid')], now);
      expect(s.total, const Money(15000));
      expect(s.count, 4);
      expect(s.byAge[DebtAge.today], const Money(1000));
      expect(s.byAge[DebtAge.week], const Money(2000));
      expect(s.byAge[DebtAge.month], const Money(4000));
      expect(s.byAge[DebtAge.older], const Money(8000));
    });
  });

  group('payments and receipts', () {
    test('methods map to their Phase 5 accounts; mobile money and bank need a reference', () {
      expect(PaymentMethod.values.map((m) => m.key), ['cash', 'mtn_merchant', 'airtel_merchant', 'bank']);
      expect(PaymentMethod.cash.accountKey, 'cash_at_hand');
      expect(PaymentMethod.cash.needsReference, isFalse);
      expect([PaymentMethod.mtnMerchant, PaymentMethod.airtelMerchant, PaymentMethod.bank].every((m) => m.needsReference), isTrue);
    });

    test('the payment request carries an amount and an idempotency key, never a balance', () {
      final json = PaymentRequest(invoiceId: 'inv1', amount: const Money(5000), method: PaymentMethod.mtnMerchant,
          requestId: newRequestId(), reference: 'MP123').toJson();
      expect(json.keys.toSet(), {'invoiceId', 'amountUgx', 'method', 'requestId', 'reference'});
      expect(json['amountUgx'], 5000);
      expect(json['requestId'], matches(RegExp(r'^[A-Za-z0-9]{24}$')));
      expect(newRequestId(), isNot(newRequestId()));
    });

    test('shared receipt text is a faithful snapshot', () {
      final r = Receipt.fromFirestore('r1', {
        'receiptNumber': 'RMX-RCP-000001', 'invoiceNumber': 'RMX-INV-000001', 'numberPlate': 'UGB 123A',
        'items': [{'serviceName': 'Full Wash', 'priceUgx': 15000}],
        'subtotalUgx': 15000, 'discountUgx': 0, 'totalUgx': 15000, 'amountPaidUgx': 15000, 'totalPaidUgx': 15000,
        'outstandingUgx': 0, 'method': 'mtn_merchant', 'reference': 'MP1', 'loyaltyPointsEarned': 20, 'loyaltyPointsBalance': 40,
        'status': 'issued',
      });
      final text = receiptText(r);
      expect(text, contains('RamosMAX Automotive Care (U) Ltd'));
      expect(text, contains('RECEIPT RMX-RCP-000001'));
      expect(text, contains('Paid now: UGX 15,000 (MTN Merchant MP1)'));
      expect(text, contains('Balance: UGX 0'));
      expect(text, contains('Loyalty points earned: 20'));
      expect(text, isNot(contains('REVERSED')));
    });
  });

  group('loyalty', () {
    test('defaults: 20 per service, 25% at 200, costs 200; overrides are bounded', () {
      const d = LoyaltyConfig.defaults;
      expect((d.pointsPerQualifyingService, d.rewardThreshold, d.rewardDiscountPercent, d.pointsConsumedOnRedemption), (20, 200, 25, 200));
      final c = LoyaltyConfig.fromMap({'rewardThreshold': 100, 'rewardDiscountPercent': 500, 'pointsPerQualifyingService': -3});
      expect(c.rewardThreshold, 100);
      expect(c.rewardDiscountPercent, 100);
      expect(c.pointsPerQualifyingService, 20);
      expect(d.pointsToNextReward(160), 40);
      expect(d.pointsToNextReward(260), 0);
    });

    test('the reward preview uses the same rounding as the server', () {
      final reward = LoyaltyReward.fromFirestore('rw1', {'vehicleId': 'v1', 'discountPercent': 25, 'pointsCost': 200, 'status': 'available'});
      expect(reward.isAvailable, isTrue);
      expect(reward.previewFor(const Money(35000)), const Money(8750));
      expect(reward.previewFor(const Money(15002)), const Money(3751));
    });

    test('ledger entries: only earned, adjustment and expiry entries can be reversed', () {
      expect(LoyaltyTransactionType.values.where((t) => t.isReversible).toList(),
          [LoyaltyTransactionType.earned, LoyaltyTransactionType.adjustment, LoyaltyTransactionType.expiry]);
      final t = LoyaltyTransaction.fromFirestore('t1', {'vehicleId': 'v1', 'type': 'redeemed', 'points': -200, 'balanceBefore': 210, 'balanceAfter': 10});
      expect(t.signedPoints, '-200');
      expect(t.balanceAfter - t.balanceBefore, t.points);
    });
  });

  group('permissions and menus (Phase 4)', () {
    final now = DateTime.utc(2026, 9, 21);

    test('cashiers redeem rewards but apply discounts only when granted', () {
      expect(RolePermissions.forRole(UserRole.cashier), contains(Permission.loyaltyRedeem));
      expect(RolePermissions.forRole(UserRole.cashier), isNot(contains(Permission.discountsApply)));
      expect(RolePermissions.forRole(UserRole.manager), containsAll([Permission.discountsApply, Permission.discountsApprove, Permission.loyaltyRedeem]));
      expect(RolePermissions.forRole(UserRole.worker), isNot(contains(Permission.discountsApply)));
      final granted = testUser(role: UserRole.cashier, permissions: {Permission.discountsApply});
      expect(granted.can(Permission.discountsApply, now), isTrue);
    });

    test('auditors stay read-only for jobs, billing and loyalty', () {
      final a = RolePermissions.forRole(UserRole.auditor);
      expect(a, containsAll([Permission.jobsView, Permission.invoicesView, Permission.paymentsView, Permission.creditView, Permission.loyaltyView]));
      for (final p in [Permission.jobsAssign, Permission.jobsComplete, Permission.invoicesCreate, Permission.paymentsRecord,
        Permission.paymentsReverse, Permission.discountsApply, Permission.creditManage, Permission.loyaltyRedeem, Permission.loyaltyAdjust]) {
        expect(a, isNot(contains(p)), reason: p.key);
      }
    });

    test('menus: workers get My Jobs; billing roles get invoices, payments, receipts, credit and loyalty', () {
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.worker), now), contains(AppModule.myJobs));
      expect(AppModule.myJobs.available && AppModule.invoices.available && AppModule.loyalty.available, isTrue);
      for (final role in [UserRole.cashier, UserRole.manager, UserRole.admin, UserRole.auditor]) {
        expect(RoleNavigation.modulesFor(testUser(role: role), now),
            containsAll([AppModule.invoices, AppModule.payments, AppModule.receipts, AppModule.credit, AppModule.loyalty]), reason: role.key);
      }
      final worker = RoleNavigation.modulesFor(testUser(role: UserRole.worker), now);
      for (final m in [AppModule.invoices, AppModule.payments, AppModule.credit, AppModule.loyalty, AppModule.jobs]) {
        expect(worker, isNot(contains(m)), reason: m.key);
      }
    });
  });
}
