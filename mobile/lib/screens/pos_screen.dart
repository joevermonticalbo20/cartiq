import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/api_client.dart';
import '../services/offline_queue.dart';
import '../services/persisted_queue.dart';
import '../services/sync_service.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../widgets/app_badge.dart';
import '../widgets/app_skeleton.dart';
import '../widgets/empty_state.dart';

String newClientRef() {
  final rnd = Random.secure();
  final hex = List.generate(
    16,
    (_) => rnd.nextInt(16).toRadixString(16),
  ).join();
  return '$hex-${DateTime.now().millisecondsSinceEpoch}';
}

enum PaymentMethod { cash, gcash, card }

extension PaymentMethodX on PaymentMethod {
  String get label => switch (this) {
    PaymentMethod.cash => 'Cash',
    PaymentMethod.gcash => 'GCash',
    PaymentMethod.card => 'Card',
  };

  IconData get icon => switch (this) {
    PaymentMethod.cash => Icons.payments_rounded,
    PaymentMethod.gcash => Icons.phone_android_rounded,
    PaymentMethod.card => Icons.credit_card_rounded,
  };
}

/// Persists a checkout sale, clearing [cart] ONLY after durable enqueue.
/// Throws whatever [queue.enqueue] throws, leaving [cart] untouched so the
/// cashier can retry. Returns the persisted payload.
Future<Map<String, dynamic>> persistCheckout({
  required CartState cart,
  required OfflineQueue queue,
  required Map<String, dynamic> Function() buildPayload,
}) async {
  final payload = buildPayload();
  await queue.enqueue(
    QueuedRecord(
      id: payload['clientRef'] as String,
      kind: 'order',
      payload: payload,
    ),
  );
  cart.clear();
  return payload;
}

class PosScreen extends StatefulWidget {
  const PosScreen({super.key});

  @override
  State<PosScreen> createState() => _PosScreenState();
}

class _PosScreenState extends State<PosScreen> {
  late Future<List<Map<String, dynamic>>> _catalogFuture;
  String _search = '';
  String _categoryFilter = 'All';
  Timer? _searchDebounce;
  final _searchController = TextEditingController();

  OfflineQueue get _queue => PersistedOfflineQueue.instance;

