import 'package:flutter/foundation.dart';

/// Broadcasts "something changed on the server, re-read your data".
///
/// Sales History, Home and Receipts each live in an IndexedStack, so they are
/// all mounted at once and each fetches once in initState. A sale completed on
/// the POS therefore never reached the other tabs - the operator had to
/// pull-to-refresh or background the app to see it. Screens subscribe here and
/// reload when [version] changes.
///
/// Deliberately NOT a network client: it carries no data, only a signal, so
/// each screen keeps owning its own fetch, error and loading states. It is a
/// plain [ChangeNotifier] rather than a stream so screens can subscribe once
/// in initState and drop the subscription in dispose.
class DataRefresh extends ChangeNotifier {
  int _version = 0;
  String? _lastReason;

  /// Increments on every [bump]. Screens may use it to ignore a reload they
  /// triggered themselves, avoiding a request loop.
  int get version => _version;

  /// What changed last, for debugging ("sale", "void", "payment").
  String? get lastReason => _lastReason;

  /// Signal that server-side data changed.
  void bump([String? reason]) {
    _version++;
    _lastReason = reason;
    notifyListeners();
  }
}
