import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/api_client.dart';
import '../services/offline_queue.dart';
import '../services/persisted_queue.dart';
import '../services/sync_service.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../utils/money_input.dart';
import '../widgets/app_dialog.dart';
import '../widgets/app_skeleton.dart';
import '../widgets/empty_state.dart';
import '../widgets/pos_cart_widgets.dart';
import '../widgets/pos_product_card.dart';

String newClientRef() {
  final rnd = Random.secure();
  final hex = List.generate(
    16,
    (_) => rnd.nextInt(16).toRadixString(16),
  ).join();
  return '$hex-${DateTime.now().millisecondsSinceEpoch}';
}

enum PaymentMethod { cash, gcash }

extension PaymentMethodX on PaymentMethod {
  String get label => switch (this) {
    PaymentMethod.cash => 'Cash',
    PaymentMethod.gcash => 'GCash',
  };

  IconData get icon => switch (this) {
    PaymentMethod.cash => Icons.payments_rounded,
    PaymentMethod.gcash => Icons.phone_android_rounded,
  };
}

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

class _PosScreenState extends State<PosScreen> with WidgetsBindingObserver {
  late Future<List<Map<String, dynamic>>> _catalogFuture;
  String _search = '';
  String _categoryFilter = 'All';
  Timer? _searchDebounce;
  final _searchController = TextEditingController();
  bool _paying = false;

  OfflineQueue get _queue => PersistedOfflineQueue.instance;

  @override
  void initState() {
    super.initState();
    _catalogFuture = _loadCatalog();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _searchDebounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _reloadCatalog(forceRefresh: true);
  }

