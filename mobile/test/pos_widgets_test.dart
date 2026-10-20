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
      await tester.pumpWidget(
        _wrap(
          PosProductCard(
            product: _product(),
            flavorCount: 2,
            inCartQty: 0,
            onTap: () {},
          ),
        ),
      );
      expect(find.text('Cheese Fries'), findsOneWidget);
      expect(find.text('₱59'), findsOneWidget);
      expect(find.text('2 flavors'), findsOneWidget);
    });

    testWidgets('shows cart badge when in cart', (tester) async {
      await tester.pumpWidget(
        _wrap(
          PosProductCard(
            product: _product(),
            flavorCount: 2,
            inCartQty: 3,
            onTap: () {},
          ),
        ),
      );
      expect(find.text('3'), findsOneWidget);
    });

    testWidgets(
      'grays out sold-out flavors and restores interaction on refresh',
      (tester) async {
        var taps = 0;
        var product = {
          ..._product(),
          'isAvailable': false,
          'availableServings': 0,
          'flavors': [
            {'name': 'Cheese', 'isAvailable': false, 'availableServings': 0},
            {'name': 'BBQ', 'isAvailable': false, 'availableServings': 0},
          ],
        };
        await tester.pumpWidget(
          _wrap(
            PosProductCard(
              product: product,
              flavorCount: 2,
              inCartQty: 0,
              onTap: () => taps++,
            ),
          ),
        );

        expect(find.text('Out of Stock'), findsOneWidget);
        await tester.tap(find.text('Cheese Fries'));
        expect(taps, 0);

        product = {
          ...product,
          'isAvailable': true,
          'availableServings': 4,
          'flavors': [
            {'name': 'Cheese', 'isAvailable': true, 'availableServings': 4},
            {'name': 'BBQ', 'isAvailable': false, 'availableServings': 0},
          ],
        };
        await tester.pumpWidget(
          _wrap(
            PosProductCard(
              product: product,
              flavorCount: 2,
              inCartQty: 0,
              onTap: () => taps++,
            ),
          ),
          );
          await tester.tap(find.text('Cheese Fries'));
          expect(taps, 1);
      },
    );

    testWidgets('warns when ten or fewer servings remain', (tester) async {
      await tester.pumpWidget(
        _wrap(
          PosProductCard(
            product: {
              ..._product(),
              'isAvailable': true,
              'availableServings': 10,
              'flavors': [
                {
                  'name': 'Cheese',
                  'isAvailable': true,
                  'availableServings': 10,
                },
                {'name': 'BBQ', 'isAvailable': true, 'availableServings': 12},
              ],
            },
            flavorCount: 2,
            inCartQty: 0,
            onTap: () {},
          ),
        ),
      );
      expect(find.text('10 servings left'), findsOneWidget);
    });

    testWidgets('quick-add renders for flavorless products', (tester) async {
      var tapped = false;
      await tester.pumpWidget(
        _wrap(
          PosProductCard(
            product: {'name': 'Plain', 'basePrice': 49},
            flavorCount: 0,
            inCartQty: 0,
            onTap: () {},
            onQuickAdd: () => tapped = true,
          ),
        ),
      );
      expect(find.text('tap to add'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.add));
      expect(tapped, isTrue);
    });

    testWidgets('tapping product opens the flavor picker bottom sheet', (
      tester,
    ) async {
      final flavors = [
        {'name': 'Cheese', 'isAvailable': true, 'availableServings': 8},
        {'name': 'BBQ', 'isAvailable': true, 'availableServings': 5},
      ];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => PosProductCard(
                product: _product(),
                flavorCount: 2,
                inCartQty: 0,
                onTap: () => showModalBottomSheet<void>(
                  context: context,
                  builder: (sheetContext) {
                    final selected = <String, int>{};
                    return StatefulBuilder(
                      builder: (context, setState) => Padding(
                        padding: const EdgeInsets.all(24),
                        child: PosFlavorPicker(
                          flavors: flavors,
                          selectedQuantities: Map.unmodifiable(selected),
                          onToggle: (name) => setState(() {
                            if (selected.containsKey(name)) {
                              selected.remove(name);
                            } else {
                              selected[name] = 1;
                            }
                          }),
                          onQuantityChanged: (name, quantity) =>
                              setState(() => selected[name] = quantity),
                          onQuickAdd: (name, amount) =>
                              setState(() => selected[name] = amount),
                        ),
                      ),
                    );
                  },
                ),
              ),
            ),
          ),
        ),
      );

      expect(find.text('Cheese Fries'), findsOneWidget);
      expect(find.byType(ChoiceChip), findsNothing);
      await tester.tap(find.text('Cheese Fries'));
      await tester.pumpAndSettle();
      expect(find.text('Choose flavors'), findsOneWidget);
      expect(find.byType(ChoiceChip), findsNWidgets(2));
      await tester.tap(find.text('Cheese • 8 left'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('BBQ • 5 left'));
      await tester.pumpAndSettle();
      expect(find.text('Cheese'), findsOneWidget);
      expect(find.text('BBQ'), findsOneWidget);
    });

    testWidgets('depleted flavors are disabled in the picker', (
      tester,
    ) async {
      var selected = false;
      await tester.pumpWidget(
        _wrap(
          PosFlavorPicker(
            flavors: const [
              {'name': 'Cheese', 'isAvailable': false, 'availableServings': 0},
              {'name': 'BBQ', 'isAvailable': true, 'availableServings': 5},
            ],
            selectedQuantities: const {},
            onToggle: (_) => selected = true,
            onQuantityChanged: (_, _) {},
            onQuickAdd: (_, _) {},
          ),
        ),
      );

      await tester.tap(find.text('Cheese • Out of Stock'));
      expect(selected, isFalse);
    });
  });

  group('PosQtyButton', () {
    testWidgets('disabled state renders without crashing', (tester) async {
      await tester.pumpWidget(
        _wrap(const PosQtyButton(icon: Icons.remove, onPressed: null)),
      );
      expect(find.byIcon(Icons.remove), findsOneWidget);
    });

    testWidgets('fires callback on tap', (tester) async {
      var tapped = false;
      await tester.pumpWidget(
        _wrap(PosQtyButton(icon: Icons.add, onPressed: () => tapped = true)),
      );
      await tester.tap(find.byIcon(Icons.add));
      expect(tapped, isTrue);
    });
  });

  group('PosCartBar', () {
    testWidgets('empty order shows placeholder', (tester) async {
      await tester.pumpWidget(
        _wrap(PosCartBar(cart: CartState(), onTap: () {})),
      );
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
