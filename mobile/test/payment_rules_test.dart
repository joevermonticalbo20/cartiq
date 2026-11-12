// The cash the customer hands over is capped at the next round amount above
// the total - and the field only takes whole pesos.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/digits_input.dart';
import 'package:cartiq_mobile/utils/payment_rules.dart';

void main() {
  group('PaymentRules - the cash ceiling', () {
    test('a small order may take the biggest note in the till', () {
      // A P15 dip: the vendor may type up to P1,000.
      expect(PaymentRules.maxCashFor(15), 1000);
      expect(PaymentRules.maxCashFor(50), 1000);
      expect(PaymentRules.maxCashFor(990), 1000);
    });

    test('a bigger order steps up to the next round amount', () {
      expect(PaymentRules.maxCashFor(1500), 2000);
      expect(PaymentRules.maxCashFor(1700), 2000);
      expect(PaymentRules.maxCashFor(1990), 2000);
      expect(PaymentRules.maxCashFor(2000), 3000);
    });

    test('the exact amount is always payable', () {
      for (final total in [15.0, 990.0, 1500.0, 1700.0, 2000.0]) {
        expect(
          PaymentRules.cashError(total, total),
          isNull,
          reason: 'the exact total of $total must be allowed',
        );
      }
    });

    test('less than the total is refused', () {
      expect(PaymentRules.cashError(990, 989), isNotNull);
      expect(PaymentRules.cashError(15, 0), isNotNull);
    });

    test('more than the ceiling is refused', () {
      expect(PaymentRules.cashError(990, 1001), isNotNull);
      expect(PaymentRules.cashError(990, 2000), isNotNull);
      expect(PaymentRules.cashError(1700, 3000), isNotNull);
      expect(PaymentRules.cashError(15, 1001), isNotNull);
    });

    test('the error names the ceiling and the order', () {
      final message = PaymentRules.cashError(990, 2000) ?? '';
      expect(message, contains('1000'));
      expect(message, contains('990'));
    });

    test('the field length follows the ceiling', () {
      expect(PaymentRules.maxDigits(15), 4); // up to 1000
      expect(PaymentRules.maxDigits(990), 4);
      expect(PaymentRules.maxDigits(1700), 4); // up to 2000
      expect(PaymentRules.maxDigits(2500), 4); // up to 3000
    });

    test('the quick amounts are only the ones that can be used', () {
      // A dip: exact plus the notes above it.
      final dip = PaymentRules.quickCashAmounts(15);
      expect(dip.first, 15);
      expect(dip, contains(20));
      expect(dip, contains(50));
      for (final amount in dip) {
        expect(amount, lessThanOrEqualTo(PaymentRules.maxCashFor(15)));
      }

      // A P990 order: exact plus P1,000 - nothing below the total.
      final fries = PaymentRules.quickCashAmounts(990);
      expect(fries, [990, 1000]);

      // A P1,700 order: exact plus P2,000.
      expect(PaymentRules.quickCashAmounts(1700), [1700, 2000]);
    });
  });

  group('DigitsOnlyFormatter', () {
    TextEditingValue apply(String text, {int maxDigits = 7}) {
      const formatter = DigitsOnlyFormatter(maxDigits: 7);
      final f = DigitsOnlyFormatter(maxDigits: maxDigits);
      return f.formatEditUpdate(
        const TextEditingValue(),
        TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: text.length),
        ),
      );
    }

    test('refuses cents instead of turning 15.50 into 1550', () {
      const formatter = DigitsOnlyFormatter();
      const before = TextEditingValue(
        text: '15',
        selection: TextSelection.collapsed(offset: 2),
      );
      final after = formatter.formatEditUpdate(
        before,
        const TextEditingValue(
          text: '15.',
          selection: TextSelection.collapsed(offset: 3),
        ),
      );
      expect(after.text, '15');
    });

    test('cuts the text at the digit limit', () {
      final after = apply('10000', maxDigits: 4);
      expect(after.text, '1000');
    });

    test('keeps a normal amount', () {
      expect(apply('990').text, '990');
      expect(apply('1').text, '1');
    });
  });
}
