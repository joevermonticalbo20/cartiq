import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/offline_queue.dart';
import '../services/persisted_queue.dart';
import '../services/sync_service.dart';
import '../theme.dart';
import '../utils/manila_time.dart';
import '../widgets/app_badge.dart';
import '../widgets/app_dialog.dart';
import '../widgets/app_skeleton.dart';
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
        const SnackBar(content: Text('Offline - showing cached info')),
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

  double get _avgTicket => _todayOrders > 0 ? _todaySales / _todayOrders : 0;

  double get _vsYesterday {
    final prev = ((_prevReport?['total_sales'] ?? 0) as num).toDouble();
    if (prev <= 0) return 0;
    return ((_todaySales - prev) / prev) * 100;
  }

  String _firstName(String full) => full.split(' ').first;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return RefreshIndicator(
      color: AppColors.primary,
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space4,
          AppSpacing.space3,
          AppSpacing.space4,
          AppSpacing.space6,
        ),
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
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: AppSpacing.space1),
                    Text(
                      '${auth.locationCode ?? "No cart"} • ${auth.roleDisplay}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              IconButton.filledTonal(
                style: IconButton.styleFrom(minimumSize: const Size(48, 48)),
                onPressed: () async {
                  final confirmed = await showAppConfirm(
                    context,
                    title: 'Log out?',
                    message: _queueCount > 0
                        ? '$_queueCount sale(s) still queued - they stay saved on this device.'
                        : 'No queued sales. You can sign back in anytime.',
                    confirmLabel: 'Log out',
                  );
                  if (!confirmed || !context.mounted) return;

                  final auth = context.read<AuthState>();
                  if (!auth.isLoggedIn) return;

                  context.read<SyncService>().cancelActiveSync();
                  await auth.signOut();
                },
                icon: const Icon(Icons.logout_rounded, size: 20),
                tooltip: 'Log out',
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),

          // ---------- MODERN KPI SECTION ----------
          if (_loading)
            Container(
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: BorderRadius.circular(20),
                boxShadow: AppShadow.sm(),
              ),
              padding: const EdgeInsets.all(AppSpacing.space4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'SALES TODAY',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  const SizedBox(height: AppSpacing.space2),
                  const AppSkeleton(rows: 2, height: 20),
                ],
              ),
            )
          else ...[
            // Solid Brand Card (Sales)
            _SolidBrandCard(
              title: 'Sales today',
              value: _todaySales,
              vsYesterday: _vsYesterday,
              icon: Icons.attach_money_rounded,
            ),
            const SizedBox(height: AppSpacing.space3),

            // 2x2 Style Grid (Orders & Avg Ticket)
            Row(
              children: [
                Expanded(
                  child: _StandardKpiCard(
                    title: 'Orders today',
                    value: '$_todayOrders',
                    sub: 'Across active carts',
                    icon: Icons.shopping_bag_rounded,
                  ),
                ),
                const SizedBox(width: AppSpacing.space3),
                Expanded(
                  child: _StandardKpiCard(
                    title: 'Avg ticket',
                    value: 'P${_avgTicket.toStringAsFixed(0)}',
                    sub: 'Per order today',
                    icon: Icons.receipt_long_rounded,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space3),

            // Trend Bar Chart
            _WeeklyTrendPanel(weekSales: _weekSales),
          ],
          const SizedBox(height: AppSpacing.space4),

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
              const SizedBox(width: AppSpacing.space3),
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
          const SizedBox(height: AppSpacing.space4),

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
            const SizedBox(height: AppSpacing.space4),
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
            const SizedBox(height: AppSpacing.space2),
            ..._recentOrders.take(3).map((o) => _RecentOrderTile(order: o)),
            const SizedBox(height: AppSpacing.space4),
          ] else if (!_loading) ...[
            _SectionHeader(
              title: 'Recent sales',
              trailing: TextButton(
                onPressed: widget.onGoPos,
                child: const Text('New sale'),
              ),
            ),
            const SizedBox(height: AppSpacing.space2),
            Container(
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: BorderRadius.circular(20),
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
                      color: AppColors.primary.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(AppRadius.s),
                    ),
                    child: const Icon(
                      Icons.receipt_long_outlined,
                      size: 22,
                      color: AppColors.primary,
                    ),
                  ),
                  title: Text(
                    'No sales yet today',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  subtitle: const Text('Start your first benta on POS'),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: widget.onGoPos,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.space4),
          ],

          // ---------- sync status ----------
          Consumer<SyncService>(
            builder: (context, sync, _) {
              final syncing = sync.isSyncing;
              return Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: surfaceColor,
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: AppShadow.sm(),
                ),
                child: Material(
                  color: Colors.transparent,
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
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
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
                          ? 'Syncing...'
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
                ),
              );
            },
          ),
          const SizedBox(height: AppSpacing.space4),

          // ---------- stock alerts ----------
          Container(
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(20),
              boxShadow: AppShadow.sm(),
            ),
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
                        const Icon(
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
                        '${item['stock']} ${item['unit']} left • threshold ${item['threshold']}',
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
        ],
      ),
    );
  }
}

