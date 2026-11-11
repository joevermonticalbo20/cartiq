import 'dart:async';
import 'dart:convert';
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
import '../utils/payment_rules.dart';
import '../utils/sizes.dart';
import '../widgets/app_dialog.dart';
import '../widgets/app_skeleton.dart';
import '../widgets/empty_state.dart';
import '../widgets/pos_cart_widgets.dart';
import '../widgets/pos_product_card.dart';
import '../widgets/pos_quantity.dart';

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

  /// Menu version the loaded catalog came with. The poll below compares the
  /// cheap /catalog/version probe against it and refetches only on a change.
  int? _catalogVersion;
  Timer? _catalogPoll;

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
    // Dashboard edits reach this device without a manual refresh: one tiny
    // version read every 30 s, and the full catalog only when it changed.
    _catalogPoll = Timer.periodic(
      const Duration(seconds: 30),
      (_) => _pollCatalogVersion(),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _dataRefresh?.removeListener(_onDataRefresh);
    _catalogPoll?.cancel();
    _searchDebounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _pollCatalogVersion() async {
    if (!mounted || _refreshingCatalog) return;
    final auth = context.read<AuthState>();
    final token = auth.token;
    if (token == null) return;
    try {
      final version = await auth.api.catalogVersion(token);
      if (!mounted) return;
      final known = _catalogVersion;
      if (known == null) {
        // First probe after a cold start: adopt the current version.
        _catalogVersion = version;
        return;
      }
      if (version != known) {
        _catalogVersion = version;
        await _reloadCatalog(forceRefresh: true);
        if (!mounted) return;
        AppMessenger.showGlassToast(
          context: context,
          message: 'Menu updated from the dashboard',
          isSuccess: true,
        );
      }
    } catch (_) {
      // Offline or transient: the next tick tries again.
    }
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
    // 'catalog' = the owner changed the menu on the dashboard (archived a
    // product, edited a price or a recipe). The push that says so arrives
    // within seconds, so the tile the vendor is looking at is the right one.
    if (_dataRefresh?.lastReason == 'sale' ||
        _dataRefresh?.lastReason == 'inventory' ||
        _dataRefresh?.lastReason == 'catalog') {
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

    // Signed out (or offline unlock): no session to fetch with — the cached
    // catalog is the only truth the POS has. Products persist; sales queue.
    if (token == null) {
      final cached = await auth.api.catalogCache();
      if (cached != null && cached['products'] is List) {
        _rememberCatalogVersion(cached);
        return (cached['products'] as List).cast<Map<String, dynamic>>();
      }
      throw ApiException(
        'No saved product list on this device. Connect once to load the catalog.',
      );
    }

    try {
      final data = await auth.api.catalog(token, forceRefresh: forceRefresh);
      _rememberCatalogVersion(data);
      return (data['products'] as List).cast<Map<String, dynamic>>();
    } on ApiException catch (e) {
      if (e.statusCode == 401 &&
          await auth.refreshSession() &&
          auth.token != null) {
        final data = await auth.api.catalog(
          auth.token!,
          forceRefresh: forceRefresh,
        );
        _rememberCatalogVersion(data);
        return (data['products'] as List).cast<Map<String, dynamic>>();
      }
      rethrow;
    }
  }

  void _rememberCatalogVersion(Map<String, dynamic> data) {
    final version = data['version'];
    if (version is num) _catalogVersion = version.toInt();
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
      // Per-flavor price from the catalog (size/price options like Medium
      // P20 / Large P30 / XL P40). Older cached catalogs have no unitPrice,
      // so fall back to the product base price.
      final flavor = flavors.firstWhere((item) => item['name'] == entry.key);
      final stock = flavor['availableServings'];
      final unitPrice = flavor['unitPrice'];
      cart.add(
        product['name'] as String,
        entry.key,
        unitPrice is num
            ? unitPrice.toDouble()
            : (product['basePrice'] as num).toDouble(),
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
      // The owner's star on the Products page is the ONLY source. The old
      // auto-ranking pulled the top sellers from recent orders, so products
      // showed up here while the dashboard showed no star.
      'Best Sellers' => product['isBestSeller'] == true,
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

    // The fries menu stores the SIZES as the product's options, so those
    // products get the big size tiles instead of the flavor chips.
    if (optionsAreSizes(flavors)) {
      await _openSizeSheet(product, flavors);
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

  /// The size sheet for a fries product: tap a size tile, bump the quantity,
  /// then add it to the cart. One size per order line.
  Future<void> _openSizeSheet(
    Map<String, dynamic> product,
    List<Map<String, dynamic>> sizes,
  ) async {
    final quantities = <String, int>{};
    String? picked;

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
          final qty = picked == null ? 0 : (quantities[picked] ?? 0);
          final price = picked == null
              ? 0.0
              : _sizePrice(sizes, picked!) *
                    (quantities[picked] ?? 0);
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
                      'Tap the size the customer wants',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppColors.muted,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    Expanded(
                      child: SingleChildScrollView(
                        child: PosSizePicker(
                          sizes: sizes,
                          selected: picked,
                          selectedQuantity: qty,
                          onSelect: (name) => setSheetState(() {
                            picked = name;
                            quantities[name] = quantities[name] ?? 1;
                          }),
                          onQuantityChanged: (name, value) =>
                              setSheetState(() {
                                if (value <= 0) {
                                  quantities.remove(name);
                                  if (picked == name) picked = null;
                                } else {
                                  final stock = _sizeStock(sizes, name);
                                  quantities[name] = stock == null
                                      ? value
                                      : value.clamp(1, stock).toInt();
                                }
                              }),
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.space2),
                    if (picked != null) ...[
                      PosQuantityField(
                        quantity: qty,
                        maxQuantity: _sizeStock(sizes, picked!),
                        label: 'How many $picked?',
                        hint: _sizeStock(sizes, picked!) == null
                            ? null
                            : 'Only ${_sizeStock(sizes, picked!)} in stock',
                        onChanged: (value) => setSheetState(() {
                          quantities[picked!] = value;
                        }),
                      ),
                      const SizedBox(height: AppSpacing.space3),
                    ],
                    PosSizeSelectionBar(
                      sizeName: picked,
                      quantity: qty,
                      total: price,
                      onAdd: picked == null
                          ? null
                          : () {
                              _addSizeSelection(product, sizes, {
                                picked!: quantities[picked] ?? 1,
                              });
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

  double _sizePrice(List<Map<String, dynamic>> sizes, String name) {
    for (final size in sizes) {
      if (size['name'] == name) {
        final price = size['unitPrice'];
        if (price is num) return price.toDouble();
      }
    }
    return 0;
  }

  int? _sizeStock(List<Map<String, dynamic>> sizes, String name) {
    for (final size in sizes) {
      if (size['name'] == name) {
        final stock = size['availableServings'];
        if (stock is num) return stock.toInt();
      }
    }
    return null;
  }

  void _addSizeSelection(
    Map<String, dynamic> product,
    List<Map<String, dynamic>> sizes,
    Map<String, int> selection,
  ) {
    final cart = context.read<CartState>();
    selection.forEach((name, qty) {
      final stock = _sizeStock(sizes, name);
      cart.add(
        product['name'] as String,
        name,
        _sizePrice(sizes, name),
        qty: qty,
        maxQty: stock,
      );
    });
    final count = selection.values.fold<int>(0, (a, b) => a + b);
    Haptics.select();
    AppMessenger.showGlassToast(
      context: context,
      message: 'Added ${product['name']}   $count serving(s)',
      isSuccess: true,
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
          onPay: (method, cashTendered, gcashProof) =>
              _payAndRecord(sheetContext, method, cashTendered, gcashProof),
        );
      },
    );
  }

  Future<void> _payAndRecord(
    BuildContext sheetContext,
    PaymentMethod method,
    double? cashTendered,
    File? gcashProof,
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

      // GCash proof photo: read + base64 ONCE. It rides inside the queued
      // payload; the sync service attaches it to the order after the sale is
      // recorded, so it works for both online and offline (queued) sales.
      Map<String, dynamic>? receipt;
      if (method == PaymentMethod.gcash && gcashProof != null) {
        try {
          final bytes = await gcashProof.readAsBytes();
          if (bytes.isEmpty) {
            // nothing to attach
          } else if (bytes.length > 512 * 1024) {
            if (mounted) {
              AppMessenger.showGlassToast(
                context: context,
                message: 'Proof photo too large - sale recorded without it',
                isSuccess: false,
              );
            }
          } else {
            final path = gcashProof.path.toLowerCase();
            receipt = {
              'mime': path.endsWith('.png') ? 'image/png' : 'image/jpeg',
              'data': base64Encode(bytes),
            };
          }
        } catch (_) {
          // Unreadable file: record the sale without the proof.
        }
      }

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
            'receipt': ?receipt,
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

      if (result.receiptsFailed > 0) {
        // The sale synced — only the photo did not. The photo is held on the
        // device and retried on later drains, but the operator must know.
        AppMessenger.showGlassToast(
          context: context,
          message:
              'Sale recorded but the receipt photo did not attach (${result.receiptError}). It will retry automatically when the app is online.',
          isSuccess: false,
        );
      }

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
        if (!result.online) {
          // Offline: the sale is safely queued, but the error snackbar
          // suppresses the offline message - so without this the operator saw
          // NO confirmation at all that the sale was recorded.
          AppMessenger.showGlassToast(
            context: context,
            message: 'Sale recorded offline   $paymentDetails\nWill upload when connected',
            isSuccess: true,
          );
        } else {
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
            onRetry: () async {
              final retry = await sync.syncAll();
              if (!mounted) return;
              if (retry.dropped.isNotEmpty) {
                AppMessenger.showErrorSnackBar(
                  context: context,
                  error: ApiException(retry.message, statusCode: 400),
                );
              }
            },
          );
        }
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
                                        ? 'No best sellers yet - tap the star next to a product on the dashboard.'
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
                                    final hasOptions =
                                        product['flavors'] is List &&
                                        (product['flavors'] as List).isNotEmpty;
                                    final inCartQty = cart.items
                                        .where(
                                          (it) =>
                                              it.productName == product['name'],
                                        )
                                        .fold<int>(0, (s, it) => s + it.qty);

                                    return PosProductCard(
                                      product: product,
                                      inCartQty: inCartQty,
                                      onTap: () => _openItemSheet(product),
                                      // [+] on a sized/flavored product opens
                                      // the picker (never a silent default
                                      // size); a flavorless product (dips)
                                      // adds straight to the cart.
                                      onQuickAdd: hasOptions
                                          ? () => _openItemSheet(product)
                                          : () {
                                              _addToCart(product);
                                              AppMessenger.showGlassToast(
                                                context: context,
                                                message:
                                                    'Added: ${product['name']}',
                                                isSuccess: true,
                                              );
                                            },
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
  final void Function(PaymentMethod method, double? cashTendered, File? gcashProof) onPay;

  @override
  State<_CartSheet> createState() => _CartSheetState();
}
class _CartSheetState extends State<_CartSheet> {
  PaymentMethod _method = PaymentMethod.cash;
  final _cashController = TextEditingController();
  File? _gcashProofImage;
  bool _isPickingImage = false;
  // Set the moment a sale is submitted. The parent owns the real "paying"
  // flag, but the sheet cannot see it (the sheet is its own route), so the
  // button is disabled here to stop a second tap from selling twice.
  bool _submitting = false;

  @override
  void dispose() {
    _cashController.dispose();
    super.dispose();
  }

  double? get _tendered {
    final text = _cashController.text.trim();
    if (text.isEmpty) return null;
    return double.tryParse(text);
  }

  /// Why the cash cannot be used (null = it can).
  String? get _cashError => PaymentRules.cashError(widget.cart.total, _tendered);

  bool get _canPay {
    if (_submitting) return false;
    if (_method == PaymentMethod.gcash) {
      // A GCash sale without the photo is not a sale: the owner needs the
      // proof to reconcile it later.
      return _gcashProofImage != null;
    }
    final tendered = _tendered;
    if (tendered == null) return false;
    return PaymentRules.cashError(widget.cart.total, tendered) == null;
  }

  void _submitIfReady() {
    if (!_canPay) {
      return;
    }
    setState(() => _submitting = true);
    widget.onPay(
      _method,
      _method == PaymentMethod.cash ? _tendered : null,
      _method == PaymentMethod.gcash ? _gcashProofImage : null,
    );
  }

  Future<void> _pickGCashProof() async {
    if (_isPickingImage) {
      return;
    }
    setState(() => _isPickingImage = true);

    try {
      final picker = ImagePicker();
      // Downscale on capture: the photo must fit the API's 512 KB receipt
      // cap (~680 KB base64) and travel inside the offline queue when the
      // cart has no signal. 1024px @ q55 lands most GCash proofs near a
      // tenth of the cap; the API 413 path is still surfaced, never silent.
      final xfile = await picker.pickImage(
        source: ImageSource.camera,
        imageQuality: 55,
        maxWidth: 1024,
        maxHeight: 1024,
      );
      // A denied camera permission (or a device without a camera) throws
      // here. Without the catch it escaped an unawaited callback and the
      // person saw nothing at all.
      if (!mounted) return;
      if (xfile != null) {
        setState(() => _gcashProofImage = File(xfile.path));
        Haptics.success();
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _isPickingImage = false);
      AppMessenger.showGlassToast(
        context: context,
        message: 'Could not open the camera. Check the camera permission.',
        isSuccess: false,
      );
      return;
    }
    if (mounted) setState(() => _isPickingImage = false);
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
                                // The quantity is a button: tap it and type the
                                // amount (a big order is not 200 taps of +).
                                Tooltip(
                                  message: 'Tap to type the quantity',
                                  child: Material(
                                    color: AppColors.primary.withValues(
                                      alpha: 0.12,
                                    ),
                                    borderRadius: BorderRadius.circular(
                                      AppRadius.s,
                                    ),
                                    clipBehavior: Clip.antiAlias,
                                    child: InkWell(
                                      onTap: () async {
                                        Haptics.select();
                                        final value = await showPosQuantityDialog(
                                          context,
                                          quantity: item.qty,
                                          maxQuantity: item.maxQty,
                                          title:
                                              'How many ${item.displayFlavor.isEmpty ? item.productName : item.displayFlavor}?',
                                        );
                                        if (value == null || !context.mounted) {
                                          return;
                                        }
                                        cart.setQty(item, value);
                                      },
                                      child: SizedBox(
                                        width: 40,
                                        height: 40,
                                        child: Center(
                                          child: Text(
                                            '${item.qty}',
                                            style: const TextStyle(
                                              color: AppColors.primary,
                                              fontWeight: FontWeight.w800,
                                            ),
                                          ),
                                        ),
                                      ),
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
                        labelText: 'Cash Received',
                        helperText: 'The cash the customer handed over',
                        errorText: _cashError,
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
                    PosChangeDisplay(
                      total: cart.total,
                      tendered: _tendered ?? 0,
                    ),
                  ] else ...[
                    if (_gcashProofImage != null)
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          PosProofThumbnail(
                            file: _gcashProofImage!,
                            onTap: () => showPosImageViewer(
                              context,
                              file: _gcashProofImage,
                            ),
                          ),
                          const SizedBox(width: AppSpacing.space3),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Proof captured',
                                  style: Theme.of(
                                    context,
                                  ).textTheme.titleSmall?.copyWith(
                                    fontWeight: FontWeight.w800,
                                    color: AppColors.ok,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  'Tap the photo to see it full screen',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                const SizedBox(height: AppSpacing.space2),
                                OutlinedButton.icon(
                                  onPressed: _isPickingImage
                                      ? null
                                      : _pickGCashProof,
                                  icon: _isPickingImage
                                      ? const SizedBox(
                                          width: 16,
                                          height: 16,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                          ),
                                        )
                                      : const Icon(
                                          Icons.camera_alt_outlined,
                                          size: 16,
                                        ),
                                  label: Text(
                                    _isPickingImage
                                        ? 'Opening camera…'
                                        : 'Retake',
                                  ),
                                  style: OutlinedButton.styleFrom(
                                    minimumSize: const Size(0, 44),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 12,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      )
                    else
                      OutlinedButton.icon(
                        onPressed: _isPickingImage ? null : _pickGCashProof,
                        icon: _isPickingImage
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.camera_alt_outlined),
                        label: Text(
                          _isPickingImage
                              ? 'Opening camera…'
                              : 'Capture Proof of Payment',
                        ),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size.fromHeight(56),
                        ),
                      ),
                    if (_method == PaymentMethod.gcash &&
                        _gcashProofImage == null) ...[
                      const SizedBox(height: AppSpacing.space2),
                      Text(
                        'Take the GCash receipt photo to record this sale',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: AppColors.muted,
                        ),
                      ),
                    ],
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
