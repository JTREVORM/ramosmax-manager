import '../../models/app_user.dart';
import 'permissions.dart';
import 'user_role.dart';

/// Account-administration actions an actor may take on another user.
enum UserAdminAction {
  editProfile,
  changeRole,
  managePermissions,
  grantTemporary,
  activate,
  deactivate,
  linkStaff,
  changePhone,
  resetPassword,
}

/// Who may administer whom. A UX mirror of the checks in
/// `functions/src/access.js` — it decides which buttons to show, while the
/// Cloud Functions make the binding decision on the server with the same
/// rules:
///
/// * the actor needs the permission for the action;
/// * nobody changes their own role, permissions, temporary access, status,
///   phone number, or resets their own password (they change it instead);
/// * Managers reset passwords for Workers only;
/// * Administrator accounts are managed only by Administrators;
/// * a non-admin manages only roles ranked below their own;
/// * nobody hands out (grants, grants temporarily, or un-denies) a
///   permission they don't hold, and admin-only permissions only by an Admin.
abstract final class AccessPolicy {
  static Permission _permissionFor(UserAdminAction action) => switch (action) {
        UserAdminAction.editProfile || UserAdminAction.linkStaff || UserAdminAction.changePhone =>
          Permission.usersEdit,
        UserAdminAction.resetPassword => Permission.usersPasswordsReset,
        UserAdminAction.changeRole => Permission.usersRolesManage,
        UserAdminAction.managePermissions => Permission.usersPermissionsManage,
        UserAdminAction.grantTemporary => Permission.usersPermissionsTemporary,
        UserAdminAction.activate => Permission.usersActivate,
        UserAdminAction.deactivate => Permission.usersDeactivate,
      };

  static bool _holdsFor(AppUser actor, UserAdminAction action, DateTime now) {
    final perms = actor.effectivePermissions(now);
    if (action == UserAdminAction.grantTemporary) {
      return perms.contains(Permission.usersPermissionsTemporary) ||
          perms.contains(Permission.usersPermissionsManage);
    }
    return perms.contains(_permissionFor(action));
  }

  /// Target's role is administrable by the actor at all.
  static bool canAdminister(AppUser actor, AppUser target) {
    if (actor.role == UserRole.admin) return true;
    if (target.role == UserRole.admin) return false;
    return target.role.rank < actor.role.rank;
  }

  /// Whether [actor] may perform [action] on [target] at [now].
  static bool can(AppUser actor, UserAdminAction action, AppUser target, DateTime now) {
    if (!_holdsFor(actor, action, now)) return false;
    final self = actor.uid == target.uid;
    if (self) {
      // Only profile details may be self-edited (phone number excepted).
      return action == UserAdminAction.editProfile;
    }
    if (!canAdminister(actor, target)) return false;
    if (action == UserAdminAction.resetPassword &&
        actor.role != UserRole.admin &&
        !passwordResetRolesForNonAdmins.contains(target.role)) {
      return false;
    }
    if (action == UserAdminAction.activate) return !target.active;
    if (action == UserAdminAction.deactivate) return target.active;
    return true;
  }

  /// Roles whose passwords a non-admin holder of `users.passwords.reset` may
  /// reset: Managers reset Workers only. Mirrors
  /// `passwordResetRolesForNonAdmins` in functions/src/access_catalog.json.
  static const Set<UserRole> passwordResetRolesForNonAdmins = {UserRole.worker};

  static bool canCreateUsers(AppUser actor, DateTime now) =>
      actor.can(Permission.usersCreate, now);

  /// Roles [actor] may assign (at creation or via a role change).
  static List<UserRole> assignableRoles(AppUser actor) => [
        for (final r in UserRole.values)
          if (actor.role == UserRole.admin || (r != UserRole.admin && r.rank < actor.role.rank)) r,
      ];

  /// Whether [actor] may hand [permission] to someone else.
  static bool canGrant(AppUser actor, Permission permission, DateTime now) {
    if (permission.isAdminOnly && actor.role != UserRole.admin) return false;
    return actor.can(permission, now);
  }

  /// Permissions [actor] may hand out, in catalogue order.
  /// Never offers the Phase 8 authorisation-only permissions: they come only
  /// with an after-hours authorisation (the server refuses them anyway).
  static List<Permission> grantablePermissions(AppUser actor, DateTime now) => [
        for (final p in Permission.values)
          if (canGrant(actor, p, now) && !p.isAuthorizationOnly) p,
      ];

  /// Administrators always keep user-management access (mirrors
  /// `requireAllowedDenials` on the server).
  static bool canDeny(UserRole targetRole, Permission permission) =>
      !(targetRole == UserRole.admin && permission.key.startsWith('users.'));

  /// Longest temporary grant the server accepts.
  static const Duration maxTemporaryDuration = Duration(days: 30);

  /// Validates a temporary-access window. Returns an error message or null.
  static String? validateTemporaryWindow(DateTime startsAt, DateTime expiresAt, DateTime now) {
    if (startsAt.isBefore(now.subtract(const Duration(minutes: 5)))) {
      return 'The start time cannot be in the past.';
    }
    if (!expiresAt.isAfter(startsAt)) return 'The end time must be after the start time.';
    final effectiveStart = startsAt.isBefore(now) ? now : startsAt;
    if (expiresAt.difference(effectiveStart) > maxTemporaryDuration) {
      return 'Temporary access can last at most 30 days.';
    }
    if (startsAt.difference(now) > maxTemporaryDuration) {
      return 'Temporary access must start within the next 30 days.';
    }
    return null;
  }
}
