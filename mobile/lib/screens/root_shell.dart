import 'package:flutter/material.dart';

import 'home_screen.dart';
import 'history_screen.dart';
import 'pos_screen.dart';
import 'receipts_screen.dart';
import 'scan_receipt_screen.dart';

class RootShell extends StatefulWidget {
  const RootShell({super.key});

  @override
  State<RootShell> createState() => _RootShellState();
}

class _RootShellState extends State<RootShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: IndexedStack(
          index: _index,
          children: [
            HomeScreen(
              onScanReceipt: () => _openScan(context),
              onGoPos: () => setState(() => _index = 1),
            ),
            const PosScreen(),
            const ReceiptsScreen(),
            HistoryScreen(
              onNewSale: () => setState(() => _index = 1),
            ),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
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
