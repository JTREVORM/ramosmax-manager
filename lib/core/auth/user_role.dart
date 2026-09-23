/// Authentication-level roles. Exactly one per user.
///
/// A worker's trade (detailer, mechanic, …) is NOT a role — see
/// [WorkerSpecialization]. Access differences inside a role are expressed with
/// permissions, not new roles.
enum UserRole {
  admin('admin', 'Administrator', 100),
  shareholder('shareholder', 'Shareholder', 50),
  manager('manager', 'Manager', 50),
  auditor('auditor', 'Auditor', 50),
  cashier('cashier', 'Cashier', 10),
  worker('worker', 'Worker', 10);

  const UserRole(this.key, this.label, this.rank);

  /// Value stored in Firestore (`users.role`) and checked by security rules.
  final String key;
  final String label;

  /// Seniority for account administration. A non-admin may only administer
  /// accounts whose role ranks strictly below their own, so a manager can
  /// look after cashiers and workers but never another manager, an auditor,
  /// a shareholder or an admin. Mirrored by `roleRanks` in
  /// `functions/src/access_catalog.json`.
  final int rank;

  static UserRole? tryParse(String? value) {
    for (final role in values) {
      if (role.key == value) return role;
    }
    return null;
  }
}

/// A worker's trade. Descriptive metadata only — grants no access.
enum WorkerSpecialization {
  detailer('detailer', 'Detailer'),
  carWasher('car_washer', 'Car Washer'),
  interiorCleaner('interior_cleaner', 'Interior Cleaner'),
  polisher('polisher', 'Polisher'),
  mechanic('mechanic', 'Mechanic'),
  generalWorker('general_worker', 'General Worker'),
  other('other', 'Other');

  const WorkerSpecialization(this.key, this.label);

  final String key;
  final String label;

  static WorkerSpecialization? tryParse(String? value) {
    for (final s in values) {
      if (s.key == value) return s;
    }
    return null;
  }
}
