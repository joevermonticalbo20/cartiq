/// The fries menu sizes, in the order they are spoken and shown.
///
/// The POS stores SIZES as the product's options (Medium / Large / XL 40 /
/// XL 50), so a product whose options are all sizes gets the size picker
/// instead of the flavor picker. Keep this list in step with the API's
/// flavor order (api/src/services/flavor_order.js).
library;

const posSizeNames = <String>['Medium', 'Large', 'XL 40', 'XL 50'];

/// True when [name] is one of the menu sizes.
bool isPosSize(String? name) {
  final n = name?.trim() ?? '';
  return posSizeNames.any((s) => s.toLowerCase() == n.toLowerCase());
}

/// True when every option of [options] is a menu size (so the sheet shows
/// sizes, not flavors).
bool optionsAreSizes(List<Map<String, dynamic>> options) {
  if (options.isEmpty) return false;
  return options.every((o) => isPosSize(o['name'] as String?));
}
