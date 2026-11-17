import 'package:flutter/material.dart';

import '../utils/quantity_input.dart';

class CartItem {
  final String productName;
  final String? flavor;
  final List<String>? flavors;
  final double unitPrice;
  int qty;

  /// The most of this item the cart may hold (the stock on hand when it was
  /// added). Null means "no ceiling known".
  ///
  /// Kept on the item so the "+" button cannot push the cart past the stock:
  /// the server would then reject the whole sale with INSUFFICIENT_STOCK after
  /// the customer already paid.
  final int? maxQty;

  CartItem({
    required this.productName,
    required this.flavor,
    this.flavors,
    required this.unitPrice,
    this.qty = 1,
    this.maxQty,
  });

  String get key {
    final names = (flavors ?? [flavor ?? '']).toList()..sort();
    return '$productName|$names';
  }

  String get displayFlavor => flavors != null && flavors!.length > 1
      ? flavors!.join(' + ')
      : flavor ?? '';
  double get lineTotal => unitPrice * qty;

  Map<String, dynamic> toJson() {
    final mix = flavors != null && flavors!.length > 1;
    return {
      'productName': productName,
      'flavor': mix ? displayFlavor : flavor,
      'qty': qty,
      'unitPrice': unitPrice,
      if (mix)
        'flavorShares': [
          for (final name in flavors!)
            {'flavor': name, 'share': 1 / flavors!.length},
        ],
    };
  }

  /// The DEVICE draft of this line (not the order payload): everything needed
  /// to rebuild it after the app was closed mid-order.
  Map<String, dynamic> toDraftJson() {
    return {
      'productName': productName,
      'flavor': flavor,
      'flavors': flavors,
      'unitPrice': unitPrice,
      'qty': qty,
      'maxQty': maxQty,
    };
  }

  /// Rebuilds a line from a stored draft.
  ///
  /// Returns null for a row that makes no sense - a broken draft must never
  /// take the POS down, it just loses that one line.
  static CartItem? fromDraftJson(Map<String, dynamic> json) {
    final productName = json['productName'];
    final unitPrice = json['unitPrice'];
    if (productName is! String || productName.isEmpty) return null;
    if (unitPrice is! num || !unitPrice.isFinite) return null;
    final qty = json['qty'];
    final maxQty = json['maxQty'];
    final flavor = json['flavor'];
    final flavors = json['flavors'];
    return CartItem(
      productName: productName,
      flavor: flavor is String ? flavor : null,
      flavors: flavors is List
          ? flavors.whereType<String>().toList()
          : null,
      unitPrice: unitPrice.toDouble(),
      qty: qty is num && qty >= 1 ? qty.toInt() : 1,
      maxQty: maxQty is num && maxQty >= 1 ? maxQty.toInt() : null,
    );
  }
}

class CartState extends ChangeNotifier {
  final List<CartItem> _items = [];

  List<CartItem> get items => List.unmodifiable(_items);
  bool get isEmpty => _items.isEmpty;
  int get totalQty => _items.fold(0, (sum, it) => sum + it.qty);
  double get total => _items.fold(0, (sum, it) => sum + it.lineTotal);

  /// Units still sellable in this cart: [QuantityInput.maximum] minus
  /// everything already in it. Every entry point respects this.
  int get remainingCapacity =>
      (QuantityInput.maximum - totalQty).clamp(0, QuantityInput.maximum);

  /// The most this one line may become, accounting for everything else in the
  /// cart. [item] must be an item currently in the cart.
  int capacityFor(CartItem item) => (QuantityInput.maximum -
          (totalQty - item.qty))
      .clamp(0, QuantityInput.maximum);

  /// True when this cart was rebuilt from a draft that was saved before the
  /// app was closed (the vendor left mid-order). The POS shows a hint once,
  /// then clears the flag.
  bool restoredFromDraft = false;

  /// Rebuilds the cart from a saved draft.
  ///
  /// Used when the app starts again with an order that was never recorded:
  /// the lines come back exactly as they were, so the vendor continues
  /// instead of typing the order again.
  void restoreFromDraft(List<CartItem> items) {
    _items
      ..clear()
      ..addAll(items);
    restoredFromDraft = _items.isNotEmpty;
    notifyListeners();
  }

