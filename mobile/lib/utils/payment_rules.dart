/// The rules for the cash the customer hands over.
///
/// The cash may never be less than the total (that is not a payment), and it
/// may never be more than the next round amount above the total - nobody
/// hands over P2,000 for a P990 order, and a slip of the finger must not
/// look like one:
///
///   total P15    -> P1,000   (the biggest note in the till)
///   total P990   -> P1,000
///   total P1,500 -> P2,000   (P1,500 exact is always allowed)
///   total P1,700 -> P2,000
///
/// The exact total is always allowed: it is never above the ceiling.
class PaymentRules {
  const PaymentRules._();

  /// The notes a customer actually hands over.
  static const List<double> denominations = [
    20,
    50,
    100,
    200,
    500,
    1000,
    2000,
    5000,
  ];

  /// The round amounts the ceiling steps through. The stall's biggest note
  /// (P1,000) is the ceiling for a small order; a bigger order steps up.
  static const List<double> roundSteps = [1000, 2000, 3000, 5000, 10000];

  /// The most cash that may be typed for [total].
  static double maxCashFor(double total) {
    for (final step in roundSteps) {
      if (step > total) return step;
    }
    // Above the biggest round amount: the next thousand, so the exact total
    // and a bit more are still payable.
    final next = (total / 1000).ceil() * 1000.0;
    return next <= total ? next + 1000 : next;
  }

  /// How many digits the typed cash may have (the ceiling decides it).
  ///
  /// A ceiling of P1,000 means four digits - "10000" cannot be typed.
  static int maxDigits(double total) =>
      maxCashFor(total).floor().toString().length;

  /// Why the typed cash cannot be used, or null when it can.
  ///
  /// A null [tendered] means "nothing typed yet" - that is not an error, it
  /// just means the payment is not ready.
  static String? cashError(double total, double? tendered) {
    if (tendered == null) return null;
    if (tendered < total) {
      return 'Less than the ₱${_peso(total)} total';
    }
    final max = maxCashFor(total);
    if (tendered > max) {
      return 'Maximum ₱${_peso(max)} for a ₱${_peso(total)} order';
    }
    return null;
  }

  /// The quick amounts offered for [total]: the exact total first, then the
  /// notes a customer would actually hand over (the nearest ones above the
  /// total, up to the ceiling).
  static List<double> quickCashAmounts(double total) {
    final amounts = <double>[total];
    final max = maxCashFor(total);
    for (final note in denominations) {
      if (note <= total) continue;
      if (note > max) break;
      amounts.add(note);
      if (amounts.length >= 5) break;
    }
    return amounts;
  }

  static String _peso(double value) {
    return value == value.roundToDouble()
        ? value.toStringAsFixed(0)
        : value.toStringAsFixed(2);
  }
}
