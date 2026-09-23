import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/app_failure.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/services/analytics_service.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/utils/validators.dart';
import '../data/auth_repository.dart';

/// State of the sign-in form. Never holds the password: it is passed straight
/// through to the sign-in function and then dropped.
class LoginState {
  const LoginState({this.country = PhoneNumbers.uganda, this.busy = false, this.failure});

  final PhoneCountry country;
  final bool busy;
  final AppFailure? failure;

  LoginState copyWith({PhoneCountry? country, bool? busy, AppFailure? failure, bool clearFailure = false}) =>
      LoginState(
        country: country ?? this.country,
        busy: busy ?? this.busy,
        failure: clearFailure ? null : (failure ?? this.failure),
      );
}

final loginControllerProvider = NotifierProvider<LoginController, LoginState>(LoginController.new);

/// Phone number + password sign-in. On success Firebase reports the new
/// session and `sessionProvider` takes over (profile, status, forced password
/// change, dashboard).
class LoginController extends Notifier<LoginState> {
  AuthRepository get _auth => ref.read(authRepositoryProvider);
  AnalyticsService get _analytics => ref.read(analyticsProvider);

  @override
  LoginState build() => const LoginState();

  void selectCountry(PhoneCountry country) => state = state.copyWith(country: country, clearFailure: true);

  Future<void> signIn(String rawPhone, String password) async {
    if (state.busy) return;
    // Uganda local numbers (0772…) become +256772… — the same normalisation
    // the server applies.
    final phoneError = Validators.phone(rawPhone, country: state.country);
    final e164 = PhoneNumbers.toE164(rawPhone, state.country);
    if (phoneError != null || e164 == null) {
      state = state.copyWith(failure: AppFailure(FailureKind.invalidPhoneNumber, phoneError ?? 'Invalid phone number'));
      return;
    }
    if (password.isEmpty) {
      state = state.copyWith(failure: const AppFailure(FailureKind.invalidCredentials, 'Enter your password'));
      return;
    }

    state = state.copyWith(busy: true, clearFailure: true);
    final result = await _auth.signIn(e164, password);
    result.when(
      success: (_) {
        _analytics.logEvent(AnalyticsEvents.signInSucceeded);
        state = state.copyWith(busy: false);
      },
      failure: (failure) {
        _analytics.logEvent(AnalyticsEvents.signInFailed, {'failure_kind': failure.kind.name});
        state = state.copyWith(busy: false, failure: failure);
      },
    );
  }

  void clearFailure() => state = state.copyWith(clearFailure: true);

  void reset() => state = LoginState(country: state.country);
}
