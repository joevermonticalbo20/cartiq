// The typed-quantity dialog: live validation with a visible inline error and
// a Set button that stays disabled until the number is usable.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/widgets/pos_quantity.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

  testWidgets('shows the exceeds-by message live and disables Set until fixed',
      (tester) async {
    await tester.pumpWidget(
      wrap(
        Center(
          child: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showPosQuantityDialog(
                context,
                quantity: 3,
                capacityLimit: 5,
                maxQuantity: 100,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // Type 6 (over the capacity of 5): the error appears immediately and
    // Set is disabled.
    await tester.enterText(find.byType(TextField), '6');
    await tester.pump();
    expect(find.text('Too many servings - remove 1 to stay within the '
        '200-unit limit. Set 5 or less.'), findsAtLeastNWidgets(1));
    final setButton = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Set'),
    );
    expect(setButton.onPressed, isNull);

    // Fix the number: the error clears and Set works again.
    await tester.enterText(find.byType(TextField), '5');
    await tester.pump();
    expect(find.text('Too many servings - remove 1 to stay within the '
        '200-unit limit. Set 5 or less.'), findsNothing);
    expect(
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Set')).onPressed,
      isNotNull,
    );
  });

  testWidgets('keeps Set enabled for a valid number', (tester) async {
    await tester.pumpWidget(
      wrap(
        Center(
          child: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showPosQuantityDialog(
                context,
                quantity: 2,
                capacityLimit: 10,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), '8');
    await tester.pump();
    expect(
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Set')).onPressed,
      isNotNull,
    );
  });
}
