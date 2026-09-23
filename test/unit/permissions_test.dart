import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/models/app_user.dart';

import '../support/fixtures.dart';

void main() {
  final now = DateTime.utc(2026, 9, 21, 12);

  group('role detection from Firestore', () {
    test('parses every role key', () {
      for (final role in UserRole.values) {
        final user = AppUser.fromFirestore('u1', {'phoneNumber': '+256772123456', 'role': role.key, 'active': true});
        expect(user?.role, role);
      }
    });

    test('unknown or missing role yields no profile (fail closed)', () {
      expect(AppUser.fromFirestore('u1', {'phoneNumber': '+256772123456', 'role': 'superuser', 'active': true}), isNull);
      expect(AppUser.fromFirestore('u1', {'phoneNumber': '+256772123456', 'active': true}), isNull);
    });

    test('active must be literally true', () {
      final user = AppUser.fromFirestore('u1', {'phoneNumber': '+256772123456', 'role': 'worker', 'active': 'yes'});
      expect(user!.active, isFalse);
    });

    test('worker specialisation is metadata, not a role', () {
      final user = AppUser.fromFirestore('u1', {
        'phoneNumber': '+256772123456', 'role': 'worker', 'active': true, 'specialization': 'mechanic',
      })!;
      expect(user.role, UserRole.worker);
      expect(user.specialization, WorkerSpecialization.mechanic);
    });
  });

  group('effective permissions', () {
    test('admin holds every permission', () {
      expect(testUser(role: UserRole.admin).effectivePermissions(now), Permission.values.toSet());
    });

    test('auditor is strictly read-only', () {
      final perms = testUser(role: UserRole.auditor).effectivePermissions(now);
      expect(perms.every((p) => p.isReadOnly), isTrue, reason: perms.where((p) => !p.isReadOnly).toString());
    });

    test('cashier does not get payroll', () {
      final perms = testUser(role: UserRole.cashier).effectivePermissions(now);
      expect(perms.intersection({Permission.payrollView, Permission.payrollProcess, Permission.staffSalaryView}), isEmpty);
    });

    test('worker only sees their own jobs, attendance and allowances', () {
      final perms = testUser(role: UserRole.worker).effectivePermissions(now);
      expect(perms, contains(Permission.jobsViewOwn));
      expect(perms, isNot(contains(Permission.jobsView)));
      expect(perms, isNot(contains(Permission.staffView)));
      expect(perms, isNot(contains(Permission.attendanceView)));
    });

    test('direct grants add and denials remove', () {
      final user = testUser(
        role: UserRole.cashier,
        permissions: {Permission.expensesCreate},
        denied: {Permission.creditManage},
      );
      final perms = user.effectivePermissions(now);
      expect(perms, contains(Permission.expensesCreate));
      expect(perms, isNot(contains(Permission.creditManage)));
    });

    test('temporary permissions apply until expiry, then lapse automatically', () {
      final user = testUser(
        role: UserRole.worker,
        temporary: {Permission.paymentsRecord: now.add(const Duration(hours: 2))},
      );
      expect(user.can(Permission.paymentsRecord, now), isTrue);
      expect(user.can(Permission.paymentsRecord, now.add(const Duration(hours: 2))), isFalse);
    });

    test('a denial beats a temporary grant', () {
      final user = testUser(
        role: UserRole.worker,
        denied: {Permission.paymentsRecord},
        temporary: {Permission.paymentsRecord: now.add(const Duration(hours: 1))},
      );
      expect(user.can(Permission.paymentsRecord, now), isFalse);
    });

    test('inactive or expired accounts have no permissions', () {
      expect(testUser(role: UserRole.admin, active: false).effectivePermissions(now), isEmpty);
      expect(testUser(role: UserRole.admin, accessExpiresAt: now).effectivePermissions(now), isEmpty);
    });

    test('temporary grants round-trip through Firestore maps', () {
      final expiry = now.add(const Duration(hours: 3));
      final user = AppUser.fromFirestore('u1', {
        'phoneNumber': '+256772123456',
        'role': 'worker',
        'active': true,
        'temporaryPermissions': {'payments.record': Timestamp.fromDate(expiry), 'bogus.permission': Timestamp.fromDate(expiry)},
        'permissions': ['expenses.view', 'not.real'],
      })!;
      expect(user.temporaryPermissions.keys, [Permission.paymentsRecord]);
      expect(user.permissions, {Permission.expensesView});
    });
  });

  group('role navigation', () {
    test('each role sees its own menu', () {
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.worker), now),
          [AppModule.dashboard, AppModule.myJobs, AppModule.vehicles, AppModule.services,
            AppModule.attendance, AppModule.allowances, AppModule.myAfterHours, AppModule.myProfile]);
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.cashier), now), contains(AppModule.invoices));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.cashier), now), isNot(contains(AppModule.payroll)));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.auditor), now), contains(AppModule.auditLogs));
      expect(RoleNavigation.modulesFor(testUser(role: UserRole.admin), now), contains(AppModule.users));
    });

    test('denying a permission removes the module from the menu', () {
      final user = testUser(role: UserRole.cashier, denied: {Permission.creditView});
      expect(RoleNavigation.modulesFor(user, now), isNot(contains(AppModule.credit)));
    });
  });

  group('rules ↔ Dart permission matrix', () {
    // Fails if firebase/firestore.rules and RolePermissions drift apart.
    final rules = File('firebase/firestore.rules').readAsStringSync();

    Set<String> rulesListFor(String function) {
      final match = RegExp('function $function\\(\\) \\{\\s*return \\[(.*?)\\];', dotAll: true).firstMatch(rules);
      expect(match, isNotNull, reason: 'function $function not found in rules');
      return RegExp(r"'([a-z_.]+)'").allMatches(match!.group(1)!).map((m) => m.group(1)!).toSet();
    }

    for (final (role, fn) in [
      (UserRole.manager, 'managerPermissions'),
      (UserRole.cashier, 'cashierPermissions'),
      (UserRole.worker, 'workerPermissions'),
      (UserRole.shareholder, 'shareholderPermissions'),
      (UserRole.auditor, 'auditorPermissions'),
    ]) {
      test('${role.key} matches', () {
        expect(rulesListFor(fn), RolePermissions.forRole(role).map((p) => p.key).toSet());
      });
    }

    test('rules never contain an allow-all', () {
      expect(rules.contains('if true'), isFalse);
      expect(File('firebase/storage.rules').readAsStringSync().contains('if true'), isFalse);
    });
  });
}
