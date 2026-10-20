import 'package:flutter/material.dart';

class CartItem {
  final String productName;
  final String? flavor;
  final List<String>? flavors;
  final double unitPrice;
  int qty;

  CartItem({
    required this.productName,
    required this.flavor,
    this.flavors,
    required this.unitPrice,
    this.qty = 1,
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
}

class CartState extends ChangeNotifier {
  final List<CartItem> _items = [];

  List<CartItem> get items => List.unmodifiable(_items);
  bool get isEmpty => _items.isEmpty;
  int get totalQty => _items.fold(0, (sum, it) => sum + it.qty);
  double get total => _items.fold(0, (sum, it) => sum + it.lineTotal);

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
      final next = existing.first.qty + qty;
      existing.first.qty = maxQty == null
          ? next
          : next.clamp(1, maxQty).toInt();
    } else {
      _items.add(
        CartItem(
          productName: productName,
          flavor: flavor,
          unitPrice: unitPrice,
          qty: maxQty == null ? qty : qty.clamp(1, maxQty).toInt(),
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
      final next = existing.first.qty + qty;
      existing.first.qty = maxQty == null
          ? next
          : next.clamp(1, maxQty).toInt();
    } else {
      _items.add(
        CartItem(
          productName: productName,
          flavor: null,
          flavors: normalized,
          unitPrice: unitPrice,
          qty: maxQty == null ? qty : qty.clamp(1, maxQty).toInt(),
        ),
      );
    }
    notifyListeners();
  }

  void changeQty(CartItem item, int delta) {
    item.qty += delta;
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
