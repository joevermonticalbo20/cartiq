/// The rules for a quantity the vendor types.
///
/// A vendor taking a big order ("200 fries") must not tap + 200 times, and
/// must not be able to type more than the stock on hand: the server would
/// refuse the whole sale after the customer already paid.
class QuantityInput {
  const QuantityInput._();

  /// The smallest order line.
  static const int minimum = 1;

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
    if (max != null && value > max) {
      return max == 1 ? 'Only 1 left in stock' : 'Only $max left in stock';
    }
    return null;
  }

  /// Clamps a quantity into the range the stock allows.
  static int clamp(int value, {int? max}) {
    final ceiling = (max == null || max < minimum) ? null : max;
    if (ceiling == null) return value < minimum ? minimum : value;
    if (value < minimum) return minimum;
    if (value > ceiling) return ceiling;
    return value;
  }

  /// How many digits the field may hold: the stock on hand decides it.
  ///
  /// A stock of 130 means three digits - "1310" cannot even be typed, let
  /// alone accepted.
  static int maxDigits(int? max) {
    if (max == null || max < minimum) return 5;
    return max.toString().length;
  }
}
