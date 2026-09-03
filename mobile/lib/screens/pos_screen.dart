import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/offline_queue.dart';
import '../services/persisted_queue.dart';
import '../services/sync_service.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';

String newClientRef() {
  final rnd = Random.secure();
  final hex = List.generate(16, (_) => rnd.nextInt(16).toRadixString(16)).join();
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

class PosScreen extends StatefulWidget {
  const PosScreen({super.key});

  @override
  State<PosScreen> createState() => _PosScreenState();
}

class _PosScreenState extends State<PosScreen> {
  late Future<List<Map<String, dynamic>>> _catalogFuture;
  String _search = '';
  String _categoryFilter = 'All';

  OfflineQueue get _queue => PersistedOfflineQueue.instance;

  @override
  void initState() {
    super.initState();
    _catalogFuture = _loadCatalog();
  }

  Future<List<Map<String, dynamic>>> _loadCatalog() async {
    final auth = context.read<AuthState>();
    final data = await auth.api.catalog(auth.token!);
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
    String? selectedFlavor =
        flavors.isNotEmpty ? flavors.first['name'] as String : null;
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
            final price =
                ((product['basePrice'] as num) * qty).toStringAsFixed(0);
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
                  const Text('Flavor', style: TextStyle(fontWeight: FontWeight.w700)),
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
                              () => selectedFlavor = f['name'] as String),
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
                        padding:
                            const EdgeInsets.symmetric(horizontal: 24),
                        child: Text(
                          qty.toString(),
                          style: Theme.of(sheetContext)
                              .textTheme
                              .headlineMedium
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
                      _addToCart(product,
                          flavor: selectedFlavor, qty: qty);
                      Navigator.pop(sheetContext);
                      _showSnack(
                        'Added: ${product['name']}${selectedFlavor != null ? ' (${selectedFlavor})' : ''} × $qty',
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

    final payload = {
      'clientRef': newClientRef(),
      'locationCode': auth.locationCode,
      'items': cart.items.map((it) => it.toJson()).toList(),
      'total': cart.total,
      'status': 'PAID',
      'paymentMethod': method.name.toUpperCase(),
    };

    final snapshotTotal = cart.total;
    cart.clear();
    await _queue.enqueue(QueuedRecord(
      id: payload['clientRef'] as String,
      kind: 'order',
      payload: payload,
    ));

    if (sheetContext.mounted) Navigator.pop(sheetContext);

    final result = await sync.syncAll();
    if (!mounted) return;
    if (result.allDone) {
      await Haptics.success();
    } else {
      await Haptics.tap();
    }
    _showSnack(
      result.allDone
          ? 'Sale recorded · ${method.label} · P${snapshotTotal.toStringAsFixed(0)}'
          : '${result.message} · P${snapshotTotal.toStringAsFixed(0)} queued',
      success: result.allDone,
      error: !result.allDone,
    );
  }

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartState>();
    return SafeArea(
      top: false,
      child: Column(
        children: [
          // Search bar
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
            child: TextField(
              decoration: InputDecoration(
                hintText: 'Search product...',
                prefixIcon: const Icon(Icons.search),
                border: const OutlineInputBorder(),
                isDense: true,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                suffixIcon: _search.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () => setState(() => _search = ''),
                      ),
              ),
              onChanged: (v) =>
                  setState(() => _search = v.trim().toLowerCase()),
            ),
          ),
          // Category filters
          SizedBox(
            height: 44,
            child: FutureBuilder<List<Map<String, dynamic>>>(
              future: _catalogFuture,
              builder: (context, snap) {
                if (!snap.hasData) return const SizedBox.shrink();
                final categories = ['All', ...?snap.data
                    ?.map((p) => p['category'] as String?)
                    .where((c) => c != null && c.isNotEmpty)
                    .toSet()];
                return ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  itemCount: categories.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (context, i) {
                    final cat = categories[i];
                    final selected = cat == _categoryFilter;
                    return FilterChip(
                      label: Text(cat ?? ''),
                      selected: selected,
                      onSelected: (_) =>
                          setState(() => _categoryFilter = cat ?? 'All'),
                      showCheckmark: false,
                      selectedColor: AppColors.primary,
                      labelStyle: TextStyle(
                        fontWeight: FontWeight.w700,
                        color:
                            selected ? Colors.white : null,
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
                  return const Center(child: CircularProgressIndicator());
                }
                if (snap.hasError) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        'Catalog unavailable:\n${snap.error}',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  );
                }
                final products = (snap.data ?? const [])
                    .where((p) =>
                        (_search.isEmpty ||
                            (p['name'] as String)
                                .toLowerCase()
                                .contains(_search)) &&
                        (_categoryFilter == 'All' ||
                            p['category'] == _categoryFilter))
                    .toList();
                if (products.isEmpty) {
                  return Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.inbox_outlined,
                            size: 48,
                            color: AppColors.accent
                                .withValues(alpha: 0.4)),
                        const SizedBox(height: 12),
                        Text(
                          'No products match',
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  );
                }
                return GridView.builder(
                  padding: const EdgeInsets.fromLTRB(14, 4, 14, 14),
                  gridDelegate:
                      const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 190,
                    childAspectRatio: 0.95,
                    crossAxisSpacing: 12,
                    mainAxisSpacing: 12,
                  ),
                  itemCount: products.length,
                  itemBuilder: (context, i) {
                    final product = products[i];
                    final flavorCount =
                        (product['flavors'] as List).length;
                    final cart = context.watch<CartState>();
                    final inCartQty = cart.items
                        .where((it) => it.productName == product['name'])
                        .fold<int>(0, (s, it) => s + it.qty);
                    return _ProductCard(
                      product: product,
                      flavorCount: flavorCount,
                      inCartQty: inCartQty,
                      onTap: () => _openItemSheet(product),
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
          _CartBar(
            cart: cart,
            onTap: _openCartSheet,
          ),
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
    this.onQuickAdd,
  });

  final Map<String, dynamic> product;
  final int flavorCount;
  final int inCartQty;
  final VoidCallback onTap;
  final VoidCallback? onQuickAdd;

  @override
  Widget build(BuildContext context) {
    final name = product['name'] as String;
    final price = product['basePrice'] as num;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Material(
      color: isDark ? const Color(0xFF1E1E1E) : Colors.white,
      borderRadius: BorderRadius.circular(AppRadius.l),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.l),
        onTap: onTap,
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
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Top: name + cart badge
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      name,
                      style: Theme.of(context)
                          .textTheme
                          .titleMedium
                          ?.copyWith(fontWeight: FontWeight.w700),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (inCartQty > 0) ...[
                    const SizedBox(width: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.primary,
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: Text(
                        '$inCartQty',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
              const Spacer(),
              // Price + flavor badge
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Flexible(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(
                        'P$price',
                        style: Theme.of(context)
                            .textTheme
                            .headlineSmall
                            ?.copyWith(
                              color: AppColors.primary,
                              fontWeight: FontWeight.w800,
                            ),
                      ),
                    ),
                  ),
                  if (flavorCount > 0)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppColors.primary.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: Text(
                        '$flavorCount',
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                          color: AppColors.primary,
                        ),
                      ),
                    )
                  else if (onQuickAdd != null)
                    Container(
                      width: 30,
                      height: 30,
                      decoration: const BoxDecoration(
                        color: AppColors.primary,
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.add,
                        color: Colors.white,
                        size: 18,
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
        onTap: onPressed,
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

class _CartBar extends StatelessWidget {
  const _CartBar({required this.cart, required this.onTap});

  final CartState cart;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isEmpty = cart.isEmpty;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1E1E1E) : Colors.white,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
        border: Border(
          top: BorderSide(color: Theme.of(context).dividerColor),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.07),
            blurRadius: 14,
            offset: const Offset(0, -4),
          ),
        ],
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
                    horizontal: 18, vertical: 14),
                child: Row(
                  children: [
                    const Icon(Icons.receipt_long_rounded,
                        color: Colors.white),
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
                      const Icon(Icons.chevron_right_rounded,
                          color: Colors.white),
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
  bool get _canPay => _method != PaymentMethod.cash || _tendered >= widget.cart.total;

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
              padding: const EdgeInsets.symmetric(vertical: 32),
              child: Column(
                children: [
                  Icon(Icons.shopping_basket_outlined,
                      size: 48,
                      color: AppColors.accent.withValues(alpha: 0.4)),
                  const SizedBox(height: 12),
                  const Text('No items yet'),
                ],
              ),
            )
          else
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280),
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: cart.items.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
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
                                    fontWeight: FontWeight.w700),
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
                            style: const TextStyle(
                                fontWeight: FontWeight.w800),
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
                Text('Total',
                    style: Theme.of(context).textTheme.titleMedium),
                Text(
                  'P${cart.total.toStringAsFixed(0)}',
                  style: Theme.of(context)
                      .textTheme
                      .headlineSmall
                      ?.copyWith(
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
                        setState(() => _method = m);
                        if (m != PaymentMethod.cash) {
                          _cashController.clear();
                        }
                      },
                    ),
                  ),
                  if (m != PaymentMethod.values.last)
                    const SizedBox(width: 8),
                ],
              ],
            ),
            if (_method == PaymentMethod.cash) ...[
              const SizedBox(height: 14),
              TextField(
                controller: _cashController,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[\d.]')),
                ],
                decoration: const InputDecoration(
                  labelText: 'Cash tendered (PHP)',
                  prefixText: 'P ',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 8),
              // Quick cash buttons
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final amt in _quickCash(cart.total))
                    ActionChip(
                      label: Text('P$amt'),
                      onPressed: () {
                        _cashController.text = amt.toStringAsFixed(0);
                        setState(() {});
                      },
                    ),
                  ActionChip(
                    label: const Text('Exact'),
                    onPressed: () {
                      _cashController.text = cart.total.toStringAsFixed(0);
                      setState(() {});
                    },
                  ),
                ],
              ),
              const SizedBox(height: 12),
              if (_tendered > 0)
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
              onPressed: !_canPay
                  ? null
                  : () => widget.onPay(
                        _method,
                        _method == PaymentMethod.cash ? _tendered : null,
                      ),
            ),
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
