import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:ramosmax_auto_manager/app.dart';
import 'package:ramosmax_auto_manager/core/errors/app_failure.dart';
import 'package:ramosmax_auto_manager/features/dashboard/presentation/dashboard_shell.dart';
import 'package:ramosmax_auto_manager/features/operations/application/operations_providers.dart';

import '../support/fake_auth_repository.dart';
import '../support/fake_operations_api.dart';
import '../support/fake_user_admin_api.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

void main() {
  late FakeFirebaseFirestore db;
  late FakeOperationsApi api;
  late FakeConnectivityService connectivity;

  setUp(() {
    db = FakeFirebaseFirestore();
    api = FakeOperationsApi();
    connectivity = FakeConnectivityService();
  });

  Future<void> seed({String role = 'cashier'}) async {
    await db.collection('users').doc('me').set(userDocData(role: role, fullName: 'Carl Cashier'));
    await db.collection('customers').doc('c1').set({
      'customerNumber': 'RMX-CUS-000001', 'fullName': 'John Doe', 'phoneNumber': '+256772123456',
      'searchTokens': ['j', 'jo', 'joh', 'john', 'd', 'do', 'doe'], 'status': 'active', 'vehicleCount': 2,
      'createdAt': Timestamp.fromDate(DateTime.utc(2026, 9, 1)),
    });
    Future<void> vehicle(String id, String plate, String key, String model, String colour, {String status = 'active'}) =>
        db.collection('vehicles').doc(id).set({
          'vehicleId': id, 'numberPlate': plate, 'normalizedNumberPlate': key, 'make': 'Toyota', 'model': model, 'colour': colour,
          'customerId': 'c1', 'customerName': 'John Doe', 'customerNumber': 'RMX-CUS-000001', 'status': status,
          'createdAt': Timestamp.fromDate(DateTime.utc(2026, 9, 2)),
        });
    await vehicle('v1', 'UGB 123A', 'UGB123A', 'Harrier', 'Black');
    await vehicle('v2', 'UAX 456B', 'UAX456B', 'Premio', 'White', status: 'inactive');
    Future<void> service(String id, String name, String cat, int price, {bool active = true}) =>
        db.collection('services').doc(id).set({'name': name, 'category': cat, 'priceUgx': price, 'isActive': active,
          'qualifiesForLoyalty': true, 'estimatedDurationMinutes': 30});
    await service('s1', 'Full Wash', 'washing', 15000);
    await service('s2', 'Interior Cleaning', 'interior', 20000);
    await service('s3', 'Polishing', 'polishing', 50000, active: false);
    await service('s4', 'Waxing', 'waxing', 30000);
  }

  Future<void> pumpAt(WidgetTester tester, String location) async {
    await tester.binding.setSurfaceSize(const Size(430, 1600));
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...testOverrides(
          auth: FakeAuthRepository(initialUser: MockUser(uid: 'me', phoneNumber: testPhone)),
          db: db,
          connectivity: connectivity,
        ),
        operationsApiProvider.overrideWithValue(api),
      ],
      child: const RamosMaxApp(),
    ));
    await tester.pumpAndSettle();
    GoRouter.of(tester.element(find.byType(DashboardShell))).go(location);
    await tester.pumpAndSettle();
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.binding.setSurfaceSize(null);
  }

  Future<void> tapKey(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    if (f.evaluate().isEmpty) {
      await tester.scrollUntilVisible(f, 300,
          scrollable: find.descendant(of: find.byType(ListView), matching: find.byType(Scrollable)).first);
    }
    final element = tester.element(f);
    if (Scrollable.maybeOf(element) != null) {
      await Scrollable.ensureVisible(element, alignment: 0.5);
      await tester.pumpAndSettle();
    }
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  Future<void> typePlate(WidgetTester tester, String plate) async {
    await tester.enterText(find.byKey(const Key('plate-search-field')), plate);
    await tester.pump(const Duration(milliseconds: 400)); // debounce
    await tester.pumpAndSettle();
  }

  testWidgets('dashboard: one tap to New Service', (tester) async {
    await seed();
    await pumpAt(tester, '/app');
    await tapKey(tester, 'dashboard-new-service');
    expect(find.byKey(const Key('plate-search-field')), findsOneWidget);
    expect(find.text('New service'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('returning vehicle: plate in any format → found → start service → select services → intake', (tester) async {
    await seed();
    await pumpAt(tester, '/app/new-service');
    await typePlate(tester, 'ugb-123a');
    expect(find.byKey(const Key('vehicle-found')), findsOneWidget);
    expect(find.text('Toyota Harrier · Black'), findsOneWidget);
    expect(find.text('Owner: John Doe'), findsOneWidget);

    await tapKey(tester, 'start-service-button');
    expect(find.text('Start service'), findsWidgets);
    expect(find.byKey(const Key('select-service-s3')), findsNothing, reason: 'inactive services cannot be selected');
    expect(find.text('Selected services: 0'), findsOneWidget);

    await tapKey(tester, 'select-service-s2');
    await tapKey(tester, 'select-service-s1');
    expect(find.text('Selected services: 2'), findsOneWidget);
    await tapKey(tester, 'create-intake-button');

    expect(api.names, ['createServiceIntake']);
    expect(api.calls.single.$2['vehicleId'], 'v1');
    expect(api.calls.single.$2['serviceIds'], ['s1', 's2'], reason: 'catalogue order');
    await unmount(tester);
  });

  testWidgets('unknown plate → register vehicle with the plate prefilled and a new customer', (tester) async {
    await seed();
    await pumpAt(tester, '/app/new-service');
    await typePlate(tester, 'ubd789c');
    expect(find.byKey(const Key('vehicle-not-found')), findsOneWidget);
    expect(find.text('No vehicle found for UBD 789C.'), findsOneWidget);
    await tapKey(tester, 'register-vehicle-button');

    final plateField = tester.widget<TextFormField>(find.byKey(const Key('vehicle-plate-field')));
    expect(plateField.controller!.text, 'UBD 789C');

    await tapKey(tester, 'vehicle-save-button');
    expect(find.text('Enter the model'), findsOneWidget);
    expect(find.text('Enter the colour'), findsOneWidget);
    expect(find.text("Enter the customer's name"), findsOneWidget);
    expect(api.calls, isEmpty);

    await tester.enterText(find.byKey(const Key('vehicle-model-field')), 'Forester');
    await tester.enterText(find.byKey(const Key('vehicle-colour-field')), 'Blue');
    await tester.enterText(find.byKey(const Key('customer-name-field')), 'Peter Okot');
    await tester.enterText(find.byKey(const Key('customer-phone-field')), '0701 555 666');
    await tapKey(tester, 'vehicle-save-button');

    expect(api.names, ['createVehicle']);
    final call = api.calls.single.$2;
    expect([call['numberPlate'], call['model'], call['colour']], ['UBD 789C', 'Forester', 'Blue']);
    expect((call['newCustomer'] as Map)['fullName'], 'Peter Okot');
    // Continues straight to service selection for the new vehicle.
    final router = GoRouter.of(tester.element(find.byType(DashboardShell)));
    expect(router.routerDelegate.currentConfiguration.uri.toString(), '/app/vehicles/new-vehicle/start');
    await unmount(tester);
  });

  testWidgets('register a vehicle without a customer; duplicate plate offers the existing vehicle', (tester) async {
    await seed();
    await pumpAt(tester, '/app/vehicles/new?plate=UGB%20123A');
    await tester.enterText(find.byKey(const Key('vehicle-model-field')), 'Harrier');
    await tester.enterText(find.byKey(const Key('vehicle-colour-field')), 'Black');
    await tester.tap(find.text('None'));
    await tester.pumpAndSettle();
    api.nextFailure = const AppFailure(FailureKind.alreadyExists, 'UGB 123A is already registered.',
        code: 'duplicate_plate', details: {'reason': 'duplicate_plate', 'vehicleId': 'v1'});
    await tapKey(tester, 'vehicle-save-button');
    expect(api.calls.single.$2['customer'], 'none');
    expect(find.text('UGB 123A is already registered.'), findsOneWidget);
    await tapKey(tester, 'open-existing-vehicle');
    expect(find.byKey(const Key('vehicle-detail-description')), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('invalid plate cannot be registered', (tester) async {
    await seed();
    await pumpAt(tester, '/app/vehicles/new');
    await tester.enterText(find.byKey(const Key('vehicle-plate-field')), 'ABC 12');
    await tapKey(tester, 'vehicle-save-button');
    expect(find.text('Enter a valid plate, e.g. UBA 123A'), findsOneWidget);
    expect(api.calls, isEmpty);
    await unmount(tester);
  });

  testWidgets('vehicle details: vehicle, customer, service activity; inactive vehicles cannot start a service', (tester) async {
    await seed();
    await pumpAt(tester, '/app/vehicles/v1');
    for (final section in ['Vehicle', 'Customer', 'Service activity']) {
      expect(find.text(section), findsOneWidget, reason: section);
    }
    expect(find.text('RMX-CUS-000001'), findsOneWidget);
    expect(find.text('+256772123456'), findsOneWidget);
    expect(find.byKey(const Key('vehicle-start-service')), findsOneWidget);

    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/vehicles/v2');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('vehicle-start-service')), findsNothing);
    expect(find.byKey(const Key('vehicle-reactivate')), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('marking a vehicle inactive asks for a reason', (tester) async {
    await seed();
    await pumpAt(tester, '/app/vehicles/v1');
    await tapKey(tester, 'vehicle-deactivate');
    await tester.enterText(find.byKey(const Key('reason-field')), 'Sold to another garage');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.calls.single.$1, 'updateVehicle');
    expect(api.calls.single.$2['status'], 'inactive');
    expect(api.calls.single.$2['reason'], 'Sold to another garage');
    await unmount(tester);
  });

  testWidgets('customer search by phone in local format, and details list the vehicles', (tester) async {
    await seed();
    await pumpAt(tester, '/app/customers');
    await tester.enterText(find.byKey(const Key('customer-search')), '0772 123 456');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    await tapKey(tester, 'customer-tile-c1');
    expect(find.byKey(const Key('customer-detail-name')), findsOneWidget);
    expect(find.text('UGB 123A'), findsOneWidget);
    expect(find.text('UAX 456B'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('add customer: only the name is required; phone validated', (tester) async {
    await seed();
    await pumpAt(tester, '/app/customers/new');
    await tapKey(tester, 'customer-save-button');
    expect(find.text("Enter the customer's name"), findsOneWidget);
    await tester.enterText(find.byKey(const Key('customer-name-field')), 'Grace Nakato');
    await tester.enterText(find.byKey(const Key('customer-phone-field')), '12345');
    await tapKey(tester, 'customer-save-button');
    expect(find.textContaining('valid phone number'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('customer-phone-field')), '');
    await tapKey(tester, 'customer-save-button');
    expect(api.names, ['createCustomer']);
    expect(api.calls.single.$2['fullName'], 'Grace Nakato');
    await unmount(tester);
  });

  testWidgets('manager adds a service; decimal prices are rejected', (tester) async {
    await seed(role: 'manager');
    await pumpAt(tester, '/app/services');
    await tapKey(tester, 'add-service-button');
    await tester.enterText(find.byKey(const Key('service-name-field')), 'Engine Wash');
    await tester.enterText(find.byKey(const Key('service-price-field')), '10,000.50');
    await tapKey(tester, 'service-save-button');
    expect(find.text('Enter whole shillings, e.g. 15,000 (no decimals)'), findsOneWidget);
    expect(api.calls, isEmpty);

    await tester.enterText(find.byKey(const Key('service-price-field')), '12,000');
    await tester.enterText(find.byKey(const Key('service-duration-field')), '40');
    await tapKey(tester, 'service-save-button');
    expect(api.names, ['createService']);
    final c = api.calls.single.$2;
    expect([c['name'], c['priceUgx'], c['estimatedDurationMinutes'], c['category'], c['isActive']],
        ['Engine Wash', 12000, 40, 'washing', true]);
    await unmount(tester);
  });

  testWidgets('changing a price asks for confirmation', (tester) async {
    await seed(role: 'manager');
    await pumpAt(tester, '/app/services/s1');
    await tester.enterText(find.byKey(const Key('service-price-field')), '18000');
    await tapKey(tester, 'service-save-button');
    expect(find.textContaining('UGX 15,000 → UGX 18,000'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.calls.single.$2['priceUgx'], 18000);
    await unmount(tester);
  });

  testWidgets('workers and cashiers see prices but cannot change them', (tester) async {
    for (final role in ['worker', 'cashier']) {
      await seed(role: role);
      await pumpAt(tester, '/app/services');
      expect(find.text('UGX 15,000'), findsOneWidget, reason: role);
      expect(find.byKey(const Key('service-card-s3')), findsNothing, reason: 'inactive services hidden from $role');
      expect(find.byKey(const Key('add-service-button')), findsNothing);
      await tester.tap(find.text('Full Wash'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('service-read-only')), findsOneWidget);
      expect(find.byKey(const Key('service-price-field')), findsNothing);
      await unmount(tester);
    }
  });

  testWidgets('workers look up plates but cannot register vehicles or start services', (tester) async {
    await seed(role: 'worker');
    await pumpAt(tester, '/app/vehicles');
    await typePlate(tester, 'UGB 123A');
    expect(find.byKey(const Key('vehicle-found')), findsOneWidget);
    expect(find.byKey(const Key('start-service-button')), findsNothing);
    await typePlate(tester, 'UBD 789C');
    expect(find.byKey(const Key('register-vehicle-button')), findsNothing);
    GoRouter.of(tester.element(find.byType(DashboardShell))).go('/app/new-service');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('plate-search-field')), findsNothing, reason: 'New Service is not on the worker menu');
    await unmount(tester);
  });

  testWidgets('offline: registering is refused and nothing is queued', (tester) async {
    await seed();
    connectivity.online = false;
    await pumpAt(tester, '/app/vehicles/v1/start');
    await tapKey(tester, 'select-service-s1');
    await tapKey(tester, 'create-intake-button');
    expect(api.calls, isEmpty);
    expect(find.textContaining('needs an internet connection'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('a vehicle with a service in progress links to it', (tester) async {
    await seed();
    await pumpAt(tester, '/app/vehicles/v1/start');
    api.nextFailure = const AppFailure(FailureKind.conflict, 'UGB 123A already has a service in progress.',
        code: 'open_intake_exists', details: {'reason': 'open_intake_exists', 'intakeId': 'i9'});
    await tapKey(tester, 'select-service-s1');
    await tapKey(tester, 'create-intake-button');
    expect(find.text('UGB 123A already has a service in progress.'), findsOneWidget);
    expect(find.byKey(const Key('open-existing-intake')), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('intake details: services with snapshot prices; cancel requires a reason', (tester) async {
    await seed();
    await db.collection('service_intakes').doc('i1').set({
      'vehicleId': 'v1', 'numberPlate': 'UGB 123A', 'vehicleSummary': 'Toyota · Harrier · Black', 'customerName': 'John Doe',
      'status': 'open', 'createdAt': Timestamp.fromDate(DateTime.utc(2026, 9, 21, 8)),
      'selectedServices': [
        {'serviceId': 's1', 'name': 'Full Wash', 'category': 'washing', 'priceUgx': 15000},
        {'serviceId': 's2', 'name': 'Interior Cleaning', 'category': 'interior', 'priceUgx': 20000},
      ],
    });
    await pumpAt(tester, '/app/jobs');
    await tapKey(tester, 'intake-tile-i1');
    expect(find.text('Selected services: 2'), findsOneWidget);
    expect(find.text('UGX 20,000'), findsOneWidget);
    await tapKey(tester, 'cancel-intake-button');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty, reason: 'reason required');
    await tester.enterText(find.byKey(const Key('reason-field')), 'Customer left');
    await tester.tap(find.byKey(const Key('confirm-button')));
    await tester.pumpAndSettle();
    expect(api.calls.single.$2, {'intakeId': 'i1', 'serviceIds': null, 'status': 'cancelled', 'reason': 'Customer left'});
    await unmount(tester);
  });
}