// ---------- NEW: SOLID BRAND KPI CARD ----------
class _SolidBrandCard extends StatelessWidget {
  const _SolidBrandCard({
    required this.title,
    required this.value,
    required this.vsYesterday,
    required this.icon,
  });

  final String title;
  final double value;
  final double vsYesterday;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppColors.primary, AppColors.primaryStrong],
        ),
        boxShadow: [
          BoxShadow(
            color: AppColors.primary.withValues(alpha: 0.35),
            blurRadius: 32,
            offset: const Offset(0, 16),
          ),
        ],
      ),
      child: Stack(
        children: [
          // Glowing Orbs
          Positioned(
            top: -60,
            right: -60,
            child: Container(
              width: 160,
              height: 160,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.white.withValues(alpha: 0.15),
              ),
            ),
          ),
          Positioned(
            bottom: -40,
            left: -20,
            child: Container(
              width: 100,
              height: 100,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.white.withValues(alpha: 0.1),
              ),
            ),
          ),

          // Content
          Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: Colors.white70,
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.25),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: Icon(icon, color: Colors.white, size: 20),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  'P${value.toStringAsFixed(0)}',
                  style: const TextStyle(
                    fontSize: 36,
                    fontWeight: FontWeight.w900,
                    color: Colors.white,
                    letterSpacing: -1,
                  ),
                ),
                const SizedBox(height: 8),
                if (vsYesterday != 0)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.2),
                      borderRadius: BorderRadius.circular(99),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          vsYesterday >= 0
                              ? Icons.arrow_upward_rounded
                              : Icons.arrow_downward_rounded,
                          size: 14,
                          color: Colors.white,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '${vsYesterday.abs().toStringAsFixed(1)}% vs yesterday',
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            color: Colors.white,
                          ),
                        ),
                      ],
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

// ---------- NEW: STANDARD KPI CARD ----------
class _StandardKpiCard extends StatelessWidget {
  const _StandardKpiCard({
    required this.title,
    required this.value,
    required this.sub,
    required this.icon,
  });

  final String title;
  final String value;
  final String sub;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(20),
        boxShadow: AppShadow.sm(), // TINANGGAL ANG BORDER DITO
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                title,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: Theme.of(context).textTheme.bodySmall?.color,
                ),
              ),
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.primarySoft,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: AppColors.primary, size: 16),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            value,
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.5,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            sub,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w500,
              color: Theme.of(context).textTheme.bodySmall?.color,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

// ---------- NEW: WEEKLY TREND PANEL ----------
class _WeeklyTrendPanel extends StatelessWidget {
  const _WeeklyTrendPanel({required this.weekSales});
  final List<double> weekSales;

  @override
  Widget build(BuildContext context) {
    if (weekSales.isEmpty || weekSales.length < 2) {
      return const SizedBox.shrink();
    }

    final maxVal = weekSales.reduce(max);
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(20),
        boxShadow: AppShadow.sm(), // TINANGGAL ANG BORDER DITO
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Weekly sales trend',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
              ),
              AppBadge(
                label: 'P${weekSales.last.toStringAsFixed(0)}',
                variant: AppBadgeVariant.brand,
              ),
            ],
          ),
          const SizedBox(height: 24),
          SizedBox(
            height: 110,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: weekSales.asMap().entries.map((entry) {
                final val = entry.value;
                final heightFactor = maxVal == 0 ? 0.0 : (val / maxVal);
                final days = ["M", "T", "W", "T", "F", "S", "S"];
                final label = days[entry.key % days.length];

                return Flexible(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Flexible(
                        child: FractionallySizedBox(
                          heightFactor: heightFactor > 0.05
                              ? heightFactor
                              : 0.05,
                          child: Container(
                            width: 24,
                            decoration: BoxDecoration(
                              borderRadius: const BorderRadius.vertical(
                                top: Radius.circular(99),
                              ),
                              gradient: LinearGradient(
                                begin: Alignment.bottomCenter,
                                end: Alignment.topCenter,
                                colors: isDark
                                    ? [
                                        AppColors.primaryTint.withValues(
                                          alpha: 0.1,
                                        ),
                                        AppColors.primaryStrong,
                                      ]
                                    : [
                                        AppColors.primarySoft,
                                        AppColors.primary,
                                      ],
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        label,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: Theme.of(context).textTheme.bodySmall?.color,
                        ),
                      ),
                    ],
                  ),
                );
              }).toList(),
            ),
          ),
        ],
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
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(AppRadius.m),
        boxShadow: AppShadow.sm(), // TINANGGAL ANG BORDER DITO
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
        ? ManilaTime.parse(order['createdAt'])
        : null;

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.space2),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space3,
        vertical: AppSpacing.space3,
      ),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(AppRadius.l),
        boxShadow: AppShadow.sm(), // TINANGGAL ANG BORDER DITO
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppColors.primary.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(AppRadius.s),
            ),
            child: const Icon(
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
                  ManilaTime.formatTime(time),
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
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(), // TINANGGAL ANG BORDER DITO
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.space5),
            child: Column(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(AppRadius.m),
                  ),
                  child: Icon(icon, size: 24, color: color),
                ),
                const SizedBox(height: AppSpacing.space2),
                Text(label, style: Theme.of(context).textTheme.titleSmall),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
