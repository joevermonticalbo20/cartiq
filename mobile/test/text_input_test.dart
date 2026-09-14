import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/text_input.dart';

void main() {
  group('TextInputRules.sanitize', () {
    test('collapses multiple spaces and strips a leading space', () {
      expect(TextInputRules.sanitize('SM   Supermarket'), 'SM Supermarket');
      expect(TextInputRules.sanitize('  SM'), 'SM');
      expect(TextInputRules.sanitize('SM '), 'SM ');
    });

    test('caps at 40 chars', () {
      expect(TextInputRules.sanitize('a' * 50), 'a' * 40);
    });

    test('keeps special characters and numbers', () {
      expect(TextInputRules.sanitize('7-Eleven #12!'), '7-Eleven #12!');
    });
  });

  group('vendor / note validation', () {
    test('accepts normal vendors', () {
      expect(TextInputRules.isValidVendor('SM Supermarket'), isTrue);
      expect(TextInputRules.isValidVendor('7-Eleven #12'), isTrue);
    });

    test('rejects empty and letter-less vendors', () {
      expect(TextInputRules.isValidVendor(''), isFalse);
      expect(TextInputRules.isValidVendor('   '), isFalse);
      expect(TextInputRules.isValidVendor('12'), isFalse);
      expect(TextInputRules.isValidVendor('A1'), isFalse);
    });

    test('note is optional; over-40 is truncated to 40', () {
      expect(TextInputRules.isValidNote(''), isTrue);
      expect(TextInputRules.isValidNote('ok'), isTrue);
      expect(TextInputRules.isValidNote('x'), isFalse);
      expect(TextInputRules.sanitize('b' * 41), 'b' * 40);
    });
  });

  group('SingleSpaceFormatter', () {
    const formatter = SingleSpaceFormatter();

    TextEditingValue edit(String text) => formatter.formatEditUpdate(
          const TextEditingValue(),
          TextEditingValue(text: text),
        );

    test('leaves valid input untouched', () {
      expect(edit('SM Supermarket').text, 'SM Supermarket');
    });

    test('collapses double spaces and cuts over-long input', () {
      expect(edit('SM  Mart').text, 'SM Mart');
      expect(edit('a' * 45).text, 'a' * 40);
    });
  });
}
