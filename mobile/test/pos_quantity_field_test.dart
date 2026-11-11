// The typed quantity field: it takes a big order in one go and refuses what
// the stock cannot cover.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/widgets/pos_quantity.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  group('PosQuantityField', () {
    testWidgets('shows the current quantity and accepts a typed one', (
      tester,
    ) async {
      int? changed;
      await tester.pumpWidget(
        _wrap(
          PosQuantityField(
            quantity: 1,
            maxQuantity: 200,
            onChanged: (v) => changed = v,
          ),
        ),
      );

      expect(find.text('1'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '200');
      await tester.pump();

      expect(changed, 200);
    });

    testWidgets('refuses more than the stock and says why', (tester) async {
      var changed = 0;
      await tester.pumpWidget(
        _wrap(
          PosQuantityField(
            quantity: 1,
            maxQuantity: 200,
            onChanged: (_) => changed++,
          ),
        ),
      );

      await tester.enterText(find.byType(TextField), '201');
      await tester.pump();

      expect(changed, 0, reason: 'the stock must not be exceeded');
      expect(find.text('Only 200 left in stock'), findsOneWidget);
    });

    testWidgets('refuses zero and rubbish', (tester) async {
      var changed = 0;
      await tester.pumpWidget(
        _wrap(
          PosQuantityField(
            quantity: 1,
            maxQuantity: 200,
            onChanged: (_) => changed++,
          ),
        ),
      );

      await tester.enterText(find.byType(TextField), '0');
      await tester.pump();
      expect(changed, 0);
      expect(find.text('Enter a number'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'abc');
      await tester.pump();
      expect(changed, 0);
    });

    testWidgets('the - and + buttons move by one and stop at the stock', (
      tester,
    ) async {
      final changes = <int>[];
      await tester.pumpWidget(
        _wrap(
          PosQuantityField(
            quantity: 1,
            maxQuantity: 2,
            onChanged: changes.add,
          ),
        ),
      );

      await tester.tap(find.byIcon(Icons.add));
      await tester.pump();
      expect(changes, [2]);

      // At the ceiling the + button is dead: 2 is all the stock there is.
      await tester.pumpWidget(
        _wrap(
          PosQuantityField(
            quantity: 2,
            maxQuantity: 2,
            onChanged: changes.add,
          ),
        ),
      );
      final plus = tester.widget<Material>(
        find
            .ancestor(
              of: find.byIcon(Icons.add),
              matching: find.byType(Material),
            )
            .first,
      );
      final ink = plus.child as InkWell;
      expect(ink.onTap, isNull, reason: 'the + button is disabled at the stock');
    });
  });
}
