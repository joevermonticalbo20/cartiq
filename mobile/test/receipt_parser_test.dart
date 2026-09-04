import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/receipt_scanner.dart';

void main() {
  group('parseReceiptText', () {
    test('vendor is the first short alphabetic line', () {
      final parsed = parseReceiptText('POTA FRIES SUPPLY\n123 Main St\nP250.00');
      expect(parsed.vendor, 'POTA FRIES SUPPLY');
    });

    test('amount prefers the total line over larger values', () {
      final parsed = parseReceiptText(
        'VENDOR\nItem A P500.00\nTOTAL P250.00',
      );
      expect(parsed.amount, 250.0);
    });

    test('amount falls back to largest money value without total', () {
      final parsed = parseReceiptText('VENDOR\nBread P45.50\nCheese P120.00');
      expect(parsed.amount, 120.0);
    });

    test('date extracts yyyy-mm-dd token', () {
      final parsed = parseReceiptText('VENDOR\nDate: 2026-08-30\nP100.00');
      expect(parsed.dateText, '2026-08-30');
    });

    test('date extracts dd/mm/yyyy token', () {
      final parsed = parseReceiptText('VENDOR\n30/08/2026\nP100.00');
      expect(parsed.dateText, '30/08/2026');
    });

    test('empty text yields empty vendor and null amount', () {
      final parsed = parseReceiptText('');
      expect(parsed.vendor, isEmpty);
      expect(parsed.amount, isNull);
    });

    test('quantity-like numbers on non-total lines do not crash', () {
      final parsed = parseReceiptText('VENDOR\n2x fries\nP80.00');
      expect(parsed.amount, 80.0);
    });
  });
}
