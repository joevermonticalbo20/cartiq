import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';

class ParsedReceipt {
  final String vendor;
  final String? dateText;
  final double? amount;
  final List<String> lines;
  final String rawText;

  ParsedReceipt({
    required this.vendor,
    this.dateText,
    this.amount,
    required this.lines,
    required this.rawText,
  });
}

/// On-device OCR receipt parser (ML Kit, no cloud). Heuristics:
/// - vendor = first short alphabetic line
/// - amount = value on the "total" line, otherwise the largest money value
/// - date = first ISO, numeric, or month-name date token
/// Money understands both 1,234.50 and 1.234,50 thousand styles.
ParsedReceipt parseReceiptText(String text) {
  final rawLines =
      text.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty).toList();

  String vendor = '';
  for (final line in rawLines) {
    if (line.contains(RegExp(r'[A-Za-z]{3}')) && line.length <= 40) {
      vendor = line;
      break;
    }
  }

  const monthNames = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
  final dateRe = RegExp(
    '(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2})'
    '|(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4})'
    '|(\\d{1,2}\\s+(?:$monthNames)[a-z]*\\s+\\d{2,4})'
    '|((?:$monthNames)[a-z]*\\s+\\d{1,2},?\\s+\\d{2,4})',
    caseSensitive: false,
  );
  String? dateText;
  for (final line in rawLines) {
    final m = dateRe.firstMatch(line);
    if (m != null) {
      dateText = m.group(0);
      break;
    }
  }

  final moneyRe = RegExp(
    r'(?:P|PHP)?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)',
  );
  double? bestAmount;
  double? totalLineAmount;
  for (final line in rawLines) {
    final withoutDates = line.replaceAll(dateRe, ' ');
    for (final m in moneyRe.allMatches(withoutDates)) {
      final value = _parseMoney(m.group(1)!);
      if (value == null || value <= 0 || value > 500000) continue;
      if (bestAmount == null || value > bestAmount) bestAmount = value;
      if (line.toLowerCase().contains('total') && value > (totalLineAmount ?? 0)) {
        totalLineAmount = value;
      }
    }
  }

  return ParsedReceipt(
    vendor: vendor,
    dateText: dateText,
    amount: totalLineAmount ?? bestAmount,
    lines: rawLines.take(30).toList(),
    rawText: text,
  );
}

/// Parse a money token in either thousand style:
/// "1,234.50" and "1.234,50" both yield 1234.5.
/// A lone comma is a decimal mark only with 1-2 trailing digits
/// ("1,25" -> 1.25); otherwise commas are thousands ("1,250" -> 1250).
/// Returns null when the token is not a plausible amount.
double? parseMoneyToken(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return null;
  final hasComma = s.contains(',');
  final hasDot = s.contains('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replaceAll('.', '').replaceAll(',', '.');
    } else {
      s = s.replaceAll(',', '');
    }
  } else if (hasComma) {
    final parts = s.split(',');
    if (parts.length == 2 && parts[1].length <= 2) {
      s = '${parts[0]}.${parts[1]}';
    } else {
      s = parts.join('');
    }
  }
  final value = double.tryParse(s);
  if (value == null || value <= 0 || value > 500000) return null;
  return value;
}

double? _parseMoney(String raw) => parseMoneyToken(raw);

const _monthIndex = {
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
  'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
};

/// Parse a receipt date token (ISO, dd/mm/yyyy with any separator, or
/// month-name forms like "12 Sep 2026" / "Sep 12, 2026").
/// Returns null for malformed input instead of throwing.
DateTime? parseReceiptDate(String? text) {
  if (text == null) return null;
  final t = text.trim();
  if (t.isEmpty) return null;
  final iso = DateTime.tryParse(t);
  if (iso != null) return iso;
  final numeric = RegExp(r'^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$').firstMatch(t);
  if (numeric != null) {
    var year = int.parse(numeric.group(3)!);
    if (year < 100) year += 2000;
    final day = int.parse(numeric.group(1)!);
    final month = int.parse(numeric.group(2)!);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return DateTime(year, month, day);
  }
  final named = RegExp(
    r'^(?:(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})|([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{2,4}))$',
  ).firstMatch(t);
  if (named != null) {
    // First three letters identify the month ("sept" -> "sep").
    final monthName = (named.group(2) ?? named.group(4) ?? '').toLowerCase();
    if (monthName.length < 3) return null;
    final month = _monthIndex[monthName.substring(0, 3)];
    if (month == null) return null;
    var year = int.parse(named.group(3) ?? named.group(6)!);
    if (year < 100) year += 2000;
    final day = int.parse(named.group(1) ?? named.group(5)!);
    if (day < 1 || day > 31) return null;
    return DateTime(year, month, day);
  }
  return null;
}

/// Thin wrapper so screens never touch ML Kit classes directly.
class ReceiptScanner {
  final TextRecognizer _recognizer = TextRecognizer(
    script: TextRecognitionScript.latin,
  );

  Future<ParsedReceipt> scanFromFile(String filePath) async {
    final input = InputImage.fromFilePath(filePath);
    final result = await _recognizer.processImage(input);
    return parseReceiptText(result.text);
  }

  void dispose() => _recognizer.close();
}