  void _onSearchChanged(String v) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      setState(() => _search = v.trim().toLowerCase());
    });
  }

  void _reloadCatalog({bool forceRefresh = false}) {
    setState(() => _catalogFuture = _loadCatalog(forceRefresh: forceRefresh));
  }

  Future<void> _refreshCatalog() async {
    _reloadCatalog(forceRefresh: true);
    try {
      await _catalogFuture;
    } catch (_) {}
  }

  Future<List<Map<String, dynamic>>> _loadCatalog({
    bool forceRefresh = false,
  }) async {
    final auth = context.read<AuthState>();
    var token = auth.token;
    if (token == null) {
      throw ApiException('Session expired. Please log in again.');
    }
    try {
      final data = await auth.api.catalog(token, forceRefresh: forceRefresh);
      return (data['products'] as List).cast<Map<String, dynamic>>();
    } on ApiException catch (e) {
      if (e.statusCode == 401 &&
          await auth.refreshSession() &&
          auth.token != null) {
        final data = await auth.api.catalog(
          auth.token!,
          forceRefresh: forceRefresh,
        );
        return (data['products'] as List).cast<Map<String, dynamic>>();
      }
      rethrow;
    }
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
            ? AppColors.accentSoft
            : AppColors.accent,
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
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.space5,
                AppSpacing.space2,
                AppSpacing.space5,
                AppSpacing.space6,
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
                  Text(
                    product['name'] as String,
                    style: Theme.of(sheetContext).textTheme.titleLarge,
                  ),
                  const SizedBox(height: AppSpacing.space1),
                  Text(
                    'P${product['basePrice']} each',
                    style: Theme.of(sheetContext).textTheme.bodySmall,
                  ),
                  const SizedBox(height: AppSpacing.space5),
                  const Text(
                    'Flavor',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  Wrap(
                    spacing: AppSpacing.space2,
                    runSpacing: AppSpacing.space2,
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
                  const SizedBox(height: AppSpacing.space5),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      PosQtyButton(
                        icon: Icons.remove,
                        onPressed: qty > 1
                            ? () => setSheetState(() => qty--)
                            : null,
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.space6,
                        ),
                        child: Text(
                          qty.toString(),
                          style: Theme.of(sheetContext).textTheme.headlineMedium
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                      ),
                      PosQtyButton(
                        icon: Icons.add,
                        onPressed: () => setSheetState(() => qty++),
                      ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.space5),
                  FilledButton.icon(
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(56),
                    ),
                    icon: const Icon(Icons.add_shopping_cart_rounded),
                    label: Text('Add to order   P$price'),
                    onPressed: () {
                      _addToCart(product, flavor: selectedFlavor, qty: qty);
                      Navigator.pop(sheetContext);
                      _showSnack(
                        'Added: ${product['name']}${selectedFlavor != null ? ' ($selectedFlavor)' : ''}   $qty',
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
    final sync = sheetContext.read<SyncService>();

    if (cart.isEmpty) return;
    if (_paying) return;
    _paying = true;

    try {
      final cartCode = auth.locationCode;
      if (cartCode == null || cartCode.isEmpty) {
        if (!mounted) return;
        await Haptics.error();
        _showSnack('No cart assigned to this account - ask OWNER', error: true);
        return;
      }

      final snapshotTotal = cart.total;
      try {
        await persistCheckout(
          cart: cart,
          queue: _queue,
          buildPayload: () => {
            'clientRef': newClientRef(),
            'locationCode': cartCode,
            'items': cart.items.map((it) => it.toJson()).toList(),
            'total': cart.total,
            'status': 'PAID',
            'paymentMethod': method.name.toUpperCase(),
          },
        );
      } catch (_) {
        if (!mounted) return;
        await Haptics.error();
        _showSnack(
          'Could not save sale on this device - cart kept',
          error: true,
        );
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

      _showSnack(
        result.fullySynced
            ? 'Sale recorded   ${method.label}   P${snapshotTotal.toStringAsFixed(0)}'
            : '${result.message}   P${snapshotTotal.toStringAsFixed(0)}',
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
    } finally {
      _paying = false;
    }
  }

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
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space6,
          AppSpacing.space3,
          AppSpacing.space6,
          AppSpacing.space7,
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
            Icon(
              synced ? Icons.check_circle_rounded : Icons.cloud_upload_outlined,
              size: 56,
              color: synced ? AppColors.ok : AppColors.warn,
            ),
            const SizedBox(height: AppSpacing.space3),
            Text(
              synced ? 'Sale recorded' : 'Sale queued offline',
              textAlign: TextAlign.center,
              style: Theme.of(ctx).textTheme.titleLarge,
            ),
            const SizedBox(height: AppSpacing.space1),
            Text(
              synced
                  ? '${method.label}   P${total.toStringAsFixed(0)}'
                  : '${queueMessage ?? 'Will upload when online'}   P${total.toStringAsFixed(0)}',
              textAlign: TextAlign.center,
              style: Theme.of(ctx).textTheme.bodyMedium,
            ),
            if (method == PaymentMethod.cash && (cashTendered ?? 0) > 0) ...[
              const SizedBox(height: AppSpacing.space4),
              Container(
                padding: const EdgeInsets.all(AppSpacing.space4),
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
            const SizedBox(height: AppSpacing.space5),
            FilledButton(
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(56),
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
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space4,
              AppSpacing.space3,
              AppSpacing.space4,
              AppSpacing.space2,
            ),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: 'Search product...',
                prefixIcon: const Icon(Icons.search),
                isDense: true,
                suffixIcon: _search.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        tooltip: 'Clear search',
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
          const PosOfflineStrip(),
          SizedBox(
            height: 48,
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
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space4,
                  ),
                  itemCount: categories.length,
                  separatorBuilder: (_, _) =>
                      const SizedBox(width: AppSpacing.space2),
                  itemBuilder: (context, i) {
                    final cat = categories[i];
                    final selected = cat == _categoryFilter;
                    return FilterChip(
                      label: Text(cat ?? ''),
                      selected: selected,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(AppRadius.pill),
                      ),
                      // TINA-TRANSPARENT ANG BORDER PARA "GLASS" EFFECT
                      side: selected
                          ? BorderSide.none
                          : BorderSide(
                              color: Theme.of(
                                context,
                              ).dividerColor.withValues(alpha: 0.15),
                              width: 1.5,
                            ),
                      backgroundColor: Theme.of(
                        context,
                      ).colorScheme.surface.withValues(alpha: 0.5),
                      elevation: 0,
                      pressElevation: 0,
                      showCheckmark: false,
                      selectedColor: AppColors.primary,
                      labelStyle: TextStyle(
                        fontWeight: FontWeight.w700,
                        // Pinalambot yung kulay ng text pag hindi selected
                        color: selected ? Colors.white : AppColors.muted,
                      ),
                      onSelected: (_) {
                        Haptics.select();
                        setState(() => _categoryFilter = cat ?? 'All');
                      },
                    );
                  },
                );
              },
            ),
          ),
          const SizedBox(height: AppSpacing.space2),
          Expanded(
            child: FutureBuilder<List<Map<String, dynamic>>>(
              future: _catalogFuture,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return ListView(
                    padding: const EdgeInsets.all(AppSpacing.space4),
                    children: const [AppSkeleton(rows: 6)],
                  );
                }
                if (snap.hasError) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.space6),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.cloud_off_outlined, size: 48),
                          const SizedBox(height: AppSpacing.space3),
                          Text(
                            'Catalog unavailable:\n${snap.error}',
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: AppSpacing.space4),
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
                  return RefreshIndicator(
                    onRefresh: _refreshCatalog,
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(
                        AppSpacing.space4,
                        60,
                        AppSpacing.space4,
                        AppSpacing.space4,
                      ),
                      children: [
                        AppEmptyState(
                          compact: true,
                          icon: Icons.search_off_rounded,
                          title: 'No products match',
                          subtitle: _search.isNotEmpty
                              ? 'Try a different name or category.'
                              : 'Pull down to refresh the catalog.',
                        ),
                      ],
                    ),
                  );
                }
                return RefreshIndicator(
                  onRefresh: _refreshCatalog,
                  child: GridView.builder(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.space4,
                      AppSpacing.space1,
                      AppSpacing.space4,
                      AppSpacing.space4,
                    ),
                    gridDelegate:
                        const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 190,
                          childAspectRatio: 0.95,
                          crossAxisSpacing: AppSpacing.space3,
                          mainAxisSpacing: AppSpacing.space3,
                        ),
                    itemCount: products.length,
                    itemBuilder: (context, i) {
                      final product = products[i];
                      final flavorCount = (product['flavors'] as List).length;
                      final inCartQty = cart.items
                          .where((it) => it.productName == product['name'])
                          .fold<int>(0, (s, it) => s + it.qty);
                      return PosProductCard(
                        product: product,
                        flavorCount: flavorCount,
                        inCartQty: inCartQty,
                        onTap: () => _openItemSheet(product),
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
                  ),
                );
              },
            ),
          ),
          PosCartBar(cart: cart, onTap: _openCartSheet),
        ],
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

  File? _gcashProofImage;
  bool _isPickingImage = false;

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
        setState(() => _gcashProofImage = File(xfile.path));
        Haptics.success();
      }
    } finally {
      if (mounted) setState(() => _isPickingImage = false);
    }
  }

  void _viewGCashProof() {
    if (_gcashProofImage == null) return;
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
                      child: Image.file(_gcashProofImage!, fit: BoxFit.contain),
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
    final cart = context.watch<CartState>();
    final viewInsets = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.space5,
        AppSpacing.space1,
        AppSpacing.space5,
        AppSpacing.space5 + viewInsets,
      ),
      child: SingleChildScrollView(
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
                Expanded(
                  child: Text(
                    'Current order',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                if (!cart.isEmpty)
                  TextButton.icon(
                    onPressed: () async {
                      Haptics.tap();
                      final confirmed = await showAppConfirm(
                        context,
                        title: 'Clear order?',
                        message:
                            'This removes every item from the current order. This cannot be undone.',
                        confirmLabel: 'Clear',
                        danger: true,
                      );
                      if (confirmed) cart.clear();
                    },
                    icon: const Icon(Icons.delete_outline, size: 18),
                    label: const Text('Clear'),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.space2),
            if (cart.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: AppSpacing.space7,
                ),
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
                    const SizedBox(height: AppSpacing.space3),
                    Text(
                      'No items yet',
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: AppSpacing.space1),
                    Text(
                      'Tap a product to start the order.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              )
            else
              Column(
                children: [
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 280),
                    child: ListView.separated(
                      shrinkWrap: true,
                      itemCount: cart.items.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (context, i) {
                        final item = cart.items[i];
                        return Dismissible(
                          key: ValueKey(item.key),
                          direction: DismissDirection.endToStart,
                          background: Container(
                            alignment: Alignment.centerRight,
                            padding: const EdgeInsets.only(
                              right: AppSpacing.space5,
                            ),
                            color: AppColors.danger,
                            child: const Icon(
                              Icons.delete_outline,
                              color: Colors.white,
                            ),
                          ),
                          onDismissed: (direction) {
                            Haptics.select();
                            cart.changeQty(item, -item.qty);
                          },
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              vertical: AppSpacing.space2,
                            ),
                            child: Row(
                              children: [
                                Container(
                                  width: 40,
                                  height: 40,
                                  decoration: BoxDecoration(
                                    color: AppColors.primary.withValues(
                                      alpha: 0.12,
                                    ),
                                    borderRadius: BorderRadius.circular(
                                      AppRadius.s,
                                    ),
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
                                const SizedBox(width: AppSpacing.space3),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
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
                                        style: Theme.of(
                                          context,
                                        ).textTheme.bodySmall,
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(
                                  icon: Icon(
                                    item.qty == 1
                                        ? Icons.delete_outline
                                        : Icons.remove_circle_outline,
                                  ),
                                  color: item.qty == 1
                                      ? AppColors.danger
                                      : null,
                                  tooltip: item.qty == 1
                                      ? 'Remove item'
                                      : 'Decrease quantity',
                                  onPressed: () {
                                    Haptics.select();
                                    cart.changeQty(item, -1);
                                  },
                                  visualDensity: VisualDensity.compact,
                                ),
                                IconButton(
                                  icon: const Icon(Icons.add_circle_outline),
                                  tooltip: 'Increase quantity',
                                  onPressed: () {
                                    Haptics.select();
                                    cart.changeQty(item, 1);
                                  },
                                  visualDensity: VisualDensity.compact,
                                ),
                                const SizedBox(width: AppSpacing.space2),
                                SizedBox(
                                  width: 60,
                                  child: Text(
                                    'P${item.lineTotal.toStringAsFixed(0)}',
                                    textAlign: TextAlign.end,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space2),
                  TextButton.icon(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.add_circle_outline, size: 18),
                    label: const Text('Add more items'),
                    style: TextButton.styleFrom(
                      foregroundColor: AppColors.primary,
                      textStyle: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                ],
              ),
            if (!cart.isEmpty) ...[
              const Divider(height: 24),
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
              const SizedBox(height: AppSpacing.space4),
              Text(
                'Payment method',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: Theme.of(context).textTheme.bodySmall?.color,
                ),
              ),
              const SizedBox(height: AppSpacing.space2),
              Row(
                children: [
                  for (final m in PaymentMethod.values) ...[
                    Expanded(
                      child: _PaymentMethodChip(
                        method: m,
                        selected: _method == m,
                        onTap: () async {
                          Haptics.select();
                          setState(() {
                            _method = m;
                            if (m != PaymentMethod.cash) {
                              _cashController.clear();
                            }
                          });

                          if (m == PaymentMethod.gcash &&
                              _gcashProofImage == null) {
                            await _pickGCashProof();
                          }
                        },
                      ),
                    ),
                    if (m != PaymentMethod.values.last)
                      const SizedBox(width: AppSpacing.space2),
                  ],
                ],
              ),

              if (_method == PaymentMethod.gcash) ...[
                const SizedBox(height: AppSpacing.space4),
                if (_gcashProofImage != null)
                  Row(
                    children: [
                      Expanded(
                        flex: 3,
                        child: FilledButton.tonalIcon(
                          onPressed: _viewGCashProof,
                          icon: const Icon(Icons.visibility_outlined, size: 16),
                          label: const Text(
                            'View proof of payment',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          style: FilledButton.styleFrom(
                            backgroundColor: AppColors.ok.withValues(
                              alpha: 0.12,
                            ),
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

              if (_method == PaymentMethod.cash) ...[
                const SizedBox(height: AppSpacing.space4),
                TextField(
                  controller: _cashController,
                  autofocus: true,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  textInputAction: TextInputAction.done,
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[\d.]')),
                    MoneyInputFormatter(),
                  ],
                  decoration: const InputDecoration(
                    labelText: 'Cash tendered (PHP)',
                    prefixText: 'P ',
                  ),
                  onChanged: (_) => setState(() {}),
                  onSubmitted: (_) => _submitIfReady(),
                ),
                const SizedBox(height: AppSpacing.space2),
                Wrap(
                  spacing: AppSpacing.space2,
                  runSpacing: AppSpacing.space2,
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
                const SizedBox(height: AppSpacing.space3),
                Container(
                  padding: const EdgeInsets.all(AppSpacing.space3),
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
              const SizedBox(height: AppSpacing.space4),
              FilledButton.icon(
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(56),
                ),
                icon: const Icon(Icons.payments_rounded),
                label: Text(
                  _method == PaymentMethod.cash && _tendered > 0
                      ? 'Record sale   P${cart.total.toStringAsFixed(0)}'
                      : 'Record sale',
                ),
                onPressed: !_canPay ? null : _submitIfReady,
              ),
              if (!_canPay) ...[
                const SizedBox(height: AppSpacing.space2),
                Text(
                  'Enter P${cart.total.toStringAsFixed(0)} or more to record the sale',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              const SizedBox(height: AppSpacing.space2),
              Text(
                'clientRef   duplicate-safe   replays never double-charge',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
        ),
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
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
          alignment: Alignment.center,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                method.icon,
                color: selected ? Colors.white : AppColors.primary,
                size: 24,
              ),
              const SizedBox(height: AppSpacing.space1),
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
