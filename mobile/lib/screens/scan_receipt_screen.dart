import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/receipt_scanner.dart';
import '../utils/money_input.dart';
import '../utils/text_input.dart';
import '../theme.dart';

class ScanReceiptScreen extends StatefulWidget {
  const ScanReceiptScreen({super.key});

  @override
  State<ScanReceiptScreen> createState() => _ScanReceiptScreenState();
}

class _ScanReceiptScreenState extends State<ScanReceiptScreen> {
  final ReceiptScanner _scanner = ReceiptScanner();
  final _vendor = TextEditingController();
  final _amount = TextEditingController();
  final _date = TextEditingController();
  final _note = TextEditingController();
  String? _locationCode;
  String _category = 'Supplies';
  bool _busy = false;
  String? _message;
  bool _messageIsError = false;
  List<Map<String, dynamic>> _locations = const [];

  static const _categories = [
    'Supplies',
    'LPG/Gas',
    'Maintenance',
    'Fees/Rent',
    'Other',
  ];

  bool get _ocrSupported => Platform.isAndroid || Platform.isIOS;

  @override
  void initState() {
    super.initState();
    final auth = context.read<AuthState>();
    _locationCode = auth.locationCode;
    final token = auth.token;
    if (token == null) return;
    auth.api.catalog(token).then((data) {
      if (!mounted) return;
      setState(() {
        _locations = (data['locations'] as List).cast<Map<String, dynamic>>();
      });
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _scanner.dispose();
    _vendor.dispose();
    _amount.dispose();
    _date.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pick(ImageSource source) async {
    setState(() {
      _busy = true;
      _message = null;
      _messageIsError = false;
    });
    try {
      final picker = ImagePicker();
      final xfile = await picker.pickImage(source: source, imageQuality: 85);
      if (xfile == null) return;
      final parsed = await _scanner.scanFromFile(xfile.path);
      if (!mounted) return;
      setState(() {
        _vendor.text = parsed.vendor;
        if (parsed.amount != null) _amount.text = parsed.amount.toString();
        if (parsed.dateText != null) _date.text = parsed.dateText!;
        _note.text =
            'OCR lines: ${parsed.lines.take(5).join(' / ')}';
        _message = 'Receipt scanned - review the fields below before saving.';
        _messageIsError = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _message = 'Scan failed: $e';
        _messageIsError = true;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save(bool ocrSource) async {
    final vendor = TextInputRules.sanitize(_vendor.text).trim();
    final note = TextInputRules.sanitize(_note.text).trim();
    if (!TextInputRules.isValidVendor(_vendor.text)) {
      setState(() {
        _message =
            'Vendor needs at least 2 letters (max 40 characters, single spaces).';
        _messageIsError = true;
      });
      return;
    }
    if (!TextInputRules.isValidNote(_note.text)) {
      setState(() {
        _message =
            'Note needs at least 2 letters when provided (max 40 characters).';
        _messageIsError = true;
      });
      return;
    }
    final amount = MoneyInput.tryParse(_amount.text);
    if (amount == null || amount <= 0) {
      setState(() {
        _message = 'Enter an amount from P0.01 to P9,999,999.99.';
        _messageIsError = true;
      });
      return;
    }
    // Expenses are online-only (not queued offline). Surface connectivity
    // failures honestly instead of silently dropping them.
    final auth = context.read<AuthState>();
    if (auth.token == null) {
      setState(() {
        _message = 'Session expired — please log in again.';
        _messageIsError = true;
      });
      return;
    }
    try {
      final online = await auth.api.health();
      if (!mounted) return;
      if (!online) {
        setState(() {
          _message =
              'Offline — expenses need a connection and are not queued. Reconnect and try again; POS sales are the only offline-queued records.';
          _messageIsError = true;
        });
        return;
      }
    } catch (_) {
      // Fall through to createExpense which will report the real error.
    }
    setState(() {
      _busy = true;
      _message = null;
      _messageIsError = false;
    });
    // Prefer the OCR-parsed date (ISO, dd/mm/yyyy, or month names);
    // otherwise the server records upload time. Raw text stays visible.
    DateTime expenseDate = DateTime.now();
    final dateText = _date.text.trim();
    if (dateText.isNotEmpty) {
      expenseDate = parseReceiptDate(dateText) ?? DateTime.now();
    }
    try {
      await auth.api.createExpense(auth.token ?? '', {
        'vendor': vendor,
        'locationCode': _locationCode,
        'amount': amount,
        'date': expenseDate.toIso8601String(),
        'source': ocrSource ? 'OCR' : 'MANUAL',
        'category': _category,
        'note': note.isEmpty ? '' : note,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Expense recorded: $vendor (P${amount.toStringAsFixed(2)})')),
      );
      Navigator.pop(context);
    } on ApiException catch (e) {
      setState(() {
        _message = e.message;
        _messageIsError = true;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _stepBadge(int n, String label, {IconData? icon}) {
    return Row(
      children: [
        Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            color: AppColors.primary,
            borderRadius: BorderRadius.circular(AppRadius.s),
          ),
          child: Center(
            child: Text('$n',
                style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: Colors.white)),
          ),
        ),
        const SizedBox(width: AppSpacing.space2),
        if (icon != null) ...[
          Icon(icon, size: 18, color: AppColors.primary),
          const SizedBox(width: AppSpacing.space1),
        ],
        Text(label, style: Theme.of(context).textTheme.titleMedium),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Record expense')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.space4),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space3),
              child: Row(
                children: [
                  const Icon(Icons.cloud_off_outlined, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Expenses need a connection — they are sent immediately and are not queued offline (POS sales queue instead).',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.space3),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _stepBadge(1, 'Scan vendor receipt',
                      icon: Icons.document_scanner_rounded),
                  const SizedBox(height: AppSpacing.space3),
                  Text(
                    _ocrSupported
                        ? 'On-device OCR (ML Kit). Fields auto-fill after scanning.'
                        : 'On-device OCR runs on Android/iOS builds. On Windows, fill the form manually.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  Row(
                    children: [
                      Expanded(
                        child: FilledButton.tonalIcon(
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(0, 48),
                          ),
                          onPressed:
                              !_ocrSupported || _busy ? null : () => _pick(ImageSource.camera),
                          icon: const Icon(Icons.photo_camera),
                          label: const Text('Camera'),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.space3),
                      Expanded(
                        child: FilledButton.tonalIcon(
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(0, 48),
                          ),
                          onPressed:
                              !_ocrSupported || _busy ? null : () => _pick(ImageSource.gallery),
                          icon: const Icon(Icons.photo_library),
                          label: const Text('Gallery'),
                        ),
                      ),
                    ],
                  ),
                  if (_busy)
                    const Padding(
                      padding: EdgeInsets.only(top: AppSpacing.space3),
                      child: LinearProgressIndicator(),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.space3),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _stepBadge(2, 'Confirm details', icon: Icons.fact_check_rounded),
                  const SizedBox(height: AppSpacing.space3),
                  DropdownButtonFormField<String>(
                    initialValue: _locationCode,
                    decoration: const InputDecoration(
                      labelText: 'Cart location',
                    ),
                    items: _locations
                        .map((loc) => DropdownMenuItem(
                              value: loc['code'] as String,
                              child: Text('${loc['code']} - ${loc['name']}'),
                            ))
                        .toList(),
                    onChanged: (v) => setState(() => _locationCode = v),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  DropdownButtonFormField<String>(
                    initialValue: _category,
                    decoration: const InputDecoration(
                      labelText: 'Category',
                    ),
                    items: _categories
                        .map((c) => DropdownMenuItem(value: c, child: Text(c)))
                        .toList(),
                    onChanged: (v) => setState(() => _category = v ?? 'Supplies'),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: _vendor,
                    inputFormatters: const [SingleSpaceFormatter()],
                    decoration: const InputDecoration(
                      labelText: 'Vendor *',
                      helperText: 'Min 2 letters, max 40',
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: _amount,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [MoneyInputFormatter()],
                    decoration: const InputDecoration(
                      labelText: 'Amount (PHP) *',
                      helperText: 'Max 7 digits, up to 2 decimals',
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: _date,
                    decoration: const InputDecoration(
                      labelText: 'Date text (from receipt)',
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: _note,
                    maxLines: 2,
                    inputFormatters: const [SingleSpaceFormatter()],
                    decoration: const InputDecoration(
                      labelText: 'Note / OCR excerpt',
                      helperText: 'Max 40 characters',
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space2),
              child: Container(
                padding: const EdgeInsets.all(AppSpacing.space3),
                decoration: BoxDecoration(
                  color: _messageIsError
                      ? AppColors.danger.withValues(alpha: 0.12)
                      : AppColors.primary.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(AppRadius.s),
                  border: Border.all(
                    color: _messageIsError
                        ? AppColors.danger.withValues(alpha: 0.35)
                        : AppColors.primary.withValues(alpha: 0.30),
                    width: 1,
                  ),
                ),
                child: Text(
                  _message!,
                  style: TextStyle(
                    color: _messageIsError
                        ? AppColors.danger
                        : AppColors.primary,
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                ),
              ),
            ),
          const SizedBox(height: AppSpacing.space3),
          FilledButton.icon(
            onPressed: _busy ? null : () => _save(true),
            icon: const Icon(Icons.save),
            label: const Text('Save expense (OCR)'),
          ),
          const SizedBox(height: AppSpacing.space2),
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _save(false),
            icon: const Icon(Icons.edit_note),
            label: const Text('Save as manual entry'),
          ),
        ],
      ),
    );
  }
}
