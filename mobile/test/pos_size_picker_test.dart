import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/sizes.dart';
import 'package:cartiq_mobile/widgets/pos_cart_widgets.dart';
import 'package:cartiq_mobile/widgets/pos_product_card.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

/// The catalog shape of a fries parent: the options are the SIZES.
List<Map<String, dynamic>> _sizes() => [
  {
    'name': 'Medium',
    'unitPrice': 20,
    'availableServings': 143,
    'isAvailable': true,
  },
  {
    'name': 'Large',
    'unitPrice': 30,
    'availableServings': 148,
    'isAvailable': true,
  },
  {
    'name': 'XL 40',
    'unitPrice': 40,
    'availableServings': 148,
    'isAvailable': true,
  },
  {
    'name': 'XL 50',
    'unitPrice': 50,
    'availableServings': 0,
    'isAvailable': false,
  },
];

Map<String, dynamic> _friesProduct() => {
  'name': 'BBQ Fries',
  'basePrice': 20,
  'category': 'Fries',
  'flavors': _sizes(),
};

void main() {
  group('size detection', () {
    test('every option is a size -> the size sheet is used', () {
      expect(optionsAreSizes(_sizes()), isTrue);
      expect(isPosSize('Medium'), isTrue);
      expect(isPosSize('XL 40'), isTrue);
      expect(isPosSize('Cheese'), isFalse);
    });

    test('real flavors are not sizes', () {
      expect(
        optionsAreSizes([
          {'name': 'Cheese'},
          {'name': 'BBQ'},
        ]),
        isFalse,
      );
      expect(optionsAreSizes([]), isFalse);
    });
  });

  group('PosSizePicker', () {
    testWidgets('shows every size with its price', (tester) async {
      await tester.pumpWidget(
        _wrap(
          PosSizePicker(
            sizes: _sizes(),
            selected: null,
            onSelect: (_) {},
            onQuantityChanged: (_, _) {},
          ),
        ),
      );

      expect(find.text('Medium'), findsOneWidget);
      expect(find.text('Large'), findsOneWidget);
      expect(find.text('XL 40'), findsOneWidget);
      expect(find.text('XL 50'), findsOneWidget);
      expect(find.text('₱20'), findsOneWidget);
      expect(find.text('₱30'), findsOneWidget);
      expect(find.text('₱40'), findsOneWidget);
      expect(find.text('₱50'), findsOneWidget);
      expect(find.textContaining('servings left'), findsWidgets);
    });

    testWidgets('marks the out-of-stock size and blocks it', (tester) async {
      String? picked;
      await tester.pumpWidget(
        _wrap(
          PosSizePicker(
            sizes: _sizes(),
            selected: null,
            onSelect: (name) => picked = name,
            onQuantityChanged: (_, _) {},
          ),
        ),
      );

      expect(find.text('Out of stock'), findsOneWidget);
      await tester.tap(find.text('XL 50'));
      await tester.pump();
      expect(picked, isNull, reason: 'an out-of-stock size must not be picked');
    });

    testWidgets('picking a size reports it', (tester) async {
      String? picked;
      await tester.pumpWidget(
        _wrap(
          PosSizePicker(
            sizes: _sizes(),
            selected: null,
            onSelect: (name) => picked = name,
            onQuantityChanged: (_, _) {},
          ),
        ),
      );

      await tester.tap(find.text('Large'));
      await tester.pump();
      expect(picked, 'Large');
    });
  });

  group('PosSizeSelectionBar', () {
    testWidgets('is disabled until a size is picked', (tester) async {
      var added = false;
      await tester.pumpWidget(
        _wrap(
          PosSizeSelectionBar(
            sizeName: null,
            quantity: 0,
            total: 0,
            onAdd: () => added = true,
          ),
        ),
      );

      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, isNull);

      await tester.pumpWidget(
        _wrap(
          PosSizeSelectionBar(
            sizeName: 'Medium',
            quantity: 2,
            total: 40,
            onAdd: () => added = true,
          ),
        ),
      );
      expect(find.textContaining('2 × Medium'), findsOneWidget);
      expect(find.textContaining('₱40.00'), findsOneWidget);

      await tester.tap(find.byType(FilledButton));
      await tester.pump();
      expect(added, isTrue);
    });
  });

  group('PosProductCard price', () {
    testWidgets('shows a range when the sizes cost different amounts', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          PosProductCard(
            product: _friesProduct(),
            inCartQty: 0,
            onTap: () {},
            onQuickAdd: null,
          ),
        ),
      );

      expect(find.text('₱20–50'), findsOneWidget);
    });

    testWidgets('shows one price when there are no options', (tester) async {
      await tester.pumpWidget(
        _wrap(
          PosProductCard(
            product: {
              'name': 'Barbecue Dip',
              'basePrice': 15,
              'category': 'Add-ons',
            },
            inCartQty: 0,
            onTap: () {},
            onQuickAdd: null,
          ),
        ),
      );

      expect(find.text('₱15'), findsOneWidget);
    });
  });
}
