// A big order ("200 fries") must be typeable, and it must never be more
// than the stock on hand: the server would refuse the whole sale after the
// customer already paid.
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
}
