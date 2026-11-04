import 'dart:convert';

import 'kv_store.dart';

/// A GCash proof photo whose order synced but whose photo upload did not.
///
/// The photo rides inside the queued order payload; while the sale is on the
/// device this is the ONLY copy of the evidence. The upload after a sale is
/// best-effort by design (it must never fail the sale), so this store is the
/// safety net: incomplete uploads are kept here and retried on every drain,
/// instead of being swallowed.
class FailedReceiptsStore {
  FailedReceiptsStore(this._storage);

  final KeyValueStore _storage;

  static const _indexKey = 'failed_receipts_index';
  static const _prefix = 'failed_receipt:';

  /// Caps the backlog: oldest photos expire after a week either way, and the
  /// phone keeps at most [maxEntries] small payloads around.
  static const maxEntries = 5;

  Future<List<String>> _readIndex() async {
    try {
      final raw = await _storage.read(key: _indexKey);
      if (raw == null || raw.isEmpty) {
        return [];
      }
      final decoded = jsonDecode(raw);
      if (decoded is! List) {
        return [];
      }
      return decoded.map((e) => e.toString()).toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> _writeIndex(List<String> keys) =>
      _storage.write(key: _indexKey, value: jsonEncode(keys));

  Future<void> add({
    required String clientRef,
    required int orderId,
    required String mime,
    required String data,
  }) async {
    try {
      await _storage.write(
        key: '$_prefix$clientRef',
        value: jsonEncode({
          'clientRef': clientRef,
          'orderId': orderId,
          'mime': mime,
          'data': data,
          'at': DateTime.now().toIso8601String(),
        }),
      );
      final index = await _readIndex();
      if (!index.contains(clientRef)) {
        index.add(clientRef);
      }
      while (index.length > maxEntries) {
        final dropped = index.removeAt(0);
        await _storage.delete(key: '$_prefix$dropped');
      }
      await _writeIndex(index);
    } catch (_) {
      // The store itself failing must not take the sale down either. The
      // upload error is already surfaced to the operator by the caller.
    }
  }

  Future<List<Map<String, dynamic>>> pending() async {
    final index = await _readIndex();
    final out = <Map<String, dynamic>>[];
    for (final clientRef in index) {
      try {
        final raw = await _storage.read(key: '$_prefix$clientRef');
        if (raw == null || raw.isEmpty) {
          continue;
        }
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic>) {
          out.add(decoded);
        }
      } catch (_) {
        // Unreadable entry: leave it indexed, it simply skips this drain.
      }
    }
    return out;
  }

  Future<void> remove(String clientRef) async {
    try {
      await _storage.delete(key: '$_prefix$clientRef');
      final index = await _readIndex();
      index.remove(clientRef);
      await _writeIndex(index);
    } catch (_) {
      // A leftover index entry is harmless: the next drain re-checks and
      // removes it.
    }
  }
}
