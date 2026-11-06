import 'dart:convert';

import 'kv_store.dart';

/// Small persisted list cache (newest-first) for the POS-adjacent lists.
///
/// A cart with no signal still shows the last known History and Receipts
/// instead of "Session expired. Please log in again." (which is what happened
/// when the app silently lost its session). Saved on every successful page
/// load, read only when the network is missing.
class ListCache {
  static const historyKey = 'cartiq_history_cache';
  static const expensesKey = 'cartiq_expenses_cache';

  /// Enough to cover a shift; older rows drop off the device.
  static const maxRows = 50;

  static Future<List<Map<String, dynamic>>> load(
    KeyValueStore store,
    String key,
  ) async {
    try {
      final raw = await store.read(key: key);
      if (raw == null || raw.isEmpty) return const [];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return [
        for (final row in decoded)
          if (row is Map<String, dynamic>) row,
      ];
    } catch (_) {
      return const [];
    }
  }

  static Future<void> save(
    KeyValueStore store,
    String key,
    List<Map<String, dynamic>> rows,
  ) async {
    try {
      final clipped = rows.take(maxRows).toList();
      await store.write(key: key, value: jsonEncode(clipped));
    } catch (_) {
      // Cache is best-effort; never block the live list on it.
    }
  }

  /// Stable identity for de-duplication across pages and sessions.
  static String keyOf(Map<String, dynamic> row) {
    final id = row['id'];
    if (id is num) return id.toInt().toString();
    if (id is String && id.isNotEmpty) return id;
    return jsonEncode(row);
  }

  /// Merge fresh rows with the stored cache, fresh first, no duplicates.
  static List<Map<String, dynamic>> merge(
    List<Map<String, dynamic>> fresh,
    List<Map<String, dynamic>> cached,
  ) {
    final merged = <String, Map<String, dynamic>>{};
    for (final row in fresh) {
      merged[keyOf(row)] = row;
    }
    for (final row in cached) {
      merged.putIfAbsent(keyOf(row), () => row);
    }
    return merged.values.toList().take(maxRows).toList();
  }
}
