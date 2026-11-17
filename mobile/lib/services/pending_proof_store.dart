import 'kv_store.dart';

/// GCash proof photos the vendor already captured but has not attached to a
/// sale (or a receipt replacement) yet.
///
/// The payment sheet closes when the vendor looks away — and the photo must
/// still be there when it opens again. The store keeps ONLY the file path,
/// keyed by scope (the shared cart, or one specific order), and is cleared
/// once the sale is recorded or the receipt is uploaded.
class PendingProofStore {
  PendingProofStore(this._store);

  /// The GCash proof attached to the current (unpaid) cart.
  static const cartKey = 'cartiq_pending_proof_cart';

  /// The replacement receipt photo for one order (pending decision).
  static String orderKey(int orderId) => 'cartiq_pending_proof_order_$orderId';

  final KeyValueStore _store;

  Future<void> write({required String key, required String path}) =>
      _store.write(key: key, value: path);

  Future<String?> read({required String key}) => _store.read(key: key);

  Future<void> delete({required String key}) async {
    try {
      await _store.delete(key: key);
    } catch (_) {
      /* a missing entry is already where we want it to be */
    }
  }
}
