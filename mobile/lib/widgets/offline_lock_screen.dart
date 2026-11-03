import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/offline_pin.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import 'brand_hero.dart';
import 'pin_pad.dart';

/// Cold-start lock for an unverified session on a device with an offline
/// PIN. The app could not confirm the token online, so the PIN proves the
/// phone belongs to the staff member before the POS opens — sales queue
/// locally and sync when the connection returns.
class OfflineLockScreen extends StatefulWidget {
  const OfflineLockScreen({super.key, required this.onUsePassword});

  /// Escape hatch: show the full login screen instead. The cached session
  /// is kept until an actual online sign-in replaces it.
  final VoidCallback onUsePassword;

  @override
  State<OfflineLockScreen> createState() => _OfflineLockScreenState();
}

class _OfflineLockScreenState extends State<OfflineLockScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _unlock(String code) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final auth = context.read<AuthState>();
    try {
      await auth.unlockOffline(code);
      await Haptics.success();
      // CartIQApp rebuilds: offlineMode is set, so the shell opens.
    } on PinException catch (e) {
      await Haptics.error();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.lockedUntil != null
            ? '${e.message} (until '
                  '${e.lockedUntil!.hour.toString().padLeft(2, "0")}:'
                  '${e.lockedUntil!.minute.toString().padLeft(2, "0")})'
            : e.message;
      });
    } catch (e) {
      await Haptics.error();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Could not unlock: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final name = auth.displayName;
    final cart = auth.locationCode;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.space6),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const BrandHero(compact: true),
                  const SizedBox(height: AppSpacing.space4),
                  Text(
                    'Welcome back, $name',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.space1),
                  Text(
                    cart == null
                        ? 'No internet right now. Enter your device PIN to '
                              'open the POS offline.'
                        : 'No internet right now. Enter your device PIN to '
                              'open $cart offline.',
                    style: Theme.of(context).textTheme.bodySmall,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.space4),
                  PinPad(
                    title: 'Device PIN',
                    errorText: _error,
                    onComplete: _unlock,
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextButton(
                    onPressed: _busy ? null : widget.onUsePassword,
                    child: const Text('Sign in with password instead'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
