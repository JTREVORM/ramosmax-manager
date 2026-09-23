import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/access_policy.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/core/errors/error_mapper.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/features/users/application/user_filter.dart';
import 'package:ramosmax_auto_manager/models/app_user.dart';
import 'package:ramosmax_auto_manager/models/temporary_grant.dart';

import '../support/fixtures.dart';

void main() {
  final now = DateTime.utc(2026, 9, 21, 12);

  final admin = testUser(uid: 'admin', role: UserRole.admin, fullName: 'Ada Admin');
  final admin2 = testUser(uid: 'admin2', role: UserRole.admin, fullName: 'Abe Admin');
  final manager = testUser(uid: 'mgr', role: UserRole.manager, fullName: 'Mary Manager');
  final cashier = testUser(uid: 'cash', role: UserRole.cashier, fullName: 'Carl Cashier');
  final worker = testUser(uid: 'wkr', role: UserRole.worker, fullName: 'Walt Worker');
  final auditor = testUser(uid: 'aud', role: UserRole.auditor, fullName: 'Audrey Auditor');
  final shareholder = testUser(uid: 'sh', role: UserRole.shareholder, fullName: 'Sam Holder');

  group('AccessPolicy — admin', () {
    test('can take every action on other users, including other admins', () {
      for (final a in UserAdminAction.values) {
        if (a == UserAdminAction.activate) continue; // targets are active
        expect(AccessPolicy.can(admin, a, worker, now), isTrue, reason: a.name);
        expect(AccessPolicy.can(admin, a, admin2, now), isTrue, reason: a.name);
      }
      expect(AccessPolicy.can(admin, UserAdminAction.activate, testUser(active: false), now), isTrue);
      expect(AccessPolicy.canCreateUsers(admin, now), isTrue);
    });

    test('can assign every role', () {
      expect(AccessPolicy.assignableRoles(admin), UserRole.values);
    });

    test('cannot change own role, permissions or status (self-escalation)', () {
      for (final a in [
        UserAdminAction.changeRole,
        UserAdminAction.managePermissions,
        UserAdminAction.grantTemporary,
        UserAdminAction.deactivate,
        UserAdminAction.linkStaff,
      ]) {
        expect(AccessPolicy.can(admin, a, admin, now), isFalse, reason: a.name);
      }
      expect(AccessPolicy.can(admin, UserAdminAction.editProfile, admin, now), isTrue);
    });

    test('keeps user-management access: users.* cannot be denied to an admin', () {
      expect(AccessPolicy.canDeny(UserRole.admin, Permission.usersView), isFalse);
      expect(AccessPolicy.canDeny(UserRole.admin, Permission.payrollApprove), isTrue);
      expect(AccessPolicy.canDeny(UserRole.worker, Permission.usersView), isTrue);
    });
  });

  group('AccessPolicy — manager', () {
    test('can view users and grant temporary access to cashiers and workers only', () {
      expect(manager.can(Permission.usersView, now), isTrue);
      expect(AccessPolicy.can(manager, UserAdminAction.grantTemporary, worker, now), isTrue);
      expect(AccessPolicy.can(manager, UserAdminAction.grantTemporary, cashier, now), isTrue);
      expect(AccessPolicy.can(manager, UserAdminAction.grantTemporary, admin, now), isFalse);
      expect(AccessPolicy.can(manager, UserAdminAction.grantTemporary, auditor, now), isFalse);
      expect(AccessPolicy.can(manager, UserAdminAction.grantTemporary, testUser(uid: 'm2', role: UserRole.manager), now), isFalse);
    });

    test('cannot create users, change roles, deactivate or manage admin accounts', () {
      expect(AccessPolicy.canCreateUsers(manager, now), isFalse);
      for (final a in [UserAdminAction.changeRole, UserAdminAction.deactivate, UserAdminAction.managePermissions, UserAdminAction.editProfile]) {
        expect(AccessPolicy.can(manager, a, worker, now), isFalse, reason: a.name);
        expect(AccessPolicy.can(manager, a, admin, now), isFalse, reason: a.name);
      }
    });

    test('never assigns Admin, even with an explicit role-management grant', () {
      final empowered = testUser(uid: 'mgr', role: UserRole.manager, permissions: {Permission.usersRolesManage});
      expect(AccessPolicy.assignableRoles(empowered), [UserRole.cashier, UserRole.worker]);
      expect(AccessPolicy.can(empowered, UserAdminAction.changeRole, worker, now), isTrue);
      expect(AccessPolicy.can(empowered, UserAdminAction.changeRole, admin, now), isFalse);
    });

    test('can only hand out permissions they hold, never admin-only ones', () {
      expect(AccessPolicy.canGrant(manager, Permission.paymentsRecord, now), isTrue);
      expect(AccessPolicy.canGrant(manager, Permission.payrollApprove, now), isFalse);
      expect(AccessPolicy.canGrant(manager, Permission.usersPermissionsTemporary, now), isFalse);
      expect(AccessPolicy.canGrant(manager, Permission.settingsManage, now), isFalse);
    });
  });

  group('AccessPolicy — cashier, worker, auditor, shareholder', () {
    for (final (name, user) in [('cashier', cashier), ('worker', worker), ('auditor', auditor), ('shareholder', shareholder)]) {
      test('$name cannot manage users or roles', () {
        expect(AccessPolicy.canCreateUsers(user, now), isFalse);
        for (final a in UserAdminAction.values) {
          expect(AccessPolicy.can(user, a, worker, now), isFalse, reason: a.name);
          expect(AccessPolicy.can(user, a, user, now), isFalse, reason: 'self ${a.name}');
        }
        expect(AccessPolicy.grantablePermissions(user, now).where((p) => p.isAdminOnly), isEmpty);
      });
    }

    test('auditor can view users (read-only), worker, cashier and shareholder cannot', () {
      expect(auditor.can(Permission.usersView, now), isTrue);
      expect(RolePermissions.forRole(UserRole.auditor).every((p) => p.isReadOnly), isTrue);
      expect(worker.can(Permission.usersView, now), isFalse);
      expect(cashier.can(Permission.usersView, now), isFalse);
      expect(shareholder.can(Permission.usersView, now), isFalse);
    });

    test('User Management appears only for roles that can view users', () {
      expect(RoleNavigation.modulesFor(admin, now), contains(AppModule.users));
      expect(RoleNavigation.modulesFor(manager, now), contains(AppModule.users));
      expect(RoleNavigation.modulesFor(auditor, now), contains(AppModule.users));
      for (final u in [cashier, worker, shareholder]) {
        expect(RoleNavigation.modulesFor(u, now), isNot(contains(AppModule.users)));
      }
      final denied = testUser(uid: 'mgr', role: UserRole.manager, denied: {Permission.usersView});
      expect(RoleNavigation.modulesFor(denied, now), isNot(contains(AppModule.users)));
    });

    test('role change is reflected immediately in access and navigation', () {
      final promoted = testUser(uid: 'wkr', role: UserRole.manager);
      expect(worker.can(Permission.paymentsRecord, now), isFalse);
      expect(promoted.can(Permission.paymentsRecord, now), isTrue);
      expect(RoleNavigation.modulesFor(promoted, now), contains(AppModule.payments));
    });
  });

  group('temporary windows', () {
    test('scheduled grants are not effective until they start', () {
      final user = testUser(temporaryWindows: {
        Permission.paymentsRecord: TemporaryWindow(
          startsAt: now.add(const Duration(hours: 6)),
          expiresAt: now.add(const Duration(hours: 10)),
        ),
      });
      expect(user.can(Permission.paymentsRecord, now), isFalse);
      expect(user.can(Permission.paymentsRecord, now.add(const Duration(hours: 7))), isTrue);
      expect(user.can(Permission.paymentsRecord, now.add(const Duration(hours: 10))), isFalse);
    });

    test('expired temporary permission grants nothing', () {
      final user = testUser(temporary: {Permission.paymentsRecord: now.subtract(const Duration(minutes: 1))});
      expect(user.can(Permission.paymentsRecord, now), isFalse);
      expect(user.activeTemporaryPermissions(now), isEmpty);
    });

    test('Phase 1 (bare expiry) and Phase 2 (window map) formats both parse', () {
      final user = AppUser.fromFirestore('u1', {
        'phoneNumber': testPhone,
        'role': 'worker',
        'active': true,
        'temporaryPermissions': {
          'payments.record': Timestamp.fromDate(now.add(const Duration(hours: 1))),
          'invoices.create': {
            'startsAt': Timestamp.fromDate(now.subtract(const Duration(hours: 1))),
            'expiresAt': Timestamp.fromDate(now.add(const Duration(hours: 1))),
            'grantId': 'g1',
          },
        },
      })!;
      expect(user.activeTemporaryPermissions(now), {Permission.paymentsRecord, Permission.invoicesCreate});
      expect(user.temporaryPermissions[Permission.invoicesCreate]!.grantId, 'g1');
    });

    test('window validation mirrors the server', () {
      expect(AccessPolicy.validateTemporaryWindow(now, now.add(const Duration(hours: 4)), now), isNull);
      expect(AccessPolicy.validateTemporaryWindow(now, now, now), contains('after the start'));
      expect(AccessPolicy.validateTemporaryWindow(now.add(const Duration(hours: 2)), now.add(const Duration(hours: 1)), now),
          contains('after the start'));
      expect(AccessPolicy.validateTemporaryWindow(now.subtract(const Duration(hours: 1)), now.add(const Duration(hours: 1)), now),
          contains('past'));
      expect(AccessPolicy.validateTemporaryWindow(now, now.add(const Duration(days: 31)), now), contains('30 days'));
    });

    test('grant record status is derived from the clock', () {
      TemporaryGrant grant(String status, DateTime start, DateTime end) => TemporaryGrant(
            id: 'g', permission: Permission.paymentsRecord, startsAt: start, expiresAt: end, storedStatus: status);
      final later = now.add(const Duration(hours: 2));
      expect(grant('active', now.subtract(const Duration(hours: 1)), later).statusAt(now), TemporaryGrantStatus.active);
      expect(grant('active', later, later.add(const Duration(hours: 1))).statusAt(now), TemporaryGrantStatus.scheduled);
      expect(grant('active', now.subtract(const Duration(hours: 3)), now).statusAt(now), TemporaryGrantStatus.expired);
      expect(grant('revoked', now, later).statusAt(now), TemporaryGrantStatus.revoked);
      expect(grant('revoked', now, later).isCurrent(now), isFalse);
    });
  });

  group('UserSearch', () {
    final users = [
      testUser(uid: '1', fullName: 'Jane Washer', phone: '+256772123456', staffId: 'RMX-STF-0001'),
      testUser(uid: '2', fullName: 'John Polisher', phone: '+256701234567', staffId: 'RMX-STF-0002', active: false),
      testUser(uid: '3', fullName: 'Carl Cashier', phone: '+256752000111', role: UserRole.cashier),
      testUser(uid: '4', fullName: 'Ada Admin', phone: '+254712345678', role: UserRole.admin),
    ];
    List<String> ids(UserListFilter f, String q) => UserSearch.apply(users, f, q).map((u) => u.uid).toList();

    test('search by name, case-insensitive', () => expect(ids(UserListFilter.all, 'jOHN'), ['2']));
    test('search by staff ID', () => expect(ids(UserListFilter.all, 'stf-0001'), ['1']));
    test('search by phone in local, national and international form', () {
      expect(ids(UserListFilter.all, '0772 123'), ['1']);
      expect(ids(UserListFilter.all, '701234'), ['2']);
      expect(ids(UserListFilter.all, '+254712'), ['4']);
    });
    test('filters', () {
      expect(ids(UserListFilter.all, ''), ['1', '2', '3', '4']);
      expect(ids(UserListFilter.active, ''), ['1', '3', '4']);
      expect(ids(UserListFilter.inactive, ''), ['2']);
      expect(ids(UserListFilter.cashier, ''), ['3']);
      expect(ids(UserListFilter.admin, ''), ['4']);
      expect(ids(UserListFilter.worker, 'jane'), ['1']);
      expect(ids(UserListFilter.manager, ''), isEmpty);
    });
  });

  group('Cloud Function errors', () {
    test('our deliberate errors show the server message and keep the reason', () {
      final f = ErrorMapper.functions('failed-precondition',
          'RamosMAX must always have at least one active Administrator.', {'reason': 'last_admin'});
      expect(f.kind, FailureKind.conflict);
      expect(f.code, 'last_admin');
      expect(f.message, contains('at least one active Administrator'));
      expect(ErrorMapper.functions('already-exists', 'Staff ID X is already linked.', {'reason': 'staff_linked'}).kind,
          FailureKind.alreadyExists);
    });

    test('platform/internal errors never leak their text', () {
      final f = ErrorMapper.functions('internal', 'INTERNAL: stack trace at line 42', null);
      expect(f.message, 'Something went wrong. Please try again.');
      expect(ErrorMapper.functions('permission-denied', 'Missing or insufficient permissions.', null).message,
          'You do not have permission to do this.');
    });
  });

  group('access catalogue: Dart ↔ Cloud Functions', () {
    final catalog = jsonDecode(File('functions/src/access_catalog.json').readAsStringSync()) as Map<String, dynamic>;

    test('every permission key matches', () {
      expect((catalog['permissions'] as List).cast<String>().toSet(), Permission.values.map((p) => p.key).toSet());
    });

    test('role matrices match', () {
      final roles = catalog['roles'] as Map<String, dynamic>;
      expect(roles['admin'], '*');
      for (final role in UserRole.values.where((r) => r != UserRole.admin)) {
        expect((roles[role.key] as List).cast<String>().toSet(), RolePermissions.forRole(role).map((p) => p.key).toSet(),
            reason: role.key);
      }
    });

    test('ranks, admin-only permissions and specialisations match', () {
      final ranks = catalog['roleRanks'] as Map<String, dynamic>;
      for (final r in UserRole.values) {
        expect(ranks[r.key], r.rank, reason: r.key);
      }
      expect((catalog['adminOnlyPermissions'] as List).cast<String>().toSet(),
          Permission.values.where((p) => p.isAdminOnly).map((p) => p.key).toSet());
      expect((catalog['specializations'] as List).cast<String>().toSet(),
          WorkerSpecialization.values.map((s) => s.key).toSet());
    });
  });
}
