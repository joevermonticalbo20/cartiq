import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/offline_queue.dart';
import '../services/persisted_queue.dart';
import '../services/sync_service.dart';
import '../state/theme_controller.dart';
import '../theme.dart';
import '../widgets/app_badge.dart';
import '../widgets/app_dialog.dart';
import '../widgets/section_header.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.onScanReceipt,
    required this.onGoPos,
    required this.onGoHistory,
  });

  final VoidCallback onScanReceipt;
  final VoidCallback onGoPos;
  final VoidCallback onGoHistory;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool _loading = true;
  double _todaySales = 0;
  int _todayOrders = 0;
  int _queueCount = 0;
  List<Map<String, dynamic>> _lowItems = const [];
  List<Map<String, dynamic>> _onShift = const [];
  List<Map<String, dynamic>> _recentOrders = const [];
  Map<String, dynamic>? _prevReport;
  List<double> _weekSales = const [];

  OfflineQueue get _queue => PersistedOfflineQueue.instance;
  StreamSubscription<int>? _queueSub;

  @override
  void initState() {
    super.initState();
    _refresh();
    _queueSub = _queue.changes.listen((c) {
      if (mounted) setState(() => _queueCount = c);
    });
  }

  @override
  void dispose() {
    _queueSub?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final auth = context.read<AuthState>();
    final sync = context.read<SyncService>();
    final code = auth.locationCode;
    if (code == null) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    try {
      // Trigger a sync in the background while we load the dashboard.
      // Errors are swallowed here: manual sync surfaces them, and the
      // dashboard below degrades to cached info on failure.
      unawaited(sync.syncAll().then((_) {}).catchError((_) {}));
      final token = auth.token;
      if (token == null) {
        if (mounted) setState(() => _loading = false);
        return;
      }
      final results = await Future.wait([
        auth.api.dailyReport(token, locationCode: code),
        auth.api.inventory(token, locationCode: code),
        auth.api.staffOnShift(token),
        auth.api.orders(token, page: 1, pageSize: 3, locationCode: code),
        auth.api
            .dailyReport(token, locationCode: code, daysAgo: 1)
            .catchError((_) => <String, dynamic>{}),
        auth.api.salesSeries(token, locationCode: code),
      ]);

      final report = results[0] as Map<String, dynamic>?;
      final inv = results[1] as List<dynamic>?;
      final onShift = results[2] as Map<String, dynamic>;
      final recentOrders = results[3] as List<dynamic>;
      final prevReport = results[4] as Map<String, dynamic>?;
      final weekSales = results[5] as List<double>;

      List<Map<String, dynamic>> low = [];
      if (inv != null && inv.isNotEmpty) {
        final loc = inv.first as Map<String, dynamic>?;
        final items =
            (loc?['items'] as List?)?.cast<Map<String, dynamic>>() ?? [];
        low = items.where((i) => i['status'] != 'ok').take(5).toList();
      }

      if (!mounted) return;
      setState(() {
        _todaySales = ((report?['total_sales'] ?? 0) as num).toDouble();
        _todayOrders = (report?['orders'] ?? 0) as int;
        _lowItems = low;
        _onShift =
            (onShift['on_shift'] as List?)?.cast<Map<String, dynamic>>() ?? [];
        _recentOrders = recentOrders.cast<Map<String, dynamic>>();
        _prevReport = prevReport;
        _weekSales = weekSales;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Offline — showing cached info')),
      );
    }
    final count = await _queue.count;
    if (mounted) setState(() => _queueCount = count);
  }

  Future<void> _manualSync() async {
    final result = await context.read<SyncService>().syncAll();
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(result.message)));
    _refresh();
  }

  bool get _isDark => Theme.of(context).brightness == Brightness.dark;

  double get _avgTicket => _todayOrders > 0 ? _todaySales / _todayOrders : 0;

  double get _vsYesterday {
    final prev = ((_prevReport?['total_sales'] ?? 0) as num).toDouble();
    if (prev <= 0) return 0;
    return ((_todaySales - prev) / prev) * 100;
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    return RefreshIndicator(
      color: AppColors.primary,
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
        children: [
          // ---------- header ----------
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Kumusta, ${_firstName(auth.displayName)}',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${auth.locationCode ?? "No cart"} · ${auth.roleDisplay}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              IconButton.filledTonal(
                onPressed: () => context.read<ThemeController>().toggle(),
                icon: Icon(
                  _isDark ? Icons.light_mode : Icons.dark_mode,
                  size: 20,
                ),
                tooltip: 'Toggle theme',
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                onPressed: () async {
                  final confirmed = await showAppConfirm(
                    context,
                    title: 'Log out?',
                    message: _queueCount > 0
                        ? '$_queueCount sale(s) still queued — they stay saved on this device.'
                        : 'No queued sales. You can sign back in anytime.',
                    confirmLabel: 'Log out',
                  );
                  if (!confirmed || !context.mounted) return;
                  final auth = context.read<AuthState>();
                  if (!auth.isLoggedIn) return;
                  // Stop any in-flight drain first so no further request
                  // reuses this session after sign-out.
                  context.read<SyncService>().cancelActiveSync();
                  await auth.signOut();
                },
                icon: const Icon(Icons.logout_rounded, size: 20),
                tooltip: 'Log out',
              ),
            ],
          ),
          const SizedBox(height: 14),

          // ---------- KPI row ----------
          _KpiRow(
            todaySales: _todaySales,
            todayOrders: _todayOrders,
            avgTicket: _avgTicket,
            vsYesterday: _vsYesterday,
            weekSales: _weekSales,
            loading: _loading,
          ),
          const SizedBox(height: 12),

          // ---------- quick actions ----------
          Row(
            children: [
              Expanded(
                child: _QuickAction(
                  icon: Icons.point_of_sale_rounded,
                  label: 'New Sale',
                  color: AppColors.primary,
                  onTap: widget.onGoPos,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _QuickAction(
                  icon: Icons.document_scanner_rounded,
                  label: 'Scan Receipt',
                  color: AppColors.primary,
                  onTap: widget.onScanReceipt,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),

          // ---------- on-shift staff ----------
          if (_onShift.isNotEmpty) ...[
            _SectionHeader(
              title: 'On shift now',
              trailing: AppBadge(
                label: '${_onShift.length}',
                variant: AppBadgeVariant.brand,
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 72,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _onShift.length,
                separatorBuilder: (_, _) => const SizedBox(width: 10),
                itemBuilder: (context, i) {
                  final s = _onShift[i];
                  return _StaffChip(
                    name: s['name'] ?? 'Unknown',
                    location: s['location_name'] ?? '',
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
          ],

          // ---------- recent orders ----------
          if (_recentOrders.isNotEmpty) ...[
            _SectionHeader(
              title: 'Recent sales',
              trailing: TextButton(
                onPressed: widget.onGoHistory,
                child: const Text('View all'),
              ),
            ),
            const SizedBox(height: 6),
            ..._recentOrders.take(3).map((o) => _RecentOrderTile(order: o)),
            const SizedBox(height: 12),
          ],

          // ---------- sync status ----------
          Consumer<SyncService>(
            builder: (context, sync, _) {
              final syncing = sync.isSyncing;
              return Card(
                child: ListTile(
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 4,
                  ),
                  leading: Badge(
                    isLabelVisible: _queueCount > 0,
                    label: Text('$_queueCount'),
                    backgroundColor: AppColors.warn,
                    child: CircleAvatar(
                      radius: 19,
                      backgroundColor: Theme.of(
                        context,
                      ).colorScheme.surfaceContainerHighest,
                      child: syncing
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Icon(
                              Icons.cloud_sync_rounded,
                              size: 20,
                              color: _queueCount > 0 ? AppColors.warn : null,
                            ),
                    ),
                  ),
                  title: Text(
                    syncing
                        ? 'Syncing…'
                        : _queueCount > 0
                        ? '$_queueCount sale${_queueCount != 1 ? 's' : ''} waiting to sync'
                        : 'Everything synced',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  subtitle: Text(
                    _queueCount > 0
                        ? 'Uploads automatically when online'
                        : 'Offline records upload when online',
                  ),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: _manualSync,
                ),
              );
            },
          ),
          const SizedBox(height: 12),

          // ---------- stock alerts ----------
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _SectionHeader(
                    title: 'Stock alerts',
                    trailing: _lowItems.isNotEmpty
                        ? AppBadge(
                            label:
                                '${_lowItems.length} ITEM${_lowItems.length != 1 ? 'S' : ''}',
                            variant: AppBadgeVariant.danger,
                          )
                        : null,
                  ),
                  const SizedBox(height: 8),
                  if (_loading)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 10),
                      child: LinearProgressIndicator(minHeight: 3),
                    )
                  else if (_lowItems.isEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(
                        children: [
                          Icon(
                            Icons.check_circle_rounded,
                            color: AppColors.ok,
                            size: 20,
                          ),
                          const SizedBox(width: 8),
                          Text(
                            'All stocks healthy',
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ],
                      ),
                    )
                  else
                    ..._lowItems.map((item) {
                      final critical = item['status'] == 'critical';
                      final c = critical ? AppColors.danger : AppColors.warn;
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        leading: Container(
                          width: 36,
                          height: 36,
                          decoration: BoxDecoration(
                            color: c.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(AppRadius.s),
                          ),
                          child: Icon(
                            critical
                                ? Icons.error_rounded
                                : Icons.warning_amber_rounded,
                            size: 20,
                            color: c,
                          ),
                        ),
                        title: Text(
                          item['name'] ?? '',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        subtitle: Text(
                          '${item['stock']} ${item['unit']} left · threshold ${item['threshold']}',
                        ),
                        trailing: Text(
                          critical ? 'CRITICAL' : 'LOW',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                            color: c,
                          ),
                        ),
                      );
                    }),
                  const SizedBox(height: 4),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _firstName(String full) => full.split(' ').first;
}

// ---------- KPI row ----------
class _KpiRow extends StatelessWidget {
  const _KpiRow({
    required this.todaySales,
    required this.todayOrders,
    required this.avgTicket,
    required this.vsYesterday,
    required this.weekSales,
    required this.loading,
  });

  final double todaySales;
  final int todayOrders;
  final double avgTicket;
  final double vsYesterday;
  final List<double> weekSales;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    if (loading) {
      return Container(
        height: 120,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadius.l),
          color: Theme.of(context).cardTheme.color,
        ),
        child: const Center(child: CircularProgressIndicator()),
      );
    }
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadius.l),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: isDark
              ? [const Color(0xFF3B1513), Theme.of(context).colorScheme.surface]
              : [AppColors.primarySoft, Colors.white],
        ),
        border: Border.all(
          color: isDark
              ? AppColors.primary.withValues(alpha: 0.3)
              : AppColors.primary.withValues(alpha: 0.25),
        ),
        boxShadow: AppShadow.sm(),
      ),
      child: Column(
        children: [
          // Main: total sales
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'SALES TODAY',
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                    const SizedBox(height: 4),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(
                        'P${todaySales.toStringAsFixed(0)}',
                        style: Theme.of(context).textTheme.headlineMedium
                            ?.copyWith(color: AppColors.primary),
                      ),
                    ),
                    if (vsYesterday != 0) ...[
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Icon(
                            vsYesterday >= 0
                                ? Icons.trending_up_rounded
                                : Icons.trending_down_rounded,
                            size: 14,
                            color: vsYesterday >= 0
                                ? AppColors.ok
                                : AppColors.danger,
                          ),
                          const SizedBox(width: 3),
                          Text(
                            '${vsYesterday >= 0 ? '+' : ''}${vsYesterday.toStringAsFixed(0)}% vs yesterday',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                              color: vsYesterday >= 0
                                  ? AppColors.ok
                                  : AppColors.danger,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 12),
              if (weekSales.length >= 2)
                _Sparkline(values: weekSales)
              else
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Icon(
                    Icons.storefront_rounded,
                    size: 28,
                    color: AppColors.primary,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          // Sub KPIs
          Row(
            children: [
              _MiniKpi(
                label: 'Orders',
                value: '$todayOrders',
                icon: Icons.receipt_long_rounded,
              ),
              const SizedBox(width: 12),
              _MiniKpi(
                label: 'Avg ticket',
                value: 'P${avgTicket.toStringAsFixed(0)}',
                icon: Icons.analytics_rounded,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 7-day sales sparkline for the KPI hero. Pure CustomPainter, no deps.
class _Sparkline extends StatelessWidget {
  const _Sparkline({required this.values});

  final List<double> values;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 118,
      height: 56,
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.m),
      ),
      child: CustomPaint(
        painter: _SparklinePainter(values),
        child: const SizedBox.expand(),
      ),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  _SparklinePainter(this.values);

  final List<double> values;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2) return;
    final max = values.reduce((a, b) => a > b ? a : b);
    final min = values.reduce((a, b) => a < b ? a : b);
    final span = (max - min) == 0 ? 1.0 : (max - min);
    const pad = 4.0;
    final pts = List<Offset>.generate(values.length, (i) {
      final x = pad + (size.width - pad * 2) * (i / (values.length - 1));
      final y =
          size.height -
          pad -
          (size.height - pad * 2) * ((values[i] - min) / span);
      return Offset(x, y);
    });

    final fill = Path()
      ..moveTo(pts.first.dx, size.height)
      ..lineTo(pts.first.dx, pts.first.dy);
    for (final p in pts.skip(1)) {
      fill.lineTo(p.dx, p.dy);
    }
    fill
      ..lineTo(pts.last.dx, size.height)
      ..close();
    canvas.drawPath(
      fill,
      Paint()..color = AppColors.primary.withValues(alpha: 0.15),
    );

    final line = Path()..moveTo(pts.first.dx, pts.first.dy);
    for (final p in pts.skip(1)) {
      line.lineTo(p.dx, p.dy);
    }
    canvas.drawPath(
      line,
      Paint()
        ..color = AppColors.primary
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );

    // Last-day dot in brand yellow with a white halo.
    final last = pts.last;
    canvas.drawCircle(last, 5, Paint()..color = Colors.white);
    canvas.drawCircle(last, 3.2, Paint()..color = AppColors.highlight);
  }

  @override
  bool shouldRepaint(covariant _SparklinePainter old) => old.values != values;
}

class _MiniKpi extends StatelessWidget {
  const _MiniKpi({
    required this.label,
    required this.value,
    required this.icon,
  });

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: isDark
              ? Colors.black.withValues(alpha: 0.2)
              : Colors.white.withValues(alpha: 0.7),
          borderRadius: BorderRadius.circular(AppRadius.m),
          border: Border.all(
            color: isDark
                ? Colors.white.withValues(alpha: 0.08)
                : AppColors.primary.withValues(alpha: 0.15),
          ),
        ),
        child: Row(
          children: [
            Icon(icon, size: 18, color: AppColors.primary),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(fontSize: 11),
                  ),
                  Text(
                    value,
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 14,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- section header ----------
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return SectionHeader(title: title, trailing: trailing);
  }
}

// ---------- staff chip ----------
class _StaffChip extends StatelessWidget {
  const _StaffChip({required this.name, required this.location});

  final String name;
  final String location;

  @override
  Widget build(BuildContext context) {
    final initial = name.isNotEmpty ? name[0].toUpperCase() : '?';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).cardTheme.color,
        borderRadius: BorderRadius.circular(AppRadius.m),
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: AppColors.primary,
            child: Text(
              initial,
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w800,
                fontSize: 13,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, style: Theme.of(context).textTheme.titleSmall),
              Text(
                location,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(fontSize: 11),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ---------- recent order tile ----------
class _RecentOrderTile extends StatelessWidget {
  const _RecentOrderTile({required this.order});

  final Map<String, dynamic> order;

  @override
  Widget build(BuildContext context) {
    final items = (order['items'] as List?) ?? [];
    final first = items.isNotEmpty ? items.first : null;
    final itemCount = items.fold<int>(
      0,
      (sum, i) => sum + ((i['qty'] ?? 1) as int),
    );
    final total = (order['total'] ?? 0) as num;
    final time = order['createdAt'] != null
        ? DateTime.tryParse(order['createdAt'])?.toLocal()
        : null;

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).cardTheme.color,
        borderRadius: BorderRadius.circular(AppRadius.m),
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: AppColors.primary.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(9),
            ),
            child: Icon(
              Icons.receipt_rounded,
              size: 18,
              color: AppColors.primary,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  first?['productName'] ?? 'Order',
                  style: Theme.of(context).textTheme.titleSmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  '${itemCount}x item${itemCount != 1 ? 's' : ''}${items.length > 1 ? ' (+${items.length - 1} more)' : ''}',
                  style: Theme.of(context).textTheme.bodySmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                'P${total.toStringAsFixed(0)}',
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 14,
                ),
              ),
              if (time != null)
                Text(
                  _formatTime(time),
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(fontSize: 11),
                ),
            ],
          ),
        ],
      ),
    );
  }

  String _formatTime(DateTime dt) {
    final now = DateTime.now();
    final hh = dt.hour.toString().padLeft(2, '0');
    final mm = dt.minute.toString().padLeft(2, '0');
    if (dt.day == now.day && dt.month == now.month && dt.year == now.year) {
      return 'Today $hh:$mm';
    }
    final md = '${dt.month}/${dt.day}';
    return '$md $hh:$mm';
  }
}

// ---------- quick action ----------
class _QuickAction extends StatelessWidget {
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Material(
      color: Theme.of(context).colorScheme.surface,
      borderRadius: BorderRadius.circular(AppRadius.l),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.l),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 18),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.l),
            border: Border.all(
              color: isDark ? const Color(0xFF2A2A2A) : const Color(0xFFE5E7EB),
            ),
          ),
          child: Column(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(13),
                ),
                child: Icon(icon, size: 24, color: color),
              ),
              const SizedBox(height: 8),
              Text(label, style: Theme.of(context).textTheme.titleSmall),
            ],
          ),
        ),
      ),
    );
  }
}
