import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Minimal key-value store surface for persisted app state.
/// FlutterSecureStorage implements this; tests inject an in-memory fake.
abstract class KeyValueStore {
  Future<String?> read({required String key});
  Future<void> write({required String key, required String? value});
  Future<void> delete({required String key});
}

class SecureStoreAdapter implements KeyValueStore {
  const SecureStoreAdapter(this._inner);
  final FlutterSecureStorage _inner;

  @override
  Future<String?> read({required String key}) => _inner.read(key: key);

  @override
  Future<void> write({required String key, required String? value}) =>
      _inner.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => _inner.delete(key: key);
}
