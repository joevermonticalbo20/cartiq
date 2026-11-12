import 'package:flutter/services.dart';

/// A field that only takes WHOLE pesos: digits, and never more digits than
/// the limit allows.
///
/// Two rules, both learned the hard way:
///  - a dot is REFUSED, not stripped: stripping would turn "15.50" into
///    "1550" - a number the vendor never typed;
///  - the length is capped, so a slip of the finger cannot type "10000" into
///    a field that may only hold four digits.
class DigitsOnlyFormatter extends TextInputFormatter {
  const DigitsOnlyFormatter({this.maxDigits = 7});

  /// The most digits the field may hold.
  final int maxDigits;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final text = newValue.text;
    if (text.contains('.')) {
      // Whole pesos only: keep what was there.
      return oldValue;
    }
    final cleaned = text.replaceAll(RegExp(r'[^0-9]'), '');
    if (cleaned.length > maxDigits) {
      final trimmed = cleaned.substring(0, maxDigits);
      return TextEditingValue(
        text: trimmed,
        selection: TextSelection.collapsed(offset: trimmed.length),
      );
    }
    if (cleaned == text) return newValue;
    return TextEditingValue(
      text: cleaned,
      selection: TextSelection.collapsed(offset: cleaned.length),
    );
  }
}
