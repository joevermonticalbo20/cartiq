import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// Disk cache for receipt photos keyed by order/expense id.
///
/// Receipt images are fetched with the session token, so a signed-out or
/// offline device could never open a previously viewed photo again. Whenever
/// a photo is fetched it is copied here; the offline path serves the copy.
/// Files live in the app's private databases directory (the same place the
/// offline queue keeps its SQLite file), so no new permissions or packages
/// are needed.
class ReceiptFileCache {
  static Future<String?> _dir() async {
    try {
      if (Platform.isWindows || Platform.isLinux) {
        sqfliteFfiInit();
      }
      final dir = await getDatabasesPath();
      return dir;
    } catch (_) {
      return null;
    }
  }

  static Future<bool> save(String id, List<int> bytes) async {
    final dir = await _dir();
    if (dir == null) return false;
    try {
      final file = File(p.join(dir, 'cartiq_receipt_$id.jpg'));
      await file.writeAsBytes(bytes, flush: true);
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<List<int>?> load(String id) async {
    final dir = await _dir();
    if (dir == null) return null;
    try {
      final file = File(p.join(dir, 'cartiq_receipt_$id.jpg'));
      if (!await file.exists()) return null;
      return await file.readAsBytes();
    } catch (_) {
      return null;
    }
  }
}
