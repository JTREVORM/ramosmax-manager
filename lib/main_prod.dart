import 'bootstrap.dart';
import 'core/config/app_environment.dart';

/// Production entrypoint — Firebase project `ramosmax-prod`, real business data.
///   flutter build appbundle --flavor prod -t lib/main_prod.dart
void main() => bootstrap(AppFlavor.prod);
