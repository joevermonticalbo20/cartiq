import 'money_input.dart';

/// The rules for the cash the customer hands over.
///
/// Two limits, both about the stall's reality:
///  - the cash can never be LESS than the total (that is not a payment), and
///  - the cash can never be more than the total plus the biggest change the
///    stall can hand back. Without that ceiling a typo ("2000" for a 50-peso
///    order) would look like a 1,950-peso change and the till would be short.
class PaymentRules {
  const PaymentRules._();

  /// The most change the stall can give back in one sale.
  static const double maxChange = 1000;

  /// The largest cash amount that may be typed for [total].
  static double maxCashFor(double total) => total + maxChange;

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
      return 'Maximum ₱${_peso(max)} (total + ₱${_peso(maxChange)})';
    }
    return null;
  }

  /// The quick amounts offered for [total]: the exact total first, then the
  /// notes a customer would actually hand over (the smallest notes above the
  /// total). Anything above the ceiling is left out.
  static List<double> quickCashAmounts(double total) {
    final amounts = <double>[total];
    for (final note in MoneyInput.cashDenominations) {
      if (note <= total) continue;
      if (note > maxCashFor(total)) continue;
      amounts.add(note.toDouble());
    }
    return amounts;
  }

  static String _peso(double value) {
    return value == value.roundToDouble()
        ? value.toStringAsFixed(0)
        : value.toStringAsFixed(2);
  }
}
