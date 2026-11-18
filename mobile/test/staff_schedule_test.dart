import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/staff_schedule.dart';

void main() {
  // 2026-11-17 is a Tuesday in Manila (index 2, 0 = Sunday).
  // Manila 06:00 on Tue 2026-11-17 = 2026-11-16 22:00 UTC.
  const shift = {'start': '06:00', 'end': '14:00'};
  final tuesdayWeek = [null, null, Map<String, String>.from(shift), null, null, null, null];
  final schedule = StaffScheduleConfig(days: tuesdayWeek);

  DateTime mnl(String iso) => DateTime.parse('$iso+08:00');

  group('fromJson / toJson', () {
    test('parses a weekly template and canonicalizes times', () {
      final cfg = StaffScheduleConfig.fromJson(const {
        'days': [null, {'start': '6:00', 'end': '14:00'}, null, null, null, null, null],
      });
      expect(cfg.days[0], isNull);
      expect(cfg.days[1], {'start': '06:00', 'end': '14:00'});
    });

    test('drops junk days but keeps the valid ones', () {
      final cfg = StaffScheduleConfig.fromJson(const {
        'days': [
          {'start': '25:00', 'end': '14:00'}, // invalid start
          {'start': '06:00', 'end': '05:00'}, // start >= end
          null,
          'garbage',
          {'start': '07:00', 'end': '15:00'},
          null,
          null,
        ],
      });
      expect(cfg.days[0], isNull);
      expect(cfg.days[1], isNull);
      expect(cfg.days[4], {'start': '07:00', 'end': '15:00'});
    });

    test('roundtrips through toJson', () {
      final back = StaffScheduleConfig.fromJson(schedule.toJson());
      expect(back.sameAs(schedule), true);
    });

    test('sameAs detects any drift', () {
      expect(schedule.sameAs(null), false);
      expect(schedule.sameAs(schedule), true);
      final drifted = StaffScheduleConfig(
        days: [null, {'start': '06:00', 'end': '14:30'}, null, null, null, null, null],
      );
      expect(schedule.sameAs(drifted), false);
    });
  });

  group('isOpenNow', () {
    test('a null entry (day off) blocks both events', () {
      final dayOff = StaffScheduleConfig(days: List.filled(7, null));
      expect(dayOff.isOpenNow('IN', mnl('2026-11-17T06:30:00')), false);
      expect(dayOff.isOpenNow('OUT', mnl('2026-11-17T12:00:00')), false);
    });

    test('time in opens 15 minutes before the start and ends at the end', () {
      expect(schedule.isOpenNow('IN', mnl('2026-11-17T05:44:00')), false);
      expect(schedule.isOpenNow('IN', mnl('2026-11-17T05:45:00')), true);
      expect(schedule.isOpenNow('IN', mnl('2026-11-17T06:00:00')), true);
      expect(schedule.isOpenNow('IN', mnl('2026-11-17T13:59:00')), true);
      expect(schedule.isOpenNow('IN', mnl('2026-11-17T14:00:00')), true);
      expect(schedule.isOpenNow('IN', mnl('2026-11-17T14:01:00')), false);
    });

    test('time out allows the start through 60 minutes past the end', () {
      expect(schedule.isOpenNow('OUT', mnl('2026-11-17T05:59:00')), false);
      expect(schedule.isOpenNow('OUT', mnl('2026-11-17T06:00:00')), true);
      expect(schedule.isOpenNow('OUT', mnl('2026-11-17T14:00:00')), true);
      expect(schedule.isOpenNow('OUT', mnl('2026-11-17T15:00:00')), true);
      expect(schedule.isOpenNow('OUT', mnl('2026-11-17T15:01:00')), false);
    });

    test('other weekdays are day off even with a Tuesday schedule', () {
      // Wednesday 2026-11-18 06:30 Manila
      expect(schedule.isOpenNow('IN', mnl('2026-11-18T06:30:00')), false);
      expect(schedule.isOpenNow('OUT', mnl('2026-11-18T10:00:00')), false);
    });
  });

  group('lockHint', () {
    test('is null while the event is allowed', () {
      expect(schedule.lockHint('IN', mnl('2026-11-17T06:00:00')), isNull);
    });

    test('names the scheduled day off', () {
      expect(schedule.lockHint('IN', mnl('2026-11-18T06:00:00')),
          contains('day off'));
    });

    test('states the window when too early', () {
      expect(schedule.lockHint('IN', mnl('2026-11-17T04:00:00')),
          contains('6:00 AM to 2:00 PM'));
    });

    test('states the end when the shift is over', () {
      expect(schedule.lockHint('IN', mnl('2026-11-17T15:00:00')),
          contains('ended at 2:00 PM'));
    });

    test('states the overtime window for a late time out', () {
      expect(schedule.lockHint('OUT', mnl('2026-11-17T16:00:00')),
          contains('overtime window'));
    });
  });

  group('todayLabel / todayEntry', () {
    test('shows the window on a scheduled day', () {
      expect(schedule.todayLabel(mnl('2026-11-17T08:00:00')),
          'Today: 6:00 AM – 2:00 PM');
      expect(schedule.todayEntry(mnl('2026-11-17T08:00:00')), isNotNull);
    });

    test('shows Day off on an unscheduled weekday', () {
      expect(schedule.todayLabel(mnl('2026-11-18T08:00:00')), 'Today: Day off');
      expect(schedule.todayEntry(mnl('2026-11-18T08:00:00')), isNull);
    });
  });
}
