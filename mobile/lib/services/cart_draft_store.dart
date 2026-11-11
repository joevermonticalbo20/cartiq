import 'dart:convert';

import '../state/cart_state.dart';
import 'kv_store.dart';

/// The unfinished order, kept on the device.
///
/// Recording an order takes a few taps (flavor, size, quantity, payment). If
/// the app is closed in the middle - the vendor switches apps, Android kills
/// it, the battery dies - the cart used to vanish and the whole order had to
/// be typed again.
///
/// The draft is written on every cart change and read back on the next
/// start. It is a DEVICE draft, not a sale: nothing is sent to the server
/// until the vendor actually pays.
class CartDraftStore {
  CartDraftStore(this._store);

  /// Where the draft lives in the key-value store.
  static const storageKey = 'cartiq_cart_draft';

  final KeyValueStore _store;

  /// Saves the cart. An empty cart deletes the draft instead of storing an
  /// empty one - a recorded sale must not leave a draft behind.
  Future<void> save(List<CartItem> items) async {
    try {
      if (items.isEmpty) {
        await _store.delete(key: storageKey);
        return;
      }
      final payload = {
        'version': 1,
        'savedAt': DateTime.now().toIso8601String(),
        'items': items.map((it) => it.toDraftJson()).toList(),
      };
      await _store.write(key: storageKey, value: jsonEncode(payload));
    } catch (_) {
      // A draft that cannot be saved must never break selling.
    }
  }

  /// Reads the draft back. A missing or broken draft simply means "no draft".
  Future<List<CartItem>> load() async {
    try {
      final raw = await _store.read(key: storageKey);
      if (raw == null || raw.isEmpty) return const [];
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return const [];
      final items = decoded['items'];
      if (items is! List) return const [];
      return items
          .whereType<Map<String, dynamic>>()
          .map(CartItem.fromDraftJson)
          .whereType<CartItem>()
          .toList();
    } catch (_) {
      return const [];
    }
  }

  /// Throws the draft away (after a sale, or when the device is handed over).
  Future<void> clear() async {
    try {
      await _store.delete(key: storageKey);
    } catch (_) {
      // Best-effort.
    }
  }
}
