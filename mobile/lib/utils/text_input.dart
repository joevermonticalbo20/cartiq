import 'package:flutter/services.dart';

/// Shared text-input rules for vendor/note fields. Mirrors web
/// `utils/text.js` and api/src/services/validation.js: 2-40 chars, at least
/// 2 letters, single spaces only, strict symbol allowlist for person names.
class TextInputRules {
  static const int minLetters = 2;
  static const int maxLength = 40;
  static const personNameMax = 100;
  static final RegExp _namePattern = RegExp(
    r"^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}\p{Pc}\p{Pd}'.\-&#/ ]*$",
    unicode: true,
  );
  static final RegExp _usernamePattern = RegExp(r'^[a-z0-9._-]{3,30}$');

  static int countLetters(String s) =>
      RegExp(r'\p{L}', unicode: true).allMatches(s).length;

  /// Live-typing sanitizer: collapse whitespace runs, drop a leading
  /// space, cap at [max]. A single trailing space is kept so the next
  /// word can be typed.
  static String sanitize(String raw, [int max = maxLength]) {
    var s = raw.replaceAll(RegExp(r'\s+'), ' ');
    if (s.startsWith(' ')) s = s.substring(1);
    if (s.length > max) s = s.substring(0, max);
    return s;
  }

  static bool isValidVendor(String raw) {
    final v = sanitize(raw).trim();
    if (v.length < 2 || v.length > maxLength) return false;
    return countLetters(v) >= minLetters;
  }

  /// Note is optional: empty is valid, non-empty follows vendor rules.
  static bool isValidNote(String raw) {
    final v = sanitize(raw).trim();
    if (v.isEmpty) return true;
    if (v.length > maxLength) return false;
    return countLetters(v) >= minLetters;
  }

  static String cleanPersonName(String raw) {
    return raw
        .replaceAll(RegExp(r'[\u0000-\u001F\u007F]'), '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }

  static bool isValidPersonName(String raw) {
    final v = cleanPersonName(raw);
    if (v.length < 2 || v.length > personNameMax) return false;
    if (countLetters(v) < minLetters) return false;
    return _namePattern.hasMatch(v);
  }

  static String cleanUsername(String raw) => raw.trim().toLowerCase();

  static bool isValidUsername(String raw) {
    final v = cleanUsername(raw);
    if (!_usernamePattern.hasMatch(v)) return false;
    if (v.startsWith('.') || v.endsWith('.') || v.contains('..')) return false;
    return true;
  }
}

/// Enforces [TextInputRules.sanitize] while typing (double spaces collapse,
/// over-long input is cut). Only rewrites when something was actually cut
/// so the caret stays stable.
class SingleSpaceFormatter extends TextInputFormatter {
  final int max;
  const SingleSpaceFormatter([this.max = TextInputRules.maxLength]);

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final clean = TextInputRules.sanitize(newValue.text, max);
    if (clean == newValue.text) return newValue;
    return TextEditingValue(
      text: clean,
      selection: TextSelection.collapsed(offset: clean.length),
    );
  }
}
