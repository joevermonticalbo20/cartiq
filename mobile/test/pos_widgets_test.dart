import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/state/cart_state.dart';
import 'package:cartiq_mobile/widgets/pos_cart_widgets.dart';
import 'package:cartiq_mobile/widgets/pos_product_card.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

Map<String, dynamic> _product() => {
      'name': 'Cheese Fries',
      'basePrice': 59,
      'category': 'Fries',
      'flavors': [
        {'name': 'Cheese'},
        {'name': 'BBQ'},
      ],
    };

void main() {
  group('PosProductCard', () {
    testWidgets('renders name, price and flavor count', (tester) async {
      await tester.pumpWidget(_wrap(PosProductCard(
        product: _product(),
        flavorCount: 2,
        inCartQty: 0,
        onTap: () {},
      )));
      expect(find.text('Cheese Fries'), findsOneWidget);
      expect(find.text('₱59'), findsOneWidget);
      expect(find.text('2 flavors'), findsOneWidget);
    });

    testWidgets('shows cart badge when in cart', (tester) async {
      await tester.pumpWidget(_wrap(PosProductCard(
        product: _product(),
        flavorCount: 2,
        inCartQty: 3,
        onTap: () {},
      )));
      expect(find.text('3'), findsOneWidget);
    });

    testWidgets('quick-add renders for flavorless products',
        (tester) async {
      var tapped = false;
      await tester.pumpWidget(_wrap(PosProductCard(
        product: {'name': 'Plain', 'basePrice': 49},
        flavorCount: 0,
        inCartQty: 0,
        onTap: () {},
        onQuickAdd: () => tapped = true,
      )));
      expect(find.text('tap to add'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.add));
      expect(tapped, isTrue);
    });
  });

  group('PosQtyButton', () {
    testWidgets('disabled state renders without crashing', (tester) async {
      await tester.pumpWidget(_wrap(const PosQtyButton(
        icon: Icons.remove,
        onPressed: null,
      )));
      expect(find.byIcon(Icons.remove), findsOneWidget);
    });

    testWidgets('fires callback on tap', (tester) async {
      var tapped = false;
      await tester.pumpWidget(_wrap(PosQtyButton(
        icon: Icons.add,
        onPressed: () => tapped = true,
      )));
      await tester.tap(find.byIcon(Icons.add));
      expect(tapped, isTrue);
    });
  });

  group('PosCartBar', () {
    testWidgets('empty order shows placeholder', (tester) async {
      await tester.pumpWidget(_wrap(PosCartBar(
        cart: CartState(),
        onTap: () {},
      )));
      expect(find.text('Order empty'), findsOneWidget);
    });

    testWidgets('filled cart shows qty and total', (tester) async {
      final cart = CartState();
      cart.add('Cheese Fries', 'Cheese', 59);
      cart.add('Cheese Fries', 'Cheese', 59);
      await tester.pumpWidget(_wrap(PosCartBar(cart: cart, onTap: () {})));
      expect(find.text('2 items'), findsOneWidget);
      expect(find.text('₱118'), findsOneWidget);
    });
  });

  group('PosOfflineStrip', () {
    testWidgets('hidden when queue is empty', (tester) async {
      await tester.pumpWidget(_wrap(const PosOfflineStrip()));
      await tester.pump();
      // No queued sales seeded: strip collapses to nothing.
      expect(find.textContaining('waiting to sync'), findsNothing);
    });
  });
}
