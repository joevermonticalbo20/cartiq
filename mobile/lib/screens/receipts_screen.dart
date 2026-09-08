import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../theme.dart';
import '../widgets/empty_state.dart';
import 'scan_receipt_screen.dart';

class ReceiptsScreen extends StatefulWidget {
  const ReceiptsScreen({super.key, this.onScanReceipt});

  /// Optional callback to launch the scan flow (used by the empty-state CTA).
  final Future<void> Function()? onScanReceipt;

  @override
  State<ReceiptsScreen> createState() => _ReceiptsScreenState();
}

class _ReceiptsScreenState extends State<ReceiptsScreen> {
  final List<Map<String, dynamic>> _rows = [];
  int _page = 1;
  bool _loading = false;
  bool _done = false;
  bool _searching = false;
  String _search = '';
  final _searchCtrl = TextEditingController();
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadMore();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  bool _matches(Map<String, dynamic> e, String q) {
    if (q.isEmpty) return true;
    final lq = q.toLowerCase();
    final amount = 'P${((e['amount'] ?? 0) as num).toStringAsFixed(0)}';
    if (amount.toLowerCase().contains(lq)) return true;
    if ((e['vendor'] as String? ?? '').toLowerCase().contains(lq)) return true;
    if ((e['category'] as String? ?? '').toLowerCase().contains(lq)) {
      return true;
    }
    if ((e['note'] as String? ?? '').toLowerCase().contains(lq)) return true;
    final loc = e['location'] as Map<String, dynamic>?;
    if (loc != null &&
        (loc['code'] as String? ?? '').toLowerCase().contains(lq)) {
      return true;
    }
    return false;
  }

