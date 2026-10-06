import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_state.dart';
import '../services/rfid_registration.dart';
import '../utils/haptics.dart';
import '../utils/pin_setup.dart';
import '../widgets/app_dialog.dart';
import '../widgets/rfid_claim_dialog.dart';
import '../theme.dart';

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
  int _index = 2; // Default is Home (Gitna)

  final _receiptsKey = GlobalKey<ReceiptsScreenState>();

  final List<Map<String, dynamic>> _navItems = [
    {
      'label': 'POS',
      'icon': Icons.point_of_sale_outlined,
      'activeIcon': Icons.point_of_sale,
    },
    {
      'label': 'Receipts',
      'icon': Icons.receipt_long_outlined,
      'activeIcon': Icons.receipt_long,
    },
    {'label': 'Home', 'icon': Icons.home_outlined, 'activeIcon': Icons.home},
    {
      'label': 'History',
      'icon': Icons.history_outlined,
      'activeIcon': Icons.history,
    },
    {
      'label': 'Settings',
      'icon': Icons.settings_outlined,
      'activeIcon': Icons.settings,
    },
  ];

  @override
  void initState() {
    super.initState();
    // RFID first: clocking in and out needs a card, so it is the more useful of
    // the two prompts. They are separate callbacks rather than one chain so a
    // skipped PIN setup cannot suppress the card prompt (and vice versa).
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybePromptRfid());
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybePromptPin());
  }

  /// Post-login nudge for a staff member with no card on file. Skipping is
  /// silent by design: Settings > Session always offers it again.
  Future<void> _maybePromptRfid() async {
    if (!mounted) return;
    final auth = context.read<AuthState>();
    if (!await auth.needsRfidPrompt()) return;

    // Marked as offered before showing, not after: a skip must not nag on every
    // cold start.
    await auth.markRfidPromptShown();
    if (!mounted) return;

    final confirmed = await showAppConfirm(
      context,
      title: 'Tap your RFID card',
      message:
          'Register a staff card on the reader at this cart so you can clock in and out by tapping.',
      confirmLabel: 'Tap card',
    );

    if (!confirmed || !mounted) return;
    if (auth.token == null) return;

    final result = await RfidClaimDialog.show(
      context,
      token: auth.token!,
      registration: auth.rfidRegistration,
    );
    if (!mounted || result == null) return;

    // A success already folded the new UID into auth.user; the others report
    // why nothing was saved.
    final isSuccess = result is RfidBound;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            isSuccess
                ? RfidRegistrationService.describe(result)
                : '${RfidRegistrationService.describe(result)}'
                      '   You can retry in Settings.',
          ),
        ),
      );
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
          content: Text(
            ok
                ? 'Offline PIN ready.'
                : 'PIN not set   you can set it anytime in Settings.',
          ),
        ),
      );
  }

  Future<void> _openScan(BuildContext context) async {
    await Navigator.of(
      context,
      rootNavigator: true,
    ).push(MaterialPageRoute(builder: (_) => const ScanReceiptScreen()));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBody: true,
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: SafeArea(
        bottom: false,
        child: IndexedStack(
          index: _index,
          children: [
            const PosScreen(),
            ReceiptsScreen(key: _receiptsKey),
            HomeScreen(
              onScanReceipt: () async {
                await _openScan(context);
                _receiptsKey.currentState?.reload();
              },
              onGoPos: () => setState(() => _index = 0),
              onGoHistory: () => setState(() => _index = 3),
            ),
            HistoryScreen(onNewSale: () => setState(() => _index = 0)),
            const SettingsScreen(),
          ],
        ),
      ),
      bottomNavigationBar: Container(
        color: Colors.transparent,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space4,
              AppSpacing.space2,
              AppSpacing.space4,
              AppSpacing.space4,
            ),
            child: Container(
              height: 72,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(AppRadius.pill),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.1),
                    blurRadius: 24,
                    offset: const Offset(0, 8),
                  ),
                ],
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(AppRadius.pill),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
                  child: Container(
                    decoration: BoxDecoration(
                      color: Theme.of(
                        context,
                      ).colorScheme.surface.withValues(alpha: 0.25),
                      borderRadius: BorderRadius.circular(AppRadius.pill),
                      border: Border.all(
                        color: Colors.white.withValues(alpha: 0.4),
                        width: 1.2,
                      ),
                    ),
                    // MAGIC: Gumamit tayo ng LayoutBuilder para malaman ang lapad ng screen
                    child: LayoutBuilder(
                      builder: (context, constraints) {
                        final itemWidth =
                            constraints.maxWidth / _navItems.length;
                        const pillWidth = 56.0;

                        // Kino-compute kung saang eksaktong posisyon mag-i-slide ang pill
                        final leftPosition =
                            (_index * itemWidth) +
                            (itemWidth / 2) -
                            (pillWidth / 2);

                        return Stack(
                          children: [
                            // 1. ANG SLIDING PILL (Nasa ilalim ng icons)
                            AnimatedPositioned(
                              duration: const Duration(milliseconds: 350),
                              // Eto ang curve para sa stretchy/bouncy slide effect
                              curve: Curves.easeOutBack,
                              left: leftPosition,
                              top:
                                  (72 - 48) /
                                  2, // Centered vertically (72 bar height - 48 pill height)
                              child: Container(
                                width: pillWidth,
                                height: 48,
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(
                                    AppRadius.pill,
                                  ),
                                  gradient: const LinearGradient(
                                    begin: Alignment.topLeft,
                                    end: Alignment.bottomRight,
                                    colors: [
                                      AppColors.primarySoft,
                                      AppColors.primary,
                                    ],
                                  ),
                                  boxShadow: [
                                    BoxShadow(
                                      color: AppColors.primary.withValues(
                                        alpha: 0.4,
                                      ),
                                      blurRadius: 12,
                                      offset: const Offset(0, 4),
                                    ),
                                  ],
                                ),
                                // Fading icon animation habang nag-i-slide ang pill
                                child: AnimatedSwitcher(
                                  duration: const Duration(milliseconds: 200),
                                  child: Icon(
                                    _navItems[_index]['activeIcon'] as IconData,
                                    key: ValueKey('active_icon_$_index'),
                                    color: Colors.white,
                                    size: 26,
                                  ),
                                ),
                              ),
                            ),

                            // 2. MGA INACTIVE ICONS AT TAP AREAS (Nasa ibabaw)
                            Row(
                              children: List.generate(_navItems.length, (i) {
                                final isSelected = _index == i;
                                final item = _navItems[i];

                                return Expanded(
                                  child: GestureDetector(
                                    onTap: () {
                                      Haptics.tap();
                                      setState(() => _index = i);
                                    },
                                    behavior: HitTestBehavior.opaque,
                                    child: SizedBox(
                                      height: 72,
                                      // I-fade out ang inactive icon kapag tumapat na sa kanya ang pill
                                      child: AnimatedOpacity(
                                        duration: const Duration(
                                          milliseconds: 200,
                                        ),
                                        opacity: isSelected ? 0.0 : 1.0,
                                        child: Column(
                                          mainAxisAlignment:
                                              MainAxisAlignment.center,
                                          children: [
                                            Icon(
                                              item['icon'] as IconData,
                                              color: AppColors.muted,
                                              size: 24,
                                            ),
                                            const SizedBox(height: 4),
                                            Text(
                                              item['label'] as String,
                                              style: const TextStyle(
                                                color: AppColors.muted,
                                                fontSize: 10,
                                                fontWeight: FontWeight.w600,
                                              ),
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  ),
                                );
                              }),
                            ),
                          ],
                        );
                      },
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
