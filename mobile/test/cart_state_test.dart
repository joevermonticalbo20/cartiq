import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/state/cart_state.dart';

void main() {
  group('CartState', () {
    test('add creates a line with qty 1', () {
      final cart = CartState();
      cart.add('Flavored Fries', 'Cheese', 40);
      expect(cart.items, hasLength(1));
      expect(cart.totalQty, 1);
      expect(cart.total, 40);
    });

    test('re-adding same product+flavor increments qty', () {
      final cart = CartState();
      cart.add('Flavored Fries', 'Cheese', 40);
      cart.add('Flavored Fries', 'Cheese', 40);
      expect(cart.items, hasLength(1));
      expect(cart.items.first.qty, 2);
      expect(cart.total, 80);
    });

    test('same product different flavor is a separate line', () {
      final cart = CartState();
      cart.add('Flavored Fries', 'Cheese', 40);
      cart.add('Flavored Fries', 'BBQ', 40);
      expect(cart.items, hasLength(2));
      expect(cart.totalQty, 2);
    });

    test('mixed flavors have one item price and equal recipe shares', () {
      final cart = CartState();
      cart.addMixed('Flavored Fries', ['Cheese', 'BBQ'], 40, qty: 2);

      expect(cart.items, hasLength(1));
      expect(cart.totalQty, 2);
      expect(cart.total, 80);
      expect(cart.items.single.toJson()['flavorShares'], [
        {'flavor': 'BBQ', 'share': 0.5},
        {'flavor': 'Cheese', 'share': 0.5},
      ]);
    });

    test('mixed cart key ignores flavor selection order', () {
      final cart = CartState();
      cart.addMixed('Flavored Fries', ['Cheese', 'BBQ'], 40);
      cart.addMixed('Flavored Fries', ['BBQ', 'Cheese'], 40);

      expect(cart.items, hasLength(1));
      expect(cart.items.single.qty, 2);
    });

    test('changeQty to zero removes the line', () {
      final cart = CartState();
      cart.add('Flavored Fries', 'Cheese', 40);
      cart.changeQty(cart.items.first, -1);
      expect(cart.isEmpty, isTrue);
    });

    test('clear empties the cart', () {
      final cart = CartState();
      cart.add('Flavored Fries', 'Cheese', 40);
      cart.add('Flavored Fries', 'BBQ', 40);
      cart.clear();
      expect(cart.isEmpty, isTrue);
      expect(cart.total, 0);
    });

    test('restores a stock-rejected mixed order for editing', () {
      final cart = CartState();
      cart.restoreRejectedOrder({
        'items': [
          {
            'productName': 'Flavored Fries',
            'flavor': 'BBQ + Cheese',
            'qty': 2,
            'unitPrice': 40,
            'flavorShares': [
              {'flavor': 'BBQ', 'share': 0.5},
              {'flavor': 'Cheese', 'share': 0.5},
            ],
          },
        ],
      });

      expect(cart.items, hasLength(1));
      expect(cart.items.single.qty, 2);
      expect(cart.items.single.flavors, ['BBQ', 'Cheese']);
      expect(cart.total, 80);
    });

    test('CartItem key distinguishes null flavor', () {
      final a = CartItem(productName: 'Fries', flavor: null, unitPrice: 40);
      final b = CartItem(productName: 'Fries', flavor: 'Cheese', unitPrice: 40);
      expect(a.key, isNot(b.key));
      expect(a.lineTotal, 40);
    });
  });
}
