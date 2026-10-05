import 'dart:convert';
import 'dart:io';
import 'dart:async';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'offline_queue.dart';

/// SQLite-backed queue: records survive app restarts and drain FIFO on sync.
/// Works on Android (sqflite) and Windows/Linux (sqflite_common_ffi).
class PersistedOfflineQueue implements OfflineQueue {
  Database? _db;
  final _controller = StreamController<int>.broadcast();

  /// Set when SQLite could not be opened. The queue then keeps records in
  /// memory so the POS can still take and sync sales for this session - they
  /// just will not survive a restart. Losing the ability to ring up an order
  /// because a cache file is corrupt is far worse than losing history.
  final List<QueuedRecord> _memory = [];
  String? _degradedReason;

  /// True when the SQLite file could not be opened and records are being held
  /// in memory instead. The UI surfaces this so the operator knows unsynced
  /// sales are at risk.
  bool get isDegraded => _db == null;
  String? get degradedReason => _degradedReason;

  PersistedOfflineQueue._();
  static final PersistedOfflineQueue instance = PersistedOfflineQueue._();

  /// Isolated instance for tests, which must not touch the app-wide singleton.
  @visibleForTesting
  factory PersistedOfflineQueue.forTesting() => PersistedOfflineQueue._();

  /// Force the degraded (no SQLite) branch so its behaviour is testable
  /// without a real database failure.
  @visibleForTesting
  void debugForceDegraded([String reason = 'test']) {
    _db = null;
    _degradedReason = reason;
  }

  @override
  Stream<int> get changes => _controller.stream;

  Future<void> open() async {
    if (_db != null) return;
    try {
      if (Platform.isWindows || Platform.isLinux) {
        sqfliteFfiInit();
        databaseFactory = databaseFactoryFfi;
      }
      final dir = await getDatabasesPath();
      _db = await databaseFactory.openDatabase(
        p.join(dir, 'cartiq_queue.db'),
        options: OpenDatabaseOptions(
          version: 1,
          onCreate: (db, version) => db.execute('''
            CREATE TABLE records(
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              payload TEXT NOT NULL,
              createdAt INTEGER NOT NULL
            )
          '''),
        ),
      );
    } catch (e) {
      // Never rethrow: main() awaits this before runApp(), and an exception
      // here means nothing is ever rendered - a blank white window in release,
      // with no way for the operator to recover.
      _degradedReason = '$e';
      _db = null;
    }
    _controller.add(await count);
  }

  @override
  Future<void> enqueue(QueuedRecord record) async {
    final db = _db;
    if (db == null) {
      _memory.removeWhere((r) => r.id == record.id);
      _memory.add(record);
      _controller.add(await count);
      return;
    }
    await db.insert('records', {
      'id': record.id,
      'kind': record.kind,
      'payload': jsonEncode(record.payload),
      'createdAt': record.createdAt.millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    _controller.add(await count);
  }

  @override
  Future<List<QueuedRecord>> pending() async {
    final db = _db;
    if (db == null) {
      final copy = [..._memory]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
      return copy;
    }
    final rows = await db.query('records', orderBy: 'createdAt ASC');
    return rows.map((row) {
      return QueuedRecord(
        id: row['id'] as String,
        kind: row['kind'] as String,
        payload: jsonDecode(row['payload'] as String) as Map<String, dynamic>,
        createdAt: DateTime.fromMillisecondsSinceEpoch(row['createdAt'] as int),
      );
    }).toList();
  }

  @override
  Future<void> remove(String id) async {
    final db = _db;
    if (db == null) {
      _memory.removeWhere((r) => r.id == id);
      _controller.add(await count);
      return;
    }
    await db.delete('records', where: 'id = ?', whereArgs: [id]);
    _controller.add(await count);
  }

  @override
  Future<int> get count async {
    final db = _db;
    if (db == null) return _memory.length;
    final result = await db.rawQuery('SELECT COUNT(*) AS c FROM records');
    return result.first['c'] as int? ?? 0;
  }
}
