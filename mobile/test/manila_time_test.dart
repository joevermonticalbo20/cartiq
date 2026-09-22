import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/utils/manila_time.dart';

void main() {
  group('ManilaTime.parse', () {
    test('shifts UTC noon to 20:00 Manila', () {
      final dt = ManilaTime.parse('2026-09-22T12:00:00Z');
      expect(dt, isNotNull);
      expect(dt!.hour, 20);
      expect(dt.day, 22);
    });

    test('crosses midnight into next day', () {
      final dt = ManilaTime.parse('2026-09-22T18:30:00Z');
      expect(dt, isNotNull);
      expect(dt!.day, 23);
      expect(dt.hour, 2);
      expect(dt.minute, 30);
    });

    test('returns null for garbage input', () {
      expect(ManilaTime.parse('not-a-date'), isNull);
      expect(ManilaTime.parse(null), isNull);
    });
  });

  group('ManilaTime.formatTime', () {
    test('labels today in Manila time', () {
      final now = ManilaTime.now();
      final label = ManilaTime.formatTime(now);
      expect(label.startsWith('Today '), isTrue);
    });

    test('includes year for old dates', () {
      // Full pipeline: UTC string -> Manila wall-clock -> label.
      // 2020-01-05 00:00 UTC = 2020-01-05 08:00 Manila.
      final manila = ManilaTime.parse('2020-01-05T00:00:00Z')!;
      expect(ManilaTime.formatTime(manila), '1/5/2020 08:00');
    });
  });

  group('ManilaTime.groupKey', () {
    test('groups by Manila day, not UTC day', () {
      // 18:30 UTC Sep 22 = 02:30 Manila Sep 23.
      expect(ManilaTime.groupKey('2026-09-22T18:30:00Z'), '2026/9/23');
    });

    test('unknown for unparsable input', () {
      expect(ManilaTime.groupKey('bogus'), 'unknown');
    });
  });

  group('ManilaTime.shortLabel', () {
    test('formats current-year dates without year', () {
      final year = ManilaTime.now().year;
      final label = ManilaTime.shortLabel(
        '$year-03-04T01:02:00Z',
      );
      expect(label, '3/4 · 09:02');
    });

    test('empty string for unparsable input', () {
      expect(ManilaTime.shortLabel('bogus'), isEmpty);
    });
  });
}
