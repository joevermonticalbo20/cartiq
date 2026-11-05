import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/time_clock.dart';

void main() {
  group('hmToMinutes', () {
    test('parses HH:MM and rejects nonsense', () {
      expect(TimeClockConfig.hmToMinutes('07:00'), 7 * 60);
      expect(TimeClockConfig.hmToMinutes('23:59'), 23 * 60 + 59);
      expect(TimeClockConfig.hmToMinutes('7:05'), 7 * 60 + 5);

      expect(TimeClockConfig.hmToMinutes('24:00'), -1);
      expect(TimeClockConfig.hmToMinutes('12:60'), -1);
      expect(TimeClockConfig.hmToMinutes('ab:cd'), -1);
      expect(TimeClockConfig.hmToMinutes(''), -1);
      expect(TimeClockConfig.hmToMinutes('7am'), -1);
    });
  });

  group('manilaMinutesOfDay', () {
    test('is UTC+8 regardless of anything else', () {
      // 00:00 UTC is 08:00 in Manila.
      expect(TimeClockConfig.manilaMinutes(DateTime.utc(2026, 1, 5, 0)), 8 * 60);
      // 15:59 UTC is 23:59 in Manila (same day).
      expect(TimeClockConfig.manilaMinutes(DateTime.utc(2026, 1, 5, 15, 59)),
          23 * 60 + 59);
      // 16:00 UTC is 00:00 Manila the next day - minute count wraps to 0.
      expect(TimeClockConfig.manilaMinutes(DateTime.utc(2026, 1, 5, 16)), 0);
      // 23:30 UTC is 07:30 Manila next day.
      expect(TimeClockConfig.manilaMinutes(DateTime.utc(2026, 1, 5, 23, 30)),
          7 * 60 + 30);
    });
  });

  group('isOpenNow', () {
    const cfg = TimeClockConfig(
      enabled: true,
      inOpen: '07:00',
      inClose: '09:00',
      outOpen: '17:00',
      outClose: '19:00',
    );

    test('disabled config never locks anyone out', () {
      const off = TimeClockConfig(enabled: false, inOpen: '23:59', inClose: '23:59', outOpen: '00:01', outClose: '00:01');
      expect(off.isOpenNow('IN', DateTime.utc(2026, 1, 5, 0)), true);
      expect(off.isOpenNow('OUT', DateTime.utc(2026, 1, 5, 12)), true);
    });

    test('IN window is inclusive at open and at close', () {
      expect(cfg.isOpenNow('IN', DateTime.utc(2026, 1, 5, 22, 59)), false); // 06:59 Manila
      expect(cfg.isOpenNow('IN', DateTime.utc(2026, 1, 5, 23)), true);      // 07:00 Manila
      expect(cfg.isOpenNow('IN', DateTime.utc(2026, 1, 6, 1)), true);       // 09:00 Manila
      expect(cfg.isOpenNow('IN', DateTime.utc(2026, 1, 6, 1, 1)), false);   // 09:01 Manila
    });

    test('OUT window is independent of IN', () {
      expect(cfg.isOpenNow('OUT', DateTime.utc(2026, 1, 6, 8)), false);     // 16:00 Manila
      expect(cfg.isOpenNow('OUT', DateTime.utc(2026, 1, 6, 9)), true);      // 17:00 Manila
      expect(cfg.isOpenNow('OUT', DateTime.utc(2026, 1, 6, 11)), true);     // 19:00 Manila
      expect(cfg.isOpenNow('OUT', DateTime.utc(2026, 1, 6, 11, 1)), false); // 19:01 Manila
    });

    test('a corrupt config never locks staff out', () {
      const junk = TimeClockConfig(
        enabled: true,
        inOpen: 'holiday',
        inClose: '09:00',
        outOpen: '17:00',
        outClose: '19:00',
      );
      expect(junk.isValid, false);
      expect(junk.isOpenNow('IN', DateTime.utc(2026, 1, 5, 12)), true);
    });

    test('manilaWeekday matches getDay on the Manila wall clock', () {
      expect(TimeClockConfig.manilaWeekday(DateTime.utc(2026, 11, 5, 15, 59)), 4); // Thu 23:59
      expect(TimeClockConfig.manilaWeekday(DateTime.utc(2026, 11, 5, 16)), 5);     // Fri 00:00
      expect(TimeClockConfig.manilaWeekday(DateTime.utc(2026, 11, 7, 16)), 0);     // Sun 00:00
    });

    test('closed days block both events for the whole day', () {
      const weekdaysOnly = TimeClockConfig(
        enabled: true,
        inOpen: '07:00',
        inClose: '09:00',
        outOpen: '17:00',
        outClose: '19:00',
        days: [1, 2, 3, 4, 5, 6],
      );
      // Sunday 2026-11-08 07:30 Manila (Sat 2026-11-07 23:30 UTC).
      expect(weekdaysOnly.isDayOpen(DateTime.utc(2026, 11, 7, 23, 30)), false);
      expect(weekdaysOnly.isOpenNow('IN', DateTime.utc(2026, 11, 7, 23, 30)), false);
      expect(weekdaysOnly.isOpenNow('OUT', DateTime.utc(2026, 11, 7, 23, 30)), false);
      // Tuesday 2026-11-10 07:30 Manila (Mon 2026-11-09 23:30 UTC).
      expect(weekdaysOnly.isDayOpen(DateTime.utc(2026, 11, 9, 23, 30)), true);
      expect(weekdaysOnly.isOpenNow('IN', DateTime.utc(2026, 11, 9, 23, 30)), true);
      // An all-day window is open on a Sunday when enabled fully.
      const allDays = TimeClockConfig(
        enabled: true,
        inOpen: '00:00',
        inClose: '23:59',
        outOpen: '00:00',
        outClose: '23:59',
      );
      expect(allDays.isOpenNow('IN', DateTime.utc(2026, 11, 7, 23, 30)), true);
    });
  });

  group('fromJson', () {
    test('snaps HH:MM values and defaults missing fields', () {
      final cfg = TimeClockConfig.fromJson(const {
        'enabled': true,
        'inOpen': '7:05',
        'outClose': '19:30',
      });
      expect(cfg.enabled, true);
      expect(cfg.inOpen, '07:05');
      expect(cfg.inClose, TimeClockConfig.defaults.inClose);
      expect(cfg.outOpen, TimeClockConfig.defaults.outOpen);
      expect(cfg.outClose, '19:30');
    });

    test('rejects junk values to defaults', () {
      final cfg = TimeClockConfig.fromJson(const {
        'enabled': true,
        'inOpen': '25:00',
        'inClose': 'nope',
        'outOpen': '12:34pm',
        'outClose': '',
      });
      expect(cfg.inOpen, TimeClockConfig.defaults.inOpen);
      expect(cfg.inClose, TimeClockConfig.defaults.inClose);
      expect(cfg.outOpen, TimeClockConfig.defaults.outOpen);
      expect(cfg.outClose, TimeClockConfig.defaults.outClose);
    });

      test('fromJson snaps days', () {
      final cfg = TimeClockConfig.fromJson(const {
        'enabled': true,
        'days': [6, 2, 2, 9],
      });
      expect(cfg.days, [2, 6]);

      final cfgMissing = TimeClockConfig.fromJson(const {'enabled': true});
      expect(cfgMissing.days, [0, 1, 2, 3, 4, 5, 6]);

      final cfgEmpty = TimeClockConfig.fromJson(const {
        'enabled': true,
        'days': [],
      });
      expect(cfgEmpty.days, [0, 1, 2, 3, 4, 5, 6]);
    });

    test('toJson roundtrips through fromJson', () {
      const original = TimeClockConfig(
        enabled: true,
        inOpen: '06:30',
        inClose: '08:45',
        outOpen: '16:00',
        outClose: '21:15',
      );
      final back = TimeClockConfig.fromJson(original.toJson());
      expect(back.sameAs(original), true);
    });

    test('sameAs detects any drift', () {
      const a = TimeClockConfig(
        enabled: true,
        inOpen: '07:00',
        inClose: '09:00',
        outOpen: '17:00',
        outClose: '19:00',
      );
      expect(a.sameAs(a), true);
      expect(a.sameAs(null), false);
      expect(a.sameAs(const TimeClockConfig(
          enabled: true,
          inOpen: '07:30',
          inClose: '09:00',
          outOpen: '17:00',
          outClose: '19:00')), false);
      expect(a.sameAs(const TimeClockConfig(
          enabled: false,
          inOpen: '07:00',
          inClose: '09:00',
          outOpen: '17:00',
          outClose: '19:00')), false);
    });
  });
}
