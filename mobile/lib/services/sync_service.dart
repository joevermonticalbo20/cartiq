import 'dart:async';

import 'package:flutter/widgets.dart';

import 'api_client.dart';
import 'auth_state.dart';
import 'data_refresh.dart';
import 'failed_receipts_store.dart';
import 'offline_queue.dart';

/// A queued record the server will never accept. Kept out of the queue but
/// reported separately - dropped must NEVER be counted as synced.
class DroppedRecord {
  final String id;
  final String kind;
  final String reason;
  final String? code;
  final Map<String, dynamic>? payload;

  const DroppedRecord({
    required this.id,
    required this.kind,
    required this.reason,
    this.code,
    this.payload,
  });
}

class SyncResult {
  final bool online;
  final int synced;
  final int remaining;
  final List<DroppedRecord> dropped;

  /// True when the drain stopped because the session could not be
  /// refreshed — the user must log in again (records stay queued).
  final bool authExpired;
  final String? errorMessage;

  /// GCash proof photos that could NOT be attached this drain. The sale
  /// itself synced; these photos are kept on the device and retried on the
  /// next drain (see FailedReceiptsStore).
  final int receiptsFailed;
  final String? receiptError;

  const SyncResult({
    required this.online,
    required this.synced,
    required this.remaining,
    this.dropped = const [],
    this.authExpired = false,
    this.errorMessage,
    this.receiptsFailed = 0,
    this.receiptError,
  });

  bool get allDone => online && remaining == 0;

  /// True only when everything uploaded AND nothing was dropped.
  /// Use this (not [allDone]) for success UI.
  bool get fullySynced => allDone && dropped.isEmpty;

  String get message {
    if (!online) return errorMessage ?? ApiClient.noInternetMessage;
    if (authExpired) return ApiClient.sessionExpiredMessage;
    final stockFailure = dropped.where((d) => d.code == 'INSUFFICIENT_STOCK');
    if (stockFailure.isNotEmpty) return stockFailure.first.reason;
    if (dropped.isNotEmpty) {
      final reasons = dropped.map((d) => d.reason).toSet().join(', ');
      if (remaining == 0 && synced == 0) {
        return 'Sale could not be sent ($reasons) - ask OWNER to review';
      }
      return 'Synced $synced record(s), ${dropped.length} could not be sent ($reasons)';
    }
    if (errorMessage != null) return errorMessage!;
    if (synced == 0 && remaining > 0) {
      return 'Unable to sync queued orders. Please try again.';
    }
    return 'Synced $synced record(s)';
  }
}

/// Drains the offline queue to the API whenever the server is reachable.
/// The API deduplicates by client_ref, so replays are always safe.
class SyncService extends ChangeNotifier {
  final ApiClient api;
  final AuthState auth;
  final OfflineQueue queue;
  final DataRefresh? dataRefresh;

  /// Where GCash proof photos wait to be retried when their upload failed.
  /// Optional so tests can omit it; production wires it in main.dart.
  final FailedReceiptsStore? receiptStore;

  SyncService({
    required this.api,
    required this.auth,
    required this.queue,
    this.dataRefresh,
    this.receiptStore,
  });

  Timer? _timer;
  bool _running = false;
  bool _appResumed = true;
  bool get isSyncing => _running;

