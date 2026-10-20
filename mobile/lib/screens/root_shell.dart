import 'dart:async';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/persisted_queue.dart';
import '../services/rfid_registration.dart';
import '../services/sync_service.dart';
import '../state/cart_state.dart';
import '../utils/app_messenger.dart';
import '../utils/haptics.dart';
import '../utils/pin_setup.dart';
import '../widgets/app_dialog.dart';
import '../widgets/rfid_claim_dialog.dart';
import '../theme.dart';

import 'home_screen.dart';
import 'history_screen.dart';
import 'pos_screen.dart';
import 'live_stock_screen.dart';
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
  final _queue = PersistedOfflineQueue.instance;
  late final SyncService _sync;
  late final StreamSubscription<int> _queueSubscription;
  int _queuedOrders = 0;
  bool _syncListenerAdded = false;
  SyncResult? _handledSyncResult;

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
    {
      'label': 'Live Stock',
      'icon': Icons.inventory_2_outlined,
      'activeIcon': Icons.inventory_2,
    },
  ];

  @override
  void initState() {
    super.initState();
    _queueSubscription = _queue.changes.listen((count) {
      if (mounted) setState(() => _queuedOrders = count);
    });
    _readQueueCount();
    // RFID first: clocking in and out needs a card, so it is the more useful of
    // the two prompts. They are separate callbacks rather than one chain so a
    // skipped PIN setup cannot suppress the card prompt (and vice versa).
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybePromptRfid());
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybePromptPin());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_syncListenerAdded) return;
    _sync = context.read<SyncService>();
    _sync.addListener(_onSyncChanged);
    _syncListenerAdded = true;
  }

  @override
  void dispose() {
    _queueSubscription.cancel();
    if (_syncListenerAdded) _sync.removeListener(_onSyncChanged);
    super.dispose();
  }

  Future<void> _readQueueCount() async {
    final count = await _queue.count;
    if (mounted) setState(() => _queuedOrders = count);
  }

  void _onSyncChanged() {
    if (!mounted) return;
    setState(() {});
    final result = _sync.lastResult;
    if (result == null || identical(result, _handledSyncResult)) return;
    _handledSyncResult = result;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      for (final dropped in result.dropped) {
        if (dropped.code == 'INSUFFICIENT_STOCK' && dropped.payload != null) {
          context.read<CartState>().restoreRejectedOrder(dropped.payload!);
        }
      }
      if (result.authExpired) {
        AppMessenger.showErrorSnackBar(
          context: context,
          error: const ApiException(
            AuthState.sessionExpiredMessage,
            statusCode: 401,
          ),
        );
      } else if (result.dropped.any(
        (record) => record.code == 'INSUFFICIENT_STOCK',
      )) {
        final record = result.dropped.firstWhere(
          (entry) => entry.code == 'INSUFFICIENT_STOCK',
        );
        AppMessenger.showRecoverySnackBar(
          context: context,
          message: record.reason,
          actionLabel: 'Review cart',
          onAction: () => setState(() => _index = 0),
        );
      }
    });
  }

  Future<void> _retrySync() async {
    await Haptics.tap();
    try {
      final result = await _sync.syncAll();
      if (!mounted || result.fullySynced || result.dropped.isNotEmpty) return;
      if (!result.online || result.errorMessage != null) {
        AppMessenger.showErrorSnackBar(
          context: context,
          error: ApiException(
            result.errorMessage ?? ApiClient.noInternetMessage,
            statusCode: result.authExpired ? 401 : null,
          ),
          onRetry: _retrySync,
        );
      }
    } catch (error) {
      if (!mounted) return;
      AppMessenger.showErrorSnackBar(
        context: context,
        error: error,
        onRetry: _retrySync,
      );
    }
  }

  Widget _offlineSyncBanner() {
    final auth = context.watch<AuthState>();
    final isOffline = auth.offlineMode || _sync.lastResult?.online == false;
    final isVisible =
        _queuedOrders > 0 || auth.offlineMode || _sync.lastResult?.online == false;
    if (!isVisible) return const SizedBox.shrink();

    final status = _sync.isSyncing
        ? 'Syncing queued orders'
        : isOffline
        ? 'Offline Mode'
        : 'Orders queued for sync';
    final details = _queuedOrders == 1
        ? '1 order queued for sync'
        : '$_queuedOrders orders queued for sync';
    return Material(
      color: isOffline
          ? AppColors.warn.withValues(alpha: 0.14)
          : AppColors.primary.withValues(alpha: 0.1),
      child: InkWell(
        onTap: _sync.isSyncing ? null : _retrySync,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.space4,
            vertical: AppSpacing.space2,
          ),
          child: Row(
            children: [
              Icon(
                isOffline ? Icons.cloud_off_rounded : Icons.sync_rounded,
                size: 18,
                color: isOffline ? AppColors.warn : AppColors.primary,
              ),
              const SizedBox(width: AppSpacing.space2),
              Expanded(
                child: Text(
                  '$status • $details${_sync.isSyncing ? '…' : ' — Tap to retry'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
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
        child: Column(
          children: [
            _offlineSyncBanner(),
            Expanded(
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
                  const LiveStockScreen(),
                ],
              ),
            ),
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
                        final pillWidth =
                            (itemWidth - 4).clamp(44.0, 56.0).toDouble();

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
