import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ramosmax_auto_manager/core/auth/permissions.dart';
import 'package:ramosmax_auto_manager/core/auth/user_role.dart';
import 'package:ramosmax_auto_manager/core/money/money.dart';
import 'package:ramosmax_auto_manager/core/utils/number_plates.dart';
import 'package:ramosmax_auto_manager/core/utils/phone_number.dart';
import 'package:ramosmax_auto_manager/features/dashboard/application/role_navigation.dart';
import 'package:ramosmax_auto_manager/features/operations/application/customer_search.dart';
import 'package:ramosmax_auto_manager/features/operations/data/operations_repository.dart';
import 'package:ramosmax_auto_manager/features/operations/presentation/intake_screens.dart' show groupActive;
import 'package:ramosmax_auto_manager/features/operations/presentation/service_screens.dart' show filterServices, priceValidator;
import 'package:ramosmax_auto_manager/models/catalog_service.dart';
import 'package:ramosmax_auto_manager/models/customer.dart';
import 'package:ramosmax_auto_manager/models/service_intake.dart';
import 'package:ramosmax_auto_manager/models/vehicle.dart';

import '../support/fixtures.dart';

CatalogService svc(String id, String name, ServiceCategory c, int price, {bool active = true, bool loyalty = false}) =>
    CatalogService(serviceId: id, name: name, category: c, price: Money(price), isActive: active, qualifiesForLoyalty: loyalty);

