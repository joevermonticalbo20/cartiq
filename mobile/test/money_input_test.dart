import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/money_input.dart';

void main() {
  group('MoneyInput.sanitize', () {
    test('passes normal amounts through', () {
      expect(MoneyInput.sanitize('40'), '40');
      expect(MoneyInput.sanitize('1234.56'), '1234.56');
    });

    test('caps integer part at 7 digits', () {
      expect(MoneyInput.sanitize('111111111111111111'), '1111111');
    });

    test('caps decimals at 2 places', () {
      expect(MoneyInput.sanitize('10.999'), '10.99');
    });

    test('keeps a single dot and drops other characters', () {
      expect(MoneyInput.sanitize('12.3.4'), '12.34');
      expect(MoneyInput.sanitize('P1,200.50'), '1200.50');
    });

    test('preserves partial typing states', () {
      expect(MoneyInput.sanitize(''), '');
      expect(MoneyInput.sanitize('12.'), '12.');
    });
  });

  group('MoneyInput.tryParse', () {
    test('parses valid amounts', () {
      expect(MoneyInput.tryParse('40'), 40);
      expect(MoneyInput.tryParse('10.5'), 10.5);
    });

    test('rejects empty, negative, and over-cap values', () {
      expect(MoneyInput.tryParse(''), isNull);
      expect(MoneyInput.tryParse('abc'), isNull);
      expect(MoneyInput.tryParse('-5'), isNull);
      expect(MoneyInput.tryParse('10000000'), isNull);
      expect(MoneyInput.tryParse('9999999.99'), 9999999.99);
    });
  });

  group('MoneyInputFormatter', () {
    final formatter = MoneyInputFormatter();

    TextEditingValue edit(String text) => formatter.formatEditUpdate(
          const TextEditingValue(),
          TextEditingValue(text: text),
        );

    test('leaves valid input untouched', () {
      expect(edit('250.75').text, '250.75');
    });

    test('trims over-limit input', () {
      expect(edit('12345678').text, '1234567');
      expect(edit('10.999').text, '10.99');
    });
  });
}
