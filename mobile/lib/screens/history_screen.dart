import 'dart:io';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/api_client.dart';
import '../services/data_refresh.dart';
import '../theme.dart';
import '../utils/app_messenger.dart';
import '../utils/haptics.dart';
import '../utils/manila_time.dart';
import '../widgets/app_badge.dart';
import '../widgets/app_skeleton.dart';
import '../widgets/empty_state.dart';
import '../widgets/section_header.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, this.onNewSale});
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
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Subscribe once the provider is reachable. All five tabs live in an
    // IndexedStack, so this screen stays mounted while a sale happens on the
    // POS - without this it kept showing yesterday until a pull-to-refresh.
    final bus = context.read<DataRefresh?>();
    if (bus != null && !identical(bus, _bus)) {
      _bus?.removeListener(_onDataChanged);
      _bus = bus..addListener(_onDataChanged);
    }
  }

  DataRefresh? _bus;

  /// Monotonic request stamp. A slow response from before a refresh must not
  /// overwrite fresher rows, so late answers are dropped.
  int _requestSeq = 0;

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

  bool _matches(Map<String, dynamic> order, String q) {
    if (q.isEmpty) return true;
    final lq = q.toLowerCase();
    final total = '₱${((order['total'] ?? 0) as num).toStringAsFixed(0)}';
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

  void _fail(String message) {
    if (!mounted) return;
    final hadRows = _rows.isNotEmpty;
    setState(() => _error = message);
    if (hadRows && mounted) {
      // INAYOS: Gumamit ng bagong bouncing Glass Toast
      AppMessenger.showGlassToast(
        context: context,
        message: 'Refresh failed: $message',
        isSuccess: false,
      );
    }
  }

  Future<void> _loadMore({bool reset = false}) async {
    if (_loading || (_done && !reset)) return;
    final seq = ++_requestSeq;
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
      // A newer refresh started while this was in flight; its answer wins.
      if (seq != _requestSeq) return;
      setState(() {
        if (reset) _rows.clear();
        _rows.addAll(batch);
        _page = reset ? 2 : _page + 1;
        _done = batch.length < 10;
      });
    } on ApiException catch (e) {
      if (seq != _requestSeq) return;
      _fail(e.message);
    } on FormatException {
      if (seq != _requestSeq) return;
      _fail('Server returned an unexpected response.');
    } catch (e) {
      if (seq != _requestSeq) return;
      _fail('Unexpected error: $e');
    } finally {
      if (mounted && seq == _requestSeq) setState(() => _loading = false);
    }
  }

  Future<void> _promptVoidOrder(Map<String, dynamic> order) async {
    // The route needs the NUMERIC id. `clientRef` is a string and is not
    // accepted here; the old `?? order['clientRef']` fallback was harmless
    // only because this value was never actually used.
    final rawId = order['id'];
    if (rawId is! num) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'Cannot void: order has no numeric id.',
        isSuccess: false,
      );
      return;
    }
    final orderId = rawId.toInt();
    final reasons = [
      'Wrong item punched',
      'Customer cancelled',
      'Duplicate order',
      'Others',
    ];
    final reason = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (modalContext) => _VoidReasonSheet(reasons: reasons),
    );
    if (reason == null) return;
    if (!mounted) return;

    final auth = context.read<AuthState>();
    final token = auth.token;
    if (token == null) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'Session expired. Please log in again.',
        isSuccess: false,
      );
      return;
    }

    Map<String, dynamic> res;
    try {
      res = await auth.api.voidOrder(token, orderId, reason: reason);
    } on ApiException catch (e) {
      // This previously showed "Order voided successfully" without ever
      // calling the API — a fake success on an action that mutated nothing.
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: e.message,
        isSuccess: false,
      );
      return;
    } catch (e) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: 'Could not reach the server. Order not voided.',
        isSuccess: false,
      );
      return;
    }
    if (!mounted) return;

    // The server tells us what it could and could not put back. If a recipe
    // no longer matches (product/flavour renamed after the sale) nothing is
    // restored, so say so instead of claiming a clean void.
    final restored = (res['restored'] as List?) ?? [];
    final warnings =
        (res['warnings'] as List?)?.map((w) => '$w').where((w) => w.isNotEmpty).toList() ??
            const <String>[];
    final unrestored = warnings
        .where((w) => w.contains('no recipe matched') || w.contains('generic recipe'))
        .toList();

    final msg = unrestored.isNotEmpty
        ? 'Voided · ${restored.length} restored · ${unrestored.length} NOT restored'
        : (restored.isEmpty
            ? 'Voided · no stock needed restoring'
            : 'Voided · ${restored.length} ingredient${restored.length == 1 ? '' : 's'} restored');

    AppMessenger.showGlassToast(
      context: context,
      message: msg,
      isSuccess: unrestored.isEmpty,
    );
    if (unrestored.isNotEmpty && mounted) {
      // Surface the detail where it cannot be missed — the operator needs to
      // recount, and silently lost stock is the bug this whole path exists to
      // prevent.
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(Icons.warning_amber_rounded, color: AppColors.danger),
          title: const Text('Stock not fully restored'),
          content: SingleChildScrollView(
            child: Text(
              '${unrestored.join('\n\n')}\n\n'
              'The sale is voided, but this stock was NOT put back. '
              'Please recount it.',
              style: const TextStyle(height: 1.4),
            ),
          ),
          actions: [
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Understood'),
            ),
          ],
        ),
      );
    }

    // Reflect the new state locally first so the row turns red immediately,
    // then reconcile against the server.
    setState(() {
      order['status'] = 'VOID';
      order['voidReason'] = reason;
    });
    // Home totals and the day header elsewhere need to know the money moved.
    // Bumped before the await below, and guarded, rather than reading context
    // after an async gap.
    if (mounted) _bus?.bump('void');
    await _loadMore(reset: true);
  }

  Future<void> _editPaymentMethod(Map<String, dynamic> order) async {
    final currentMethod = order['paymentMethod'] ?? 'CASH';
    final method = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (modalContext) =>
          _EditPaymentSheet(initialMethod: currentMethod),
    );
    if (method == null) return;
    if (!mounted) return;

    // Same fake-success defect as the void path: this showed "Payment method
    // updated successfully" without ever issuing a request.
    final rawId = order['id'];
    final auth = context.read<AuthState>();
    final token = auth.token;
    if (rawId is! num || token == null) {
      AppMessenger.showGlassToast(
        context: context,
        message: token == null
            ? 'Session expired. Please log in again.'
            : 'Cannot update: order has no numeric id.',
        isSuccess: false,
      );
      return;
    }
    final chosen = method;
    try {
      await auth.api.updateOrderPayment(token, rawId.toInt(), chosen);
    } on ApiException catch (e) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: e.message,
        isSuccess: false,
      );
      return;
    } catch (e) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: 'Could not reach the server. Not saved.',
        isSuccess: false,
      );
      return;
    }
    if (!mounted) return;

    AppMessenger.showGlassToast(
      context: context,
      message: 'Payment method updated to $chosen.',
      isSuccess: true,
    );
    setState(() => order['paymentMethod'] = chosen);
    if (mounted) _bus?.bump('payment');
    await _loadMore(reset: true);
  }

  // BAGONG FUNCTION PARA I-VIEW ANG GCASH RECEIPT MULA SA NETWORK
  void _viewNetworkProof(BuildContext context, String? url) {
    if (url == null || url.isEmpty) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'No receipt image uploaded for this order.',
        isSuccess: false,
      );
      return;
    }
    showDialog(
      context: context,
      barrierColor: Colors.black.withValues(alpha: 0.4),
      builder: (ctx) => BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
        child: Dialog(
          backgroundColor: Colors.transparent,
          elevation: 0,
          insetPadding: const EdgeInsets.all(AppSpacing.space4),
          child: SizedBox(
            width: double.infinity,
            height: MediaQuery.of(context).size.height * 0.7,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Positioned.fill(
                  child: InteractiveViewer(
                    minScale: 1.0,
                    maxScale: 4.0,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(AppRadius.l),
                      child: Image.network(
                        url,
                        fit: BoxFit.contain,
                        errorBuilder: (_, _, _) => const Center(
                          child: Icon(
                            Icons.broken_image_rounded,
                            color: Colors.white,
                            size: 48,
                          ),
                        ),
                        loadingBuilder: (context, child, progress) {
                          if (progress == null) return child;
                          return const Center(
                            child: CircularProgressIndicator(
                              color: Colors.white,
                            ),
                          );
                        },
                      ),
                    ),
                  ),
                ),
                Positioned(
                  top: AppSpacing.space2,
                  right: AppSpacing.space2,
                  child: IconButton(
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.white.withValues(alpha: 0.25),
                      side: BorderSide(
                        color: Colors.white.withValues(alpha: 0.4),
                      ),
                    ),
                    icon: const Icon(Icons.close_rounded, color: Colors.white),
                    onPressed: () => Navigator.pop(ctx),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _showOrderDetails(Map<String, dynamic> order) async {
    final items = (order['items'] as List?) ?? [];
    final total = (order['total'] ?? 0) as num;
    final paymentMethod = order['paymentMethod'] ?? 'CASH';
    final clientRef = order['clientRef'] ?? order['id'] ?? 'N/A';
    final dt = ManilaTime.parse(order['createdAt']);
    final dateStr = dt == null ? 'Unknown' : ManilaTime.formatTime(dt);
    // Both actions below are rejected by the API on a voided order, so they
    // are hidden rather than left to fail. A reversed sale is read-only.
    final isVoided = (order['status'] ?? 'PAID').toString() == 'VOID';
    final voidReason = order['voidReason'];

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
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.symmetric(vertical: AppSpacing.space2),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.3),
                  borderRadius: BorderRadius.circular(AppRadius.xs),
                ),
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Order details',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                if (isVoided)
                  const AppBadge(
                    label: 'VOIDED',
                    variant: AppBadgeVariant.danger,
                    icon: Icons.block_rounded,
                  )
                else
                  GestureDetector(
                  onTap: () {
                    Navigator.pop(sheetContext);
                    _editPaymentMethod(order);
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(AppRadius.pill),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          paymentMethod,
                          style: const TextStyle(
                            color: AppColors.primary,
                            fontWeight: FontWeight.w800,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(width: 4),
                        const Icon(
                          Icons.edit,
                          size: 12,
                          color: AppColors.primary,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space2),
            Text(dateStr, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.space4),
            const Divider(height: 1),
            const SizedBox(height: AppSpacing.space4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 240),
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: items.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.space3),
                itemBuilder: (context, index) {
                  final item = items[index];
                  final name = item['productName'] ?? 'Item';
                  final flavor = item['flavor'];
                  final qty = item['qty'] ?? 1;
                  final unitPrice = (item['unitPrice'] ?? 0) as num;
                  final lineTotal = qty * unitPrice;
                  return Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '$qty x $name${flavor != null ? ' ($flavor)' : ''}',
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              '₱${unitPrice.toStringAsFixed(0)} each',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      Text(
                        '₱${lineTotal.toStringAsFixed(0)}',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ],
                  );
                },
              ),
            ),
            const SizedBox(height: AppSpacing.space4),
            const Divider(height: 1),
            const SizedBox(height: AppSpacing.space4),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Total Amount',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                Text(
                  '₱${total.toStringAsFixed(0)}',
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    color: isVoided ? AppColors.danger : AppColors.primary,
                    fontWeight: FontWeight.w900,
                    decoration: isVoided ? TextDecoration.lineThrough : null,
                    decorationColor: AppColors.danger,
                  ),
                ),
              ],
            ),
            if (isVoided) ...[
              const SizedBox(height: AppSpacing.space3),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(AppSpacing.space3),
                decoration: BoxDecoration(
                  color: AppColors.danger.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(AppRadius.s),
                  border: Border.all(
                    color: AppColors.danger.withValues(alpha: 0.3),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'This sale was voided',
                      style: TextStyle(
                        color: AppColors.danger,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    if (voidReason != null && '$voidReason'.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        'Reason: $voidReason',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.space3),
            Text(
              'Ref: $clientRef',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(fontSize: 10),
              overflow: TextOverflow.ellipsis,
            ),

            // BAGONG BUTTON PARA I-VIEW ANG GCASH RECEIPT KUNG GCASH ANG BINAYAD
            if (paymentMethod == 'GCASH') ...[
              const SizedBox(height: AppSpacing.space4),
              FilledButton.tonalIcon(
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                  backgroundColor: AppColors.info.withValues(alpha: 0.1),
                  foregroundColor: AppColors.info,
                ),
                icon: const Icon(Icons.image_outlined, size: 18),
                label: const Text('View GCash Receipt'),
                onPressed: () {
                  // I-a-assume natin na may 'proofImageUrl' data mula sa API kapag GCash
                  _viewNetworkProof(sheetContext, order['proofImageUrl']);
                },
              ),
            ],

            const SizedBox(height: AppSpacing.space5),
            Row(
              children: [
                if (!isVoided)
                  Expanded(
                    child: OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.danger,
                        side: const BorderSide(color: AppColors.danger),
                        minimumSize: const Size.fromHeight(48),
                      ),
                      icon: const Icon(Icons.block_rounded, size: 18),
                      label: const Text('Void Order'),
                      onPressed: () {
                        Navigator.pop(sheetContext);
                        _promptVoidOrder(order);
                      },
                    ),
                  ),
                if (!isVoided) const SizedBox(width: AppSpacing.space3),
                Expanded(
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                    ),
                    onPressed: () => Navigator.pop(sheetContext),
                    child: const Text('Close'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _rows.where((o) => _matches(o, _search)).toList();
    final hasResults = filtered.isNotEmpty;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    final topPadding = MediaQuery.of(context).padding.top + 90;

    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final o in filtered) {
      final key = ManilaTime.groupKey(o['createdAt']);
      final label = key == 'unknown' ? 'Unknown date' : key;
      (grouped[label] ??= []).add(o);
    }

    final rows = <Object>[];
    for (final entry in grouped.entries) {
      // A voided sale is not money. Summing it into the day's takings was the
      // bug reported from the field: the total never moved after a void.
      // Voided rows stay visible (an operator needs the audit trail) but they
      // do not count toward the figure, and the count excludes them too so the
      // header and the number cannot disagree.
      final payable = entry.value
          .where((o) => (o['status'] ?? 'PAID').toString() != 'VOID')
          .toList();
      final voidedCount = entry.value.length - payable.length;
      final dayTotal = payable.fold<double>(
        0,
        (s, o) => s + ((o['total'] ?? 0) as num).toDouble(),
      );
      rows.add((entry.key, payable.length, dayTotal, voidedCount));
      rows.addAll(entry.value);
    }

    return Scaffold(
      extendBody: true,
      body: Stack(
        children: [
          RefreshIndicator(
            onRefresh: () async => _loadMore(reset: true),
            child: _rows.isEmpty && _loading && _error == null
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: EdgeInsets.fromLTRB(
                      AppSpacing.space4,
                      topPadding,
                      AppSpacing.space4,
                      120,
                    ),
                    children: const [AppSkeleton(rows: 6)],
                  )
                : !hasResults && !_loading
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: EdgeInsets.fromLTRB(0, topPadding, 0, 120),
                    children: [
                      AppEmptyState(
                        isError: _error != null,
                        icon: _error != null
                            ? Icons.error_outline_rounded
                            : _search.isNotEmpty
                            ? Icons.search_off_rounded
                            : Icons.receipt_long_rounded,
                        title: _error != null
                            ? _error!
                            : _search.isNotEmpty
                            ? 'No sales match "$_search"'
                            : 'No sales recorded yet',
                        subtitle: _error != null
                            ? 'Please check your internet connection and try again.'
                            : _search.isNotEmpty
                            ? 'Try a different product, flavor, or amount.'
                            : (widget.onNewSale != null
                                  ? 'Record a sale on the POS tab to see it appear here.'
                                  : null),
                        actionLabel: _error != null
                            ? 'Tap to retry'
                            : _search.isNotEmpty
                            ? 'Clear search'
                            : (widget.onNewSale != null ? 'Open POS' : null),
                        actionIcon: _error != null
                            ? Icons.refresh_rounded
                            : _search.isNotEmpty
                            ? Icons.close
                            : Icons.point_of_sale_rounded,
                        onAction: _error != null
                            ? () => _loadMore(reset: true)
                            : _search.isNotEmpty
                            ? () => setState(() {
                                _search = '';
                                _searchCtrl.clear();
                                _searching = false;
                              })
                            : widget.onNewSale,
                      ),
                    ],
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
                        if (row is (String, int, double, int)) {
                          final (date, count, total, voided) = row;
                          return Padding(
                            padding: const EdgeInsets.only(
                              top: AppSpacing.space2,
                              bottom: AppSpacing.space1,
                            ),
                            child: SectionHeader(
                              title: date,
                              eyebrow: voided > 0
                                  ? '$count sale${count != 1 ? 's' : ''} · $voided voided'
                                  : '$count sale${count != 1 ? 's' : ''}',
                              trailing: Text(
                                '₱${total.toStringAsFixed(0)}',
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
                        // Voided sales read as voided at a glance: red wash,
                        // danger border, a struck-through amount and an
                        // explicit badge. Previously every row looked
                        // identical with a green payment icon, so a reversed
                        // sale was indistinguishable from a real one.
                        final isVoided =
                            (o['status'] ?? 'PAID').toString() == 'VOID';
                        return Container(
                          clipBehavior: Clip.antiAlias,
                          decoration: BoxDecoration(
                            color: isVoided
                                ? AppColors.danger.withValues(alpha: 0.06)
                                : surfaceColor,
                            borderRadius: BorderRadius.circular(AppRadius.l),
                            boxShadow: isVoided
                                ? null
                                : AppShadow.sm(),
                            border: isVoided
                                ? Border.all(
                                    color: AppColors.danger.withValues(alpha: 0.35),
                                  )
                                : null,
                          ),
                          child: Material(
                            color: Colors.transparent,
                            child: InkWell(
                              onTap: () => _showOrderDetails(o),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: AppSpacing.space4,
                                  vertical: AppSpacing.space3,
                                ),
                                child: Row(
                                  children: [
                                    Container(
                                      width: 44,
                                      height: 44,
                                      decoration: BoxDecoration(
                                        color: (isVoided
                                                ? AppColors.danger
                                                : AppColors.ok)
                                            .withValues(alpha: 0.1),
                                        borderRadius: BorderRadius.circular(
                                          AppRadius.s,
                                        ),
                                      ),
                                      child: Icon(
                                        isVoided
                                            ? Icons.block_rounded
                                            : Icons.payments_rounded,
                                        size: 21,
                                        color: isVoided
                                            ? AppColors.danger
                                            : AppColors.ok,
                                      ),
                                    ),
                                    const SizedBox(width: AppSpacing.space3),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Row(
                                            children: [
                                              Text(
                                                '₱${((o['total'] ?? 0) as num).toStringAsFixed(0)}',
                                                style: Theme.of(context)
                                                    .textTheme
                                                    .titleMedium
                                                    ?.copyWith(
                                                      fontWeight:
                                                          FontWeight.w800,
                                                      color: isVoided
                                                          ? AppColors.danger
                                                          : null,
                                                      decoration: isVoided
                                                          ? TextDecoration.lineThrough
                                                          : null,
                                                      decorationColor:
                                                          AppColors.danger,
                                                    ),
                                              ),
                                              const SizedBox(width: 8),
                                              Text(
                                                '${(o['items'] as List).length} item(s)',
                                                style: Theme.of(
                                                  context,
                                                ).textTheme.bodySmall,
                                              ),
                                              if (isVoided) ...[
                                                const SizedBox(width: 8),
                                                const AppBadge(
                                                  label: 'VOIDED',
                                                  variant: AppBadgeVariant.danger,
                                                  icon: Icons.block_rounded,
                                                ),
                                              ],
                                            ],
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            items,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: Theme.of(
                                              context,
                                            ).textTheme.bodySmall,
                                          ),
                                        ],
                                      ),
                                    ),
                                    const Icon(
                                      Icons.chevron_right_rounded,
                                      size: 20,
                                      color: Colors.grey,
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
                                    hintText: 'Search product, flavor...',
                                    border: InputBorder.none,
                                    enabledBorder: InputBorder.none,
                                    focusedBorder: InputBorder.none,
                                    fillColor: Colors.transparent,
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
                                    'Sales history',
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
                                    tooltip: 'Search sales',
                                    onPressed: () =>
                                        setState(() => _searching = true),
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

// ---------------------------------------------------------
// Void Reason Modal
// ---------------------------------------------------------
class _VoidReasonSheet extends StatefulWidget {
  const _VoidReasonSheet({required this.reasons});
  final List<String> reasons;

  @override
  State<_VoidReasonSheet> createState() => _VoidReasonSheetState();
}

class _VoidReasonSheetState extends State<_VoidReasonSheet> {
  late String selectedReason;
  final otherController = TextEditingController();

  @override
  void initState() {
    super.initState();
    selectedReason = widget.reasons.first;
  }

  @override
  void dispose() {
    otherController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.space5,
        AppSpacing.space4,
        AppSpacing.space5,
        MediaQuery.of(context).viewInsets.bottom + AppSpacing.space6,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              margin: const EdgeInsets.symmetric(vertical: AppSpacing.space2),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(AppRadius.xs),
              ),
            ),
          ),
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.danger.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(AppRadius.m),
                ),
                child: const Icon(
                  Icons.block_rounded,
                  color: AppColors.danger,
                  size: 24,
                ),
              ),
              const SizedBox(width: AppSpacing.space3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Void Order',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Stocks will be reverted automatically.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          const Divider(height: 1),
          const SizedBox(height: AppSpacing.space3),
          Text(
            'Select reason for voiding:',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: AppSpacing.space2),
          ...widget.reasons.map(
            (reason) => InkWell(
              onTap: () {
                setState(() => selectedReason = reason);
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: 12,
                  horizontal: 8,
                ),
                child: Row(
                  children: [
                    Icon(
                      selectedReason == reason
                          ? Icons.radio_button_checked_rounded
                          : Icons.radio_button_unchecked_rounded,
                      color: selectedReason == reason
                          ? AppColors.danger
                          : Colors.grey,
                      size: 22,
                    ),
                    const SizedBox(width: 12),
                    Text(
                      reason,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedCrossFade(
            firstChild: const SizedBox.shrink(),
            secondChild: Padding(
              padding: const EdgeInsets.only(
                top: AppSpacing.space2,
                bottom: AppSpacing.space2,
              ),
              child: TextField(
                controller: otherController,
                autofocus: true,
                decoration: const InputDecoration(
                  labelText: 'Specify custom reason',
                  hintText: 'Enter reason here...',
                  prefixIcon: Icon(Icons.edit_note_rounded),
                ),
              ),
            ),
            crossFadeState: selectedReason == 'Others'
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            duration: const Duration(milliseconds: 200),
          ),
          const SizedBox(height: AppSpacing.space4),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(52),
                  ),
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Cancel'),
                ),
              ),
              const SizedBox(width: AppSpacing.space3),
              Expanded(
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.danger,
                    minimumSize: const Size.fromHeight(52),
                  ),
                  onPressed: () {
                    if (selectedReason == 'Others' &&
                        otherController.text.trim().isEmpty) {
                      return;
                    }
                    // Return the reason itself, not a bare `true` - the API
                    // stores voidReason, and an operator reading the audit
                    // trail later needs to know why the sale was reversed.
                    final text = selectedReason == 'Others'
                        ? otherController.text.trim()
                        : selectedReason;
                    Navigator.pop(context, text);
                  },
                  child: const Text('Confirm'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------
// Edit Payment Method Modal (INAYOS: Kopyang-kopya ang GCash layout sa POS)
// ---------------------------------------------------------
class _EditPaymentSheet extends StatefulWidget {
  const _EditPaymentSheet({required this.initialMethod});
  final String initialMethod;

  @override
  State<_EditPaymentSheet> createState() => _EditPaymentSheetState();
}

class _EditPaymentSheetState extends State<_EditPaymentSheet> {
  late String currentMethod;
  File? proofImage;
  bool _isPickingImage = false;

  final methods = [
    {'key': 'CASH', 'label': 'Cash', 'icon': Icons.payments_rounded},
    {'key': 'GCASH', 'label': 'GCash', 'icon': Icons.phone_android_rounded},
  ];

  @override
  void initState() {
    super.initState();
    currentMethod = widget.initialMethod;
  }

  // Kinuha mula sa pos_screen.dart
  Future<void> _pickGCashProof() async {
    if (_isPickingImage) return;
    setState(() => _isPickingImage = true);
    try {
      final picker = ImagePicker();
      final xfile = await picker.pickImage(
        source: ImageSource.camera,
        imageQuality: 80,
      );
      if (xfile != null) {
        setState(() => proofImage = File(xfile.path));
        Haptics.success();
      }
    } finally {
      if (mounted) setState(() => _isPickingImage = false);
    }
  }

  // Kinuha mula sa pos_screen.dart
  void _viewGCashProof() {
    if (proofImage == null) return;
    showDialog(
      context: context,
      barrierColor: Colors.black.withValues(alpha: 0.4),
      builder: (ctx) => BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
        child: Dialog(
          backgroundColor: Colors.transparent,
          elevation: 0,
          insetPadding: const EdgeInsets.all(AppSpacing.space4),
          child: SizedBox(
            width: double.infinity,
            height: MediaQuery.of(context).size.height * 0.7,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Positioned.fill(
                  child: InteractiveViewer(
                    minScale: 1.0,
                    maxScale: 4.0,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(AppRadius.l),
                      child: Image.file(proofImage!, fit: BoxFit.contain),
                    ),
                  ),
                ),
                Positioned(
                  top: AppSpacing.space2,
                  right: AppSpacing.space2,
                  child: IconButton(
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.white.withValues(alpha: 0.25),
                      side: BorderSide(
                        color: Colors.white.withValues(alpha: 0.4),
                      ),
                    ),
                    icon: const Icon(Icons.close_rounded, color: Colors.white),
                    onPressed: () => Navigator.pop(ctx),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.space5,
        AppSpacing.space4,
        AppSpacing.space5,
        MediaQuery.of(context).viewInsets.bottom + AppSpacing.space6,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              margin: const EdgeInsets.symmetric(vertical: AppSpacing.space2),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(AppRadius.xs),
              ),
            ),
          ),
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(AppRadius.m),
                ),
                child: const Icon(
                  Icons.payment_rounded,
                  color: AppColors.primary,
                  size: 24,
                ),
              ),
              const SizedBox(width: AppSpacing.space3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Edit Payment Method',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Update transaction payment mode.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          const Divider(height: 1),
          const SizedBox(height: AppSpacing.space3),
          Text(
            'Select new payment method:',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: AppSpacing.space2),

          // INAYOS: Parehong Payment Method Chips mula sa POS Screen
          Row(
            children: [
              for (final m in methods) ...[
                Expanded(
                  child: _PaymentChip(
                    label: m['label'] as String,
                    icon: m['icon'] as IconData,
                    selected: currentMethod == m['key'],
                    onTap: () async {
                      Haptics.select();
                      final v = m['key'] as String;
                      setState(() => currentMethod = v);
                      // No longer auto-opens the proof picker. There is no
                      // upload endpoint anywhere in the app (no multipart in
                      // ApiClient), so the picked image was never sent - but
                      // selecting GCash was BLOCKED on attaching one, so the
                      // operator filed a receipt that went nowhere and was
                      // told "Payment method updated successfully". Choosing a
                      // payment method must not depend on that. TODO: either
                      // add a receipt-proof upload endpoint or drop the
                      // attach UI, so nothing implies it was transmitted.
                    },
                  ),
                ),
                if (m != methods.last) const SizedBox(width: AppSpacing.space2),
              ],
            ],
          ),

          // INAYOS: GCash Proof Capture / Retake / View UI
          if (currentMethod == 'GCASH') ...[
            const SizedBox(height: AppSpacing.space4),
            if (proofImage != null)
              Row(
                children: [
                  Expanded(
                    flex: 3,
                    child: FilledButton.tonalIcon(
                      onPressed: _viewGCashProof,
                      icon: const Icon(Icons.visibility_outlined, size: 16),
                      label: const Text(
                        'View proof',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      style: FilledButton.styleFrom(
                        backgroundColor: AppColors.ok.withValues(alpha: 0.12),
                        foregroundColor: AppColors.ok,
                        minimumSize: const Size(0, 52),
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.space2),
                  Expanded(
                    flex: 2,
                    child: OutlinedButton.icon(
                      onPressed: _pickGCashProof,
                      icon: const Icon(Icons.camera_alt_outlined, size: 16),
                      label: const Text(
                        'Retake',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 52),
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                      ),
                    ),
                  ),
                ],
              )
            else
              OutlinedButton.icon(
                onPressed: _pickGCashProof,
                icon: const Icon(Icons.camera_alt_outlined),
                label: const Text('Capture Proof of Payment'),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(56),
                ),
              ),
          ],

          const SizedBox(height: AppSpacing.space4),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(52),
                  ),
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Cancel'),
                ),
              ),
              const SizedBox(width: AppSpacing.space3),
              Expanded(
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(52),
                  ),
                  onPressed: () => Navigator.pop(context, currentMethod),
                  child: const Text('Save Changes'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// Lokal na kopya ng Payment Chip (mula pos_screen)
class _PaymentChip extends StatelessWidget {
  const _PaymentChip({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected
          ? AppColors.primary
          : AppColors.primary.withValues(alpha: 0.08),
      borderRadius: BorderRadius.circular(AppRadius.m),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.m),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
          alignment: Alignment.center,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                icon,
                color: selected ? Colors.white : AppColors.primary,
                size: 24,
              ),
              const SizedBox(height: AppSpacing.space1),
              Text(
                label,
                style: TextStyle(
                  color: selected ? Colors.white : AppColors.primary,
                  fontWeight: FontWeight.w700,
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
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