  @override
  void initState() {
    super.initState();
    _catalogFuture = _loadCatalog();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged(String v) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      setState(() => _search = v.trim().toLowerCase());
    });
  }

  void _reloadCatalog() {
    setState(() => _catalogFuture = _loadCatalog());
  }

  Future<List<Map<String, dynamic>>> _loadCatalog() async {
    final auth = context.read<AuthState>();
    final token = auth.token;
    if (token == null) {
      throw ApiException('Session expired. Please log in again.');
    }
    final data = await auth.api.catalog(token);
    return (data['products'] as List).cast<Map<String, dynamic>>();
  }

  void _showSnack(String message, {bool error = false, bool success = false}) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: error
            ? AppColors.danger
            : success
            ? AppColors.ok
            : Theme.of(context).brightness == Brightness.dark
            ? const Color(0xFF0A0908)
            : null,
        content: Text(message, style: const TextStyle(color: Colors.white)),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  void _addToCart(Map<String, dynamic> product, {String? flavor, int qty = 1}) {
    final cart = context.read<CartState>();
    final price = (product['basePrice'] as num).toDouble();
    final name = product['name'] as String;
    for (var i = 0; i < qty; i++) {
      cart.add(name, flavor, price);
    }
    Haptics.select();
  }

  Future<void> _openItemSheet(Map<String, dynamic> product) async {
    final flavors = (product['flavors'] as List).cast<Map<String, dynamic>>();
    String? selectedFlavor = flavors.isNotEmpty
        ? flavors.first['name'] as String
        : null;
    var qty = 1;

    if (flavors.isEmpty) {
      _addToCart(product);
      _showSnack('Added: ${product['name']}', success: true);
      return;
    }

    await showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (context, setSheetState) {
            final price = ((product['basePrice'] as num) * qty).toStringAsFixed(
              0,
            );
            return Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    width: 40,
                    height: 4,
                    margin: const EdgeInsets.symmetric(vertical: 8),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.3),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    product['name'] as String,
                    style: Theme.of(sheetContext).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'P${product['basePrice']} each',
                    style: Theme.of(sheetContext).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    'Flavor',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final f in flavors)
                        ChoiceChip(
                          label: Text(f['name'] as String),
                          selected: selectedFlavor == f['name'],
                          onSelected: (_) => setSheetState(
                            () => selectedFlavor = f['name'] as String,
                          ),
                          showCheckmark: false,
                          selectedColor: AppColors.primary,
                          labelStyle: TextStyle(
                            fontWeight: FontWeight.w700,
                            color: selectedFlavor == f['name']
                                ? Colors.white
                                : null,
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      _QtyButton(
                        icon: Icons.remove,
                        onPressed: qty > 1
                            ? () => setSheetState(() => qty--)
                            : null,
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 24),
                        child: Text(
                          qty.toString(),
                          style: Theme.of(sheetContext).textTheme.headlineMedium
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                      ),
                      _QtyButton(
                        icon: Icons.add,
                        onPressed: () => setSheetState(() => qty++),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  FilledButton.icon(
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(52),
                    ),
                    icon: const Icon(Icons.add_shopping_cart_rounded),
                    label: Text('Add to order · P$price'),
                    onPressed: () {
                      _addToCart(product, flavor: selectedFlavor, qty: qty);
                      Navigator.pop(sheetContext);
                      _showSnack(
                        'Added: ${product['name']}${selectedFlavor != null ? ' ($selectedFlavor)' : ''} × $qty',
                        success: true,
                      );
                    },
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Future<void> _openCartSheet() async {
    final cart = context.read<CartState>();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (sheetContext) {
        return _CartSheet(
          cart: cart,
          onPay: (method, cashTendered) =>
              _payAndRecord(sheetContext, method, cashTendered),
        );
      },
    );
  }

  Future<void> _payAndRecord(
    BuildContext sheetContext,
    PaymentMethod method,
    double? cashTendered,
  ) async {
    final cart = sheetContext.read<CartState>();
    final auth = sheetContext.read<AuthState>();
    final sync = context.read<SyncService>();

    if (cart.isEmpty) return;

    final snapshotTotal = cart.total;
    try {
      // Enqueue FIRST: cart.clear() below only runs after durable persist,
      // so a storage failure keeps the sale intact for retry.
      await persistCheckout(
        cart: cart,
        queue: _queue,
        buildPayload: () => {
          'clientRef': newClientRef(),
          'locationCode': auth.locationCode,
          'items': cart.items.map((it) => it.toJson()).toList(),
          'total': cart.total,
          'status': 'PAID',
          'paymentMethod': method.name.toUpperCase(),
        },
      );
    } catch (_) {
      if (!mounted) return;
      await Haptics.error();
      _showSnack('Could not save sale on this device - cart kept', error: true);
      return;
    }

    if (sheetContext.mounted) Navigator.pop(sheetContext);

    final result = await sync.syncAll();
    if (!mounted) return;
    if (result.fullySynced) {
      await Haptics.success();
    } else if (result.dropped.isNotEmpty) {
      await Haptics.error();
    } else {
      await Haptics.tap();
    }
    // Queued-offline is a normal flow, not an error - keep it neutral.
    // Dropped is never reported as success (see SyncResult).
    _showSnack(
      result.fullySynced
          ? 'Sale recorded · ${method.label} · P${snapshotTotal.toStringAsFixed(0)}'
          : '${result.message} · P${snapshotTotal.toStringAsFixed(0)}',
      success: result.fullySynced,
      error: result.dropped.isNotEmpty,
    );
    if (!mounted) return;
    await _showSaleResultSheet(
      method: method,
      total: snapshotTotal,
      cashTendered: cashTendered,
      synced: result.fullySynced,
      queueMessage: result.fullySynced ? null : result.message,
    );
  }

  /// Confirmation sheet so the change amount can't be missed in a rush.
  Future<void> _showSaleResultSheet({
    required PaymentMethod method,
    required double total,
    required double? cashTendered,
    required bool synced,
    required String? queueMessage,
  }) async {
    final change = method == PaymentMethod.cash && cashTendered != null
        ? cashTendered - total
        : 0;
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.symmetric(vertical: 8),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.3),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Icon(
              synced ? Icons.check_circle_rounded : Icons.cloud_upload_outlined,
              size: 56,
              color: synced ? AppColors.ok : AppColors.warn,
            ),
            const SizedBox(height: 12),
            Text(
              synced ? 'Sale recorded' : 'Sale queued offline',
              textAlign: TextAlign.center,
              style: Theme.of(ctx).textTheme.titleLarge,
            ),
            const SizedBox(height: 4),
            Text(
              synced
                  ? '${method.label} · P${total.toStringAsFixed(0)}'
                  : '${queueMessage ?? 'Will upload when online'} · P${total.toStringAsFixed(0)}',
              textAlign: TextAlign.center,
              style: Theme.of(ctx).textTheme.bodyMedium,
            ),
            if (method == PaymentMethod.cash && (cashTendered ?? 0) > 0) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppColors.ok.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(AppRadius.m),
                  border: Border.all(
                    color: AppColors.ok.withValues(alpha: 0.4),
                  ),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'Change',
                      style: TextStyle(
                        color: AppColors.ok,
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                      ),
                    ),
                    Text(
                      'P${change.toStringAsFixed(0)}',
                      style: const TextStyle(
                        color: AppColors.ok,
                        fontWeight: FontWeight.w800,
                        fontSize: 28,
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 20),
            FilledButton(
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(52),
              ),
              onPressed: () => Navigator.pop(ctx),
              child: const Text('New sale'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartState>();
    return SafeArea(
      top: false,
      child: Column(
        children: [
          // Search bar (debounced so typing doesn't rebuild the grid per keystroke)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: 'Search product...',
                prefixIcon: const Icon(Icons.search),
                border: const OutlineInputBorder(),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 14,
                ),
                suffixIcon: _search.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _searchDebounce?.cancel();
                          _searchController.clear();
                          setState(() => _search = '');
                        },
                      ),
              ),
              onChanged: _onSearchChanged,
            ),
          ),
          // Offline queue strip - visible where the cashier works.
          const _OfflineStrip(),
          // Category filters
          SizedBox(
            height: 44,
            child: FutureBuilder<List<Map<String, dynamic>>>(
              future: _catalogFuture,
              builder: (context, snap) {
                if (!snap.hasData) return const SizedBox.shrink();
                final categories = [
                  'All',
                  ...?snap.data
                      ?.map((p) => p['category'] as String?)
                      .where((c) => c != null && c.isNotEmpty)
                      .toSet(),
                ];
                return ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  itemCount: categories.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 8),
                  itemBuilder: (context, i) {
                    final cat = categories[i];
                    final selected = cat == _categoryFilter;
                    return FilterChip(
                      label: Text(cat ?? ''),
                      selected: selected,
                      onSelected: (_) {
                        Haptics.select();
                        setState(() => _categoryFilter = cat ?? 'All');
                      },
                      showCheckmark: false,
                      selectedColor: AppColors.primary,
                      labelStyle: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: selected ? Colors.white : null,
                      ),
                    );
                  },
                );
              },
            ),
          ),
          const SizedBox(height: 6),
          Expanded(
            child: FutureBuilder<List<Map<String, dynamic>>>(
              future: _catalogFuture,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return ListView(
                    padding: const EdgeInsets.all(14),
                    children: const [AppSkeleton(rows: 6)],
                  );
                }
                if (snap.hasError) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.cloud_off_outlined, size: 48),
                          const SizedBox(height: 12),
                          Text(
                            'Catalog unavailable:\n${snap.error}',
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 16),
                          FilledButton.icon(
                            icon: const Icon(Icons.refresh_rounded),
                            label: const Text('Retry'),
                            onPressed: _reloadCatalog,
                          ),
                        ],
                      ),
                    ),
                  );
                }
                final products = (snap.data ?? const [])
                    .where(
                      (p) =>
                          (_search.isEmpty ||
                              (p['name'] as String).toLowerCase().contains(
                                _search,
                              )) &&
                          (_categoryFilter == 'All' ||
                              p['category'] == _categoryFilter),
                    )
                    .toList();
                if (products.isEmpty) {
                  return AppEmptyState(
                    compact: true,
                    icon: Icons.search_off_rounded,
                    title: 'No products match',
                    subtitle: _search.isNotEmpty
                        ? 'Try a different name or category.'
                        : 'Pull down to refresh the catalog.',
                  );
                }
                return GridView.builder(
                  padding: const EdgeInsets.fromLTRB(14, 4, 14, 14),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 190,
                    childAspectRatio: 0.95,
                    crossAxisSpacing: 12,
                    mainAxisSpacing: 12,
                  ),
                  itemCount: products.length,
                  itemBuilder: (context, i) {
                    final product = products[i];
                    final flavorCount = (product['flavors'] as List).length;
                    final cart = context.watch<CartState>();
                    final inCartQty = cart.items
                        .where((it) => it.productName == product['name'])
                        .fold<int>(0, (s, it) => s + it.qty);
                    return _ProductCard(
                      product: product,
                      flavorCount: flavorCount,
                      inCartQty: inCartQty,
                      onTap: () => _openItemSheet(product),
                      // Long-press = rush-hour quick-add with the default
                      // (first) flavor, skipping the option sheet.
                      onLongPress: flavorCount == 0
                          ? null
                          : () {
                              final flavors = (product['flavors'] as List)
                                  .cast<Map<String, dynamic>>();
                              final def = flavors.first['name'] as String;
                              _addToCart(product, flavor: def);
                              Haptics.select();
                              _showSnack(
                                'Added: ${product['name']} ($def)',
                                success: true,
                              );
                            },
                      onQuickAdd: flavorCount == 0
                          ? () {
                              _addToCart(product);
                              _showSnack(
                                'Added: ${product['name']}',
                                success: true,
                              );
                            }
                          : null,
                    );
                  },
                );
              },
            ),
          ),
          // Persistent cart panel at bottom
          _CartBar(cart: cart, onTap: _openCartSheet),
        ],
      ),
    );
  }
}

