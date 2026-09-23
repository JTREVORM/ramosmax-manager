import '../../../core/auth/user_role.dart';
import '../../../models/app_user.dart';

/// Filter chips on the Users screen.
enum UserListFilter {
  all('All'),
  active('Active'),
  inactive('Inactive'),
  admin('Admin', UserRole.admin),
  shareholder('Shareholder', UserRole.shareholder),
  manager('Manager', UserRole.manager),
  auditor('Auditor', UserRole.auditor),
  cashier('Cashier', UserRole.cashier),
  worker('Worker', UserRole.worker);

  const UserListFilter(this.label, [this.role]);

  final String label;
  final UserRole? role;

  bool matches(AppUser user) => switch (this) {
        UserListFilter.all => true,
        UserListFilter.active => user.active,
        UserListFilter.inactive => !user.active,
        _ => user.role == role,
      };
}

/// Pure search + filter, unit-tested in test/unit/user_management_test.dart.
///
/// The query matches name, staff ID or phone number. Phone matching ignores
/// spaces and accepts local (`0772…`), national (`772…`) and international
/// (`+256772…`) forms.
abstract final class UserSearch {
  static List<AppUser> apply(List<AppUser> users, UserListFilter filter, String query) {
    final q = query.trim().toLowerCase();
    return [
      for (final u in users)
        if (filter.matches(u) && (q.isEmpty || matchesQuery(u, q))) u,
    ];
  }

  static bool matchesQuery(AppUser user, String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return true;
    if ((user.fullName ?? '').toLowerCase().contains(q)) return true;
    if ((user.staffId ?? '').toLowerCase().contains(q)) return true;

    final digits = q.replaceAll(RegExp(r'[^\d]'), '');
    if (digits.length >= 3 && RegExp(r'^[\d\s+()-]+$').hasMatch(q)) {
      final phone = user.phoneNumber.replaceAll(RegExp(r'[^\d]'), '');
      // "0772…" → "772…" so local-format searches find +256772….
      final national = digits.startsWith('0') ? digits.substring(1) : digits;
      return phone.contains(digits) || (national.isNotEmpty && phone.contains(national));
    }
    return false;
  }
}
