import 'dart:convert';

/// Cart-wide clock-in/out windows, exactly as the owner configures them in
/// the web dashboard (Settings → Time clock). The document is
/// `settings/timeClock` on the server; the app only ever reads it.
///
/// All "wall clock" math is Manila (UTC+8, no DST), the same business day the
/// rest of CartIQ uses. The comparison is done from `toUtc()` so the result
/// does not depend on the device's timezone.
class TimeClockConfig {
  const TimeClockConfig({
    required this.enabled,
    required this.inOpen,
    required this.inClose,
    required this.outOpen,
    required this.outClose,
  });

  final bool enabled;

  /// "HH:MM" 24h Manila wall-clock times.
  final String inOpen;
  final String inClose;
  final String outOpen;
  final String outClose;

  /// Unrestricted defaults. When disabled — or the stored doc is corrupt —
  /// the app never locks staff out of clocking in/out.
  static const defaults = TimeClockConfig(
    enabled: false,
    inOpen: '07:00',
    inClose: '09:00',
    outOpen: '17:00',
    outClose: '19:00',
  );

  /// "HH:MM" -> minutes since midnight, or -1 when invalid.
  static int hmToMinutes(String v) {
    final m = RegExp(r'^\s*(\d{1,2}):(\d{2})\s*$').firstMatch(v);
    if (m == null) return -1;
    final h = int.parse(m.group(1)!);
    final min = int.parse(m.group(2)!);
    if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
    return h * 60 + min;
  }

  bool get isValid =>
      hmToMinutes(inOpen) >= 0 &&
      hmToMinutes(inClose) >= 0 &&
      hmToMinutes(outOpen) >= 0 &&
      hmToMinutes(outClose) >= 0;

  /// Minutes since Manila midnight for any instant.
  static int manilaMinutes(DateTime when) {
    final m = when.toUtc().add(const Duration(hours: 8));
    return m.hour * 60 + m.minute;
  }

  bool isOpenNow(String event, DateTime when) {
    if (!enabled || !isValid) return true;
    final nowMin = manilaMinutes(when);
    final isOut = event == 'OUT';
    final open = hmToMinutes(isOut ? outOpen : inOpen);
    final close = hmToMinutes(isOut ? outClose : inClose);
    // The closing minute itself is allowed (minute-level window).
    return nowMin >= open && nowMin <= close;
  }

  /// "HH:MM-HH:MM" for display, e.g. "07:00-09:00".
  String windowLabel(String event) => event == 'OUT'
      ? '$outOpen-$outClose'
      : '$inOpen-$inClose';

  String windowLabelLong(String event) =>
      event == 'OUT' ? '$outOpen – $outClose' : '$inOpen – $inClose';

  factory TimeClockConfig.fromJson(Map<String, dynamic> json) {
    String snap(String? value, String fallback) =>
        (value is String && hmToMinutes(value) >= 0) ? _canon(value) : fallback;
    return TimeClockConfig(
      enabled: json['enabled'] == true,
      inOpen: snap(json['inOpen'] as String?, defaults.inOpen),
      inClose: snap(json['inClose'] as String?, defaults.inClose),
      outOpen: snap(json['outOpen'] as String?, defaults.outOpen),
      outClose: snap(json['outClose'] as String?, defaults.outClose),
    );
  }

  static String _canon(String v) {
    final n = hmToMinutes(v);
    return '${(n ~/ 60).toString().padLeft(2, '0')}:${(n % 60).toString().padLeft(2, '0')}';
  }

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'inOpen': inOpen,
        'inClose': inClose,
        'outOpen': outOpen,
        'outClose': outClose,
      };

  bool sameAs(TimeClockConfig? other) =>
      other != null &&
      other.enabled == enabled &&
      other.inOpen == inOpen &&
      other.inClose == inClose &&
      other.outOpen == outOpen &&
      other.outClose == outClose;

  @override
  String toString() => jsonEncode(toJson());
}
