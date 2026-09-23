import 'dart:async';

extension SwitchMapExtension<T> on Stream<T> {
  /// Maps each event to an inner stream and emits only from the latest one,
  /// cancelling the previous inner subscription. Used to follow "current auth
  /// user → that user's live profile" without leaking the old user's listener.
  Stream<R> switchMap<R>(Stream<R> Function(T value) mapper) {
    late StreamController<R> controller;
    StreamSubscription<T>? outer;
    StreamSubscription<R>? inner;
    var outerDone = false;

    controller = StreamController<R>(
      onListen: () {
        outer = listen(
          (value) {
            inner?.cancel();
            inner = mapper(value).listen(
              controller.add,
              onError: controller.addError,
              onDone: () {
                inner = null;
                if (outerDone) controller.close();
              },
            );
          },
          onError: controller.addError,
          onDone: () {
            outerDone = true;
            if (inner == null) controller.close();
          },
        );
      },
      onPause: () {
        outer?.pause();
        inner?.pause();
      },
      onResume: () {
        outer?.resume();
        inner?.resume();
      },
      onCancel: () async {
        await inner?.cancel();
        await outer?.cancel();
      },
    );
    return controller.stream;
  }
}
