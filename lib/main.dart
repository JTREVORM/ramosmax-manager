import 'bootstrap.dart';
import 'core/config/app_environment.dart';

/// Default entrypoint (used when no `-t` is given) deliberately targets
/// DEVELOPMENT, so a forgotten flag can never touch production data. Release
/// builds must name `lib/main_prod.dart` explicitly — see docs/ENVIRONMENTS.md.
void main() => bootstrap(AppFlavor.dev);
