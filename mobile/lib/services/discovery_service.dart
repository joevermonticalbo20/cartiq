import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

class DiscoveryService {
  static const int _apiPort = 4000;
  static const Duration _scanTimeout = Duration(milliseconds: 500);
  static const int _concurrency = 30;

  final Map<String, String> _ssidCache = {};
  String? _lastFoundUrl;
  String? _lastSsid;

  static final DiscoveryService _instance = DiscoveryService._internal();
  factory DiscoveryService() => _instance;
  DiscoveryService._internal();

  /// Get the device's WiFi IP address.
  Future<String?> getWifiIp() async {
    try {
      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLoopback: false,
      );
      for (final interface in interfaces) {
        for (final addr in interface.addresses) {
          final ip = addr.address;
          if (_isPrivateIp(ip)) {
            return ip;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  /// Derive the subnet from an IP (e.g., "192.168.1" from "192.168.1.42").
  String _subnet(String ip) {
    final parts = ip.split('.');
    return '${parts[0]}.${parts[1]}.${parts[2]}';
  }

  bool _isPrivateIp(String ip) {
    return ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') ||
        ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') ||
        ip.startsWith('172.19.') ||
        ip.startsWith('172.2') ||
        ip.startsWith('172.30.') ||
        ip.startsWith('172.31.');
  }

  /// Scan the local subnet for a CartIQ API server on port 4000.
  /// Returns the first found URL (e.g., "http://192.168.1.5:4000/api") or null.
  Future<String?> scanSubnet(String subnet) async {
    final futures = <Future<String?>>[];

    for (int i = 1; i <= 254; i++) {
      final ip = '$subnet.$i';
      futures.add(_checkHost(ip));
      if (futures.length >= _concurrency) {
        final results = await Future.wait(futures);
        final found = results.firstWhere((url) => url != null, orElse: () => null);
        if (found != null) return found;
        futures.clear();
      }
    }

    if (futures.isNotEmpty) {
      final results = await Future.wait(futures);
      return results.firstWhere((url) => url != null, orElse: () => null);
    }

    return null;
  }

  Future<String?> _checkHost(String ip) async {
    try {
      final socket = await Socket.connect(
        ip,
        _apiPort,
        timeout: _scanTimeout,
      );
      socket.destroy();
      return 'http://$ip:4000/api';
    } catch (_) {
      return null;
    }
  }

  /// Attempt to auto-discover the API server.
  /// Strategy:
  /// 1. Check if we're on a known SSID → use cached IP
  /// 2. Scan the subnet for port 4000
  /// 3. Fall back to the provided default URL
  Future<String> discoverApiUrl(String defaultUrl) async {
    final wifiIp = await getWifiIp();
    if (wifiIp == null) {
      debugPrint('[discovery] no wifi IP, fallback $defaultUrl');
      return defaultUrl;
    }

    final subnet = _subnet(wifiIp);
    final ssid = await _getCurrentSsid();

    // Step 1: Check cache (SSID → IP mapping)
    if (ssid != null && _ssidCache.containsKey(ssid)) {
      final cached = _ssidCache[ssid]!;
      if (await _isReachable(cached)) {
        _lastFoundUrl = cached;
        _lastSsid = ssid;
        return cached;
      }
      _ssidCache.remove(ssid);
    }

    // Step 2: Scan subnet
    debugPrint('[discovery] scanning $subnet.1-254 for :$_apiPort…');
    final found = await scanSubnet(subnet);
    if (found != null) {
      if (ssid != null) {
        _ssidCache[ssid] = found;
      }
      _lastFoundUrl = found;
      _lastSsid = ssid;
      debugPrint('[discovery] found API at $found');
      return found;
    }
    debugPrint('[discovery] nothing on $subnet, fallback $defaultUrl');

    // Step 3: Fall back
    return defaultUrl;
  }

  Future<bool> _isReachable(String url) async {
    try {
      final uri = Uri.parse('$url/health');
      final client = HttpClient();
      final request = await client.getUrl(uri).timeout(Duration(seconds: 2));
      final response = await request.close().timeout(Duration(seconds: 2));
      client.close();
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  Future<String?> _getCurrentSsid() async {
    // Note: Getting SSID on Android requires location permission and is not
    // always reliable. We'll use a simplified approach without SSID detection.
    return null;
  }

  String? get lastFoundUrl => _lastFoundUrl;
  String? get lastSsid => _lastSsid;

  /// Clear the SSID cache (useful for debugging).
  void clearCache() {
    _ssidCache.clear();
  }
}