class _ProductCard extends StatelessWidget {
  const _ProductCard({
    required this.product,
    required this.flavorCount,
    required this.inCartQty,
    required this.onTap,
    this.onLongPress,
    this.onQuickAdd,
  });

  final Map<String, dynamic> product;
  final int flavorCount;
  final int inCartQty;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onQuickAdd;

  @override
  Widget build(BuildContext context) {
    final name = product['name'] as String;
    final price = product['basePrice'] as num;
    return Material(
      color: Theme.of(context).colorScheme.surface,
      borderRadius: BorderRadius.circular(AppRadius.l),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.l),
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            border: Border.all(
              color: inCartQty > 0
                  ? AppColors.primary
                  : Theme.of(context).dividerColor,
              width: inCartQty > 0 ? 1.5 : 1,
            ),
            borderRadius: BorderRadius.circular(AppRadius.l),
            boxShadow: inCartQty > 0 ? AppShadow.sm() : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Top: food icon tile + name + cart badge
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(AppRadius.s),
                    ),
                    alignment: Alignment.center,
                    child: const Icon(
                      Icons.fastfood_rounded,
                      size: 20,
                      color: AppColors.primary,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      name,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (inCartQty > 0) ...[
                    const SizedBox(width: 4),
                    AppBadge(
                      label: '$inCartQty',
                      variant: AppBadgeVariant.brand,
                    ),
                  ],
                ],
              ),
              const Spacer(),
              // Price + flavor badge / quick-add
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Flexible(
                    child: Text(
                      'P$price',
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(
                            color: AppColors.primary,
                            fontWeight: FontWeight.w800,
                          ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (flavorCount > 0)
                    AppBadge(
                      label: '$flavorCount',
                      variant: AppBadgeVariant.brand,
                    )
                  else if (onQuickAdd != null)
                    Material(
                      color: AppColors.primary,
                      shape: const CircleBorder(),
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: onQuickAdd,
                        child: const SizedBox(
                          width: 44,
                          height: 44,
                          child: Icon(Icons.add, color: Colors.white, size: 22),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                flavorCount > 0
                    ? '$flavorCount flavor${flavorCount != 1 ? 's' : ''}'
                    : 'tap to add',
                style: Theme.of(context).textTheme.bodySmall,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _QtyButton extends StatelessWidget {
  const _QtyButton({required this.icon, this.onPressed});

  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: onPressed == null
          ? Theme.of(context).disabledColor.withValues(alpha: 0.2)
          : AppColors.primary,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onPressed == null
            ? null
            : () {
                Haptics.select();
                onPressed!();
              },
        child: SizedBox(
          width: 48,
          height: 48,
          child: Icon(
            icon,
            color: onPressed == null
                ? Theme.of(context).disabledColor
                : Colors.white,
          ),
        ),
      ),
    );
  }
}

/// Thin persistent strip showing queued-offline sales where the cashier works.
class _OfflineStrip extends StatefulWidget {
  const _OfflineStrip();

  @override
  State<_OfflineStrip> createState() => _OfflineStripState();
}

class _OfflineStripState extends State<_OfflineStrip> {
  int _count = 0;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final c = await PersistedOfflineQueue.instance.count;
      if (mounted) setState(() => _count = c);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<int>(
      stream: PersistedOfflineQueue.instance.changes,
      builder: (context, snap) {
        final count = snap.hasData ? snap.data! : _count;
        if (count <= 0) return const SizedBox.shrink();
        return Container(
          margin: const EdgeInsets.fromLTRB(14, 0, 14, 6),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: AppColors.warn.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(AppRadius.s),
            border: Border.all(color: AppColors.warn.withValues(alpha: 0.45)),
          ),
          child: Row(
            children: [
              const Icon(
                Icons.cloud_upload_outlined,
                size: 18,
                color: AppColors.warn,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '$count sale${count != 1 ? 's' : ''} waiting to sync - uploads automatically when online',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _CartBar extends StatelessWidget {
  const _CartBar({required this.cart, required this.onTap});

  final CartState cart;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isEmpty = cart.isEmpty;
    return Container(
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
        border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
        boxShadow: AppShadow.md(),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          child: Material(
            color: isEmpty
                ? AppColors.primary.withValues(alpha: 0.5)
                : AppColors.primary,
            borderRadius: BorderRadius.circular(AppRadius.m),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppRadius.m),
              onTap: isEmpty ? null : onTap,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 18,
                  vertical: 14,
                ),
                child: Row(
                  children: [
                    const Icon(Icons.receipt_long_rounded, color: Colors.white),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            isEmpty
                                ? 'Order empty'
                                : '${cart.totalQty} item${cart.totalQty != 1 ? 's' : ''} in order',
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                              fontSize: 14,
                            ),
                          ),
                          if (!isEmpty) ...[
                            const SizedBox(height: 2),
                            Text(
                              'P${cart.total.toStringAsFixed(0)}',
                              style: const TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w800,
                                fontSize: 18,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (!isEmpty)
                      const Icon(
                        Icons.chevron_right_rounded,
                        color: Colors.white,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CartSheet extends StatefulWidget {
  const _CartSheet({required this.cart, required this.onPay});

  final CartState cart;
  final void Function(PaymentMethod method, double? cashTendered) onPay;

  @override
  State<_CartSheet> createState() => _CartSheetState();
}

class _CartSheetState extends State<_CartSheet> {
  PaymentMethod _method = PaymentMethod.cash;
  final _cashController = TextEditingController();

  @override
  void dispose() {
    _cashController.dispose();
    super.dispose();
  }

  double get _tendered => double.tryParse(_cashController.text) ?? 0;
  double get _change =>
      _method == PaymentMethod.cash ? _tendered - widget.cart.total : 0;
  bool get _canPay =>
      _method != PaymentMethod.cash || _tendered >= widget.cart.total;

  void _submitIfReady() {
    if (!_canPay) return;
    widget.onPay(_method, _method == PaymentMethod.cash ? _tendered : null);
  }

  @override
  Widget build(BuildContext context) {
    final cart = widget.cart;
    final viewInsets = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, 20 + viewInsets),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              margin: const EdgeInsets.symmetric(vertical: 8),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          Row(
            children: [
              Expanded(
                child: Text(
                  'Current order',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              if (!cart.isEmpty)
                TextButton.icon(
                  onPressed: () {
                    Haptics.tap();
                    cart.clear();
                  },
                  icon: const Icon(Icons.delete_outline, size: 18),
                  label: const Text('Clear'),
                ),
            ],
          ),
          const SizedBox(height: 8),
          if (cart.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Column(
                children: [
                  Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.12),
                      shape: BoxShape.circle,
                    ),
                    alignment: Alignment.center,
                    child: const Icon(
                      Icons.shopping_basket_outlined,
                      size: 30,
                      color: AppColors.primary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'No items yet',
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Tap a product to start the order.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            )
          else
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280),
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: cart.items.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, i) {
                  final item = cart.items[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(
                      children: [
                        Container(
                          width: 32,
                          height: 32,
                          decoration: BoxDecoration(
                            color: AppColors.primary.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          alignment: Alignment.center,
                          child: Text(
                            '${item.qty}',
                            style: const TextStyle(
                              color: AppColors.primary,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                item.flavor == null
                                    ? item.productName
                                    : '${item.productName} (${item.flavor})',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w700,
                                ),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                              Text(
                                'P${item.unitPrice.toStringAsFixed(0)} each',
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.remove_circle_outline),
                          onPressed: () => cart.changeQty(item, -1),
                          visualDensity: VisualDensity.compact,
                        ),
                        IconButton(
                          icon: const Icon(Icons.add_circle_outline),
                          onPressed: () => cart.changeQty(item, 1),
                          visualDensity: VisualDensity.compact,
                        ),
                        const SizedBox(width: 6),
                        SizedBox(
                          width: 60,
                          child: Text(
                            'P${item.lineTotal.toStringAsFixed(0)}',
                            textAlign: TextAlign.end,
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
          if (!cart.isEmpty) ...[
            const Divider(height: 24),
            // Total
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Total', style: Theme.of(context).textTheme.titleMedium),
                Text(
                  'P${cart.total.toStringAsFixed(0)}',
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    color: AppColors.primary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            // Payment method selector
            Text(
              'Payment method',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                fontWeight: FontWeight.w700,
                color: Theme.of(context).textTheme.bodySmall?.color,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                for (final m in PaymentMethod.values) ...[
                  Expanded(
                    child: _PaymentMethodChip(
                      method: m,
                      selected: _method == m,
                      onTap: () {
                        Haptics.select();
                        setState(() => _method = m);
                        if (m != PaymentMethod.cash) {
                          _cashController.clear();
                        }
                      },
                    ),
                  ),
                  if (m != PaymentMethod.values.last) const SizedBox(width: 8),
                ],
              ],
            ),
            if (_method == PaymentMethod.cash) ...[
              const SizedBox(height: 14),
              TextField(
                controller: _cashController,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                textInputAction: TextInputAction.done,
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[\d.]')),
                ],
                decoration: const InputDecoration(
                  labelText: 'Cash tendered (PHP)',
                  prefixText: 'P ',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) => _submitIfReady(),
              ),
              const SizedBox(height: 8),
              // Bill shortcuts ADD to the tendered amount; Exact sets it.
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final bill in const [20, 50, 100, 500, 1000])
                    ActionChip(
                      label: Text('+$bill'),
                      onPressed: () {
                        Haptics.select();
                        final next = _tendered + bill;
                        _cashController.text = next.toStringAsFixed(0);
                        setState(() {});
                      },
                    ),
                  for (final amt in _quickCash(cart.total))
                    ActionChip(
                      label: Text('P$amt'),
                      onPressed: () {
                        Haptics.select();
                        _cashController.text = amt.toStringAsFixed(0);
                        setState(() {});
                      },
                    ),
                  ActionChip(
                    label: const Text('Exact'),
                    onPressed: () {
                      Haptics.select();
                      _cashController.text = cart.total.toStringAsFixed(0);
                      setState(() {});
                    },
                  ),
                ],
              ),
              const SizedBox(height: 12),
              // Always visible so the cashier sees the running state.
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: _tendered >= cart.total
                      ? AppColors.ok.withValues(alpha: 0.12)
                      : AppColors.danger.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(AppRadius.s),
                  border: Border.all(
                    color: _tendered >= cart.total
                        ? AppColors.ok.withValues(alpha: 0.4)
                        : AppColors.danger.withValues(alpha: 0.4),
                  ),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      _tendered >= cart.total ? 'Change' : 'Short by',
                      style: TextStyle(
                        color: _tendered >= cart.total
                            ? AppColors.ok
                            : AppColors.danger,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      'P${(_tendered >= cart.total ? _change : cart.total - _tendered).toStringAsFixed(0)}',
                      style: TextStyle(
                        color: _tendered >= cart.total
                            ? AppColors.ok
                            : AppColors.danger,
                        fontWeight: FontWeight.w800,
                        fontSize: 18,
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(56),
              ),
              icon: const Icon(Icons.payments_rounded),
              label: Text(
                _method == PaymentMethod.cash && _tendered > 0
                    ? 'Record sale · P${cart.total.toStringAsFixed(0)}'
                    : 'Record sale',
              ),
              onPressed: !_canPay ? null : _submitIfReady,
            ),
            if (!_canPay) ...[
              const SizedBox(height: 8),
              Text(
                'Enter P${cart.total.toStringAsFixed(0)} or more to record the sale',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
        ],
      ),
    );
  }

  List<int> _quickCash(double total) {
    final t = total.ceil();
    final suggestions = <int>{};
    suggestions.add(t);
    suggestions.add(((t / 50).ceil() * 50));
    suggestions.add(((t / 100).ceil() * 100));
    suggestions.add(((t / 500).ceil() * 500));
    suggestions.add(((t / 1000).ceil() * 1000));
    suggestions.removeWhere((v) => v <= t);
    final list = suggestions.toList()..sort();
    return list.take(4).toList();
  }
}

class _PaymentMethodChip extends StatelessWidget {
  const _PaymentMethodChip({
    required this.method,
    required this.selected,
    required this.onTap,
  });

  final PaymentMethod method;
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
          padding: const EdgeInsets.symmetric(vertical: 12),
          alignment: Alignment.center,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                method.icon,
                color: selected ? Colors.white : AppColors.primary,
                size: 22,
              ),
              const SizedBox(height: 4),
              Text(
                method.label,
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
