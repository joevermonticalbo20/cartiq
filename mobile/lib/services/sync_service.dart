import 'dart:async';

import 'package:flutter/widgets.dart';

import 'api_client.dart';
import 'auth_state.dart';
import 'offline_queue.dart';

class SyncResult {
  final bool online;
  final int synced;
  final int remaining;

  const SyncResult({
    required this.online,
    required this.synced,
    required this.remaining,
  });

  bool get allDone => online && remaining == 0;

  String get message {
    if (!online) return 'Offline - records saved on this device';
    if (synced == 0 && remaining > 0) return 'Server reachable but sync failed';
    return 'Synced $synced record(s)';
  }
}

/// Drains the offline queue to the API whenever the server is reachable.
/// The API deduplicates by client_ref, so replays are always safe.
class SyncService extends ChangeNotifier {
  final ApiClient api;
  final AuthState auth;
  final OfflineQueue queue;

  SyncService({required this.api, required this.auth, required this.queue});

  Timer? _timer;
  bool _running = false;
  bool _appResumed = true;
  bool get isSyncing => _running;

  /// Trigger an immediate sync (used by app resume, lifecycle events, manual tap).
  Future<SyncResult> syncAll() async {
    if (_running) {
      return SyncResult(online: true, synced: 0, remaining: await queue.count);
    }
    _running = true;
    notifyListeners();
    try {
      return await _doSync();
    } finally {
      _running = false;
      notifyListeners();
    }
  }

  Future<SyncResult> _doSync() async {
    final token = auth.token;
    if (token == null) {
      return SyncResult(online: false, synced: 0, remaining: await queue.count);
    }
    if (!await api.health()) {
      return SyncResult(online: false, synced: 0, remaining: await queue.count);
    }

    var synced = 0;
    for (final record in await queue.pending()) {
      try {
        await api.submitOrder(record.payload, token);
        await queue.remove(record.id);
        synced++;
      } on ApiException catch (e) {
        if (e.statusCode == 401 || e.statusCode == 403) break; // session expired
        // Server rejected (e.g. bad payload): drop poison messages, keep going.
        if (e.statusCode != null && e.statusCode! >= 400 && e.statusCode! < 500) {
          await queue.remove(record.id);
        }
        break;
      } catch (_) {
        break; // network hiccup mid-drain: try again next sync
      }
    }
    return SyncResult(online: true, synced: synced, remaining: await queue.count);
  }

  /// Start the periodic timer. Idempotent.
  /// While the app is in the foreground, drain the queue every [interval].
  void start({Duration interval = const Duration(seconds: 30)}) {
    if (_timer != null) return;
    _timer = Timer.periodic(interval, (_) {
      if (_appResumed) syncAll();
    });
  }

  /// Stop the periodic timer (e.g., on logout).
  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// Hook for `WidgetsBindingObserver.didChangeAppLifecycleState`.
  void onAppResumed() {
    _appResumed = true;
    syncAll();
  }

  void onAppPaused() {
    _appResumed = false;
  }

  @override
  void dispose() {
    stop();
    super.dispose();
  }
}

/// Helper that wires [SyncService] into the Flutter app lifecycle so the
/// queue drains on resume and on a periodic interval.
class SyncLifecycleObserver with WidgetsBindingObserver {
  SyncLifecycleObserver(this._sync);
  final SyncService _sync;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        _sync.onAppResumed();
        break;
      case AppLifecycleState.inactive:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        _sync.onAppPaused();
        break;
    }
  }
}
