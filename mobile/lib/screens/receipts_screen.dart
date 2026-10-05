import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/data_refresh.dart';
import '../theme.dart';
import '../utils/app_messenger.dart';
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
    if (!mounted) return;
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
    if (q.isEmpty) return true;
    final lq = q.toLowerCase();
    final amount = '₱${((e['amount'] ?? 0) as num).toStringAsFixed(0)}';
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
      AppMessenger.showGlassToast(
        context: context,
        message: 'Refresh failed: $message',
        isSuccess: false,
      );
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

    // Mas malaking padding para pumasok ng maayos ang custom floating pill header
    final topPadding = MediaQuery.of(context).padding.top + 90;

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
      extendBody: true, // Pinapayagang pumasok sa ilalim ng bottom nav
      body: Stack(
        children: [
          // 1. ANG LISTAHAN SA ILALIM
          RefreshIndicator(
            onRefresh: () async => _loadMore(reset: true),
            child: _rows.isEmpty && _loading && _error == null
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: EdgeInsets.fromLTRB(
                      AppSpacing.space4,
                      topPadding,
                      AppSpacing.space4,
                      120, // 120 bottom padding para iwasan ang menu
                    ),
                    children: const [AppSkeleton(rows: 6)],
                  )
                : !hasResults && !_loading
                // INAYOS NA: Binalik sa Padding wrapper ang AppEmptyState para hindi siya mag-crash/mawala
                ? Padding(
                    padding: EdgeInsets.only(top: topPadding, bottom: 120),
                    child: AppEmptyState(
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
                    ),
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
                      padding: EdgeInsets.fromLTRB(
                        AppSpacing.space4,
                        topPadding,
                        AppSpacing.space4,
                        120, // 120 bottom padding para iwasan ang menu
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
                                '₱${total.toStringAsFixed(0)}', // Pinalitan din ang P ng ₱
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
                            boxShadow: AppShadow.sm(),
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
                                      ? AppColors.primary.withValues(
                                          alpha: 0.13,
                                        )
                                      : Theme.of(context).dividerColor,
                                  borderRadius: BorderRadius.circular(
                                    AppRadius.s,
                                  ),
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
                                '$dateLabel • ${e['category'] ?? 'Other'}'
                                '${(e['location'] as Map<String, dynamic>?)?['code'] != null ? ' • ${(e['location'] as Map<String, dynamic>)['code']}' : ''}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              trailing: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(
                                    '₱${((e['amount'] ?? 0) as num).toStringAsFixed(0)}',
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleMedium
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

          // 2. BAGONG FLOATING GLASS PILL HEADER (MATCHED EXACTLY TO ROOT SHELL NAV BAR)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.space4,
                  vertical: AppSpacing.space3,
                ),
                child: Row(
                  children: [
                    // A. TITLE O SEARCH FIELD (Hiwalay na Pill)
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
                                    fillColor: Colors
                                        .transparent, // Transparent para lumutang ang glass effect
                                    filled: true,
                                    isDense: true,
                                    contentPadding: const EdgeInsets.symmetric(
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

                    // B. ACTION BUTTONS (Hiwalay na Pill)
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
                                  ), // Maliit na divider sa pagitan ng search at add
                                  IconButton(
                                    icon: const Icon(Icons.add_rounded),
                                    color: AppColors
                                        .primary, // Naka-highlight ang Add button
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
          ),
        ],
      ),
    );
  }
}

// ---------- BAGONG REUSABLE WIDGET PARA SA GLASS PILL ----------
// INAYOS NA: Kinopya ang EKSAKTONG timpla ng shadow, blur, at border mula sa Root Shell menu.
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
            color: Colors.black.withValues(
              alpha: 0.1,
            ), // Match RootShell (0.1 opacity)
            blurRadius: 24, // Match RootShell
            offset: const Offset(0, 8), // Match RootShell
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.pill),
        child: BackdropFilter(
          filter: ImageFilter.blur(
            sigmaX: 12,
            sigmaY: 12,
          ), // Match RootShell (12 blur)
          child: Container(
            decoration: BoxDecoration(
              color: surfaceColor.withValues(
                alpha: 0.25,
              ), // Match RootShell (0.25 opacity surface)
              borderRadius: BorderRadius.circular(AppRadius.pill),
              border: Border.all(
                color: Colors.white.withValues(
                  alpha: 0.4,
                ), // Match RootShell frost edge
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
