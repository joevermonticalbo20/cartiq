import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/data_refresh.dart';
import '../services/api_client.dart';
import '../services/offline_queue.dart';
import '../services/persisted_queue.dart';
import '../services/sync_service.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/app_messenger.dart';
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
  bool _searching = false;
  String _search = '';
  String _categoryFilter = 'All';
  Set<String> _bestSellerNames = {};
  String? _bestSellerError;

  Timer? _searchDebounce;
  final _searchController = TextEditingController();
  bool _paying = false;

  bool _refreshingCatalog = false;
  DataRefresh? _dataRefresh;

  // STATE PARA SA AUTO-HIDE SCROLL
  bool _showFilters = true;

  OfflineQueue get _queue => PersistedOfflineQueue.instance;

  @override
  void initState() {
    super.initState();
    _catalogFuture = _loadCatalog();
    WidgetsBinding.instance.addObserver(this);
    _dataRefresh = context.read<DataRefresh?>();
    _dataRefresh?.addListener(_onDataRefresh);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _dataRefresh?.removeListener(_onDataRefresh);
    _searchDebounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _reloadCatalog(forceRefresh: true);
    }
  }

  void _onDataRefresh() {
    if (!mounted) {
      return;
    }
    if (_dataRefresh?.lastReason == 'sale' ||
        _dataRefresh?.lastReason == 'inventory') {
      _reloadCatalog(forceRefresh: true);
    }
  }

  bool _flavorAvailable(Map<String, dynamic> flavor) {
    return flavor['isAvailable'] != false &&
        !(flavor['availableServings'] is num &&
            (flavor['availableServings'] as num) <= 0);
  }

  void _onSearchChanged(String v) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 300), () {
      if (!mounted) {
        return;
      }
      setState(() => _search = v.trim().toLowerCase());
    });
  }

  Future<List<Map<String, dynamic>>> _reloadCatalog({
    bool forceRefresh = false,
  }) {
    final future = _loadCatalog(forceRefresh: forceRefresh);
    setState(() {
      _catalogFuture = future;
    });
    return future;
  }

  Future<void> _refreshCatalog() async {
    if (_refreshingCatalog) {
      return;
    }
    setState(() => _refreshingCatalog = true);

    try {
      final products = await _reloadCatalog(forceRefresh: true);
      if (!mounted) {
        return;
      }
      AppMessenger.showGlassToast(
        context: context,
        message: 'Catalog updated   ${products.length} product(s)',
        isSuccess: true,
      );
    } catch (e) {
      if (!mounted) {
        return;
      }
      AppMessenger.showErrorSnackBar(
        context: context,
        error: e,
        onRetry: _refreshCatalog,
      );
    } finally {
      if (mounted) setState(() => _refreshingCatalog = false);
    }
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
      unawaited(_loadBestSellers(auth, token));
      return (data['products'] as List).cast<Map<String, dynamic>>();
    } on ApiException catch (e) {
      if (e.statusCode == 401 &&
          await auth.refreshSession() &&
          auth.token != null) {
        final data = await auth.api.catalog(
          auth.token!,
          forceRefresh: forceRefresh,
        );
        unawaited(_loadBestSellers(auth, auth.token!));
        return (data['products'] as List).cast<Map<String, dynamic>>();
      }
      rethrow;
    }
  }

  Future<void> _loadBestSellers(AuthState auth, String token) async {
    try {
      final orders = await auth.api.orders(
        token,
        pageSize: 100,
        locationCode: auth.locationCode,
      );

      final unitsByProduct = <String, int>{};
      for (final order in orders.whereType<Map<String, dynamic>>()) {
        if (order['status'] != 'PAID') {
          continue;
        }
        final items = order['items'];
        if (items is! List) {
          continue;
        }
        for (final item in items.whereType<Map<String, dynamic>>()) {
          final name = item['productName'];
          final qty = item['qty'];
          if (name is String && qty is num) {
            unitsByProduct[name] = (unitsByProduct[name] ?? 0) + qty.toInt();
          }
        }
      }

      final ranked = unitsByProduct.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));

      if (!mounted) {
        return;
      }
      setState(() {
        _bestSellerNames = ranked.take(5).map((entry) => entry.key).toSet();
        _bestSellerError = null;
      });
    } on ApiException catch (error) {
      if (error.statusCode == 401 &&
          await auth.refreshSession() &&
          auth.token != null) {
        await _loadBestSellers(auth, auth.token!);
        return;
      }
      if (mounted) setState(() => _bestSellerError = error.message);
    } catch (error) {
      if (mounted) setState(() => _bestSellerError = '$error');
    }
  }

  void _addToCart(Map<String, dynamic> product, {String? flavor, int qty = 1}) {
    final cart = context.read<CartState>();
    final price = (product['basePrice'] as num).toDouble();
    final name = product['name'] as String;

    cart.add(name, flavor, price, qty: qty);
    Haptics.select();
  }

  void _addFlavorSelection(
    Map<String, dynamic> product,
    List<Map<String, dynamic>> flavors,
    Map<String, int> selection,
  ) {
    final cart = context.read<CartState>();
    if (selection.isEmpty) {
      return;
    }

    for (final entry in selection.entries) {
      final flavor = flavors.firstWhere((item) => item['name'] == entry.key);
      final stock = flavor['availableServings'];
      cart.add(
        product['name'] as String,
        entry.key,
        (product['basePrice'] as num).toDouble(),
        qty: entry.value,
        maxQty: stock is num ? stock.toInt() : null,
      );
    }

    final count = selection.values.fold<int>(0, (a, b) => a + b);
    Haptics.select();
    AppMessenger.showGlassToast(
      context: context,
      message: 'Added selected flavors   $count serving(s)',
      isSuccess: true,
    );
  }

  bool _matchesFilter(Map<String, dynamic> product) {
    final category = (product['category'] as String? ?? '').toLowerCase();
    final flavors = product['flavors'] is List
        ? (product['flavors'] as List)
              .whereType<Map<String, dynamic>>()
              .toList()
        : <Map<String, dynamic>>[];
    final available = flavors.isEmpty
        ? _flavorAvailable(product)
        : flavors.any(_flavorAvailable);

    return switch (_categoryFilter) {
      'Available Only' => available,
      'Best Sellers' =>
        _bestSellerNames.contains(product['name']) ||
            product['isBestSeller'] == true ||
            product['bestSeller'] == true,
      'Fries' => category.contains('fries'),
      'Drinks' => category.contains('drink'),
      'Add-ons' => category.contains('add') || category.contains('topping'),
      _ => true,
    };
  }

  Future<void> _openItemSheet(Map<String, dynamic> product) async {
    final flavors = product['flavors'] is List
        ? (product['flavors'] as List).cast<Map<String, dynamic>>()
        : <Map<String, dynamic>>[];

    if (flavors.isEmpty) {
      if (!_flavorAvailable(product)) {
        return;
      }
      _addToCart(product);
      AppMessenger.showGlassToast(
        context: context,
        message: 'Added: ${product['name']}',
        isSuccess: true,
      );
      return;
    }

    final selection = <String, int>{};

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (context, setSheetState) {
          final bottomInset = MediaQuery.of(context).viewInsets.bottom;
          return SafeArea(
            top: false,
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                AppSpacing.space5,
                AppSpacing.space4,
                AppSpacing.space5,
                AppSpacing.space4 + bottomInset,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(context).size.height * 0.82,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      product['name'] as String,
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(
                            fontWeight: FontWeight.w900,
                            letterSpacing: -0.5,
                          ),
                    ),
                    const SizedBox(height: AppSpacing.space1),
                    Text(
                      '₱${product['basePrice']} per serving   choose one or more flavors',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppColors.muted,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    Expanded(
                      child: SingleChildScrollView(
                        child: PosFlavorPicker(
                          flavors: flavors,
                          selectedQuantities: Map.unmodifiable(selection),
                          onToggle: (name) => setSheetState(() {
                            if (selection.containsKey(name)) {
                              selection.remove(name);
                            } else {
                              selection[name] = 1;
                            }
                          }),
                          onQuantityChanged: (name, value) => setSheetState(() {
                            if (value <= 0) {
                              selection.remove(name);
                            } else {
                              final flavor = flavors.firstWhere(
                                (item) => item['name'] == name,
                              );
                              final stock = flavor['availableServings'];
                              selection[name] = stock is num
                                  ? value.clamp(1, stock.toInt()).toInt()
                                  : value;
                            }
                          }),
                          onQuickAdd: (name, amount) => setSheetState(() {
                            final flavor = flavors.firstWhere(
                              (item) => item['name'] == name,
                            );
                            final stock = flavor['availableServings'];
                            final current = selection[name] ?? 0;
                            selection[name] = stock is num
                                ? (current + amount)
                                      .clamp(1, stock.toInt())
                                      .toInt()
                                : current + amount;
                          }),
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.space2),
                    PosFlavorSelectionBar(
                      selectedCount: selection.length,
                      onAdd: selection.isEmpty
                          ? null
                          : () {
                              _addFlavorSelection(product, flavors, selection);
                              Navigator.pop(sheetContext);
                            },
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
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

    if (cart.isEmpty) {
      return;
    }
    if (_paying) {
      return;
    }
    _paying = true;

    try {
      final cartCode = auth.locationCode;
      final refresh = context.read<DataRefresh?>();

      await Haptics.tap();

      if (cartCode == null || cartCode.isEmpty) {
        if (!mounted) {
          return;
        }
        await Haptics.error();
        if (!mounted) {
          return;
        }
        AppMessenger.showGlassToast(
          context: context,
          message: 'No cart assigned to this account - ask OWNER',
          isSuccess: false,
        );
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
        if (!mounted) {
          return;
        }
        await Haptics.error();
        if (!mounted) {
          return;
        }
        AppMessenger.showGlassToast(
          context: context,
          message: 'Could not save sale on this device - cart kept',
          isSuccess: false,
        );
        return;
      }

      if (sheetContext.mounted) {
        Navigator.pop(sheetContext);
      }
      final result = await sync.syncAll();

      if (!mounted) {
        return;
      }
      final stockConflict = result.dropped.any(
        (record) => record.code == 'INSUFFICIENT_STOCK',
      );

      if (result.synced == 0 && !stockConflict) {
        refresh?.bump('sale');
      }

      if (result.fullySynced) {
        await Haptics.success();
      } else if (result.dropped.isNotEmpty) {
        await Haptics.error();
      } else {
        await Haptics.tap();
      }

      if (!mounted) {
        return;
      }

      final change = method == PaymentMethod.cash && cashTendered != null
          ? cashTendered - snapshotTotal
          : null;
      final paymentDetails =
          '${method.label} ₱${snapshotTotal.toStringAsFixed(0)}'
          '${change == null ? '' : '   Change ₱${change.toStringAsFixed(0)}'}';

      if (result.fullySynced) {
        AppMessenger.showGlassToast(
          context: context,
          message: 'Sale recorded   $paymentDetails',
          isSuccess: true,
        );
      } else if (!stockConflict) {
        AppMessenger.showErrorSnackBar(
          context: context,
          error: ApiException(
            result.message,
            statusCode: result.authExpired
                ? 401
                : result.errorMessage == ApiClient.unavailableMessage
                ? 503
                : null,
          ),
          onRetry: () => sync.syncAll(),
        );
      }
    } finally {
      _paying = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartState>();
    final topPadding = MediaQuery.of(context).padding.top + 90;

    final filters = [
      'All',
      'Available Only',
      'Best Sellers',
      'Fries',
      'Drinks',
      'Add-ons',
    ];

    return SafeArea(
      top: false,
      bottom: false,
      child: Column(
        children: [
          Expanded(
            child: Stack(
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
                    return false;
                  },
                  child: RefreshIndicator(
                    onRefresh: _refreshCatalog,
                    child: FutureBuilder<List<Map<String, dynamic>>>(
                      future: _catalogFuture,
                      builder: (context, snap) {
                        final products = snap.hasData
                            ? snap.data!
                                  .where(
                                    (p) =>
                                        (_search.isEmpty ||
                                            (p['name'] as String)
                                                .toLowerCase()
                                                .contains(_search) ||
                                            ((p['flavors'] as List?)?.any(
                                                  (flavor) =>
                                                      (flavor['name'] as String)
                                                          .toLowerCase()
                                                          .contains(_search),
                                                ) ??
                                                false)) &&
                                        _matchesFilter(p),
                                  )
                                  .toList()
                            : <Map<String, dynamic>>[];

                        return CustomScrollView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          slivers: [
                            SliverToBoxAdapter(
                              child: SizedBox(height: topPadding + 54),
                            ),
                            const SliverToBoxAdapter(child: PosOfflineStrip()),
                            if (snap.connectionState != ConnectionState.done)
                              SliverPadding(
                                padding: const EdgeInsets.all(
                                  AppSpacing.space4,
                                ),
                                sliver: SliverToBoxAdapter(
                                  child: Column(
                                    children: const [AppSkeleton(rows: 6)],
                                  ),
                                ),
                              )
                            else if (snap.hasError)
                              SliverFillRemaining(
                                hasScrollBody: false,
                                child: AppUnavailableState(
                                  message: AppMessenger.messageFor(snap.error!),
                                  onRetry: _refreshCatalog,
                                ),
                              )
                            else if (products.isEmpty)
                              SliverToBoxAdapter(
                                child: Padding(
                                  padding: const EdgeInsets.only(
                                    top: 60,
                                    bottom: AppSpacing.space4,
                                  ),
                                  child: AppEmptyState(
                                    compact: true,
                                    icon: Icons.search_off_rounded,
                                    title: 'No products match',
                                    subtitle: _search.isNotEmpty
                                        ? 'Try a different name or category.'
                                        : _categoryFilter == 'Best Sellers'
                                        ? _bestSellerError == null
                                              ? 'No best-selling products are available yet.'
                                              : 'Best sellers could not be loaded: $_bestSellerError'
                                        : 'Pull down to refresh the catalog.',
                                  ),
                                ),
                              )
                            else
                              SliverPadding(
                                padding: const EdgeInsets.fromLTRB(
                                  AppSpacing.space4,
                                  AppSpacing.space1,
                                  AppSpacing.space4,
                                  AppSpacing.space4,
                                ),
                                sliver: SliverGrid(
                                  gridDelegate:
                                      const SliverGridDelegateWithFixedCrossAxisCount(
                                        crossAxisCount: 2,
                                        mainAxisSpacing: AppSpacing.space3,
                                        crossAxisSpacing: AppSpacing.space3,
                                        childAspectRatio: 0.85,
                                      ),
                                  delegate: SliverChildBuilderDelegate((
                                    context,
                                    i,
                                  ) {
                                    final product = products[i];
                                    final flavorCount =
                                        product['flavors'] is List
                                        ? (product['flavors'] as List).length
                                        : 0;
                                    final inCartQty = cart.items
                                        .where(
                                          (it) =>
                                              it.productName == product['name'],
                                        )
                                        .fold<int>(0, (s, it) => s + it.qty);

                                    return PosProductCard(
                                      product: product,
                                      flavorCount: flavorCount,
                                      inCartQty: inCartQty,
                                      onTap: () => _openItemSheet(product),
                                      onQuickAdd: flavorCount == 0
                                          ? () {
                                              _addToCart(product);
                                              AppMessenger.showGlassToast(
                                                context: context,
                                                message:
                                                    'Added: ${product['name']}',
                                                isSuccess: true,
                                              );
                                            }
                                          : null,
                                    );
                                  }, childCount: products.length),
                                ),
                              ),
                          ],
                        );
                      },
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
                                            controller: _searchController,
                                            autofocus: true,
                                            decoration: InputDecoration(
                                              hintText: 'Search product...',
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
                                            onChanged: _onSearchChanged,
                                          )
                                        : Container(
                                            key: const ValueKey('titleText'),
                                            width: double.infinity,
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 20,
                                              vertical: 14,
                                            ),
                                            child: Text(
                                              'POS',
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
                                    children: [
                                      IconButton(
                                        icon: const Icon(
                                          Icons.sync_rounded,
                                          size: 20,
                                        ),
                                        tooltip:
                                            'Refresh catalog (drops the local cache)',
                                        onPressed: _refreshingCatalog
                                            ? null
                                            : _refreshCatalog,
                                      ),
                                      if (_searching)
                                        IconButton(
                                          icon: const Icon(
                                            Icons.close_rounded,
                                            size: 20,
                                          ),
                                          tooltip: 'Close search',
                                          onPressed: () {
                                            _searchDebounce?.cancel();
                                            _searchController.clear();
                                            setState(() {
                                              _search = '';
                                              _searching = false;
                                            });
                                          },
                                        )
                                      else
                                        IconButton(
                                          icon: const Icon(
                                            Icons.search_rounded,
                                            size: 20,
                                          ),
                                          tooltip: 'Search product',
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
                            itemCount: filters.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(width: AppSpacing.space2),
                            itemBuilder: (context, index) {
                              final filter = filters[index];
                              final selected = _categoryFilter == filter;
                              return FilterChip(
                                label: Text(filter),
                                selected: selected,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(
                                    AppRadius.pill,
                                  ),
                                ),
                                showCheckmark: false,
                                selectedColor: AppColors.primary,
                                labelStyle: TextStyle(
                                  fontWeight: FontWeight.w700,
                                  color: selected
                                      ? Colors.white
                                      : AppColors.muted,
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
          ),
          PosCartBar(cart: cart, onTap: _openCartSheet),
          const SizedBox(height: 120),
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

  bool get _canPay =>
      _method != PaymentMethod.cash || _tendered >= widget.cart.total;

  void _submitIfReady() {
    if (!_canPay) {
      return;
    }
    widget.onPay(_method, _method == PaymentMethod.cash ? _tendered : null);
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
        setState(() => _gcashProofImage = File(xfile.path));
        Haptics.success();
      }
    } finally {
      if (mounted) setState(() => _isPickingImage = false);
    }
  }

  void _viewGCashProof() {
    if (_gcashProofImage == null) {
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
                      if (confirmed) {
                        cart.clear();
                      }
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
                                    children: [
                                      Text(
                                        item.productName,
                                        style: const TextStyle(
                                          fontWeight: FontWeight.w700,
                                          height: 1.1,
                                        ),
                                      ),
                                      if (item.displayFlavor.isNotEmpty) ...[
                                        const SizedBox(height: 2),
                                        Text(
                                          item.displayFlavor,
                                          style: Theme.of(
                                            context,
                                          ).textTheme.bodySmall,
                                        ),
                                      ],
                                    ],
                                  ),
                                ),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.end,
                                  children: [
                                    Text(
                                      '₱${item.lineTotal.toStringAsFixed(2)}',
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w800,
                                      ),
                                    ),
                                    Row(
                                      children: [
                                        IconButton(
                                          padding: EdgeInsets.zero,
                                          constraints: const BoxConstraints(),
                                          onPressed: () {
                                            Haptics.select();
                                            cart.changeQty(item, -1);
                                          },
                                          icon: const Icon(Icons.remove),
                                        ),
                                        const SizedBox(width: 8),
                                        IconButton(
                                          padding: EdgeInsets.zero,
                                          constraints: const BoxConstraints(),
                                          onPressed: () {
                                            Haptics.select();
                                            cart.changeQty(item, 1);
                                          },
                                          icon: const Icon(Icons.add),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  const Divider(height: 1),
                  const SizedBox(height: AppSpacing.space3),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'Total Amount',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      Text(
                        '₱${cart.total.toStringAsFixed(2)}',
                        style: Theme.of(context).textTheme.headlineMedium
                            ?.copyWith(
                              color: AppColors.primary,
                              fontWeight: FontWeight.w900,
                            ),
                      ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.space4),
                  Row(
                    children: [
                      for (final m in PaymentMethod.values) ...[
                        Expanded(
                          child: _PaymentChip(
                            label: m.label,
                            icon: m.icon,
                            selected: _method == m,
                            onTap: () {
                              Haptics.select();
                              setState(() => _method = m);
                            },
                          ),
                        ),
                        if (m != PaymentMethod.values.last)
                          const SizedBox(width: AppSpacing.space2),
                      ],
                    ],
                  ),
                  const SizedBox(height: AppSpacing.space4),
                  if (_method == PaymentMethod.cash) ...[
                    TextField(
                      controller: _cashController,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      inputFormatters: [MoneyInputFormatter()],
                      textInputAction: TextInputAction.done,
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                      decoration: InputDecoration(
                        labelText: 'Cash Tendered',
                        prefixIcon: const Icon(Icons.payments_outlined),
                        suffixIcon: IconButton(
                          icon: const Icon(Icons.backspace_outlined),
                          onPressed: () {
                            Haptics.select();
                            _cashController.clear();
                            setState(() {});
                          },
                        ),
                      ),
                      onChanged: (_) => setState(() {}),
                      onSubmitted: (_) => _submitIfReady(),
                    ),
                    const SizedBox(height: AppSpacing.space3),
                    PosCashQuickAmounts(
                      total: cart.total,
                      onSelect: (v) {
                        _cashController.text = v == v.truncate()
                            ? v.toStringAsFixed(0)
                            : v.toStringAsFixed(2);
                        setState(() {});
                      },
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    PosChangeDisplay(total: cart.total, tendered: _tendered),
                  ] else ...[
                    if (_gcashProofImage != null)
                      Row(
                        children: [
                          Expanded(
                            flex: 3,
                            child: FilledButton.tonalIcon(
                              onPressed: _viewGCashProof,
                              icon: const Icon(
                                Icons.visibility_outlined,
                                size: 16,
                              ),
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
                                backgroundColor: AppColors.ok.withValues(
                                  alpha: 0.12,
                                ),
                                foregroundColor: AppColors.ok,
                                minimumSize: const Size(0, 52),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: AppSpacing.space2),
                          Expanded(
                            flex: 2,
                            child: OutlinedButton.icon(
                              onPressed: _pickGCashProof,
                              icon: const Icon(
                                Icons.camera_alt_outlined,
                                size: 16,
                              ),
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
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                ),
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
                  FilledButton.icon(
                    onPressed: _canPay ? _submitIfReady : null,
                    icon: const Icon(Icons.check_circle_rounded),
                    label: Text(
                      _method == PaymentMethod.cash
                          ? 'Confirm Payment'
                          : 'Record GCash Payment',
                    ),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(56),
                      backgroundColor: _canPay
                          ? AppColors.ok
                          : Theme.of(context).disabledColor,
                    ),
                  ),
                ],
              ),
          ],
        ),
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
              color: Theme.of(
                context,
              ).colorScheme.surface.withValues(alpha: 0.25),
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
