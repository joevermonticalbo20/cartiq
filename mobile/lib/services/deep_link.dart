/// Where a tapped notification wants to land in the app.
///
/// Kept pure (no widgets, no context) so the mapping is unit-testable:
/// the root shell asks [resolveDeepLink] what to do with the payload it
/// parked with `AuthState.stashDeepLink`.
class DeepLinkTarget {
  const DeepLinkTarget({
    required this.tabIndex,
    this.orderId,
    this.openLiveStock = false,
    this.openNotifications = false,
  });

  /// Root-shell tab to switch to (0 POS, 1 Receipts, 2 Home, 3 History,
  /// 4 Settings). Ignored when [openLiveStock] is set (that pushes a route
  /// on top of whatever tab is active).
  final int tabIndex;

  /// The order to open on the History tab (void / GCash decisions).
  final int? orderId;

  /// Push the Live Stock screen on top of the current tab.
  final bool openLiveStock;

  /// Open the Home tab's notification sheet (the fallback for types with
  /// no dedicated destination).
  final bool openNotifications;
}

/// Map a parked deep-link payload to a destination.
///
/// `link` (a server-side routing override) wins over the type mapping.
/// Unknown types fall back to Home + the notifications sheet, so a tap
/// never lands nowhere.
DeepLinkTarget resolveDeepLink(Map<String, dynamic> data) {
  final link = (data['link'] ?? '').toString().trim().toLowerCase();
  final type = (data['type'] ?? '').toString().trim().toUpperCase();
  final orderIdRaw = data['orderId'];
  final orderId = orderIdRaw is int
      ? orderIdRaw
      : int.tryParse(orderIdRaw?.toString() ?? '');

  if (link == 'attendance') {
    return const DeepLinkTarget(tabIndex: 4); // Settings: Time in / Time out
  }

  switch (type) {
    case 'VOID_DECISION':
    case 'GCASH_DECISION':
    case 'GCASH_CONFIRM':
      // The order sheet itself, straight from the History tab.
      return DeepLinkTarget(tabIndex: 3, orderId: orderId);
    case 'RESTOCK_UPDATE':
    case 'RESTOCK_REQUEST':
    case 'LOW_STOCK_NOTIFY':
      return const DeepLinkTarget(tabIndex: 2, openLiveStock: true);
    case 'TIMECLOCK_WINDOW':
    case 'SHIFT':
    case 'ABSENCE':
      return const DeepLinkTarget(tabIndex: 4); // Settings: attendance
    default:
      // SALE, OWNER_NOTICE, ALERT and anything the server adds later.
      return const DeepLinkTarget(tabIndex: 2, openNotifications: true);
  }
}
