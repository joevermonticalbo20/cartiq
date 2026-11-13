import 'package:flutter/foundation.dart';

/// Broadcasts "something changed on the server, re-read your data".
///
/// Sales History, Home, Receipts and Live Stock each live in an IndexedStack,
/// so they stay mounted after their first fetch. Screens subscribe here and
/// reload when [version] changes (for example, after a sale or stock refresh).
///
/// Deliberately NOT a network client: it carries no data, only a signal, so
/// each screen keeps owning its own fetch, error and loading states. It is a
/// plain [ChangeNotifier] rather than a stream so screens can subscribe once
/// in initState and drop the subscription in dispose.
class DataRefresh extends ChangeNotifier {
  int _version = 0;
  String? _lastReason;
  String? _lastMessage;

  /// Increments on every [bump]. Screens may use it to ignore a reload they
  /// triggered themselves, avoiding a request loop.
  int get version => _version;

  /// What changed last, for debugging ("sale", "void", "payment").
  String? get lastReason => _lastReason;

  /// A line the app should say out loud about the last change (for example
  /// "Time out is only open 16:30-16:40"). Null when there is nothing to say.
  String? get lastMessage => _lastMessage;

  /// Signal that server-side data changed.
  ///
  /// [message] rides along with the signal so a service (a push handler, for
  /// example) can tell the screen what happened without needing a BuildContext
  /// of its own.
  void bump([String? reason, String? message]) {
    _version++;
    _lastReason = reason;
    _lastMessage = message;
    notifyListeners();
  }
}
