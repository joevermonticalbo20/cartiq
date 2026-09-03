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
/// - date = first dd/mm/yyyy, yyyy-mm-dd style token
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

  final dateRe = RegExp(
    r'(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})|(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})',
  );
  String? dateText;
  for (final line in rawLines) {
    final m = dateRe.firstMatch(line);
    if (m != null) {
      dateText = m.group(0);
      break;
    }
  }

  final moneyRe = RegExp(r'(?:P|PHP)?\s*(\d{1,6}(?:[.,]\d{1,2})?)');
  double? bestAmount;
  double? totalLineAmount;
  for (final line in rawLines) {
    final withoutDates = line.replaceAll(dateRe, ' ');
    for (final m in moneyRe.allMatches(withoutDates)) {
      final raw = m.group(1)!.replaceAll(',', '.');
      final value = double.tryParse(raw);
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
