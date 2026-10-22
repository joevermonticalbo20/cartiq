import 'dart:io';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
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

  String _categoryFilter = 'All';
  final List<String> _filters = ['All', 'Cash', 'GCash', 'Voided'];

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
  int _requestSeq = 0;

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

  bool _matches(Map<String, dynamic> order, String q) {
    if (q.isEmpty) {
      return true;
    }
    final lq = q.toLowerCase();
    final total = ' ${((order['total'] ?? 0) as num).toStringAsFixed(0)}';
    if (total.toLowerCase().contains(lq)) {
      return true;
    }
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
    final seq = ++_requestSeq;
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
      final data = await auth.api.ordersPaged(
        token,
        page: reset ? 1 : _page,
        locationCode: auth.locationCode,
      );

      final batch = (data['data'] as List).cast<Map<String, dynamic>>();
      if (!mounted) {
        return;
      }
      if (seq != _requestSeq) {
        return;
      }

      setState(() {
        if (reset) {
          _rows.clear();
        }
        _rows.addAll(batch);
        _page = reset ? 2 : _page + 1;
        _done = batch.length < 10;
      });
    } on ApiException catch (e) {
      if (seq != _requestSeq) {
        return;
      }
      _fail(e.message);
    } on FormatException {
      if (seq != _requestSeq) {
        return;
      }
      _fail('Server returned an unexpected response.');
    } catch (e) {
      if (seq != _requestSeq) {
        return;
      }
      _fail('Unexpected error: $e');
    } finally {
      if (mounted && seq == _requestSeq) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _promptVoidOrder(Map<String, dynamic> order) async {
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

    if (reason == null) {
      return;
    }
    if (!mounted) {
      return;
    }

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
      if (!mounted) {
        return;
      }
      AppMessenger.showGlassToast(
        context: context,
        message: e.message,
        isSuccess: false,
      );
      return;
    } catch (e) {
      if (!mounted) {
        return;
      }
      AppMessenger.showGlassToast(
        context: context,
        message: 'Could not reach the server. Order not voided.',
        isSuccess: false,
      );
      return;
    }

    if (!mounted) {
      return;
    }

    final restored = (res['restored'] as List?) ?? [];
    final warnings =
        (res['warnings'] as List?)
            ?.map((w) => '$w')
            .where((w) => w.isNotEmpty)
            .toList() ??
        const <String>[];
    final unrestored = warnings
        .where(
          (w) =>
              w.contains('no recipe matched') || w.contains('generic recipe'),
        )
        .toList();

    final msg = unrestored.isNotEmpty
        ? 'Voided   ${restored.length} restored   ${unrestored.length} NOT restored'
        : (restored.isEmpty
              ? 'Voided   no stock needed restoring'
              : 'Voided   ${restored.length} ingredient${restored.length == 1 ? '' : 's'} restored');

    AppMessenger.showGlassToast(
      context: context,
      message: msg,
      isSuccess: unrestored.isEmpty,
    );

    if (unrestored.isNotEmpty && mounted) {
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(
            Icons.warning_amber_rounded,
            color: AppColors.danger,
          ),
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

    setState(() {
      order['status'] = 'VOID';
      order['voidReason'] = reason;
    });

    if (mounted) {
      _bus?.bump('void');
    }
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

    if (method == null) {
      return;
    }
    if (!mounted) {
      return;
    }

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
      if (!mounted) {
        return;
      }
      AppMessenger.showGlassToast(
        context: context,
        message: e.message,
        isSuccess: false,
      );
      return;
    } catch (e) {
      if (!mounted) {
        return;
      }
      AppMessenger.showGlassToast(
        context: context,
        message: 'Could not reach the server. Not saved.',
        isSuccess: false,
      );
      return;
    }

    if (!mounted) {
      return;
    }
    AppMessenger.showGlassToast(
      context: context,
      message: 'Payment method updated to $chosen.',
      isSuccess: true,
    );

    setState(() => order['paymentMethod'] = chosen);
    if (mounted) {
      _bus?.bump('payment');
    }
    await _loadMore(reset: true);
  }

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
                          if (progress == null) {
                            return child;
                          }
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
    final dateStr = dt == null ? 'Unknown' : ManilaTime.formatTime12(dt);

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
            const SizedBox(height: AppSpacing.space2),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: (isVoided ? AppColors.danger : AppColors.primary)
                        .withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(AppRadius.m),
                  ),
                  child: Icon(
                    isVoided ? Icons.block_rounded : Icons.receipt_long_rounded,
                    color: isVoided ? AppColors.danger : AppColors.primary,
                    size: 28,
                  ),
                ),
                const SizedBox(width: AppSpacing.space3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Order Details',
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
                        horizontal: 12,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: paymentMethod == 'GCASH'
                            ? AppColors.info.withValues(alpha: 0.1)
                            : AppColors.primary.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(AppRadius.pill),
                        border: Border.all(
                          color: paymentMethod == 'GCASH'
                              ? AppColors.info.withValues(alpha: 0.2)
                              : AppColors.primary.withValues(alpha: 0.2),
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            paymentMethod == 'GCASH' ? 'GCash' : 'Cash',
                            style: TextStyle(
                              color: paymentMethod == 'GCASH'
                                  ? AppColors.info
                                  : AppColors.primary,
                              fontWeight: FontWeight.w800,
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(width: 4),
                          Icon(
                            Icons.edit,
                            size: 12,
                            color: paymentMethod == 'GCASH'
                                ? AppColors.info
                                : AppColors.primary,
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            Container(
              padding: const EdgeInsets.all(AppSpacing.space4),
              decoration: BoxDecoration(
                color: Theme.of(context).dividerColor.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(AppRadius.l),
                border: Border.all(
                  color: Theme.of(context).dividerColor.withValues(alpha: 0.2),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 240),
                    child: ListView.separated(
                      shrinkWrap: true,
                      itemCount: items.length,
                      separatorBuilder: (_, _) => Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: AppSpacing.space2,
                        ),
                        child: Divider(
                          height: 1,
                          color: Theme.of(
                            context,
                          ).dividerColor.withValues(alpha: 0.2),
                        ),
                      ),
                      itemBuilder: (context, index) {
                        final item = items[index];
                        final name = item['productName'] ?? 'Item';
                        final flavor = item['flavor'];
                        final qty = item['qty'] ?? 1;
                        final unitPrice = (item['unitPrice'] ?? 0) as num;
                        final lineTotal = qty * unitPrice;

                        return Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: AppColors.primary.withValues(alpha: 0.1),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                '${qty}x',
                                style: const TextStyle(
                                  color: AppColors.primary,
                                  fontWeight: FontWeight.w900,
                                  fontSize: 13,
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    name,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                      fontSize: 15,
                                    ),
                                  ),
                                  if (flavor != null) ...[
                                    const SizedBox(height: 2),
                                    Text(
                                      flavor,
                                      style: Theme.of(
                                        context,
                                      ).textTheme.bodySmall,
                                    ),
                                  ],
                                  const SizedBox(height: 2),
                                  Text(
                                    '@ ₱${unitPrice.toStringAsFixed(2)}',
                                    style: Theme.of(context).textTheme.bodySmall
                                        ?.copyWith(fontSize: 11),
                                  ),
                                ],
                              ),
                            ),
                            Text(
                              '₱${lineTotal.toStringAsFixed(2)}',
                              style: const TextStyle(
                                fontWeight: FontWeight.w800,
                                fontSize: 15,
                              ),
                            ),
                          ],
                        );
                      },
                    ),
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
                        '₱${total.toStringAsFixed(2)}',
                        style: TextStyle(
                          fontSize: 22,
                          fontWeight: FontWeight.w900,
                          color: isVoided
                              ? AppColors.danger
                              : AppColors.primary,
                          decoration: isVoided
                              ? TextDecoration.lineThrough
                              : null,
                          decorationColor: AppColors.danger,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
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
                    const Row(
                      children: [
                        Icon(
                          Icons.info_outline_rounded,
                          color: AppColors.danger,
                          size: 16,
                        ),
                        SizedBox(width: 8),
                        Text(
                          'This sale was voided',
                          style: TextStyle(
                            color: AppColors.danger,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ],
                    ),
                    if (voidReason != null && '$voidReason'.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        'Reason: $voidReason',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: AppColors.danger,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
            if (paymentMethod == 'GCASH') ...[
              const SizedBox(height: AppSpacing.space3),
              FilledButton.tonalIcon(
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                  backgroundColor: AppColors.info.withValues(alpha: 0.1),
                  foregroundColor: AppColors.info,
                ),
                icon: const Icon(Icons.image_outlined, size: 18),
                label: const Text('View GCash Receipt'),
                onPressed: () {
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
                        minimumSize: const Size.fromHeight(52),
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
                      minimumSize: const Size.fromHeight(52),
                    ),
                    onPressed: () => Navigator.pop(sheetContext),
                    child: const Text('Close'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            Center(
              child: Text(
                'Ref: $clientRef',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontSize: 10,
                  color: AppColors.muted,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
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
    final filtered = _rows.where((o) {
      if (!_matches(o, _search)) {
        return false;
      }
      final isVoided = (o['status'] ?? 'PAID').toString() == 'VOID';
      final payMethod = o['paymentMethod'] == 'GCASH' ? 'GCash' : 'Cash';

      if (_categoryFilter == 'Voided' && !isVoided) {
        return false;
      }
      if (_categoryFilter == 'Cash' && (payMethod != 'Cash' || isVoided)) {
        return false;
      }
      if (_categoryFilter == 'GCash' && (payMethod != 'GCash' || isVoided)) {
        return false;
      }
      return true;
    }).toList();

    final hasResults = filtered.isNotEmpty;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    // Fixed top padding for the ListView so it starts below the floating header
    final topPadding = MediaQuery.of(context).padding.top + 90;

    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final o in filtered) {
      final key = ManilaTime.groupKey(o['createdAt']);
      (grouped[key] ??= []).add(o);
    }

    final rows = <Object>[];
    for (final entry in grouped.entries) {
      final payable = entry.value
          .where((o) => (o['status'] ?? 'PAID').toString() != 'VOID')
          .toList();
      final voidedCount = entry.value.length - payable.length;
      final dayTotal = payable.fold<double>(
        0,
        (s, o) => s + ((o['total'] ?? 0) as num).toDouble(),
      );
      rows.add((
        _friendlyDate(entry.key),
        payable.length,
        dayTotal,
        voidedCount,
      ));
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
                        topPadding +
                            54, // initial space when filters are showing
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
                                : Icons.receipt_long_rounded,
                            title: _search.isNotEmpty
                                ? 'No sales match "$_search"'
                                : 'No sales recorded yet',
                            subtitle: _search.isNotEmpty
                                ? 'Try a different product, flavor, or amount.'
                                : (widget.onNewSale != null
                                      ? 'Record a sale on the POS tab to see it appear here.'
                                      : null),
                            actionLabel: _search.isNotEmpty
                                ? 'Clear search'
                                : (widget.onNewSale != null
                                      ? 'Open POS'
                                      : null),
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
                          topPadding + 54, // Leaves room for header and filters
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
                            final (dateLabel, count, total, voided) = row;
                            return Padding(
                              padding: const EdgeInsets.only(
                                top: AppSpacing.space3,
                                bottom: AppSpacing.space2,
                              ),
                              child: SectionHeader(
                                title: dateLabel,
                                eyebrow: voided > 0
                                    ? '$count sale${count != 1 ? 's' : ''}   $voided voided'
                                    : '$count sale${count != 1 ? 's' : ''}',
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

                          final o = row as Map<String, dynamic>;
                          final items = (o['items'] as List)
                              .map(
                                (it) =>
                                    '${it['qty']}x ${it['productName']}${it['flavor'] != null ? ' (${it['flavor']})' : ''}',
                              )
                              .join(', ');

                          final isVoided =
                              (o['status'] ?? 'PAID').toString() == 'VOID';
                          final payMethod = o['paymentMethod'] == 'GCASH'
                              ? 'GCash'
                              : 'Cash';
                          final timeStr = o['createdAt'] != null
                              ? ManilaTime.formatClock12(
                                  ManilaTime.parse(o['createdAt'])!,
                                )
                              : '--:--';

                          // INAYOS NA: Solid surfaceColor base at transparent red tint
                          // para gumana nang tama at malinis ang shadow kapag voided
                          return Container(
                            clipBehavior: Clip.antiAlias,
                            decoration: BoxDecoration(
                              color: surfaceColor,
                              borderRadius: BorderRadius.circular(AppRadius.l),
                              boxShadow: AppShadow.sm(),
                            ),
                            child: Material(
                              color: isVoided
                                  ? AppColors.danger.withValues(alpha: 0.04)
                                  : Colors.transparent,
                              child: InkWell(
                                onTap: () => _showOrderDetails(o),
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
                                          color:
                                              (isVoided
                                                      ? AppColors.danger
                                                      : AppColors.primary)
                                                  .withValues(alpha: 0.1),
                                          borderRadius: BorderRadius.circular(
                                            AppRadius.m,
                                          ),
                                        ),
                                        child: Icon(
                                          isVoided
                                              ? Icons.block_rounded
                                              : (payMethod == 'GCash'
                                                    ? Icons
                                                          .phone_android_rounded
                                                    : Icons.payments_rounded),
                                          size: 24,
                                          color: isVoided
                                              ? AppColors.danger
                                              : AppColors.primary,
                                        ),
                                      ),
                                      const SizedBox(width: AppSpacing.space3),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              items,
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
                                                  '${(o['items'] as List).length} item(s)',
                                                  style: Theme.of(
                                                    context,
                                                  ).textTheme.bodySmall,
                                                ),
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
                                            '₱${((o['total'] ?? 0) as num).toStringAsFixed(0)}',
                                            style: Theme.of(context)
                                                .textTheme
                                                .titleLarge
                                                ?.copyWith(
                                                  fontWeight: FontWeight.w900,
                                                  color: isVoided
                                                      ? AppColors.danger
                                                      : null,
                                                  decoration: isVoided
                                                      ? TextDecoration
                                                            .lineThrough
                                                      : null,
                                                  decorationColor:
                                                      AppColors.danger,
                                                ),
                                          ),
                                          const SizedBox(height: 2),
                                          // PAYMENT METHOD PILL
                                          Container(
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 8,
                                              vertical: 2,
                                            ),
                                            decoration: BoxDecoration(
                                              color: isVoided
                                                  ? AppColors.danger.withValues(
                                                      alpha: 0.1,
                                                    )
                                                  : (payMethod == 'GCash'
                                                            ? AppColors.info
                                                            : AppColors.primary)
                                                        .withValues(alpha: 0.1),
                                              borderRadius:
                                                  BorderRadius.circular(4),
                                            ),
                                            child: Text(
                                              isVoided ? 'VOID' : payMethod,
                                              style: TextStyle(
                                                fontSize: 10,
                                                fontWeight: FontWeight.w800,
                                                color: isVoided
                                                    ? AppColors.danger
                                                    : (payMethod == 'GCash'
                                                          ? AppColors.info
                                                          : AppColors.primary),
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
                                        hintText: 'Search product, flavor...',
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
                                        'Sales History',
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
          const SizedBox(height: AppSpacing.space2),
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
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
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
                decoration: InputDecoration(
                  labelText: 'Specify custom reason',
                  hintText: 'Enter reason here...',
                  prefixIcon: const Icon(Icons.edit_note_rounded),
                  filled: true,
                  fillColor: Theme.of(
                    context,
                  ).dividerColor.withValues(alpha: 0.04),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AppRadius.m),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 16,
                  ),
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

  Future<void> _pickGCashProof() async {
    if (_isPickingImage) {
      return;
    }
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
      if (mounted) {
        setState(() => _isPickingImage = false);
      }
    }
  }

  void _viewGCashProof() {
    if (proofImage == null) {
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
          const SizedBox(height: AppSpacing.space2),
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
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
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
                    },
                  ),
                ),
                if (m != methods.last) const SizedBox(width: AppSpacing.space2),
              ],
            ],
          ),
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
