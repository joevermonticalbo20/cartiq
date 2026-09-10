import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/screens/pos_screen.dart';
import 'package:cartiq_mobile/services/offline_queue.dart';
import 'package:cartiq_mobile/state/cart_state.dart';

class _FakeQueue implements OfflineQueue {
  final List<QueuedRecord> items = [];
  bool throwOnEnqueue = false;

  @override
  Stream<int> get changes => const Stream<int>.empty();

  @override
  Future<void> enqueue(QueuedRecord record) async {
    if (throwOnEnqueue) throw StateError('disk unavailable');
    items.add(record);
  }

  @override
  Future<List<QueuedRecord>> pending() async => List.of(items);

  @override
  Future<void> remove(String id) async {
    items.removeWhere((r) => r.id == id);
  }

  @override
  Future<int> get count async => items.length;
}

CartState _cartWithSale() {
  final cart = CartState();
  cart.add('Flavored Fries', 'Cheese', 40);
  cart.add('Flavored Fries', 'Cheese', 40);
  cart.add('Flavored Fries', 'BBQ', 40);
  return cart;
}

Map<String, dynamic> _payload(CartState cart) => {
      'clientRef': 'ref-1',
      'locationCode': 'CART-01',
      'items': cart.items.map((it) => it.toJson()).toList(),
      'total': cart.total,
      'status': 'PAID',
      'paymentMethod': 'CASH',
    };

void main() {
  group('persistCheckout', () {
    test('success persists payload then clears cart', () async {
      final cart = _cartWithSale();
      final queue = _FakeQueue();

      final payload = await persistCheckout(
        cart: cart,
        queue: queue,
        buildPayload: () => _payload(cart),
      );

      expect(cart.isEmpty, isTrue);
      expect(await queue.count, 1);
      expect(payload['paymentMethod'], 'CASH');
      expect(payload['total'], 120.0);
      final queued = (await queue.pending()).single;
      expect(queued.id, 'ref-1');
      expect(queued.kind, 'order');
      // Same flavor re-adds bump qty: 2 lines (Cheese x2, BBQ x1).
      expect((queued.payload['items'] as List), hasLength(2));
    });

    test('enqueue failure leaves cart exactly unchanged', () async {
      final cart = _cartWithSale();
      final before =
          cart.items.map((it) => Map<String, dynamic>.from(it.toJson())).toList();
      final queue = _FakeQueue()..throwOnEnqueue = true;

      await expectLater(
        persistCheckout(
          cart: cart,
          queue: queue,
          buildPayload: () => _payload(cart),
        ),
        throwsStateError,
      );

      expect(await queue.count, 0);
      expect(cart.items.map((it) => it.toJson()).toList(), before);
      expect(cart.total, 120.0);
      expect(cart.totalQty, 3);
    });

    test('payload build failure leaves cart and queue untouched', () async {
      final cart = _cartWithSale();
      final queue = _FakeQueue();

      await expectLater(
        persistCheckout(
          cart: cart,
          queue: queue,
          buildPayload: () => throw FormatException('bad payload'),
        ),
        throwsFormatException,
      );

      expect(cart.totalQty, 3);
      expect(await queue.count, 0);
    });
  });
}
