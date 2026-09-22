/// Manila-time helpers mirroring `api/src/services/timezone.js` (Asia/Manila).
///
/// Server timestamps are UTC ISO strings. Display must be Manila (UTC+8,
/// no DST, server-TZ independent) so History/Reports match the web dashboard.
class ManilaTime {
  static const _offsetHours = 8;

  /// Parse an ISO string (or DateTime) and shift to Manila wall-clock.
  static DateTime? parse(dynamic input) {
    DateTime? dt;
    if (input is DateTime) {
      dt = input;
    } else if (input is String) {
      dt = DateTime.tryParse(input);
    }
    if (dt == null) return null;
    // Normalize to UTC first, then add +8. If the string had no zone,
    // treat it as UTC (server contract) rather than device-local.
    final utc = dt.isUtc ? dt : DateTime.utc(
      dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second,
      dt.millisecond, dt.microsecond,
    );
    return utc.add(const Duration(hours: _offsetHours));
  }

  static DateTime now() =>
      DateTime.now().toUtc().add(const Duration(hours: _offsetHours));

  /// `Today HH:mm`, `Yesterday HH:mm`, else `M/D HH:mm` (+ year when old).
  static String formatTime(DateTime manilaDt) {
    final today = now();
    final hh = manilaDt.hour.toString().padLeft(2, '0');
    final mm = manilaDt.minute.toString().padLeft(2, '0');
    final isToday = manilaDt.year == today.year &&
        manilaDt.month == today.month &&
        manilaDt.day == today.day;
    if (isToday) return 'Today $hh:$mm';
    final yesterday = today.subtract(const Duration(days: 1));
    final isYesterday = manilaDt.year == yesterday.year &&
        manilaDt.month == yesterday.month &&
        manilaDt.day == yesterday.day;
    if (isYesterday) return 'Yesterday $hh:$mm';
    final md = '${manilaDt.month}/${manilaDt.day}';
    if (manilaDt.year != today.year) return '$md/${manilaDt.year} $hh:$mm';
    return '$md $hh:$mm';
  }

  /// Group key `yyyy/mm/dd` in Manila time (stable across device TZ).
  static String groupKey(dynamic input) {
    final dt = parse(input);
    if (dt == null) return 'unknown';
    return '${dt.year}/${dt.month}/${dt.day}';
  }

  /// Short list label `M/D · HH:mm` (with year when not current year).
  static String shortLabel(dynamic input) {
    final dt = parse(input);
    if (dt == null) return '';
    final hh = dt.hour.toString().padLeft(2, '0');
    final mm = dt.minute.toString().padLeft(2, '0');
    final md = '${dt.month}/${dt.day}';
    if (dt.year != now().year) return '$md/${dt.year} · $hh:$mm';
    return '$md · $hh:$mm';
  }
}
