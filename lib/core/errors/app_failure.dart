/// Categories of failure the UI knows how to present.
enum FailureKind {
  invalidPhoneNumber,

  /// Wrong phone number or password (deliberately not saying which).
  invalidCredentials,

  /// A new password fails the policy, or the current password is wrong.
  invalidPassword,
  tooManyRequests,
  quotaExceeded,
  network,
  permissionDenied,
  notFound,
  unavailable,
  unauthenticated,
  invalidInput,

  /// The record already exists (duplicate phone number, staff ID in use).
  alreadyExists,

  /// The request is valid but the current state forbids it (e.g. removing
  /// the last active Administrator, nothing changed).
  conflict,
  storage,
  unknown,
}

/// A failure translated into something safe to show a user.
///
/// [message] is always user-facing and never contains stack traces, error
/// codes, document paths or other internals. [code] keeps the raw provider
/// code for logs and Crashlytics only.
class AppFailure implements Exception {
  const AppFailure(this.kind, this.message, {this.code, this.retryable = false, this.details});

  final FailureKind kind;
  final String message;
  final String? code;
  final bool retryable;

  /// Extra ids the server attached (e.g. the `vehicleId` that already owns a
  /// number plate), so the UI can offer "open the existing record".
  final Map<String, Object?>? details;

  @override
  String toString() => 'AppFailure(${kind.name}${code == null ? '' : ', $code'})';
}

/// Outcome of an operation that can fail in an expected way. Repositories
/// return this instead of throwing so the UI must handle both branches.
sealed class Result<T> {
  const Result();

  R when<R>({
    required R Function(T value) success,
    required R Function(AppFailure failure) failure,
  }) =>
      switch (this) {
        Success<T>(:final value) => success(value),
        Failure<T>(:final error) => failure(error),
      };
}

final class Success<T> extends Result<T> {
  const Success(this.value);
  final T value;
}

final class Failure<T> extends Result<T> {
  const Failure(this.error);
  final AppFailure error;
}
