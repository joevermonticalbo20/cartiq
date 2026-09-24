import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../utils/haptics.dart';
import '../utils/pin_setup.dart';
import '../widgets/app_dialog.dart';
import 'home_screen.dart';
import 'history_screen.dart';
import 'pos_screen.dart';
import 'receipts_screen.dart';
import 'scan_receipt_screen.dart';
import 'settings_screen.dart';

class RootShell extends StatefulWidget {
  const RootShell({super.key});

  @override
  State<RootShell> createState() => _RootShellState();
}

class _RootShellState extends State<RootShell> {
  int _index = 0;
  // Key into the receipts tab: after a scan flow pops, reload it so a
  // newly saved expense is visible without a manual pull-to-refresh.
  final _receiptsKey = GlobalKey<ReceiptsScreenState>();

  @override
  void initState() {
    super.initState();
    // One-time offline-PIN nudge after the first online staff login.
    // Skipping never nags again (Settings > Offline PIN stays available).
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybePromptPin());
  }

  Future<void> _maybePromptPin() async {
    if (!mounted) return;
    final auth = context.read<AuthState>();
    if (!await auth.needsPinSetupPrompt()) return;
    await auth.markPinPromptShown();
    if (!mounted) return;
    final confirmed = await showAppConfirm(
      context,
      title: 'Open without internet?',
      message:
          'Set a 6-digit device PIN so you can open the POS even with no signal. Sales stay queued and sync later.',
      confirmLabel: 'Set up PIN',
    );
    if (!confirmed || !mounted) return;
    final ok = await showPinSetupFlow(context, auth);
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(ok
              ? 'Offline PIN ready.'
              : 'PIN not set — you can set it anytime in Settings.'),
        ),
      );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: IndexedStack(
          index: _index,
          children: [
            HomeScreen(
              onScanReceipt: () async {
                await _openScan(context);
                _receiptsKey.currentState?.reload();
              },
              onGoPos: () => setState(() => _index = 1),
              onGoHistory: () => setState(() => _index = 3),
            ),
            const PosScreen(),
            ReceiptsScreen(key: _receiptsKey),
            HistoryScreen(
              onNewSale: () => setState(() => _index = 1),
            ),
            const SettingsScreen(),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) {
          Haptics.tap();
          setState(() => _index = i);
        },
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.home_outlined),
              selectedIcon: Icon(Icons.home),
              label: 'Home'),
          NavigationDestination(
              icon: Icon(Icons.point_of_sale_outlined),
              selectedIcon: Icon(Icons.point_of_sale),
              label: 'POS'),
          NavigationDestination(
              icon: Icon(Icons.receipt_long_outlined),
              selectedIcon: Icon(Icons.receipt_long),
              label: 'Receipts'),
          NavigationDestination(
              icon: Icon(Icons.history_outlined),
              selectedIcon: Icon(Icons.history),
              label: 'History'),
          NavigationDestination(
              icon: Icon(Icons.settings_outlined),
              selectedIcon: Icon(Icons.settings),
              label: 'Settings'),
        ],
      ),
    );
  }
}

Future<void> _openScan(BuildContext context) async {
  await Navigator.of(context, rootNavigator: true).push(
    MaterialPageRoute(builder: (_) => const ScanReceiptScreen()),
  );
}
