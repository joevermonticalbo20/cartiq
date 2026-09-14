import 'package:flutter/services.dart';

/// Shared money-input rules for every amount field (POS cash tendered,
/// receipt-scanner amount). Mirrors web `utils/format.js`:
/// whole pesos max 7 digits, centavos max 2 decimals.
class MoneyInput {
  static const int maxIntDigits = 7;
  static const int maxDecimals = 2;
  static const double maxValue = 9999999.99;

  /// Live-typing sanitizer: digits + one dot, capped lengths. Extra
  /// keystrokes are ignored (input never reformatted mid-typing).
  static String sanitize(String raw) {
    var s = raw.replaceAll(RegExp(r'[^0-9.]'), '');
    final dot = s.indexOf('.');
    if (dot != -1) {
      s = '${s.substring(0, dot + 1)}${s.substring(dot + 1).replaceAll('.', '')}';
    }
    final hasDot = s.contains('.');
    final parts = s.split('.');
    var intPart = parts[0];
    var decPart = parts.length > 1 ? parts[1] : '';
    if (intPart.length > maxIntDigits) {
      intPart = intPart.substring(0, maxIntDigits);
    }
    intPart = intPart.replaceFirst(RegExp(r'^0+(?=\d)'), '');
    if (decPart.length > maxDecimals) {
      decPart = decPart.substring(0, maxDecimals);
    }
    return hasDot ? '$intPart.$decPart' : intPart;
  }

  /// Strict parse for submit: null when empty/invalid/negative/over cap.
  static double? tryParse(String raw) {
    if (raw.trim().isEmpty) return null;
    final v = double.tryParse(raw.trim());
    if (v == null || v < 0 || v > maxValue) return null;
    return v;
  }
}

/// Drops keystrokes past the money limits instead of rejecting the edit
/// (keeps caret stable by only rewriting when something was actually cut).
class MoneyInputFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final clean = MoneyInput.sanitize(newValue.text);
    if (clean == newValue.text) return newValue;
    return TextEditingValue(
      text: clean,
      selection: TextSelection.collapsed(offset: clean.length),
    );
  }
}