void main() {
  final now = DateTime.utc(2026, 9, 21, 12);

  group('number plates', () {
    test('input variations share one display form and one key (same cases as functions/src/plates.js)', () {
      for (final input in ['UGB 123A', 'UGB123A', 'ugb 123a', 'UGB-123A', '  ugb  123a ']) {
        final p = NumberPlates.parse(input);
        expect(p?.display, 'UGB 123A', reason: input);
        expect(p?.key, 'UGB123A', reason: input);
      }
      expect(NumberPlates.parse('ug 1234')?.display, 'UG 1234');
      expect(NumberPlates.key('CD 123 45'), 'CD12345');
      for (final bad in ['', 'ABC 123A', '123 UBA', 'UBA 12', 'UBA 12345']) {
        expect(NumberPlates.parse(bad), isNull, reason: bad);
      }
    });

    test('partial input still yields a search key', () {
      expect(NumberPlates.key('ugb 1'), 'UGB1');
      expect(NumberPlates.key(''), '');
    });

    test('the server uses the same plate patterns', () {
      final js = File('functions/src/plates.js').readAsStringSync();
      for (final pattern in [r'/^U[A-Z]{2} \d{3}[A-Z]?$/', r'/^(UG|UP|UPDF|UPF|UA) \d{3,4}[A-Z]?$/', r'/^(CD|UN|DC) \d{2,3} \d{2,3}$/']) {
        expect(js, contains(pattern));
      }
    });
  });

  group('phone numbers for customers', () {
    test('Ugandan forms normalise to E.164; other countries need the full + form', () {
      for (final input in ['0772123456', '0772 123 456', '772123456', '+256772123456', '256 772 123 456']) {
        expect(PhoneNumbers.normalize(input), '+256772123456', reason: input);
      }
      expect(PhoneNumbers.normalize('+254712345678'), '+254712345678');
      expect(PhoneNumbers.normalize('12345'), isNull);
      expect(PhoneNumbers.normalize('+2567721'), isNull);
    });
  });

  group('customer search parsing', () {
    test('phone in any format → the stored E.164 form', () {
      expect(CustomerQuery.parse('0772123456'), isA<PhoneQuery>().having((q) => q.e164, 'e164', '+256772123456'));
      expect(CustomerQuery.parse('+256 772 123 456'), isA<PhoneQuery>().having((q) => q.e164, 'e164', '+256772123456'));
      expect(CustomerQuery.parse('0772'), isA<IncompletePhone>());
    });

    test('customer ID', () {
      expect(CustomerQuery.parse('RMX-CUS-000012'), isA<CustomerNumberQuery>().having((q) => q.customerNumber, 'n', 'RMX-CUS-000012'));
      expect(CustomerQuery.parse('cus-12'), isA<CustomerNumberQuery>().having((q) => q.customerNumber, 'n', 'RMX-CUS-000012'));
    });

    test('names: the longest word is queried, all words must match', () {
      final q = CustomerQuery.parse('jo okello') as NameQuery;
      expect(q.token, 'okello');
      Customer c(String n) => Customer(customerId: 'x', customerNumber: 'n', fullName: n);
      expect(q.matches(c('John Okello Doe')), isTrue);
      expect(q.matches(c('Mary Okello')), isFalse);
      expect(CustomerQuery.parse('   '), isA<RecentCustomers>());
    });
  });

  group('service catalogue', () {
    final all = [
      svc('1', 'Full Wash', ServiceCategory.washing, 15000, loyalty: true),
      svc('2', 'Basic Wash', ServiceCategory.washing, 10000),
      svc('3', 'Interior Cleaning', ServiceCategory.interior, 20000),
      svc('4', 'Polishing', ServiceCategory.polishing, 50000, active: false),
    ];

    test('search, category and active filters', () {
      expect(filterServices(all, query: 'wash').map((s) => s.serviceId), ['1', '2']);
      expect(filterServices(all, category: ServiceCategory.interior).map((s) => s.serviceId), ['3']);
      expect(filterServices(all, active: false).map((s) => s.serviceId), ['4']);
      expect(filterServices(all, active: true).length, 3);
    });

    test('only active services can be selected, grouped by category', () {
      final g = groupActive(all);
      expect(g.keys, [ServiceCategory.washing, ServiceCategory.interior]);
      expect(g.values.expand((l) => l).any((s) => s.serviceId == '4'), isFalse);
    });

    test('prices are whole, non-negative shillings', () {
      for (final ok in ['10000', '10,000', 'UGX 10,000', '0']) {
        expect(priceValidator(ok), isNull, reason: ok);
      }
      for (final bad in ['10,000.50', '-500', 'ten', '', '1000000000']) {
        expect(priceValidator(bad), isNotNull, reason: bad);
      }
    });

    test('model parsing keeps the price as integer UGX', () {
      final s = CatalogService.fromFirestore('s', {'name': 'Full Wash', 'category': 'washing', 'priceUgx': 15000,
        'estimatedDurationMinutes': 90, 'qualifiesForLoyalty': true, 'isActive': true});
      expect(s.price, const Money(15000));
      expect(s.price.format(), 'UGX 15,000');
      expect(s.durationLabel, '1 h 30 min');
    });

    test('an intake keeps the price snapshot it was created with', () {
      final i = ServiceIntake.fromFirestore('i', {
        'vehicleId': 'v', 'numberPlate': 'UGB 123A', 'status': 'open',
        'selectedServices': [{'serviceId': '1', 'name': 'Full Wash', 'category': 'washing', 'priceUgx': 15000}],
      });
      expect(i.isOpen, isTrue);
      expect(i.selectedServices.single.price, const Money(15000));
    });
  });

  group('catalogue sync with the Cloud Functions', () {
    final catalog = jsonDecode(File('functions/src/access_catalog.json').readAsStringSync()) as Map<String, dynamic>;
    test('service categories and vehicle types match', () {
      expect((catalog['serviceCategories'] as List).cast<String>(), ServiceCategory.values.map((c) => c.key).toList());
      expect((catalog['vehicleTypes'] as List).cast<String>(), VehicleType.values.map((t) => t.key).toList());
    });
  });

  group('permissions for customers, vehicles, services and intake', () {
    bool can(UserRole r, Permission p) => testUser(role: r).can(p, now);

    test('only admins and managers manage services and prices', () {
      for (final r in UserRole.values) {
        expect(can(r, Permission.servicesManage), r == UserRole.admin || r == UserRole.manager, reason: r.key);
      }
    });

    test('everyone operational can see the catalogue; shareholders cannot', () {
      for (final r in [UserRole.admin, UserRole.manager, UserRole.cashier, UserRole.worker, UserRole.auditor]) {
        expect(can(r, Permission.servicesView), isTrue, reason: r.key);
      }
      expect(can(UserRole.shareholder, Permission.servicesView), isFalse);
    });

    test('cashiers and managers register vehicles/customers and start services; workers only look up', () {
      for (final r in [UserRole.cashier, UserRole.manager, UserRole.admin]) {
        expect(can(r, Permission.vehiclesManage) && can(r, Permission.customersManage) && can(r, Permission.jobsCreate), isTrue, reason: r.key);
      }
      expect(can(UserRole.worker, Permission.vehiclesView), isTrue);
      expect(can(UserRole.worker, Permission.customersView), isFalse, reason: 'no customer phone numbers for workers');
      expect(can(UserRole.worker, Permission.vehiclesManage) || can(UserRole.worker, Permission.jobsCreate), isFalse);
      for (final p in [Permission.customersManage, Permission.vehiclesManage, Permission.servicesManage, Permission.jobsCreate]) {
        expect(can(UserRole.auditor, p), isFalse, reason: p.key);
      }
    });

    test('New Service is on the menu only for those who can start services', () {
      for (final r in UserRole.values) {
        final has = RoleNavigation.modulesFor(testUser(role: r), now).contains(AppModule.newService);
        expect(has, can(r, Permission.jobsCreate), reason: r.key);
      }
    });
  });

  group('OperationsRepository (fake Firestore)', () {
    late FakeFirebaseFirestore db;
    late OperationsRepository repo;

    Future<void> vehicle(String id, String plate, {String? customerId, int day = 1}) => db.collection('vehicles').doc(id).set({
          'vehicleId': id, 'numberPlate': plate, 'normalizedNumberPlate': NumberPlates.key(plate), 'model': 'M', 'colour': 'C',
          'customerId': customerId, 'status': 'active', 'createdAt': Timestamp.fromDate(DateTime.utc(2026, 9, day)),
        });

    setUp(() async {
      db = FakeFirebaseFirestore();
      repo = OperationsRepository(db);
      await vehicle('v1', 'UGB 123A', customerId: 'c1', day: 1);
      await vehicle('v2', 'UGB 124B', customerId: 'c1', day: 2);
      await vehicle('v3', 'UAX 456B', day: 3);
      await db.collection('customers').doc('c1').set({
        'customerNumber': 'RMX-CUS-000001', 'fullName': 'John Okello Doe', 'phoneNumber': '+256772123456',
        'searchTokens': ['j', 'jo', 'joh', 'john', 'o', 'ok', 'oke', 'okel', 'okell', 'okello', 'd', 'do', 'doe'],
        'status': 'active', 'createdAt': Timestamp.fromDate(DateTime.utc(2026, 9, 1)),
      });
      await db.collection('customers').doc('c2').set({
        'customerNumber': 'RMX-CUS-000002', 'fullName': 'Mary Achieng', 'searchTokens': ['m', 'ma', 'mar', 'mary'],
        'alternativePhone': '+256701000111', 'status': 'inactive', 'createdAt': Timestamp.fromDate(DateTime.utc(2026, 9, 2)),
      });
    });

    test('plate search: exact, any format, prefix, and recent when empty', () async {
      expect((await repo.searchVehicles('ugb-123a')).map((v) => v.vehicleId), ['v1']);
      expect((await repo.searchVehicles('UGB 12')).map((v) => v.vehicleId), ['v1', 'v2']);
      expect(await repo.searchVehicles('UBZ'), isEmpty);
      expect((await repo.searchVehicles('')).map((v) => v.vehicleId), ['v3', 'v2', 'v1']);
    });

    test('one customer, many vehicles', () async {
      expect((await repo.watchVehiclesOf('c1').first).map((v) => v.numberPlate), ['UGB 123A', 'UGB 124B']);
    });

    test('customer search by phone (main or alternative), name, number and status', () async {
      expect((await repo.searchCustomers('0772 123 456')).map((c) => c.customerId), ['c1']);
      expect((await repo.searchCustomers('+256701000111')).map((c) => c.customerId), ['c2']);
      expect((await repo.searchCustomers('okello')).map((c) => c.customerId), ['c1']);
      expect((await repo.searchCustomers('mar')).map((c) => c.customerId), ['c2']);
      expect((await repo.searchCustomers('RMX-CUS-000001')).map((c) => c.customerId), ['c1']);
      expect((await repo.searchCustomers('', status: RecordStatus.inactive)).map((c) => c.customerId), ['c2']);
      expect((await repo.searchCustomers('mar', status: RecordStatus.active)), isEmpty);
    });
  });
}
