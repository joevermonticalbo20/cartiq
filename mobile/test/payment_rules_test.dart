// The cash the customer hands over has two limits: it can never be less
// than the total, and it can never be more than the total plus the biggest
// change the stall can hand back.
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/payment_rules.dart';

void main() {
  group('PaymentRules', () {
    test('the biggest cash for a total is the total plus the change limit', () {
      expect(PaymentRules.maxCashFor(50), 1050);
      expect(PaymentRules.maxCashFor(900), 1900);
      expect(PaymentRules.maxCashFor(1500), 2500);
    });

    test('accepts the exact total and anything up to the limit', () {
      expect(PaymentRules.cashError(50, 50), isNull);
      expect(PaymentRules.cashError(50, 100), isNull);
      expect(PaymentRules.cashError(50, 1050), isNull);
      expect(PaymentRules.cashError(900, 900), isNull);
      expect(PaymentRules.cashError(1500, 2500), isNull);
    });

    test('refuses less than the total', () {
      expect(PaymentRules.cashError(50, 49), isNotNull);
      expect(PaymentRules.cashError(900, 899), isNotNull);
      expect(PaymentRules.cashError(50, 0), isNotNull);
    });

    test('refuses more than the total plus the change limit', () {
      expect(PaymentRules.cashError(50, 1051), isNotNull);
      expect(PaymentRules.cashError(900, 1901), isNotNull);
      expect(PaymentRules.cashError(1500, 2501), isNotNull);
    });

    test('an empty field is not an error - it is just not typed yet', () {
      expect(PaymentRules.cashError(50, null), isNull);
    });

    test('the quick amounts follow the total', () {
      // A 15-peso dip: the notes a customer would hand over.
      expect(
        PaymentRules.quickCashAmounts(15),
        [15, 50, 100, 200, 500, 1000],
      );
      // A 240 order: the notes above it, not the ones below.
      expect(
        PaymentRules.quickCashAmounts(240),
        [240, 500, 1000],
      );
      // A 2000 order: only the exact amount and the notes above it.
      expect(PaymentRules.quickCashAmounts(2000), [2000]);
    });

    test('the quick amounts never go past the cash limit', () {
      final amounts = PaymentRules.quickCashAmounts(100);
      for (final amount in amounts) {
        expect(amount, lessThanOrEqualTo(PaymentRules.maxCashFor(100)));
      }
    });
  });
}
