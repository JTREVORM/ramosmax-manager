import 'dart:async';
import 'dart:math';

import 'package:cloud_functions/cloud_functions.dart' show FirebaseFunctions, FirebaseFunctionsException, HttpsCallableOptions;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../errors/app_failure.dart';
import '../errors/error_mapper.dart';
import '../providers/core_providers.dart';

/// Calls the Cloud Function [name] and returns its result map, or the mapped
/// failure (the server's message and `details.reason` as [AppFailure.code]).
Future<Result<Map<String, dynamic>>> callFunction(
  FirebaseFunctions functions,
  String name,
  Map<String, Object?> data, {
  Duration timeout = const Duration(seconds: 30),
}) async {
  try {
    final result = await functions.httpsCallable(name, options: HttpsCallableOptions(timeout: timeout)).call<Object?>(data);
    final raw = result.data;
    return Success(raw is Map ? raw.map((k, v) => MapEntry(k.toString(), v)) : <String, dynamic>{});
  } catch (e) {
    return Failure(callFailure(e));
  }
}

/// Phase 9: how a failed call is reported. When the request left the device
/// but no answer came back, the server may have finished it - so it is never
/// called "failed", only unconfirmed. Retrying is safe: money commands carry a
/// requestId and status changes refuse to run twice.
AppFailure callFailure(Object error) {
  if (error is TimeoutException ||
      (error is FirebaseFunctionsException && (error.code == 'deadline-exceeded' || error.code == 'unavailable'))) {
    return unconfirmedFailure;
  }
  return ErrorMapper.map(error);
}

/// Shown when a command was sent but its result never arrived.
const AppFailure unconfirmedFailure = AppFailure(
  FailureKind.network,
  'No answer from the server. It may already have been saved - check before repeating it. '
  'Trying again is safe: the same request is never recorded twice.',
  code: 'unconfirmed',
  retryable: true,
);

/// Shown when a write is attempted offline. Writes are never queued: money,
/// numbers and statuses need the server.
const AppFailure onlineOnlyFailure = AppFailure(
  FailureKind.network,
  'This needs an internet connection. Connect and try again — saved information is still viewable offline.',
  code: 'offline',
  retryable: true,
);

/// Runs [action] only when online, then logs [event] (no personal data) on success.
Future<Result<T>> runOnline<T>(Ref ref, Future<Result<T>> Function() action,
    {String? event, Map<String, Object>? params}) async {
  try {
    await ref.read(connectivityServiceProvider).ensureOnline();
  } catch (_) {
    return const Failure(onlineOnlyFailure);
  }
  final result = await action();
  if (result is Success<T> && event != null) {
    try {
      await ref.read(analyticsProvider).logEvent(event, params ?? const {});
    } catch (_) {}
  }
  return result;
}

/// Idempotency key for one payment attempt: a retried request with the same
/// key is recorded once by the server.
String newRequestId([Random? random]) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  final r = random ?? Random.secure();
  return List.generate(24, (_) => chars[r.nextInt(chars.length)]).join();
}
