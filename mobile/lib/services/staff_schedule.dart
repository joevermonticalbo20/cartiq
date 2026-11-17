/// The weekly roster the owner sets in the dashboard (Staff & Shifts →
/// Staff Schedules), exactly as `/staff/my-schedule` serves it.
///
/// Time in / Time out are only accepted while the tap falls inside the
/// person's own scheduled window — the same rule the card reader's
/// server enforces:
///   Time in : 15 minutes before the scheduled start, until the end.
///   Time out: from the scheduled start, until 60 minutes past the end.
/// A staff member WITHOUT a schedule is unrestricted (legacy behavior).
/// All wall-clock math is Manila (UTC+8, no DST), matching the server.
class StaffScheduleConfig {
  const StaffScheduleConfig({required this.days});

  /// 7 entries, index 0 = Sunday. Each is null (day off) or
  /// `{ start: "HH:MM", end: "HH:MM" }` (24h Manila). Instances of this
  /// class exist only when a schedule document is stored; "unrestricted"
  /// is signalled by a null [StaffScheduleConfig].
  final List<Map<String, String>?> days;

  static int hmToMinutes(String v) {
    final m = RegExp(r'^\s*(\d{1,2}):(\d{2})\s*$').firstMatch(v);
    if (m == null) return -1;
    final h = int.parse(m.group(1)!);
    final min = int.parse(m.group(2)!);
    if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
    return h * 60 + min;
  }

  static int manilaMinutes(DateTime when) {
    final m = when.toUtc().add(const Duration(hours: 8));
    return m.hour * 60 + m.minute;
  }

  static int manilaWeekday(DateTime when) =>
      when.toUtc().add(const Duration(hours: 8)).weekday % 7;

  /// "12h 30m" / "45m" for captions (mirrors the server's fmtMinutes).
  static String fmtMinutes(int minutes) {
    final abs = minutes.abs();
    if (abs < 60) return '${abs}m';
    final h = abs ~/ 60;
    final m = abs % 60;
    return '${h}h ${m.toString().padLeft(2, '0')}m';
  }

  /// The scheduled entry for [when]'s weekday, or null. Null means the day
  /// is off (or the doc is unusable) — distinct from "no schedule document
  /// at all", which callers see as a null [StaffScheduleConfig].
  Map<String, String>? entryFor(DateTime when) {
    if (days.length != 7) return null;
    final e = days[manilaWeekday(when)];
    if (e == null) return null;
    final start = hmToMinutes(e['start'] ?? '');
    final end = hmToMinutes(e['end'] ?? '');
    if (start < 0 || end < 0 || start >= end) return null;
    return Map<String, String>.from(e);
  }

  bool isOpenNow(String event, DateTime when) {
    // A null entry means a scheduled day off — blocked. Callers gate on
    // "no schedule document at all" before calling this.
    final entry = entryFor(when);
    if (entry == null) return false;
    final nowMin = manilaMinutes(when);
    final start = hmToMinutes(entry['start']!);
    final end = hmToMinutes(entry['end']!);
    if (event == 'IN') {
      return nowMin >= start - 15 && nowMin <= end;
    }
    // Time OUT
    return nowMin >= start && nowMin <= end + 60;
  }

  /// The scheduled window for today, for the "Your shift today" card —
  /// null when today is a day off. Callers only invoke this when a
  /// schedule document exists (null `staffSchedule` means unrestricted).
  Map<String, String>? todayEntry(DateTime when) {
    if (days.length != 7) return null;
    return entryFor(when);
  }

  /// Caption for a locked Time in/Time out row (12-hour, like the rest of
  /// the app). Null only when the event is allowed right now.
  String? lockHint(String event, DateTime when) {
    if (isOpenNow(event, when)) return null;
    final entry = entryFor(when);
    if (entry == null) {
      return '${_weekdayName(when)} is your scheduled day off.';
    }
    final nowMin = manilaMinutes(when);
    final start = hmToMinutes(entry['start']!);
    final start12 = _to12Hour(entry['start']!);
    final end12 = _to12Hour(entry['end']!);
    if (event == 'IN') {
      if (nowMin < start - 15) {
        return 'Not your scheduled time - your shift is $start12 to $end12.';
      }
      return 'Your scheduled shift today ended at $end12.';
    }
    if (nowMin < start) {
      return 'Your scheduled shift starts at $start12.';
    }
    return 'Your scheduled shift ended at $end12 (overtime window is 1 hour).';
  }

  /// "Today: 6:00 AM – 2:00 PM" caption for the POS card.
  String todayLabel(DateTime when) {
    final entry = todayEntry(when);
    if (entry == null) return 'Today: Day off';
    return 'Today: ${_to12Hour(entry['start']!)} – ${_to12Hour(entry['end']!)}';
  }

  static String _weekdayName(DateTime when) {
    const names = [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
    ];
    return names[manilaWeekday(when)];
  }

  static String _to12Hour(String hhmm) {
    final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(hhmm);
    if (m == null) return hhmm;
    final h24 = int.parse(m.group(1)!);
    final minute = m.group(2)!;
    final period = h24 < 12 ? 'AM' : 'PM';
    final h12 = h24 % 12 == 0 ? 12 : h24 % 12;
    return '$h12:$minute $period';
  }

  factory StaffScheduleConfig.fromJson(Map<String, dynamic> json) {
    final raw = json['days'];
    final days = List<Map<String, String>?>.filled(7, null, growable: false);
    if (raw is List) {
      for (var i = 0; i < 7 && i < raw.length; i++) {
        final e = raw[i];
        if (e is Map) {
          final start = e['start'];
          final end = e['end'];
          if (start is String && end is String) {
            final s = hmToMinutes(start);
            final en = hmToMinutes(end);
            if (s >= 0 && en >= 0 && s < en) {
              days[i] = {
                'start': '${_pad2(s ~/ 60)}:${_pad2(s % 60)}',
                'end': '${_pad2(en ~/ 60)}:${_pad2(en % 60)}',
              };
            }
          }
        }
      }
    }
    return StaffScheduleConfig(days: days);
  }

  Map<String, dynamic> toJson() => {
        'days': days
            .map((d) => d == null ? null : {'start': d['start'], 'end': d['end']})
            .toList(),
      };

  bool sameAs(StaffScheduleConfig? other) {
    if (other == null) return false;
    for (var i = 0; i < 7; i++) {
      final a = days[i];
      final b = other.days[i];
      if ((a == null) != (b == null)) return false;
      if (a != null && (a['start'] != b?['start'] || a['end'] != b?['end'])) {
        return false;
      }
    }
    return true;
  }

  @override
  bool operator ==(Object other) =>
      other is StaffScheduleConfig && sameAs(other);

  @override
  int get hashCode => Object.hashAll(
        days.map((d) => d == null ? null : '${d['start']}-${d['end']}'),
      );
}

String _pad2(int n) => n.toString().padLeft(2, '0');
