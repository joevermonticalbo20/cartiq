import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/password_strength.dart';

void main() {
  group('evaluatePassword (web parity)', () {
    test('empty stays empty', () {
      expect(evaluatePassword('').level, 'empty');
    });

    test('one lowercase check or less is weak', () {
      expect(evaluatePassword('abc').level, 'weak');
    });

    test('two of four checks is fair', () {
      expect(evaluatePassword('abcdefg1').level, 'fair');
    });

    test('three of four is good', () {
      expect(evaluatePassword('Abcdefg1').level, 'good');
    });

    test('all four is strong', () {
      expect(evaluatePassword('Abcdefg1!').level, 'strong');
    });

    test('7 chars with case+digit+special is good but misses length', () {
      final s = evaluatePassword('Abcde1!');
      expect(s.length, isFalse);
      expect(s.level, 'good');
    });
  });

  group('meetsGood gate', () {
    test('good and strong pass, fair and below do not', () {
      expect(evaluatePassword('Abcdefg1').meetsGood, isTrue);
      expect(evaluatePassword('Abcdefg1!').meetsGood, isTrue);
      expect(evaluatePassword('abcdefg1').meetsGood, isFalse);
      expect(evaluatePassword('abc').meetsGood, isFalse);
      expect(evaluatePassword('').meetsGood, isFalse);
    });
  });

  group('isValidEmail', () {
    test('accepts normal addresses', () {
      for (final ok in [
        'name@gmail.com',
        'first.last+tag@school.edu.ph',
        'staff_01@cartiq-8e46f.web.app',
      ]) {
        expect(isValidEmail(ok), isTrue, reason: ok);
      }
    });

    test('rejects malformed input', () {
      for (final bad in [
        '',
        'plain',
        'missing@dot',
        '@nodomain.com',
        'two@@ats.com',
        'space in@mail.com',
        'trailingdot@mail.',
      ]) {
        expect(isValidEmail(bad), isFalse, reason: bad);
      }
    });

    test('trims surrounding whitespace first', () {
      expect(isValidEmail('  name@gmail.com  '), isTrue);
    });
  });
}
