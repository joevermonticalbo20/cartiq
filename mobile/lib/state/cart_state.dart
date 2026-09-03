import 'package:flutter/material.dart';

class CartItem {
  final String productName;
  final String? flavor;
  final double unitPrice;
  int qty;

  CartItem({
    required this.productName,
    required this.flavor,
    required this.unitPrice,
    this.qty = 1,
  });

  String get key => '$productName|${flavor ?? ''}';
  double get lineTotal => unitPrice * qty;

  Map<String, dynamic> toJson() => {
        'productName': productName,
        'flavor': flavor,
        'qty': qty,
        'unitPrice': unitPrice,
      };
}

class CartState extends ChangeNotifier {
  final List<CartItem> _items = [];

  List<CartItem> get items => List.unmodifiable(_items);
  bool get isEmpty => _items.isEmpty;
  int get totalQty => _items.fold(0, (sum, it) => sum + it.qty);
  double get total => _items.fold(0, (sum, it) => sum + it.lineTotal);

  void add(String productName, String? flavor, double unitPrice) {
    final key = '$productName|${flavor ?? ''}';
    final existing = _items.where((it) => it.key == key).toList();
    if (existing.isNotEmpty) {
      existing.first.qty++;
    } else {
      _items.add(CartItem(
        productName: productName,
        flavor: flavor,
        unitPrice: unitPrice,
      ));
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
}
