import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../widgets/app_skeleton.dart';
import '../widgets/empty_state.dart';
import '../widgets/section_header.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, this.onNewSale});

  /// Optional callback to jump to the POS tab (provided by RootShell).
  final VoidCallback? onNewSale;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
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

  bool _matches(Map<String, dynamic> order, String q) {
    if (q.isEmpty) return true;
    final lq = q.toLowerCase();
    final total = 'P${((order['total'] ?? 0) as num).toStringAsFixed(0)}';
    if (total.toLowerCase().contains(lq)) return true;
    final items = (order['items'] as List?) ?? [];
    for (final it in items) {
      if ((it['productName'] as String? ?? '').toLowerCase().contains(lq)) {
        return true;
      }
      if ((it['flavor'] as String? ?? '').toLowerCase().contains(lq)) {
        return true;
      }
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
      final token = auth.token;
      if (token == null) {
        if (!mounted) return;
        setState(() => _error = 'Session expired. Please log in again.');
        return;
      }
      final data = await auth.api.ordersPaged(
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
      if (!mounted) return;
      setState(() => _error = e.message);
    } on FormatException {
      if (!mounted) return;
      setState(() => _error = 'Server returned an unexpected response.');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Unexpected error: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _rows.where((o) => _matches(o, _search)).toList();
    final hasResults = filtered.isNotEmpty;
    // Group consecutive rows by day with a header (date · sales · day total).
    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final o in filtered) {
      final dt = DateTime.tryParse('${o['createdAt']}');
      final key = dt == null
          ? 'Unknown date'
          : '${dt.year}/${dt.month}/${dt.day}';
      (grouped[key] ??= []).add(o);
    }
    final rows = <Object>[];
    for (final entry in grouped.entries) {
      final dayTotal = entry.value.fold<double>(
        0,
        (s, o) => s + ((o['total'] ?? 0) as num).toDouble(),
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
                  hintText: 'Search product, flavor, amount...',
                  border: InputBorder.none,
                ),
                style: Theme.of(context).textTheme.titleMedium,
                onChanged: (v) => setState(() => _search = v.trim()),
              )
            : const Text('Sales history'),
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
              tooltip: 'Search sales',
              onPressed: () => setState(() => _searching = true),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _loadMore(reset: true),
        child: _rows.isEmpty && _loading && _error == null
            ? ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(14),
                children: const [AppSkeleton(rows: 6)],
              )
            : !hasResults && !_loading
            ? AppEmptyState(
                icon: _search.isNotEmpty
                    ? Icons.search_off_rounded
                    : Icons.receipt_long_rounded,
                title:
                    _error ??
                    (_search.isNotEmpty
                        ? 'No sales match "$_search"'
                        : 'No sales recorded yet'),
                subtitle: _search.isNotEmpty
                    ? 'Try a different product, flavor, or amount.'
                    : (widget.onNewSale != null
                          ? 'Record a sale on the POS tab to see it appear here.'
                          : null),
                actionLabel: _search.isNotEmpty
                    ? 'Clear search'
                    : (widget.onNewSale != null ? 'Open POS' : null),
                actionIcon: _search.isNotEmpty
                    ? Icons.close
                    : Icons.point_of_sale_rounded,
                onAction: _search.isNotEmpty
                    ? () => setState(() {
                        _search = '';
                        _searchCtrl.clear();
                        _searching = false;
                      })
                    : widget.onNewSale,
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
                        child: SectionHeader(
                          title: date,
                          eyebrow: '$count sale${count != 1 ? 's' : ''}',
                          trailing: Text(
                            'P${total.toStringAsFixed(0)}',
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                        ),
                      );
                    }
                    final o = row as Map<String, dynamic>;
                    final items = (o['items'] as List)
                        .map(
                          (it) =>
                              '${it['qty']}x ${it['productName']}${it['flavor'] != null ? ' (${it['flavor']})' : ''}',
                        )
                        .join(', ');
                    final dt = DateTime.tryParse('${o['createdAt']}');
                    final dateStr = dt == null
                        ? '-'
                        : '${dt.year}/${dt.month}/${dt.day}';
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
                            color: AppColors.ok.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(AppRadius.s),
                          ),
                          child: const Icon(
                            Icons.payments_rounded,
                            size: 21,
                            color: AppColors.ok,
                          ),
                        ),
                        title: Row(
                          children: [
                            Text(
                              'P${((o['total'] ?? 0) as num).toStringAsFixed(0)}',
                              style: Theme.of(context).textTheme.titleMedium
                                  ?.copyWith(fontWeight: FontWeight.w800),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              '${(o['items'] as List).length} item(s)',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                        subtitle: Text(
                          items,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        isThreeLine: false,
                        trailing: Text(
                          dateStr,
                          style: Theme.of(context).textTheme.labelSmall,
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
