import 'dart:convert';
import 'dart:io';
import 'dart:async';

import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'offline_queue.dart';

/// SQLite-backed queue: records survive app restarts and drain FIFO on sync.
/// Works on Android (sqflite) and Windows/Linux (sqflite_common_ffi).
class PersistedOfflineQueue implements OfflineQueue {
  Database? _db;
  final _controller = StreamController<int>.broadcast();

  PersistedOfflineQueue._();
  static final PersistedOfflineQueue instance = PersistedOfflineQueue._();

  @override
  Stream<int> get changes => _controller.stream;

  Future<void> open() async {
    if (_db != null) return;
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
    _controller.add(await count);
  }

  @override
  Future<void> enqueue(QueuedRecord record) async {
    final db = _db;
    if (db == null) throw StateError('PersistedOfflineQueue.open() must be called first');
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
    if (db == null) return const [];
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
    if (db == null) return;
    await db.delete('records', where: 'id = ?', whereArgs: [id]);
    _controller.add(await count);
  }

  @override
  Future<int> get count async {
    final db = _db;
    if (db == null) return 0;
    final result = await db.rawQuery('SELECT COUNT(*) AS c FROM records');
    return result.first['c'] as int? ?? 0;
  }
}
