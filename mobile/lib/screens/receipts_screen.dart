import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/data_refresh.dart';
import '../theme.dart';
import '../utils/app_messenger.dart';
import '../utils/haptics.dart';
import '../utils/manila_time.dart';
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

  String _categoryFilter = 'All';
  final List<String> _filters = [
    'All',
    'Manual',
    'OCR',
    'Supplies',
    'LPG/Gas',
    'Maintenance',
    'Fees/Rent',
    'Other',
  ];

  // STATE PARA SA AUTO-HIDE SCROLL
  bool _showFilters = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bus = context.read<DataRefresh?>();
    if (bus != null && !identical(bus, _bus)) {
      _bus?.removeListener(_onDataChanged);
      _bus = bus..addListener(_onDataChanged);
    }
  }

  DataRefresh? _bus;
  void _onDataChanged() {
    if (!mounted) {
      return;
    }
    _loadMore(reset: true);
  }

  @override
  void initState() {
    super.initState();
    _loadMore();
  }

  @override
  void dispose() {
    _bus?.removeListener(_onDataChanged);
    _bus = null;
    _searchCtrl.dispose();
    super.dispose();
  }

  bool _matches(Map<String, dynamic> e, String q) {
    if (q.isEmpty) {
      return true;
    }
    final lq = q.toLowerCase();
    final amount = '₱${((e['amount'] ?? 0) as num).toStringAsFixed(0)}';

    if (amount.toLowerCase().contains(lq)) {
      return true;
    }
    if ((e['vendor'] as String? ?? '').toLowerCase().contains(lq)) {
      return true;
    }
    if ((e['category'] as String? ?? '').toLowerCase().contains(lq)) {
      return true;
    }
    if ((e['note'] as String? ?? '').toLowerCase().contains(lq)) {
      return true;
    }
    final loc = e['location'] as Map<String, dynamic>?;
    if (loc != null &&
        (loc['code'] as String? ?? '').toLowerCase().contains(lq)) {
      return true;
    }
    return false;
  }

  /// The category chips filter the rows that are already loaded. Kept as its
  /// own predicate so the list and the "keep paging" helper cannot drift.
  bool _passesFilter(Map<String, dynamic> e) {
    if (_categoryFilter == 'OCR' && e['source'] != 'OCR') {
      return false;
    }
    if (_categoryFilter == 'Manual' && e['source'] == 'OCR') {
      return false;
    }
    if (!['All', 'OCR', 'Manual'].contains(_categoryFilter)) {
      if (e['category'] != _categoryFilter) {
        return false;
      }
    }
    return true;
  }

  bool _isVisible(Map<String, dynamic> e) =>
      _matches(e, _search) && _passesFilter(e);

  void _fail(String message) {
    if (!mounted) {
      return;
    }
    final hadRows = _rows.isNotEmpty;
    setState(() => _error = message);
    if (hadRows && mounted) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'Refresh failed: $message',
        isSuccess: false,
      );
    }
  }

  Future<void> _loadMore({bool reset = false}) async {
    if (_loading || (_done && !reset)) {
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final auth = context.read<AuthState>();
      final token = auth.token;
      if (token == null) {
        if (!mounted) {
          return;
        }
        setState(() => _error = 'Session expired. Please log in again.');
        return;
      }
      final data = await auth.api.expensesPaged(
        token,
        page: reset ? 1 : _page,
        locationCode: auth.locationCode,
      );

      final batch = (data['data'] as List).cast<Map<String, dynamic>>();
      if (!mounted) {
        return;
      }
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

  /// The category chips filter the rows that are already loaded, so a match
  /// that lives on page 2 would look like "no results" - and the empty state
  /// replaces the paginated list, so no further page is ever requested and
  /// the expense is unreachable.
  ///
  /// Keep paging while a filter is on until it matches something, or the
  /// server runs out of rows.
  Future<void> _ensureFilterMatch() async {
    if (_categoryFilter == 'All') {
      return;
    }
    while (mounted && !_done && !_loading) {
      if (_rows.any(_isVisible)) {
        return;
      }
      final pageBefore = _page;
      await _loadMore();
      if (_page == pageBefore) {
        // No progress - the request failed. Stop rather than spin.
        return;
      }
    }
  }

  Future<void> _scanAndReload() async {
    if (_loading) {
      return;
    }

    if (widget.onScanReceipt != null) {
      await widget.onScanReceipt!();
    } else {
      await Navigator.of(
        context,
      ).push(MaterialPageRoute(builder: (_) => const ScanReceiptScreen()));
    }

    if (!mounted) {
      return;
    }
    _loadMore(reset: true);
  }

  Future<void> _showReceiptDetails(Map<String, dynamic> e) async {
    final isOcr = e['source'] == 'OCR';
    final dt = ManilaTime.parse(e['date']);
    final dateStr = dt != null
        ? '${dt.month}/${dt.day}/${dt.year}   ${ManilaTime.formatClock12(dt)}'
        : 'Unknown Date';
    final amount = ((e['amount'] ?? 0) as num).toDouble();

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.fromLTRB(
          AppSpacing.space5,
          AppSpacing.space3,
          AppSpacing.space5,
          MediaQuery.of(context).viewInsets.bottom + AppSpacing.space6,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.85,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  margin: const EdgeInsets.symmetric(
                    vertical: AppSpacing.space2,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.3),
                    borderRadius: BorderRadius.circular(AppRadius.xs),
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.space2),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(AppRadius.m),
                    ),
                    child: Icon(
                      isOcr
                          ? Icons.document_scanner_rounded
                          : Icons.edit_note_rounded,
                      color: AppColors.primary,
                      size: 28,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.space3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          e['vendor'] ?? 'Unknown Vendor',
                          style: Theme.of(context).textTheme.headlineSmall
                              ?.copyWith(
                                fontWeight: FontWeight.w900,
                                letterSpacing: -0.5,
                              ),
                        ),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            const Icon(
                              Icons.calendar_today_rounded,
                              size: 14,
                              color: AppColors.muted,
                            ),
                            const SizedBox(width: 4),
                            Text(
                              dateStr,
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(fontWeight: FontWeight.w600),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(AppRadius.pill),
                      border: Border.all(
                        color: AppColors.primary.withValues(alpha: 0.2),
                      ),
                    ),
                    child: Text(
                      isOcr ? 'OCR' : 'Manual',
                      style: const TextStyle(
                        color: AppColors.primary,
                        fontWeight: FontWeight.w800,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.space4),
              // The note can be 500 characters (the API caps it there) and the
              // vendor 120. Without a scroll view the details box grows past
              // the sheet, the note is cut off, and the Close button is pushed
              // off the bottom - the sheet can then only be dismissed by
              // tapping outside it.
              Flexible(
                child: SingleChildScrollView(
                  child: Container(
                    padding: const EdgeInsets.all(AppSpacing.space4),
                    decoration: BoxDecoration(
                      color: Theme.of(
                        context,
                      ).dividerColor.withValues(alpha: 0.05),
                      borderRadius: BorderRadius.circular(AppRadius.l),
                      border: Border.all(
                        color: Theme.of(
                          context,
                        ).dividerColor.withValues(alpha: 0.2),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Text(
                              'Total Amount',
                              style: TextStyle(
                                fontWeight: FontWeight.w800,
                                fontSize: 16,
                              ),
                            ),
                            Text(
                              '₱${amount.toStringAsFixed(2)}',
                              style: const TextStyle(
                                fontSize: 22,
                                fontWeight: FontWeight.w900,
                                color: AppColors.primary,
                              ),
                            ),
                          ],
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            vertical: AppSpacing.space3,
                          ),
                          child: Divider(
                            height: 1,
                            color: Theme.of(
                              context,
                            ).dividerColor.withValues(alpha: 0.4),
                          ),
                        ),
                        _detailRow('Category', e['category'] ?? 'Other'),
                        const SizedBox(height: 12),
                        _detailRow(
                          'Location Code',
                          (e['location'] as Map<String, dynamic>?)?['code'] ??
                              'N/A',
                        ),
                        if (e['note'] != null &&
                            e['note'].toString().trim().isNotEmpty) ...[
                          const SizedBox(height: 12),
                          _detailRow('Note', e['note'].toString()),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.space5),
              FilledButton(
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(52),
                ),
                onPressed: () => Navigator.pop(sheetContext),
                child: const Text('Close'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _detailRow(String label, String value) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontWeight: FontWeight.w600,
            color: AppColors.muted,
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Text(
            value,
            textAlign: TextAlign.right,
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
        ),
      ],
    );
  }

  String _friendlyDate(String key) {
    if (key == 'unknown') {
      return 'Unknown date';
    }
    final parts = key.split('/');
    if (parts.length == 3) {
      final year = int.tryParse(parts[0]);
      final month = int.tryParse(parts[1]);
      final day = int.tryParse(parts[2]);
      if (year != null && month != null && day != null) {
        final dt = DateTime(year, month, day);
        final now = ManilaTime.now();
        final yesterday = now.subtract(const Duration(days: 1));
        if (dt.year == now.year && dt.month == now.month && dt.day == now.day) {
          return 'Today';
        } else if (dt.year == yesterday.year &&
            dt.month == yesterday.month &&
            dt.day == yesterday.day) {
          return 'Yesterday';
        } else {
          const months = [
            'Jan',
            'Feb',
            'Mar',
            'Apr',
            'May',
            'Jun',
            'Jul',
            'Aug',
            'Sep',
            'Oct',
            'Nov',
            'Dec',
          ];
          return '${months[dt.month - 1]} ${dt.day}, ${dt.year}';
        }
      }
    }
    return key;
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _rows.where(_isVisible).toList();

    final hasResults = filtered.isNotEmpty;
    final surfaceColor = Theme.of(context).colorScheme.surface;
    final topPadding = MediaQuery.of(context).padding.top + 90;

    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final e in filtered) {
      final key = ManilaTime.groupKey(e['date']);
      (grouped[key] ??= []).add(e);
    }

    final rows = <Object>[];
    for (final entry in grouped.entries) {
      final dayTotal = entry.value.fold<double>(
        0,
        (s, e) => s + ((e['amount'] ?? 0) as num).toDouble(),
      );
      rows.add((_friendlyDate(entry.key), entry.value.length, dayTotal));
      rows.addAll(entry.value);
    }

    return Scaffold(
      extendBody: true,
      body: Stack(
        children: [
          NotificationListener<UserScrollNotification>(
            onNotification: (notification) {
              final direction = notification.direction;
              if (direction == ScrollDirection.reverse) {
                if (_showFilters) {
                  setState(() => _showFilters = false);
                }
              } else if (direction == ScrollDirection.forward) {
                if (!_showFilters) {
                  setState(() => _showFilters = true);
                }
              }
              return false; // let the notification bubble up
            },
            child: RefreshIndicator(
              onRefresh: () async => _loadMore(reset: true),
              child: _rows.isEmpty && _loading && _error == null
                  ? ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: EdgeInsets.fromLTRB(
                        AppSpacing.space4,
                        topPadding + 54,
                        AppSpacing.space4,
                        120,
                      ),
                      children: const [AppSkeleton(rows: 6)],
                    )
                  : !hasResults && !_loading
                  ? ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: EdgeInsets.fromLTRB(
                        AppSpacing.space4,
                        topPadding + 54,
                        AppSpacing.space4,
                        120,
                      ),
                      children: [
                        if (_error != null)
                          AppUnavailableState(
                            message: _error!,
                            onRetry: () => _loadMore(reset: true),
                          )
                        else
                          AppEmptyState(
                            icon: _search.isNotEmpty
                                ? Icons.search_off_rounded
                                : Icons.receipt_long,
                            title: _search.isNotEmpty
                                ? 'No expenses match "$_search"'
                                : (_categoryFilter != 'All'
                                      ? 'No $_categoryFilter expenses yet'
                                      : 'No expenses yet'),
                            subtitle: _search.isNotEmpty
                                ? 'Try a different vendor, category, or amount.'
                                : (_categoryFilter != 'All'
                                      ? 'Try another filter to see the rest of your expenses.'
                                      : 'Snap a receipt and CartIQ will fill in the details.'),
                            actionLabel: _search.isNotEmpty
                                ? 'Clear search'
                                : (_categoryFilter != 'All'
                                      ? 'Show all expenses'
                                      : 'Scan a receipt'),
                            actionIcon: _search.isNotEmpty
                                ? Icons.close
                                : (_categoryFilter != 'All'
                                      ? Icons.filter_alt_off_rounded
                                      : Icons.camera_alt_rounded),
                            onAction: _search.isNotEmpty
                                ? () => setState(() {
                                    _search = '';
                                    _searchCtrl.clear();
                                    _searching = false;
                                  })
                                : (_categoryFilter != 'All'
                                      ? () => setState(() {
                                          _categoryFilter = 'All';
                                        })
                                      : () => _scanAndReload()),
                          ),
                      ],
                    )
                  : NotificationListener<ScrollNotification>(
                      onNotification: (n) {
                        if (n.metrics.pixels >
                            n.metrics.maxScrollExtent - 200) {
                          _loadMore();
                        }
                        return false;
                      },
                      child: ListView.separated(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: EdgeInsets.fromLTRB(
                          AppSpacing.space4,
                          topPadding + 54,
                          AppSpacing.space4,
                          120,
                        ),
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
                            final (dateLabel, count, total) = row;
                            return Padding(
                              padding: const EdgeInsets.only(
                                top: AppSpacing.space2,
                                bottom: AppSpacing.space1,
                              ),
                              child: SectionHeader(
                                title: dateLabel,
                                eyebrow:
                                    '$count receipt${count != 1 ? 's' : ''}',
                                trailing: Text(
                                  '₱${total.toStringAsFixed(0)}',
                                  style: Theme.of(context).textTheme.labelSmall
                                      ?.copyWith(
                                        fontWeight: FontWeight.w800,
                                        fontSize: 13,
                                      ),
                                ),
                              ),
                            );
                          }

                          final e = row as Map<String, dynamic>;
                          final isOcr = e['source'] == 'OCR';

                          final dt = ManilaTime.parse(e['date']);
                          final timeStr = dt != null
                              ? ManilaTime.formatClock12(dt)
                              : '--:--';

                          return Container(
                            clipBehavior: Clip.antiAlias,
                            decoration: BoxDecoration(
                              color: surfaceColor,
                              borderRadius: BorderRadius.circular(AppRadius.l),
                              boxShadow: AppShadow.sm(),
                            ),
                            child: Material(
                              color: Colors.transparent,
                              child: InkWell(
                                onTap: () {
                                  Haptics.select();
                                  _showReceiptDetails(e);
                                },
                                child: Padding(
                                  padding: const EdgeInsets.all(
                                    AppSpacing.space4,
                                  ),
                                  child: Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.center,
                                    children: [
                                      Container(
                                        width: 48,
                                        height: 48,
                                        decoration: BoxDecoration(
                                          color: AppColors.primary.withValues(
                                            alpha: 0.12,
                                          ),
                                          borderRadius: BorderRadius.circular(
                                            AppRadius.m,
                                          ),
                                        ),
                                        child: Icon(
                                          isOcr
                                              ? Icons.document_scanner_rounded
                                              : Icons.edit_note_rounded,
                                          size: 24,
                                          color: AppColors.primary,
                                        ),
                                      ),
                                      const SizedBox(width: AppSpacing.space3),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              e['vendor'] ?? 'Unknown Vendor',
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: const TextStyle(
                                                fontWeight: FontWeight.w700,
                                                fontSize: 14.5,
                                                height: 1.2,
                                              ),
                                            ),
                                            const SizedBox(height: 4),
                                            Wrap(
                                              crossAxisAlignment:
                                                  WrapCrossAlignment.center,
                                              spacing: 6,
                                              children: [
                                                Text(
                                                  timeStr,
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .bodySmall
                                                      ?.copyWith(
                                                        fontWeight:
                                                            FontWeight.w600,
                                                      ),
                                                ),
                                                Text(
                                                  '•',
                                                  style: Theme.of(
                                                    context,
                                                  ).textTheme.bodySmall,
                                                ),
                                                Text(
                                                  e['category'] ?? 'Other',
                                                  style: Theme.of(
                                                    context,
                                                  ).textTheme.bodySmall,
                                                ),
                                                if ((e['location']
                                                        as Map<
                                                          String,
                                                          dynamic
                                                        >?)?['code'] !=
                                                    null) ...[
                                                  Text(
                                                    '•',
                                                    style: Theme.of(
                                                      context,
                                                    ).textTheme.bodySmall,
                                                  ),
                                                  Text(
                                                    (e['location']
                                                        as Map<
                                                          String,
                                                          dynamic
                                                        >)['code'],
                                                    style: Theme.of(
                                                      context,
                                                    ).textTheme.bodySmall,
                                                  ),
                                                ],
                                              ],
                                            ),
                                          ],
                                        ),
                                      ),
                                      const SizedBox(width: AppSpacing.space2),
                                      Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.end,
                                        mainAxisAlignment:
                                            MainAxisAlignment.center,
                                        children: [
                                          Text(
                                            '₱${((e['amount'] ?? 0) as num).toStringAsFixed(0)}',
                                            style: Theme.of(context)
                                                .textTheme
                                                .titleLarge
                                                ?.copyWith(
                                                  fontWeight: FontWeight.w900,
                                                ),
                                          ),
                                          const SizedBox(height: 2),
                                          Container(
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 8,
                                              vertical: 2,
                                            ),
                                            decoration: BoxDecoration(
                                              color: AppColors.primary
                                                  .withValues(alpha: 0.1),
                                              borderRadius:
                                                  BorderRadius.circular(4),
                                            ),
                                            child: Text(
                                              isOcr ? 'OCR' : 'Manual',
                                              style: const TextStyle(
                                                fontSize: 10,
                                                fontWeight: FontWeight.w800,
                                                color: AppColors.primary,
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
            ),
          ),

          // FLOATING GLASS HEADER + AUTO-HIDE FILTERS
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SafeArea(
                  bottom: false,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.space4,
                      vertical: AppSpacing.space3,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: _GlassPillContainer(
                            child: AnimatedSwitcher(
                              duration: const Duration(milliseconds: 250),
                              child: _searching
                                  ? TextField(
                                      key: const ValueKey('searchField'),
                                      controller: _searchCtrl,
                                      autofocus: true,
                                      decoration: InputDecoration(
                                        hintText: 'Search expenses...',
                                        border: InputBorder.none,
                                        enabledBorder: InputBorder.none,
                                        focusedBorder: InputBorder.none,
                                        fillColor: Colors.transparent,
                                        filled: true,
                                        isDense: true,
                                        contentPadding:
                                            const EdgeInsets.symmetric(
                                              horizontal: 20,
                                              vertical: 14,
                                            ),
                                        hintStyle: TextStyle(
                                          color: Theme.of(
                                            context,
                                          ).textTheme.bodySmall?.color,
                                        ),
                                      ),
                                      style: Theme.of(
                                        context,
                                      ).textTheme.titleMedium,
                                      onChanged: (v) =>
                                          setState(() => _search = v.trim()),
                                    )
                                  : Container(
                                      key: const ValueKey('titleText'),
                                      width: double.infinity,
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 20,
                                        vertical: 14,
                                      ),
                                      child: Text(
                                        'Expenses',
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleLarge
                                            ?.copyWith(
                                              fontWeight: FontWeight.w800,
                                              letterSpacing: -0.5,
                                            ),
                                      ),
                                    ),
                            ),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.space2),
                        _GlassPillContainer(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 4,
                              vertical: 4,
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: _searching
                                  ? [
                                      IconButton(
                                        icon: const Icon(Icons.close_rounded),
                                        tooltip: 'Close search',
                                        onPressed: () {
                                          setState(() {
                                            _searching = false;
                                            _search = '';
                                            _searchCtrl.clear();
                                          });
                                        },
                                      ),
                                    ]
                                  : [
                                      IconButton(
                                        icon: const Icon(Icons.search_rounded),
                                        tooltip: 'Search expenses',
                                        onPressed: () =>
                                            setState(() => _searching = true),
                                      ),
                                      Container(
                                        width: 1,
                                        height: 24,
                                        color: Theme.of(
                                          context,
                                        ).dividerColor.withValues(alpha: 0.3),
                                      ),
                                      IconButton(
                                        icon: const Icon(Icons.add_rounded),
                                        color: AppColors.primary,
                                        tooltip: 'Scan / record expense',
                                        onPressed: _scanAndReload,
                                      ),
                                    ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

                // AUTO-HIDE FILTER PILLS
                AnimatedContainer(
                  duration: const Duration(milliseconds: 250),
                  curve: Curves.easeInOut,
                  height: _showFilters ? 50.0 : 0.0,
                  child: AnimatedOpacity(
                    duration: const Duration(milliseconds: 200),
                    opacity: _showFilters ? 1.0 : 0.0,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.space4,
                      ),
                      itemCount: _filters.length,
                      separatorBuilder: (_, _) =>
                          const SizedBox(width: AppSpacing.space2),
                      itemBuilder: (context, index) {
                        final filter = _filters[index];
                        final selected = _categoryFilter == filter;
                        return FilterChip(
                          label: Text(filter),
                          selected: selected,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(AppRadius.pill),
                          ),
                          showCheckmark: false,
                          selectedColor: AppColors.primary,
                          labelStyle: TextStyle(
                            fontWeight: FontWeight.w700,
                            color: selected ? Colors.white : AppColors.muted,
                          ),
                          onSelected: (_) {
                            Haptics.select();
                            setState(() => _categoryFilter = filter);
                            // The chip filters the loaded rows only, so pull
                            // more pages in until it matches or the list runs
                            // out.
                            _ensureFilterMatch();
                          },
                        );
                      },
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _GlassPillContainer extends StatelessWidget {
  const _GlassPillContainer({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final surfaceColor = Theme.of(context).colorScheme.surface;
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadius.pill),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.1),
            blurRadius: 24,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.pill),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
          child: Container(
            decoration: BoxDecoration(
              color: surfaceColor.withValues(alpha: 0.25),
              borderRadius: BorderRadius.circular(AppRadius.pill),
              border: Border.all(
                color: Colors.white.withValues(alpha: 0.4),
                width: 1.2,
              ),
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}
// System-generated tag workaround
