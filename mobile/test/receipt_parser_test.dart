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

    test('amount parses US thousands style', () {
      final parsed = parseReceiptText('VENDOR\nTOTAL P1,234.50');
      expect(parsed.amount, 1234.5);
    });

    test('amount parses European thousands style', () {
      final parsed = parseReceiptText('VENDOR\nTOTAL P1.234,50');
      expect(parsed.amount, 1234.5);
    });

    test('amount parses decimal comma without thousands', () {
      final parsed = parseReceiptText('VENDOR\nTOTAL 80,50');
      expect(parsed.amount, 80.5);
    });

    test('amount parses plain thousands comma', () {
      final parsed = parseReceiptText('VENDOR\nTOTAL P1,250');
      expect(parsed.amount, 1250.0);
    });

    test('date extracts month-name tokens', () {
      expect(
        parseReceiptText('VENDOR\n12 Sep 2026\nP100.00').dateText,
        '12 Sep 2026',
      );
      expect(
        parseReceiptText('VENDOR\nSep 12, 2026\nP100.00').dateText,
        'Sep 12, 2026',
      );
    });
  });

  group('parseMoneyToken', () {
    test('both thousand styles', () {
      expect(parseMoneyToken('1,234.50'), 1234.5);
      expect(parseMoneyToken('1.234,50'), 1234.5);
      expect(parseMoneyToken('1234.50'), 1234.5);
    });

    test('lone comma follows decimal-vs-thousands rule', () {
      expect(parseMoneyToken('1,25'), 1.25);
      expect(parseMoneyToken('1,250'), 1250.0);
    });

    test('rejects empty, zero, and absurd values', () {
      expect(parseMoneyToken(''), isNull);
      expect(parseMoneyToken('0'), isNull);
      expect(parseMoneyToken('9999999'), isNull);
      expect(parseMoneyToken('abc'), isNull);
    });
  });

  group('parseReceiptDate', () {
    test('ISO dates', () {
      expect(parseReceiptDate('2026-09-11'), DateTime(2026, 9, 11));
    });

    test('numeric local dates', () {
      expect(parseReceiptDate('11/09/2026'), DateTime(2026, 9, 11));
      expect(parseReceiptDate('11-09-26'), DateTime(2026, 9, 11));
    });

    test('month-name dates', () {
      expect(parseReceiptDate('12 Sep 2026'), DateTime(2026, 9, 12));
      expect(parseReceiptDate('Sep 12, 2026'), DateTime(2026, 9, 12));
    });

    test('malformed input returns null', () {
      expect(parseReceiptDate(null), isNull);
      expect(parseReceiptDate(''), isNull);
      expect(parseReceiptDate('not a date'), isNull);
      expect(parseReceiptDate('99/99/2026'), isNull);
    });
  });
}
