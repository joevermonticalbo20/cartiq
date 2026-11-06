import 'package:flutter_test/flutter_test.dart';
import 'package:cartiq_mobile/services/list_cache.dart';
import 'package:cartiq_mobile/services/kv_store.dart';

class FakeStore implements KeyValueStore {
  final Map<String, String?> values = {};
  @override
  Future<String?> read({required String key}) async => values[key];
  @override
  Future<void> write({required String key, required String? value}) async {
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }
  @override
  Future<void> delete({required String key}) async => values.remove(key);
}

void main() {
  group('ListCache', () {
    test('save + load round-trips rows newest-first and capped', () async {
      final store = FakeStore();
      final rows = [
        for (var i = 0; i < 60; i++) {'id': i, 'name': 'sale-$i'},
      ];
      await ListCache.save(store, ListCache.historyKey, rows);

      final loaded = await ListCache.load(store, ListCache.historyKey);
      expect(loaded.length, ListCache.maxRows);
      expect(loaded.first['id'], 0);
      expect(loaded.last['id'], ListCache.maxRows - 1);
    });

    test('load returns empty for missing/corrupt data, never throws', () async {
      final store = FakeStore();
      expect(await ListCache.load(store, ListCache.historyKey), isEmpty);

      store.values[ListCache.historyKey] = 'not json';
      expect(await ListCache.load(store, ListCache.historyKey), isEmpty);

      store.values[ListCache.historyKey] = '{"not":"a list"}';
      expect(await ListCache.load(store, ListCache.historyKey), isEmpty);

      store.values[ListCache.historyKey] = '[42, {"id": 7}, "junk"]';
      final rows = await ListCache.load(store, ListCache.historyKey);
      expect(rows.length, 1);
      expect(rows.first['id'], 7);
    });

    test('merge keeps fresh rows first, dedupes by id, caps to maxRows', () {
      final fresh = [
        {'id': 9, 'name': 'new'},
        {'id': 8, 'name': 'new8'},
      ];
      final cached = [
        {'id': 8, 'name': 'old8'},
        {'id': 7, 'name': 'old7'},
        {'id': 9, 'name': 'old9'},
      ];
      final merged = ListCache.merge(fresh, cached);
      expect(merged.map((r) => r['id']), [9, 8, 7]);
      expect(merged[0]['name'], 'new');
      expect(merged[1]['name'], 'new8');
    });

    test('keyOf prefers numeric id, falls back to raw json', () {
      expect(ListCache.keyOf({'id': 42}), '42');
      expect(ListCache.keyOf({'id': 'abc'}), 'abc');
      final k = ListCache.keyOf({'name': 'no-id'});
      expect(k, contains('no-id'));
    });
  });
}
