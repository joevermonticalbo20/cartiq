import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../theme.dart';
import '../utils/manila_time.dart';
import '../widgets/app_badge.dart';
import '../widgets/app_skeleton.dart';
import '../widgets/empty_state.dart';
import '../widgets/section_header.dart';
import 'scan_receipt_screen.dart';

class ReceiptsScreen extends StatefulWidget {
  const ReceiptsScreen({super.key, this.onScanReceipt});

  final Future<void> Function()? onScanReceipt;

  @override
  State<ReceiptsScreen> createState() => ReceiptsScreenState();
}

class ReceiptsScreenState extends State<ReceiptsScreen> {
  void reload() => _loadMore(reset: true);

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

  void _fail(String message) {
    if (!mounted) return;
    final hadRows = _rows.isNotEmpty;
    setState(() => _error = message);
    if (hadRows && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Refresh failed: $message')));
    }
  }

  Future<void> _loadMore({bool reset = false}) async {
    if (_loading || (_done && !reset)) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final auth = context.read<AuthState>();
      final token = auth.token;
      if (token == null) {
        if (!mounted) return;
        setState(() => _error = 'Session expired. Please log in again.');
        return;
      }
      final data = await auth.api.expensesPaged(
        token,
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
      _fail(e.message);
    } on FormatException {
      _fail('Server returned an unexpected response.');
    } catch (e) {
      _fail('Unexpected error: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _scanAndReload() async {
    if (_loading) return;
    if (widget.onScanReceipt != null) {
      await widget.onScanReceipt!();
    } else {
      await Navigator.of(
        context,
      ).push(MaterialPageRoute(builder: (_) => const ScanReceiptScreen()));
    }
    if (!mounted) return;
    _loadMore(reset: true);
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _rows.where((e) => _matches(e, _search)).toList();
    final hasResults = filtered.isNotEmpty;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final e in filtered) {
      final key = ManilaTime.groupKey(e['date']);
      final label = key == 'unknown' ? 'Unknown date' : key;
      (grouped[label] ??= []).add(e);
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
        child: _rows.isEmpty && _loading && _error == null
            ? ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(AppSpacing.space4),
                children: const [AppSkeleton(rows: 6)],
              )
            : !hasResults && !_loading
            ? AppEmptyState(
                isError: _error != null,
                icon: _error != null
                    ? Icons.error_outline_rounded
                    : _search.isNotEmpty
                    ? Icons.search_off_rounded
                    : Icons.receipt_long,
                title: _error != null
                    ? _error!
                    : _search.isNotEmpty
                    ? 'No expenses match "$_search"'
                    : 'No expenses yet',
                subtitle: _error != null
                    ? 'Please check your internet connection and try again.'
                    : _search.isNotEmpty
                    ? 'Try a different vendor, category, or amount.'
                    : 'Snap a receipt and CartIQ will fill in the details.',
                actionLabel: _error != null
                    ? 'Tap to retry'
                    : _search.isNotEmpty
                    ? 'Clear search'
                    : 'Scan a receipt',
                actionIcon: _error != null
                    ? Icons.refresh_rounded
                    : _search.isNotEmpty
                    ? Icons.close
                    : Icons.camera_alt_rounded,
                onAction: _error != null
                    ? () => _loadMore(reset: true)
                    : _search.isNotEmpty
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
                  padding: const EdgeInsets.all(AppSpacing.space4),
                  itemCount: rows.length + (_loading ? 1 : 0),
                  separatorBuilder: (_, _) =>
                      const SizedBox(height: AppSpacing.space2),
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
                        padding: const EdgeInsets.only(
                          top: AppSpacing.space2,
                          bottom: AppSpacing.space1,
                        ),
                        child: SectionHeader(
                          title: date,
                          eyebrow: '$count receipt${count != 1 ? 's' : ''}',
                          trailing: Text(
                            'P${total.toStringAsFixed(0)}',
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                        ),
                      );
                    }
                    final e = row as Map<String, dynamic>;
                    final isOcr = e['source'] == 'OCR';
                    final dateStr = ManilaTime.shortLabel(e['date']);
                    final dateLabel = dateStr.isEmpty ? '-' : dateStr;

                    return Container(
                      clipBehavior: Clip.antiAlias,
                      decoration: BoxDecoration(
                        color: surfaceColor,
                        borderRadius: BorderRadius.circular(AppRadius.l),
                        boxShadow:
                            AppShadow.sm(), // Pinalitan ng shadow nang walang border
                      ),
                      child: Material(
                        color: Colors.transparent,
                        child: ListTile(
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.space4,
                            vertical: AppSpacing.space2,
                          ),
                          leading: Container(
                            width: 44,
                            height: 44,
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
                            '$dateLabel   ${e['category'] ?? 'Other'}'
                            '${(e['location'] as Map<String, dynamic>?)?['code'] != null ? '   ${(e['location'] as Map<String, dynamic>)['code']}' : ''}',
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
                              AppBadge(
                                label: e['source'] ?? 'MANUAL',
                                variant: isOcr
                                    ? AppBadgeVariant.warn
                                    : AppBadgeVariant.neutral,
                              ),
                            ],
                          ),
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
