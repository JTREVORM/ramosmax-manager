import 'package:connectivity_plus/connectivity_plus.dart';

import '../errors/app_failure.dart';

/// Reports whether the device has a network path.
///
/// Having an interface is not proof the internet is reachable; this drives
/// the offline banner and the pre-check for online-only operations. The
/// authoritative guard for financial writes is still that they run as
/// Firestore transactions / server calls, which fail without a server.
class ConnectivityService {
  ConnectivityService([Connectivity? connectivity])
      : _connectivity = connectivity ?? Connectivity();

  final Connectivity _connectivity;

  Stream<bool> get onlineChanges =>
      _connectivity.onConnectivityChanged.map(_hasNetwork).distinct();

  Future<bool> isOnline() async => _hasNetwork(await _connectivity.checkConnectivity());

  /// Call before any operation that must not be queued offline (payments,
  /// transfers, payroll, cash handovers).
  Future<void> ensureOnline() async {
    if (!await isOnline()) {
      throw const AppFailure(
        FailureKind.network,
        'This action needs an internet connection. Connect and try again.',
        code: 'offline',
        retryable: true,
      );
    }
  }

  static bool _hasNetwork(List<ConnectivityResult> results) =>
      results.any((r) => r != ConnectivityResult.none);
}
