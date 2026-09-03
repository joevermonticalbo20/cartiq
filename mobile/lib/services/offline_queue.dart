import 'dart:async';

/// A record waiting to be uploaded to the API.
class QueuedRecord {
  final String id;
  final String kind; // 'order' | 'shift' | 'reading'
  final Map<String, dynamic> payload;
  final DateTime createdAt;

  QueuedRecord({
    required this.id,
    required this.kind,
    required this.payload,
    DateTime? createdAt,
  }) : createdAt = createdAt ?? DateTime.now();

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind,
        'payload': payload,
        'createdAt': createdAt.toIso8601String(),
      };
}

/// Contract for the offline-first queue. Phase 1 swaps the in-memory
/// implementation for a sqflite-backed one with identical semantics:
/// records survive app restarts and drain in FIFO order on sync.
abstract class OfflineQueue {
  Stream<int> get changes => const Stream<int>.empty();

  Future<void> enqueue(QueuedRecord record);
  Future<List<QueuedRecord>> pending();
  Future<void> remove(String id);
  Future<int> get count;
}

class InMemoryOfflineQueue implements OfflineQueue {
  final Map<String, QueuedRecord> _items = {};
  final _controller = StreamController<int>.broadcast();

  InMemoryOfflineQueue._();
  static final InMemoryOfflineQueue instance = InMemoryOfflineQueue._();

  @override
  Stream<int> get changes => _controller.stream;

  void _notify() => _controller.add(_items.length);

  @override
  Future<void> enqueue(QueuedRecord record) async {
    _items[record.id] = record;
    _notify();
  }

  @override
  Future<List<QueuedRecord>> pending() async =>
      _items.values.toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt));

  @override
  Future<void> remove(String id) async {
    _items.remove(id);
    _notify();
  }

  @override
  Future<int> get count async => _items.length;
}