  Future<void> _loadMore({bool reset = false}) async {
    if (_loading || (_done && !reset)) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final auth = context.read<AuthState>();
      final data = await auth.api.expensesPaged(
        auth.token!,
        page: reset ? 1 : _page,
        locationCode: auth.locationCode,
      );
      final batch = (data['data'] as List).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() {
        if (reset) _rows.clear();
        _rows.addAll(batch);
        _page = reset ? 2 : _page + 1;
        _done = batch.length < 10;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _scanAndReload() async {
    if (widget.onScanReceipt != null) {
      await widget.onScanReceipt!();
    } else {
      await Navigator.of(
        context,
      ).push(MaterialPageRoute(builder: (_) => const ScanReceiptScreen()));
    }
    _loadMore(reset: true);
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _rows.where((e) => _matches(e, _search)).toList();
    final hasResults = filtered.isNotEmpty;
    // Group consecutive rows by day with a header (date · receipts · total).
    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final e in filtered) {
      final dt = DateTime.tryParse('${e['date']}');
      final key = dt == null
          ? 'Unknown date'
          : '${dt.year}/${dt.month}/${dt.day}';
      (grouped[key] ??= []).add(e);
    }
    final rows = <Object>[];
    for (final entry in grouped.entries) {
      final dayTotal = entry.value.fold<double>(
        0,
        (s, e) => s + ((e['amount'] ?? 0) as num).toDouble(),
      );
      rows.add((entry.key, entry.value.length, dayTotal));
      rows.addAll(entry.value);
    }
    return Scaffold(
      appBar: AppBar(
        title: _searching
            ? TextField(
                controller: _searchCtrl,
                autofocus: true,
                decoration: const InputDecoration(
                  hintText: 'Search vendor, category, amount...',
                  border: InputBorder.none,
                ),
                style: Theme.of(context).textTheme.titleMedium,
                onChanged: (v) => setState(() => _search = v.trim()),
              )
            : const Text('Expenses'),
        actions: [
          if (_searching)
            IconButton(
              icon: const Icon(Icons.close),
              tooltip: 'Close search',
              onPressed: () {
                setState(() {
                  _searching = false;
                  _search = '';
                  _searchCtrl.clear();
                });
              },
            )
          else
            IconButton(
              icon: const Icon(Icons.search),
              tooltip: 'Search expenses',
              onPressed: () => setState(() => _searching = true),
            ),
          if (!_searching)
            IconButton(
              icon: const Icon(Icons.add),
              tooltip: 'Scan / record expense',
              onPressed: _scanAndReload,
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _loadMore(reset: true),
        child: !hasResults && !_loading
            ? AppEmptyState(
                icon: _search.isNotEmpty
                    ? Icons.search_off_rounded
                    : Icons.receipt_long,
                title:
                    _error ??
                    (_search.isNotEmpty
                        ? 'No expenses match "$_search"'
                        : 'No expenses yet'),
                subtitle: _search.isNotEmpty
                    ? 'Try a different vendor, category, or amount.'
                    : 'Snap a receipt and CartIQ will fill in the details.',
                actionLabel: _search.isNotEmpty
                    ? 'Clear search'
                    : 'Scan a receipt',
                actionIcon: _search.isNotEmpty
                    ? Icons.close
                    : Icons.camera_alt_rounded,
                onAction: _search.isNotEmpty
                    ? () => setState(() {
                        _search = '';
                        _searchCtrl.clear();
                        _searching = false;
                      })
                    : () => _scanAndReload(),
              )
            : NotificationListener<ScrollNotification>(
                onNotification: (n) {
                  if (n.metrics.pixels > n.metrics.maxScrollExtent - 200) {
                    _loadMore();
                  }
                  return false;
                },
                child: ListView.separated(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(14),
                  itemCount: rows.length + (_loading ? 1 : 0),
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, i) {
                    if (i >= rows.length) {
                      return const Center(
                        child: Padding(
                          padding: EdgeInsets.all(12),
                          child: CircularProgressIndicator(),
                        ),
                      );
                    }
                    final row = rows[i];
                    if (row is (String, int, double)) {
                      final (date, count, total) = row;
                      return Padding(
                        padding: const EdgeInsets.only(top: 6, bottom: 2),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                '$date · $count receipt${count != 1 ? 's' : ''}',
                                style: Theme.of(context).textTheme.labelSmall,
                              ),
                            ),
                            Text(
                              'P${total.toStringAsFixed(0)}',
                              style: Theme.of(context).textTheme.labelSmall
                                  ?.copyWith(fontWeight: FontWeight.w800),
                            ),
                          ],
                        ),
                      );
                    }
                    final e = row as Map<String, dynamic>;
                    final isOcr = e['source'] == 'OCR';
                    final dt = DateTime.tryParse('${e['date']}');
                    final dateStr = dt == null
                        ? '-'
                        : '${dt.month}/${dt.day} · ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
                    return Card(
                      margin: EdgeInsets.zero,
                      child: ListTile(
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 6,
                        ),
                        leading: Container(
                          width: 42,
                          height: 42,
                          decoration: BoxDecoration(
                            color: isOcr
                                ? AppColors.primary.withValues(alpha: 0.13)
                                : Theme.of(context).dividerColor,
                            borderRadius: BorderRadius.circular(AppRadius.s),
                          ),
                          child: Icon(
                            isOcr
                                ? Icons.document_scanner_rounded
                                : Icons.edit_note_rounded,
                            size: 21,
                            color: isOcr
                                ? AppColors.primary
                                : Theme.of(
                                    context,
                                  ).colorScheme.onSurfaceVariant,
                          ),
                        ),
                        title: Text(
                          e['vendor'] ?? '',
                          style: Theme.of(context).textTheme.titleMedium,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: Text(
                          '$dateStr · ${e['category'] ?? 'Other'}'
                          '${(e['location'] as Map<String, dynamic>?)?['code'] != null ? ' · ${(e['location'] as Map<String, dynamic>)['code']}' : ''}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              'P${((e['amount'] ?? 0) as num).toStringAsFixed(0)}',
                              style: Theme.of(context).textTheme.titleMedium
                                  ?.copyWith(fontWeight: FontWeight.w800),
                            ),
                            const SizedBox(height: 2),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 7,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: isOcr
                                    ? AppColors.warn
                                    : Theme.of(
                                        context,
                                      ).colorScheme.surfaceContainerHighest,
                                borderRadius: BorderRadius.circular(99),
                              ),
                              child: Text(
                                e['source'] ?? 'MANUAL',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w800,
                                  color: isOcr
                                      ? Colors.white
                                      : Theme.of(
                                          context,
                                        ).colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
      ),
    );
  }
}
