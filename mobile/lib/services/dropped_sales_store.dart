import 'dart:convert';

import 'kv_store.dart';

/// A queued sale the server refused, kept so the operator can see it.
///
/// A rejected sale is removed from the offline queue (it can never succeed),
/// so without this store the record would simply vanish: the money was taken
/// at the counter but the server never learned about it. The store keeps the
/// reason, the amount and the time so the staff member (or the owner) can see
/// what happened and re-record it by hand.
class DroppedSalesStore {
  DroppedSalesStore(this._storage);

  final KeyValueStore _storage;

  static const _indexKey = 'dropped_sales_index';
  static const _prefix = 'dropped_sale:';

  /// Keeps the phone light: these are small text records, and the owner is
  /// expected to act on them within days.
  static const maxEntries = 25;

  /// How long a rejected sale stays on the device.
  static const maxAge = Duration(days: 14);

  Future<List<String>> _readIndex() async {
    try {
      final raw = await _storage.read(key: _indexKey);
      if (raw == null || raw.isEmpty) return [];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return [];
      return decoded.map((e) => e.toString()).toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> _writeIndex(List<String> keys) =>
      _storage.write(key: _indexKey, value: jsonEncode(keys));

  /// Record one rejected sale. Never throws: losing the audit trail must not
  /// break the sync that reported it.
  Future<void> add({
    required String id,
    required String kind,
    required String reason,
    String? code,
    num? total,
    int? itemCount,
  }) async {
    try {
      await _storage.write(
        key: '$_prefix$id',
        value: jsonEncode({
          'id': id,
          'kind': kind,
          'reason': reason,
          'code': code,
          'total': total,
          'itemCount': itemCount,
          'at': DateTime.now().toIso8601String(),
        }),
      );
      final index = await _readIndex();
      if (!index.contains(id)) index.add(id);
      await _writeIndex(index);
      await _prune();
    } catch (_) {
      // The store itself failing must not take the sale down.
    }
  }

  /// Drop entries that are too old or over the cap.
  Future<void> _prune() async {
    try {
      var index = await _readIndex();
      final now = DateTime.now();
      final kept = <String>[];
      for (final key in index) {
        final entry = await _entry(key);
        if (entry == null) continue; // unreadable: drop the index entry too
        final at = DateTime.tryParse(entry['at'] as String? ?? '');
        if (at == null || now.difference(at) > maxAge) {
          await _storage.delete(key: '$_prefix$key');
          continue;
        }
        kept.add(key);
      }
      while (kept.length > maxEntries) {
        final oldest = kept.removeAt(0);
        await _storage.delete(key: '$_prefix$oldest');
      }
      await _writeIndex(kept);
    } catch (_) {
      // Best effort.
    }
  }

  Future<Map<String, dynamic>?> _entry(String key) async {
    try {
      final raw = await _storage.read(key: '$_prefix$key');
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) return decoded;
      return null;
    } catch (_) {
      return null;
    }
  }

  /// The rejected sales, newest first.
  Future<List<Map<String, dynamic>>> list() async {
    await _prune();
    final index = await _readIndex();
    final out = <Map<String, dynamic>>[];
    for (final key in index.reversed) {
      final entry = await _entry(key);
      if (entry != null) out.add(entry);
    }
    return out;
  }

  Future<int> count() async => (await list()).length;

  /// Forget one rejected sale (the operator recorded it by hand).
  Future<void> remove(String id) async {
    try {
      await _storage.delete(key: '$_prefix$id');
      final index = await _readIndex();
      index.remove(id);
      await _writeIndex(index);
    } catch (_) {
      // A leftover entry is harmless.
    }
  }

  /// Forget every rejected sale.
  Future<void> clear() async {
    try {
      final index = await _readIndex();
      for (final key in index) {
        await _storage.delete(key: '$_prefix$key');
      }
      await _writeIndex([]);
    } catch (_) {
      // Best effort.
    }
  }
}
