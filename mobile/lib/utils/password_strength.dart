/// Password strength rules — the same four checks the web app enforces
/// (`web/src/components/PasswordStrengthMeter.jsx`), so a password accepted
/// on the phone is accepted on the dashboard and vice versa.
///
/// Checks: at least 8 characters, upper + lower case, one digit, one
/// special character. Level = how many checks pass:
///   0-1 weak · 2 fair · 3 good · 4 strong · empty when nothing typed.
class PasswordStrength {
  const PasswordStrength({
    required this.length,
    required this.caseOk,
    required this.digit,
    required this.special,
    required this.level,
  });

  final bool length;
  final bool caseOk;
  final bool digit;
  final bool special;

  /// empty | weak | fair | good | strong
  final String level;

  /// The reset form requires "good" (3 of 4 checks), matching web.
  bool get meetsGood => level == 'good' || level == 'strong';
}

PasswordStrength evaluatePassword(String pw) {
  final length = pw.length >= 8;
  final caseOk = RegExp(r'[a-z]').hasMatch(pw) && RegExp(r'[A-Z]').hasMatch(pw);
  final digit = RegExp(r'\d').hasMatch(pw);
  final special = RegExp(r'[^A-Za-z0-9]').hasMatch(pw);
  final passed =
      [length, caseOk, digit, special].where((ok) => ok).length;

  var level = 'empty';
  if (pw.isNotEmpty && passed <= 1) {
    level = 'weak';
  } else if (passed == 2) {
    level = 'fair';
  } else if (passed == 3) {
    level = 'good';
  } else if (passed == 4) {
    level = 'strong';
  }
  return PasswordStrength(
    length: length,
    caseOk: caseOk,
    digit: digit,
    special: special,
    level: level,
  );
}

const passwordLevelLabel = {
  'empty': 'Start typing to check strength',
  'weak': 'Weak',
  'fair': 'Fair',
  'good': 'Good',
  'strong': 'Strong',
};

/// Loose RFC-ish shape check for the recovery-email step: one @, a dot in
/// the domain, no spaces. Same spirit as the web form.
bool isValidEmail(String value) {
  final v = value.trim();
  return RegExp(r'^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
      .hasMatch(v);
}
