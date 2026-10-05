// The queue must never be the reason the POS cannot start or cannot ring up
// a sale. These cover the degraded path taken when sqflite cannot open
// cartiq_queue.db: records are held in memory instead, so the app still runs
// and orders still queue - they just do not survive a restart.
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/offline_queue.dart';
import 'package:cartiq_mobile/services/persisted_queue.dart';

QueuedRecord rec(String id, {int minute = 0}) => QueuedRecord(
      id: id,
      kind: 'order',
      payload: {'clientRef': id},
      createdAt: DateTime(2026, 1, 1, 10, minute),
    );

void main() {
  group('PersistedOfflineQueue degraded mode', () {
    late PersistedOfflineQueue q;

    setUp(() {
      q = PersistedOfflineQueue.forTesting()..debugForceDegraded('open failed');
    });

    test('reports degraded and keeps the reason', () {
      expect(q.isDegraded, isTrue);
      expect(q.degradedReason, 'open failed');
    });

    test('enqueue does NOT throw when SQLite is unavailable', () async {
      // The old contract threw StateError here, which propagated out of
      // main() before runApp() and produced a blank white window.
      await expectLater(q.enqueue(rec('a')), completes);
      expect(await q.count, 1);
    });

    test('pending returns records oldest-first (FIFO)', () async {
      await q.enqueue(rec('first', minute: 0));
      await q.enqueue(rec('second', minute: 5));
      await q.enqueue(rec('third', minute: 2));
      final ids = (await q.pending()).map((r) => r.id).toList();
      expect(ids, ['first', 'third', 'second']);
    });

    test('re-enqueueing the same id replaces rather than duplicates', () async {
      await q.enqueue(rec('dup'));
      await q.enqueue(rec('dup', minute: 9));
      expect(await q.count, 1);
      expect((await q.pending()).single.createdAt.minute, 9);
    });

    test('remove drops only the targeted record', () async {
      await q.enqueue(rec('keep'));
      await q.enqueue(rec('drop'));
      await q.remove('drop');
      expect((await q.pending()).map((r) => r.id), ['keep']);
      expect(await q.count, 1);
    });

    test('removing an unknown id is a safe no-op', () async {
      await q.enqueue(rec('a'));
      await expectLater(q.remove('nope'), completes);
      expect(await q.count, 1);
    });

    test('payload survives the round trip intact', () async {
      final r = QueuedRecord(
        id: 'p1',
        kind: 'order',
        payload: {
          'clientRef': 'abc',
          'locationCode': 'CART-01',
          'total': 118.0,
          'items': [
            {'productName': 'Cheese Fries', 'flavor': 'Cheese', 'qty': 2}
          ],
        },
      );
      await q.enqueue(r);
      final back = (await q.pending()).single;
      expect(back.payload['clientRef'], 'abc');
      expect(back.payload['total'], 118.0);
      expect((back.payload['items'] as List).length, 1);
      expect(back.payload['locationCode'], 'CART-01');
    });

    test('changes stream emits the running count', () async {
      final seen = <int>[];
      final sub = q.changes.listen(seen.add);
      await q.enqueue(rec('x'));
      await q.enqueue(rec('y'));
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();
      expect(seen, containsAllInOrder([1, 2]));
    });

    test('a degraded queue still satisfies the OfflineQueue contract', () {
      expect(q, isA<OfflineQueue>());
    });
  });
}