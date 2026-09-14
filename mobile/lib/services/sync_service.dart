import 'dart:async';

import 'package:flutter/widgets.dart';

import 'api_client.dart';
import 'auth_state.dart';
import 'offline_queue.dart';

/// A queued record the server will never accept. Kept out of the queue but
/// reported separately - dropped must NEVER be counted as synced.
class DroppedRecord {
  final String id;
  final String kind;
  final String reason;

  const DroppedRecord({
    required this.id,
    required this.kind,
    required this.reason,
  });
}

class SyncResult {
  final bool online;
  final int synced;
  final int remaining;
  final List<DroppedRecord> dropped;

  const SyncResult({
    required this.online,
    required this.synced,
    required this.remaining,
    this.dropped = const [],
  });

  bool get allDone => online && remaining == 0;

  /// True only when everything uploaded AND nothing was dropped.
  /// Use this (not [allDone]) for success UI.
  bool get fullySynced => allDone && dropped.isEmpty;

  String get message {
    if (!online) return 'Offline - records saved on this device';
    if (dropped.isNotEmpty) {
      final reasons = dropped.map((d) => d.reason).toSet().join(', ');
      if (remaining == 0 && synced == 0) {
        return 'Sale could not be sent ($reasons) - ask OWNER to review';
      }
      return 'Synced $synced record(s), ${dropped.length} could not be sent ($reasons)';
    }
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

  /// Bumped on logout. An in-flight drain checks it before every upload and
  /// stops instead of sending another request with stale credentials.
  int _generation = 0;

  /// Cancel any in-flight drain (call before sign-out). Records already
  /// uploaded stay uploaded; the rest stay queued for the next session.
  void cancelActiveSync() {
    _generation++;
  }

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
    final startToken = auth.token;
    if (startToken == null) {
      return SyncResult(online: false, synced: 0, remaining: await queue.count);
    }
    // No health() pre-check: it cost an extra roundtrip on every drain and
    // doubled Render cold-start latency. Submit directly; network failure
    // below is treated as offline.

    var synced = 0;
    var activeToken = startToken;
    final dropped = <DroppedRecord>[];
    final gen = _generation;
    for (final record in await queue.pending()) {
      // Logout happened mid-drain: stop before another old-session upload.
      if (gen != _generation) {
        return SyncResult(
          online: true,
          synced: synced,
          remaining: await queue.count,
          dropped: dropped,
        );
      }
      // Pre-validate before spending an upload: unattributable or malformed
      // sales can never succeed, so drop with a reason instead of burning
      // retries or - worse - silently deleting after a server 400.
      final problem = _validateRecord(record);
      if (problem != null) {
        await queue.remove(record.id);
        dropped.add(DroppedRecord(
          id: record.id,
          kind: record.kind,
          reason: problem,
        ));
        continue;
      }
      try {
        // Server returns 200 {duplicate:true} for replays — still synced.
        await api.submitOrder(record.payload, activeToken);
        await queue.remove(record.id);
        synced++;
      } on ApiException catch (e) {
        if (e.statusCode == 401 || e.statusCode == 403) {
          // Access tokens are short-lived (15min). Recover once via the
          // refresh token and retry this record instead of stalling the
          // queue behind an expired session.
          if (!await auth.refreshSession()) break;
          final fresh = auth.token;
          if (fresh == null) break;
          activeToken = fresh;
          try {
            await api.submitOrder(record.payload, activeToken);
            await queue.remove(record.id);
            synced++;
          } catch (_) {
            break; // still failing after refresh: stop this round
          }
          continue;
        }
        if (e.statusCode == 409) {
          // Idempotent replay: the server already has this order, so it
          // counts as synced, not dropped.
          await queue.remove(record.id);
          synced++;
          continue;
        }
        if (e.statusCode == null ||
            e.statusCode == 429 ||
            e.statusCode! >= 500) {
          break; // retryable: network/timeout/rate-limit/5xx stays queued
        }
        // Any other 4xx slipped past pre-validation: drop with its status
        // as the reason, keep draining the rest.
        await queue.remove(record.id);
        dropped.add(DroppedRecord(
          id: record.id,
          kind: record.kind,
          reason: 'SERVER_REJECTED_${e.statusCode}',
        ));
        continue;
      } catch (_) {
        break; // network hiccup mid-drain: try again next sync
      }
    }
    return SyncResult(
      online: true,
      synced: synced,
      remaining: await queue.count,
      dropped: dropped,
    );
  }

  /// Returns a drop reason when [record] can never upload, else null.
  /// Mirrors the server's POST /orders validation so poison never uploads.
  String? _validateRecord(QueuedRecord record) {
    if (record.kind != 'order') return null;
    final payload = record.payload;
    final code = payload['locationCode'];
    if (code == null || (code is String && code.trim().isEmpty)) {
      return 'MISSING_LOCATION_CODE';
    }
    final items = payload['items'];
    if (items is! List || items.isEmpty) return 'EMPTY_ITEMS';
    for (final it in items) {
      if (it is! Map<String, dynamic>) return 'INVALID_ITEM';
      final name = it['productName'];
      if (name is! String || name.trim().isEmpty) return 'INVALID_PRODUCT';
      final qty = it['qty'];
      if (qty is! int || qty < 1) return 'INVALID_QTY';
      final price = it['unitPrice'];
      if (price is! num || !price.isFinite || price < 0) {
        return 'INVALID_PRICE';
      }
    }
    return null;
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
