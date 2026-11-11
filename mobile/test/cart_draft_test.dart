// The unfinished order must survive the app being closed mid-order.
//
// The vendor records an order over a few taps. If the app is killed (Android
// reclaiming memory, a battery pull, a crash) the cart used to vanish and the
// whole order had to be typed again. The draft is written on every change and
// read back on the next start.
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/cart_draft_store.dart';
import 'package:cartiq_mobile/services/kv_store.dart';
import 'package:cartiq_mobile/state/cart_state.dart';

class _FakeStore implements KeyValueStore {
  final Map<String, String?> values = {};

  @override
  Future<String?> read({required String key}) async => values[key];

  @override
  Future<void> write({required String key, required String? value}) async {
    values[key] = value;
  }

  @override
  Future<void> delete({required String key}) async {
    values.remove(key);
  }
}

void main() {
  group('cart draft', () {
    test('a saved cart comes back exactly as it was', () async {
      final store = _FakeStore();
      final draft = CartDraftStore(store);

      final cart = CartState();
      cart.add('BBQ Fries', 'Medium', 20, qty: 2, maxQty: 5);
      cart.addMixed('Cheese Fries', ['Cheese', 'BBQ'], 40, qty: 1);
      await draft.save(cart.items);

      final restored = await draft.load();
      expect(restored, hasLength(2));

      final fries = restored.firstWhere((it) => it.productName == 'BBQ Fries');
      expect(fries.flavor, 'Medium');
      expect(fries.qty, 2);
      expect(fries.unitPrice, 20);
      expect(fries.maxQty, 5);

      final mix = restored.firstWhere(
        (it) => it.productName == 'Cheese Fries',
      );
      expect(mix.flavors, ['BBQ', 'Cheese']);
      expect(mix.qty, 1);
      expect(mix.unitPrice, 40);
    });

    test('an empty cart deletes the draft instead of storing it', () async {
      final store = _FakeStore();
      final draft = CartDraftStore(store);

      final cart = CartState();
      cart.add('BBQ Fries', 'Medium', 20);
      await draft.save(cart.items);
      expect(store.values.containsKey(CartDraftStore.storageKey), isTrue);

      await draft.save(cart.items);
      cart.clear();
      await draft.save(cart.items);
      expect(store.values.containsKey(CartDraftStore.storageKey), isFalse);
      expect(await draft.load(), isEmpty);
    });

    test('a broken draft is ignored, never thrown', () async {
      final store = _FakeStore();
      final draft = CartDraftStore(store);

      store.values[CartDraftStore.storageKey] = 'not json at all';
      expect(await draft.load(), isEmpty);

      store.values[CartDraftStore.storageKey] = '{"items":"nope"}';
      expect(await draft.load(), isEmpty);

      store.values[CartDraftStore.storageKey] =
          '{"items":[{"productName":"BBQ Fries"}]}';
      // A line without a price is skipped; the rest survives.
      expect(await draft.load(), isEmpty);
    });

    test('a broken line does not take the good ones down', () async {
      final store = _FakeStore();
      final draft = CartDraftStore(store);
      store.values[CartDraftStore.storageKey] =
          '{"items":[{"productName":"BBQ Fries","unitPrice":20,"qty":2},'
          '{"productName":"Broken"}]}';

      final restored = await draft.load();
      expect(restored, hasLength(1));
      expect(restored.single.productName, 'BBQ Fries');
      expect(restored.single.qty, 2);
    });

    test('the cart is rebuilt from the draft and knows it was restored', () {
      final cart = CartState();
      expect(cart.restoredFromDraft, isFalse);

      cart.restoreFromDraft([
        CartItem(
          productName: 'BBQ Fries',
          flavor: 'Medium',
          unitPrice: 20,
          qty: 2,
        ),
      ]);
      expect(cart.items, hasLength(1));
      expect(cart.totalQty, 2);
      expect(cart.total, 40);
      expect(cart.restoredFromDraft, isTrue);
    });

    test('restoring an empty draft is not "restored"', () {
      final cart = CartState();
      cart.restoreFromDraft([]);
      expect(cart.isEmpty, isTrue);
      expect(cart.restoredFromDraft, isFalse);
    });
  });
}
