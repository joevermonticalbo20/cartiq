// A big order ("200 fries") must be typeable, and it must never be more
// than the stock on hand: the server would refuse the whole sale after the
// customer already paid.
import 'package:flutter/services.dart' show TextEditingValue, TextSelection;
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/quantity_input.dart';

void main() {
  group('QuantityInput', () {
    test('reads what the vendor typed', () {
      expect(QuantityInput.parse('200'), 200);
      expect(QuantityInput.parse('  12 '), 12);
      expect(QuantityInput.parse('1'), 1);
    });

    test('refuses what is not a whole number of at least one', () {
      expect(QuantityInput.parse(''), isNull);
      expect(QuantityInput.parse('   '), isNull);
      expect(QuantityInput.parse('0'), isNull);
      expect(QuantityInput.parse('-5'), isNull);
      expect(QuantityInput.parse('2.5'), isNull);
      expect(QuantityInput.parse('abc'), isNull);
      expect(QuantityInput.parse('1e3'), isNull);
    });

    test('refuses more than the stock and says why', () {
      expect(QuantityInput.error(200, max: 200), isNull);
      expect(
        QuantityInput.error(201, max: 200),
        'Only 200 left in stock',
      );
      expect(QuantityInput.error(5, max: 1), 'Only 1 left in stock');
      expect(QuantityInput.error(null), 'Enter a number');
      // No known ceiling: nothing to refuse.
      expect(QuantityInput.error(9999), isNull);
    });

    test('clamps into the range the stock allows', () {
      expect(QuantityInput.clamp(200, max: 200), 200);
      expect(QuantityInput.clamp(201, max: 200), 200);
      expect(QuantityInput.clamp(0, max: 200), 1);
      expect(QuantityInput.clamp(-3, max: 200), 1);
      expect(QuantityInput.clamp(50), 50);
      expect(QuantityInput.clamp(0), 1);
    });
  });

  group('StockInputFormatter', () {
    final formatter = const StockInputFormatter(max: 62);

    TextEditingValue v(String text) =>
        TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));

    test('allows whole numbers inside the stock', () {
      expect(formatter.formatEditUpdate(v(''), v('1')).text, '1');
      expect(formatter.formatEditUpdate(v('6'), v('62')).text, '62');
      expect(formatter.formatEditUpdate(v(''), v('62')).text, '62');
    });

    test('refuses the keystroke that would exceed the stock', () {
      // Typing "7" on top of "6" (stock 62 would make it 67) is refused.
      expect(formatter.formatEditUpdate(v('6'), v('67')).text, '6');
      // Pasting 9999 is refused entirely.
      expect(formatter.formatEditUpdate(v('6'), v('69999')).text, '6');
      // A whole order beyond the stock is rejected in one go.
      expect(formatter.formatEditUpdate(v(''), v('999')).text, '');
    });

    test('refuses non-digits and zero', () {
      expect(formatter.formatEditUpdate(v(''), v('0')).text, '');
      expect(formatter.formatEditUpdate(v('6'), v('a')).text, '6');
      expect(formatter.formatEditUpdate(v('6'), v('6.5')).text, '6');
      expect(formatter.formatEditUpdate(v('6'), v('-6')).text, '6');
      expect(formatter.formatEditUpdate(v('6'), v(' 6')).text, '6');
    });

    test('clearing the field is always allowed', () {
      expect(formatter.formatEditUpdate(v('62'), v('')).text, '');
    });

    test('null ceiling means no cap at the keystroke', () {
      const unbounded = StockInputFormatter();
      expect(unbounded.formatEditUpdate(v(''), v('99999')).text, '99999');
    });
  });
}
