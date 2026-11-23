import 'package:flutter/services.dart';

/// The rules for a quantity the vendor types.
///
/// A vendor taking a big order ("200 fries") must not tap + 200 times, and
/// must not be able to type more than the stock on hand: the server would
/// refuse the whole sale after the customer already paid.
class QuantityInput {
  const QuantityInput._();

  /// The smallest order line.
  static const int minimum = 1;

  /// The biggest order (and per line) the server accepts. Mirrored by the
  /// API: an order with more units in total is refused with a clear message.
  static const int maximum = 200;

  /// The user-facing copy for the 200-unit limit (POS toast + field error).
  static const String limitMessage = 'Limit per order is only 200 units';

  /// The message for a cart that crossed the 200-unit cap. Tells the vendor
  /// exactly how many servings to remove and the most they may set.
  static String capacityMessage(int over, {int? capacity}) {
    final tail = capacity == null ? '' : ' Set $capacity or less.';
    return 'Too many servings - remove $over to stay within the '
        '200-unit limit.$tail';
  }

  /// Parses what the vendor typed.
  ///
  /// Returns null when it is not a whole number of at least [minimum].
  static int? parse(String raw) {
    final text = raw.trim();
    if (text.isEmpty) return null;
    final value = int.tryParse(text);
    if (value == null || value < minimum) return null;
    return value;
  }

  /// Why the typed quantity cannot be used, or null when it can.
  ///
  /// [max] is the stock on hand. Null means "no ceiling known" (the catalog
  /// did not report one).
  static String? error(int? value, {int? max}) {
    if (value == null) return 'Enter a number';
    if (value > maximum) return limitMessage;
    if (max != null && value > max) {
      return max == 1 ? 'Only 1 left in stock' : 'Only $max left in stock';
    }
    return null;
  }

  /// Clamps a quantity into the range the stock allows - and never above
  /// [maximum].
  static int clamp(int value, {int? max}) {
    final stockCeiling = (max == null || max < minimum) ? maximum : max;
    final ceiling = stockCeiling < maximum ? stockCeiling : maximum;
    if (value < minimum) return minimum;
    if (value > ceiling) return ceiling;
    return value;
  }

  /// How many digits the field may hold: the stock on hand decides it, the
  /// absolute [maximum] caps it either way.
  ///
  /// A stock of 130 means three digits - "1310" cannot even be typed, let
  /// alone accepted.
  static int maxDigits(int? max) {
    if (max == null || max < minimum) return maximum.toString().length;
    final cap = max < maximum ? max : maximum;
    return cap.toString().length;
  }
}

/// Formatter that refuses anything outside the stock range - at the
/// keystroke, and at paste time.
///
/// A stock of 62 means "62" is the biggest number that may ever land in the
/// field: typing "6" then "7" is refused (the "7" never enters), and pasting
/// "999" never happens at all. Only whole numbers of at least
/// [QuantityInput.minimum] make it in.
class StockInputFormatter extends TextInputFormatter {
  const StockInputFormatter({this.max, this.onRefuse});

  /// The stock on hand. Null means "no ceiling known".
  final int? max;

  /// Fires when a value was refused because it broke the absolute cap - the
  /// caller shows the user-facing toast. Above-stock refusals stay silent
  /// (the field shows the stock error instead).
  final VoidCallback? onRefuse;

  static final _digitsOnly = RegExp(r'^\d+$');

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final text = newValue.text;
    // Clearing the field is allowed; anything pasted or typed that is not
    // pure digits is refused.
    if (text.isEmpty) return newValue;
    if (!_digitsOnly.hasMatch(text)) return oldValue;
    final value = int.tryParse(text);
    if (value == null) return oldValue;
    if (value < QuantityInput.minimum) return oldValue;
    if (value > QuantityInput.maximum) {
      onRefuse?.call();
      return oldValue;
    }
    if (max != null && value > max!) return oldValue;
    return newValue;
  }
}
