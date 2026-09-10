import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

class DiscoveryService {
  static const int _apiPort = 4000;
  static const Duration _scanTimeout = Duration(milliseconds: 500);
  static const int _concurrency = 30;

  static final DiscoveryService _instance = DiscoveryService._internal();
  factory DiscoveryService() => _instance;
  DiscoveryService._internal();

  /// Interface names that never carry LAN traffic to the API host:
  /// mobile data, VPN tunnels, virtual adapters.
  static final _nonLanIface = RegExp(
    r'rmnet|wwan|pdp_ip|ccmni|tun|tap|ppp|clat|vpn|ipsec',
    caseSensitive: false,
  );

  /// Get the device's LAN IP address. Returns null on mobile data, VPN-only,
  /// or airplane mode so callers fall back instead of scanning the wrong net.
  Future<String?> getWifiIp() async {
    try {
      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLoopback: false,
      );
      for (final interface in interfaces) {
        if (_nonLanIface.hasMatch(interface.name)) continue;
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
    if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
    // 172.16.0.0/12 (note: a plain startsWith('172.2') would also match
    // public 172.200.x.x, so parse the second octet properly).
    final parts = ip.split('.');
    if (parts.length < 2 || parts[0] != '172') return false;
    final second = int.tryParse(parts[1]);
    return second != null && second >= 16 && second <= 31;
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
    } catch (_) {
      return null;
    }
    // Port is open — verify it is actually a CartIQ API via /health
    // identity check to avoid false positives on any :4000 listener.
    try {
      final uri = Uri.parse('http://$ip:4000/api/health');
      final client = HttpClient()..connectionTimeout = const Duration(milliseconds: 1000);
      final request = await client.getUrl(uri).timeout(const Duration(milliseconds: 1500));
      final response = await request.close().timeout(const Duration(milliseconds: 1500));
      final body = await response.transform(utf8.decoder).join().timeout(
        const Duration(milliseconds: 1500),
        onTimeout: () => '',
      );
      client.close();
      if (response.statusCode == 200 && body.contains('cartiq-api')) {
        return 'http://$ip:4000/api';
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Attempt to auto-discover the API server.
  /// Strategy:
  /// 1. Read the LAN IP (null on mobile data / VPN-only / airplane mode)
  /// 2. Scan the subnet for port 4000
  /// 3. Fall back to the provided default URL
  Future<String> discoverApiUrl(String defaultUrl) async {
    final wifiIp = await getWifiIp();
    if (wifiIp == null) {
      debugPrint('[discovery] no LAN IP (mobile data/VPN/offline?), fallback $defaultUrl');
      return defaultUrl;
    }

    final subnet = _subnet(wifiIp);

    // Scan subnet
    debugPrint('[discovery] scanning $subnet.1-254 for :$_apiPort…');
    final found = await scanSubnet(subnet);
    if (found != null) {
      debugPrint('[discovery] found API at $found');
      return found;
    }
    debugPrint('[discovery] nothing on $subnet, fallback $defaultUrl');

    // Fall back
    return defaultUrl;
  }
}
