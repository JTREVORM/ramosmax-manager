# Architecture

## Stack

| Concern | Choice | Why |
|---|---|---|
| UI | Flutter, Material 3 | One codebase for Android and iOS |
| State and dependency injection | `flutter_riverpod` 3 | Compile-safe providers; every Firebase dependency can be overridden in tests |
| Navigation | `go_router` | Declarative routes plus a central redirect guard for session and role checks |
| Formatting | `intl` | Currency and date formatting |
| Backend | Firebase only | Auth, Firestore, Storage, Cloud Functions (`cloud_functions`), FCM, Analytics, Crashlytics. No other backend or database. |
| Media | `image_picker` | Staff profile photos |
| Supporting | `package_info_plus`, `connectivity_plus` | Environment guard, offline banner |

Dev-only packages: `mocktail`, `fake_cloud_firestore`, `firebase_auth_mocks`, `flutter_launcher_icons` and
`flutter_native_splash`.

## Folder structure

```
lib/
  main.dart / main_dev.dart / main_prod.dart   entrypoints (one per environment)
  bootstrap.dart        splash → Firebase init → environment guard → app
  app.dart              MaterialApp.router, theme, session side effects
  core/
    auth/               UserRole, WorkerSpecialization, Permission catalogue, role matrix, AccessPolicy,
                        PasswordPolicy (policy + secure generator)
    branding/           Brand: company name, contacts, logo paths, brand colours
    config/             AppEnvironment + generated firebase_options_{dev,prod}.dart
    constants/          Firestore collection names, Storage paths
    errors/             AppFailure, Result<T>, ErrorMapper (Firebase → user-safe messages)
    money/              Money (integer UGX)
    providers/          the dependency graph (Firebase instances, services, repositories)
    services/           Firestore, Storage, Notifications (FCM), Analytics, Crashlytics, Connectivity
    theme/              AppTheme, AppSpacing, AppColors
    utils/              dates in EAT, phone numbers, validators, stream helpers
    widgets/            logo and brand header, loading/empty/error views, dialogs, snackbars
  models/               AppUser, AuditLogEntry, Firestore converters
  repositories/         UserRepository, AuditLogRepository
  features/
    auth/               data (AuthRepository: phone + password via Cloud Functions) · application
                        (login, session) · presentation (login, change password, access denied)
    dashboard/          role navigation, shell, home, profile, "not available yet" screen
    operations/         customers, vehicles, service catalogue, service intake: data (OperationsRepository
                        reads, OperationsApi → Cloud Functions) · application (customer search, online-only
                        actions) · presentation (plate search, forms, details, services, start service, jobs)
    users/              user management: data (directory reads, UserAdminApi → Cloud Functions)
                        · application (search/filter, online-only actions) · presentation (list,
                        details, form, permissions, dialogs)
  routes/               AppRoutes, RouteGuard (pure), GoRouter wiring
firebase/               firestore.rules, firestore.indexes.json, storage.rules
functions/              Cloud Functions (Node 22): access_catalog.json, access.js (pure policy),
                        passwords.js, session.js (sign-in, own password), user_admin.js (handlers),
                        operations.js + plates.js (customers, vehicles, services, intakes),
                        notify.js, index.js; test/ runs on the emulators
tool/admin/             trusted provisioning CLI (Admin SDK). Never shipped in the app.
test/                   unit/, repository/, widget/, support/ (fakes)
```

Business modules (customers, vehicles, jobs, invoices, payments, finance, payroll …) will each be added as
`lib/features/<module>/` with the same three layers:

```
features/<module>/
  data/            repository: the only code that queries Firestore for this module
  application/     Riverpod notifiers/providers: business logic and state
  presentation/    screens and widgets: no Firebase imports
```

## Layering rules

- **Widgets never import Firebase.** They read providers and call notifiers.
- **Repositories own queries.** Collection names come from `FirestoreCollections`, and field names that every
  document shares come from `FirestoreFields`.
- **Expected failures are values.** Repositories return `Result<T>` (`Success`/`Failure`), and `ErrorMapper` is
  the single place where Firebase error codes become user-facing text.
- **Pure decisions are extracted.** `SessionResolver`, `RouteGuard`, `RoleNavigation` and
  `AppUser.effectivePermissions` have no Firebase dependencies and are unit-tested exhaustively.

## Startup sequence

1. `main_<env>.dart` calls `bootstrap(flavor)`. The native splash (brand purple and logo) is showing.
2. `AppBootstrapper` renders the Flutter splash, then:
   - checks that the running application ID matches the flavor (`com.ramosmax.automotive[.dev]`) and aborts
     otherwise;
   - runs `Firebase.initializeApp` with that environment's options and verifies the project ID;
   - enables Firestore offline persistence, registers the FCM background handler, and initialises
     Crashlytics and Analytics.
3. `ProviderScope` starts `RamosMaxApp`. `authSnapshotProvider` follows Firebase Auth and then the user's
   live `users/{uid}` document. `sessionProvider` resolves this into one of `SessionResolving`, `SignedOut`,
   `AwaitingConnection`, `AccessDenied(reason)`, `PasswordChangeRequired(user)`, `Authorized(user)` or
   `SessionFailed`.
4. `RouteGuard` sends each state to its screen: splash, phone + password login, the forced password change, access denied, or the role dashboard.

## Navigation

`RoleNavigation` maps each role to its menu (see `docs/ROADMAP.md` for the full lists). A module is shown only
if it is on the role's menu **and** the user holds one of its permissions, so denying a permission also hides
the menu entry. `RouteGuard` refuses deep links to modules outside the user's menu. The bottom bar holds up
to five entries; the rest go under "More".

## Branding

All company identity lives in `lib/core/branding/brand.dart`: names, contact details (left blank until
verified), logo asset paths and colours sampled from the official logo (purple `#362060`, gold `#D0AD47`).
Assets are in `assets/branding/`:

| File | Use |
|---|---|
| `ramosmax_logo.png` | Official logo, unmodified (225×225, purple background) |
| `ramosmax_logo_transparent.png` | Background removed. Use only on purple or dark surfaces, because the edges carry the purple tint. |
| `app_icon_1024.png` | Launcher icon source (upscaled from the official logo) |
| `app_icon_foreground.png` | Android adaptive-icon foreground on the `#362060` background |

Regenerate icons with `dart run flutter_launcher_icons` and the native splash with
`dart run flutter_native_splash:create`.

> The supplied logo is only 225×225 px. The launcher icons and splash are upscaled from it and will look
> soft on high-density screens. Replace `assets/branding/ramosmax_logo.png` with a high-resolution original
> (1024×1024 or larger, or a vector) before store submission, then rerun both generators.