  /// Last successful reachability check. The health call itself is a full
  /// round trip, so we reuse a recent success instead of re-pinging on every
  /// drain (the acceptance path after a sale calls syncAll immediately).
  DateTime? _lastHealthOk;
  static const _healthFreshness = Duration(seconds: 10);
  SyncResult? lastResult;

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
      final result = await _doSync();
      lastResult = result;
      if (result.synced > 0) dataRefresh?.bump('sale');
      return result;
    } finally {
      _running = false;
      notifyListeners();
    }
  }

  Future<SyncResult> _doSync() async {
    final startToken = auth.token;
    if (startToken == null) {
      // A signed-out device can still hold a queued offline session; say
      // plainly what is needed instead of blaming the network.
      return SyncResult(
        online: false,
        synced: 0,
        remaining: await queue.count,
        errorMessage: 'Sign in online to upload queued sales.',
      );
    }
    // Reachability gate: reports offline WITHOUT attempting any upload when
    // the server is known-unreachable (see sync_service_test "unreachable
    // server reports offline"). Skipping this would burn an upload attempt
    // per drain and misreport online:true on total network failure. A recent
    // successful ping is reused (see _lastHealthOk).
    final lastOk = _lastHealthOk;
    final freshOk = lastOk != null &&
        DateTime.now().difference(lastOk).abs() < _healthFreshness;
    final healthy = freshOk ? true : await api.health();
    if (healthy) _lastHealthOk = DateTime.now();
    if (!healthy) {
      return SyncResult(online: false, synced: 0, remaining: await queue.count);
    }

    var synced = 0;
    var activeToken = startToken;
    var authExpired = false;
    var receiptsFailed = 0;
    String? receiptError;
    String? errorMessage;
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
          receiptsFailed: receiptsFailed,
          receiptError: receiptError,
        );
      }
      // Pre-validate before spending an upload: unattributable or malformed
      // sales can never succeed, so drop with a reason instead of burning
      // retries or - worse - silently deleting after a server 400.
      final problem = _validateRecord(record);
      if (problem != null) {
        await queue.remove(record.id);
        dropped.add(
          DroppedRecord(id: record.id, kind: record.kind, reason: problem),
        );
        continue;
      }
      try {
        // Server returns 200 {duplicate:true} for replays — still synced.
        final receiptFailure = await _submitRecord(record, activeToken);
        if (receiptFailure != null) {
          receiptsFailed += 1;
          receiptError ??= receiptFailure;
        }
        await queue.remove(record.id);
        synced++;
      } on ApiException catch (e) {
        if (e.statusCode == 403) {
          // Staff outside their cart (or other permission denial): a refresh
          // cannot fix it. Drop with a clear reason instead of retrying
          // every 30s behind a poisoned record.
          await queue.remove(record.id);
          dropped.add(
            DroppedRecord(
              id: record.id,
              kind: record.kind,
              reason: 'STAFF_OUTSIDE_CART',
            ),
          );
          continue;
        }
        if (e.statusCode == 401) {
          // Access tokens are short-lived (15min). Recover once via the
          // refresh token and retry this record instead of stalling the
          // queue behind an expired session.
          if (!await auth.refreshSession()) {
            authExpired = true;
            errorMessage = ApiClient.sessionExpiredMessage;
            break;
          }
          final fresh = auth.token;
          if (fresh == null) {
            authExpired = true;
            errorMessage = ApiClient.sessionExpiredMessage;
            break;
          }
          activeToken = fresh;
          try {
            final receiptFailure = await _submitRecord(record, activeToken);
            if (receiptFailure != null) {
              receiptsFailed += 1;
              receiptError ??= receiptFailure;
            }
            await queue.remove(record.id);
            synced++;
          } catch (retryError) {
            if (retryError is ApiException && retryError.statusCode == 401) {
              authExpired = true;
              errorMessage = ApiClient.sessionExpiredMessage;
            } else if (retryError is ApiException &&
                retryError.statusCode == 409 &&
                retryError.code == 'INSUFFICIENT_STOCK') {
              await queue.remove(record.id);
              dropped.add(
                DroppedRecord(
                  id: record.id,
                  kind: record.kind,
                  reason: retryError.message,
                  code: retryError.code,
                  payload: record.payload,
                ),
              );
              dataRefresh?.bump('inventory');
            } else if (retryError is ApiException) {
              errorMessage = retryError.message;
            }
            break; // still failing after refresh: stop this round
          }
          continue;
        }
        if (e.statusCode == 409) {
          if (e.code == 'INSUFFICIENT_STOCK') {
            await queue.remove(record.id);
            dropped.add(
              DroppedRecord(
                id: record.id,
                kind: record.kind,
                reason: e.message,
                code: e.code,
                payload: record.payload,
              ),
            );
            dataRefresh?.bump('inventory');
            continue;
          }
          // Idempotent replay: the server already has this order, so it
          // counts as synced, not dropped.
          await queue.remove(record.id);
          synced++;
          continue;
        }
        if (e.statusCode == null ||
            e.statusCode == 429 ||
            e.statusCode! >= 500) {
          errorMessage = e.message;
          break; // retryable: network/timeout/rate-limit/5xx stays queued
        }
        // Any other 4xx slipped past pre-validation: drop with its status
        // as the reason, keep draining the rest.
        await queue.remove(record.id);
        dropped.add(
          DroppedRecord(
            id: record.id,
            kind: record.kind,
            reason: 'SERVER_REJECTED_${e.statusCode}',
          ),
        );
        continue;
      } catch (_) {
        break; // network hiccup mid-drain: try again next sync
      }
    }

    // Retry GCash proof photos whose upload failed earlier — a previous
    // drain, or the upload part of this one. Best effort: anything that
    // still fails stays on the device for the next drain.
    final store = receiptStore;
    if (store != null) {
      for (final item in await store.pending()) {
        final orderId = item['orderId'];
        final mime = item['mime'];
        final data = item['data'];
        final ref = item['clientRef']?.toString();
        if (ref == null || orderId is! num || mime is! String || data is! String) {
          continue;
        }
        try {
          await api.uploadOrderReceipt(
            activeToken,
            orderId.toInt(),
            mime: mime,
            data: data,
          );
          await store.remove(ref);
        } on ApiException catch (e) {
          if (e.statusCode == 401) {
            // One refresh for the whole retry batch.
            if (await auth.refreshSession()) {
              final fresh = auth.token;
              if (fresh != null) {
                try {
                  await api.uploadOrderReceipt(
                    fresh,
                    orderId.toInt(),
                    mime: mime,
                    data: data,
                  );
                  await store.remove(ref);
                } catch (_) {
                  /* keep it for the next drain */
                }
              }
            }
          }
        } catch (_) {
          /* keep it for the next drain */
        }
      }
    }
    return SyncResult(
      online: true,
      synced: synced,
      remaining: await queue.count,
      dropped: dropped,
      authExpired: authExpired,
      errorMessage: errorMessage,
      receiptsFailed: receiptsFailed,
      receiptError: receiptError,
    );
  }

  /// Posts one queued order. A GCash proof photo travels inside the queued
  /// payload but is NOT part of the order body: it is stripped before the
  /// POST and attached to the recorded order afterwards.
  ///
  /// Returns null when the order (and any photo) fully landed, otherwise the
  /// failure message. An unattachable photo never fails the sale itself — it
  /// is kept on the device (see FailedReceiptsStore) and retried on later
  /// drains instead of being silently dropped.
  Future<String?> _submitRecord(QueuedRecord record, String token) async {
    final payload = record.payload;
    var body = payload;
    if (payload['receipt'] != null) {
      body = Map<String, dynamic>.from(payload)..remove('receipt');
    }
    final response = await api.submitOrder(body, token);

    final receipt = payload['receipt'];
    if (receipt is! Map) return null;
    final mime = receipt['mime'];
    final data = receipt['data'];
    final orderId = (response['order'] as Map?)?['id'];
    if (mime is! String || data is! String || data.isEmpty || orderId is! num) {
      return 'receipt payload was incomplete';
    }
    try {
      await api.uploadOrderReceipt(
        token,
        orderId.toInt(),
        mime: mime,
        data: data,
      );
      return null;
    } on ApiException catch (e) {
      await _holdReceipt(record, orderId.toInt(), mime: mime, data: data);
      return e.message;
    } catch (_) {
      await _holdReceipt(record, orderId.toInt(), mime: mime, data: data);
      return 'receipt upload failed';
    }
  }

  /// Keep the proof photo on-device for the next drain. Without this the
  /// only copy of the evidence died with the swallowed error.
  Future<void> _holdReceipt(QueuedRecord record, int orderId, {required String mime, required String data}) async {
    try {
      await receiptStore?.add(
        clientRef: record.payload['clientRef']?.toString() ?? record.id,
        orderId: orderId,
        mime: mime,
        data: data,
      );
    } catch (_) {
      // Best effort: the caller surfaces the failure to the operator anyway.
    }
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