  void add(
    String productName,
    String? flavor,
    double unitPrice, {
    int qty = 1,
    int? maxQty,
  }) {
    if (qty <= 0) return;
    final names = [flavor ?? '']..sort();
    final key = '$productName|$names';
    final existing = _items.where((it) => it.key == key).toList();
    if (existing.isNotEmpty) {
      final target = existing.first;
      final otherUnits = totalQty - target.qty;
      final orderCap = (QuantityInput.maximum - otherUnits)
          .clamp(0, QuantityInput.maximum);
      final stockCeiling = maxQty ?? target.maxQty;
      final ceiling =
          stockCeiling == null || stockCeiling > orderCap ? orderCap : stockCeiling;
      if (ceiling <= 0) return; // the cart is already full
      target.qty = (target.qty + qty).clamp(1, ceiling).toInt();
    } else {
      if (remainingCapacity <= 0) return; // the cart is already full
      final effectiveCap = maxQty == null
          ? remainingCapacity
          : (maxQty < remainingCapacity ? maxQty : remainingCapacity);
      _items.add(
        CartItem(
          productName: productName,
          flavor: flavor,
          unitPrice: unitPrice,
          qty: qty.clamp(1, effectiveCap).toInt(),
          maxQty: maxQty,
        ),
      );
    }
    notifyListeners();
  }

  void addMixed(
    String productName,
    List<String> flavors,
    double unitPrice, {
    int qty = 1,
    int? maxQty,
  }) {
    final normalized = flavors.toSet().toList()..sort();
    if (normalized.length < 2 || normalized.length > 3 || qty <= 0) return;
    final key = '$productName|$normalized';
    final existing = _items.where((it) => it.key == key).toList();
    if (existing.isNotEmpty) {
      final target = existing.first;
      final otherUnits = totalQty - target.qty;
      final orderCap = (QuantityInput.maximum - otherUnits)
          .clamp(0, QuantityInput.maximum);
      final stockCeiling = maxQty ?? target.maxQty;
      final ceiling =
          stockCeiling == null || stockCeiling > orderCap ? orderCap : stockCeiling;
      if (ceiling <= 0) return; // the cart is already full
      target.qty = (target.qty + qty).clamp(1, ceiling).toInt();
    } else {
      if (remainingCapacity <= 0) return; // the cart is already full
      final effectiveCap = maxQty == null
          ? remainingCapacity
          : (maxQty < remainingCapacity ? maxQty : remainingCapacity);
      _items.add(
        CartItem(
          productName: productName,
          flavor: null,
          flavors: normalized,
          unitPrice: unitPrice,
          qty: qty.clamp(1, effectiveCap).toInt(),
          maxQty: maxQty,
        ),
      );
    }
    notifyListeners();
  }

  /// Sets the quantity of a line outright (the vendor typed it: "200 fries").
  ///
  /// The stock ceiling still applies: the server would refuse the whole sale
  /// (INSUFFICIENT_STOCK) after the customer already paid. A quantity of zero
  /// or less removes the line.
  void setQty(CartItem item, int qty) {
    var next = qty;
    if (next > QuantityInput.maximum) next = QuantityInput.maximum;
    final ceiling = item.maxQty;
    if (ceiling != null && next > ceiling) next = ceiling;
    final capacity = capacityFor(item);
    if (next > capacity) next = capacity;
    if (next <= 0) {
      _items.remove(item);
    } else {
      item.qty = next;
    }
    notifyListeners();
  }

  void changeQty(CartItem item, int delta) {
    // The "+" button must not push the cart past the stock on hand: the
    // server would reject the whole sale (INSUFFICIENT_STOCK) after the
    // customer already paid.
    final ceiling = item.maxQty;
    final capacity = capacityFor(item);
    final next = item.qty + delta;
    // The line may never exceed what is left for it, no matter what the
    // stock says.
    final hardCap = ceiling == null || ceiling > capacity ? capacity : ceiling;
    if (next > QuantityInput.maximum || next > hardCap) {
      notifyListeners();
      return;
    }
    item.qty = next;
    if (item.qty <= 0) _items.remove(item);
    notifyListeners();
  }

  void clear() {
    _items.clear();
    notifyListeners();
  }

  void restoreRejectedOrder(Map<String, dynamic> payload) {
    final items = payload['items'];
    if (items is! List) return;
    for (final value in items.whereType<Map<String, dynamic>>()) {
      final productName = value['productName'];
      final quantity = value['qty'];
      final price = value['unitPrice'];
      if (productName is! String ||
          quantity is! int ||
          quantity < 1 ||
          price is! num) {
        continue;
      }
      final shares = value['flavorShares'];
      if (shares is List) {
        final flavors = shares
            .whereType<Map<String, dynamic>>()
            .map((share) => share['flavor'])
            .whereType<String>()
            .toList();
        if (flavors.length >= 2 && flavors.length <= 3) {
          addMixed(
            productName,
            flavors,
            price.toDouble(),
            qty: quantity,
          );
          continue;
        }
      }
      final flavor = value['flavor'];
      add(
        productName,
        flavor is String && flavor.isNotEmpty ? flavor : null,
        price.toDouble(),
        qty: quantity,
      );
    }
  }
}
