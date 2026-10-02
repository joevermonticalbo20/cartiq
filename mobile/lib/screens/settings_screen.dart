import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/offline_pin.dart';
import '../services/sync_service.dart';
import '../config.dart';
import '../state/theme_controller.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../utils/manila_time.dart';
import '../utils/pin_setup.dart';
import '../widgets/pin_pad.dart';
import '../widgets/app_badge.dart';
import '../widgets/app_dialog.dart';
import '../widgets/section_header.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => SettingsScreenState();
}

class SettingsScreenState extends State<SettingsScreen> {
  bool? _hasPin;
  DateTime? _lastOnline;
  PinEligibility? _eligibility;

  @override
  void initState() {
    super.initState();
    _loadAuthData();
  }

  Future<void> _loadAuthData() async {
    final auth = context.read<AuthState>();
    final hasPin = await auth.pin.hasPin;
    final lastOnline = await auth.lastOnline;
    final eligibility = await auth.checkOfflineEligibility();

    if (mounted) {
      setState(() {
        _hasPin = hasPin;
        _lastOnline = lastOnline;
        _eligibility = eligibility;
      });
    }
  }

  Future<void> reload() async {
    await _loadAuthData();
  }

  Future<String?> _askPin({required String title, String? errorText}) async {
    String? result;
    String? error = errorText;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (context, setSheetState) => SafeArea(
          child: Padding(
            padding: EdgeInsets.only(
              left: AppSpacing.space5,
              right: AppSpacing.space5,
              top: AppSpacing.space4,
              bottom:
                  MediaQuery.of(context).viewInsets.bottom + AppSpacing.space6,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    margin: const EdgeInsets.symmetric(
                      vertical: AppSpacing.space2,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.3),
                      borderRadius: BorderRadius.circular(AppRadius.xs),
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.space2),
                PinPad(
                  title: title,
                  errorText: error,
                  onComplete: (pin) {
                    result = pin;
                    Navigator.pop(sheetContext);
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return result;
  }

  Future<void> _setupPinFlow(AuthState auth) async {
    final ok = await showPinSetupFlow(context, auth);
    if (!mounted) return;
    if (ok) {
      await reload();
      final username = auth.user?['username'];
      _showSnack('Offline PIN set for $username', success: true);
    }
  }

  Future<void> _changePinFlow(AuthState auth) async {
    final username = auth.user?['username'] as String?;
    if (username == null) return;
    final oldPin = await _askPin(title: 'Enter current PIN');
    if (oldPin == null || !mounted) return;
    final next = await _askPin(title: 'Choose a new 6-digit PIN');
    if (next == null || !mounted) return;
    try {
      await auth.pin.changePin(
        username: username,
        oldPin: oldPin,
        newPin: next,
      );
      await Haptics.success();
      if (!mounted) return;
      await reload();
      _showSnack('Offline PIN changed', success: true);
    } on PinException catch (e) {
      if (!mounted) return;
      _showSnack(e.message, error: true);
    }
  }

  Future<void> _disablePinFlow(AuthState auth) async {
    if (!await auth.api.health()) {
      if (!mounted) return;
      _showSnack('Connect to the internet to disable the PIN.', error: true);
      return;
    }
    if (!mounted) return;
    final confirmed = await showAppConfirm(
      context,
      title: 'Disable offline PIN?',
      message:
          'This device will no longer open without internet. You can set a new PIN anytime.',
      confirmLabel: 'Disable',
      danger: true,
    );
    if (!confirmed || !mounted) return;
    await auth.pin.clear();
    await Haptics.success();
    await reload();
    _showSnack('Offline PIN disabled', success: true);
  }

  Future<void> _changePasswordFlow(AuthState auth) async {
    final current = TextEditingController();
    final next = TextEditingController();
    final confirm = TextEditingController();
    var obscure = true;
    String? error;
    var pending = false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Change password'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: current,
                obscureText: obscure,
                decoration: const InputDecoration(
                  labelText: 'Current password',
                ),
              ),
              const SizedBox(height: AppSpacing.space3),
              TextField(
                controller: next,
                obscureText: obscure,
                decoration: const InputDecoration(labelText: 'New password'),
              ),
              const SizedBox(height: AppSpacing.space3),
              TextField(
                controller: confirm,
                obscureText: obscure,
                decoration: const InputDecoration(
                  labelText: 'Confirm new password',
                ),
                onSubmitted: (_) => Navigator.pop(dialogContext, true),
              ),
              if (error != null) ...[
                const SizedBox(height: AppSpacing.space2),
                Text(
                  error!,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: AppColors.danger),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => setDialogState(() => obscure = !obscure),
              child: Text(obscure ? 'Show' : 'Hide'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: pending
                  ? null
                  : () async {
                      if (next.text != confirm.text) {
                        setDialogState(
                          () => error = 'New passwords do not match.',
                        );
                        return;
                      }
                      setDialogState(() {
                        pending = true;
                        error = null;
                      });
                      try {
                        final token = auth.token;
                        if (token == null) throw ApiException('Signed out');
                        await auth.api.changePassword(
                          token,
                          currentPassword: current.text,
                          newPassword: next.text,
                        );
                        if (dialogContext.mounted) {
                          Navigator.pop(dialogContext, true);
                        }
                      } on ApiException catch (e) {
                        setDialogState(() {
                          pending = false;
                          error = e.message;
                        });
                      }
                    },
              child: Text(pending ? 'Saving...' : 'Save'),
            ),
          ],
        ),
      ),
    );
    current.dispose();
    next.dispose();
    confirm.dispose();
    if (ok == true && mounted) {
      await auth.signOut();
      _showSnack('Password changed. Please sign in again.', success: true);
    }
  }

  Future<void> _signOutFlow(AuthState auth, SyncService sync) async {
    int queued = 0;
    try {
      queued = await sync.queue.count;
    } catch (_) {}
    if (!mounted) return;
    final confirmed = await showAppConfirm(
      context,
      title: 'Log out?',
      message: queued > 0
          ? '$queued sale(s) still queued - they stay saved on this device.'
          : 'No queued sales. You can sign back in anytime.',
      confirmLabel: 'Log out',
    );
    if (!confirmed || !mounted) return;
    sync.cancelActiveSync();
    await auth.signOut();
    await Haptics.success();
  }

  void _showSnack(String message, {bool error = false, bool success = false}) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: error
            ? AppColors.danger
            : success
            ? AppColors.ok
            : null,
        content: Text(message, style: const TextStyle(color: Colors.white)),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Consumer2<AuthState, ThemeController>(
      builder: (context, auth, theme, _) => ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space4,
          AppSpacing.space4,
          AppSpacing.space4,
          120,
        ),
        children: [
          const SectionHeader(title: 'Account', eyebrow: 'Signed in as'),
          const SizedBox(height: AppSpacing.space3),
          _AccountCard(auth: auth, lastOnline: _lastOnline),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(
            title: 'Offline PIN',
            eyebrow: 'No-internet login',
          ),
          const SizedBox(height: AppSpacing.space3),
          _PinSection(
            auth: auth,
            hasPin: _hasPin,
            onSetup: () => _setupPinFlow(auth),
            onChange: () => _changePinFlow(auth),
            onDisable: () => _disablePinFlow(auth),
          ),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'Appearance', eyebrow: 'Theme'),
          const SizedBox(height: AppSpacing.space3),

          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.space4,
              vertical: AppSpacing.space2,
            ),
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.pill),
              boxShadow: AppShadow.sm(),
            ),
            child: Row(
              children: [
                Expanded(
                  child: _ThemeButton(
                    currentMode: theme.mode,
                    targetMode: ThemeMode.light,
                    icon: Icons.light_mode_outlined,
                    label: 'Light',
                    onTap: () {
                      Haptics.select();
                      theme.setMode(ThemeMode.light);
                    },
                  ),
                ),
                const SizedBox(width: AppSpacing.space2),
                Expanded(
                  child: _ThemeButton(
                    currentMode: theme.mode,
                    targetMode: ThemeMode.dark,
                    icon: Icons.dark_mode_outlined,
                    label: 'Dark',
                    onTap: () {
                      Haptics.select();
                      theme.setMode(ThemeMode.dark);
                    },
                  ),
                ),
                const SizedBox(width: AppSpacing.space2),
                Expanded(
                  child: _ThemeButton(
                    currentMode: theme.mode,
                    targetMode: ThemeMode.system,
                    icon: Icons.settings_suggest_outlined,
                    label: 'Auto',
                    onTap: () {
                      Haptics.select();
                      theme.setMode(ThemeMode.system);
                    },
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'Server', eyebrow: 'Backend connection'),
          const SizedBox(height: AppSpacing.space3),
          _ServerSection(onChanged: () => setState(() {})),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'Sync & storage', eyebrow: 'Offline data'),
          const SizedBox(height: AppSpacing.space3),
          _SyncSection(onToast: _showSnack),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'Session', eyebrow: 'This device'),
          const SizedBox(height: AppSpacing.space3),
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.xl),
              boxShadow: AppShadow.sm(),
            ),
            child: Material(
              color: Colors.transparent,
              child: Column(
                children: [
                  _PremiumTile(
                    icon: Icons.password_outlined,
                    iconColor: AppColors.info,
                    title: 'Change password',
                    subtitle: 'Needs internet',
                    onTap: () => _changePasswordFlow(auth),
                  ),
                  _PremiumTile(
                    icon: Icons.logout_rounded,
                    iconColor: AppColors.danger,
                    title: 'Log out',
                    onTap: () =>
                        _signOutFlow(auth, context.read<SyncService>()),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'About', eyebrow: 'CartIQ POS'),
          const SizedBox(height: AppSpacing.space3),
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.xl),
              boxShadow: AppShadow.sm(),
            ),
            child: Material(
              color: Colors.transparent,
              child: Column(
                children: [
                  const _PremiumTile(
                    icon: Icons.info_outline_rounded,
                    iconColor: AppColors.primary,
                    title: 'Version',
                    subtitle: 'v1.0.0 • Pota Fries Operations',
                  ),
                  _PremiumTile(
                    icon: Icons.dns_outlined,
                    iconColor: Colors.deepPurple,
                    title: 'Backend',
                    subtitle: AppConfig.apiBaseUrl,
                  ),
                  const _PremiumTile(
                    icon: Icons.security_outlined,
                    iconColor: Colors.teal,
                    title: 'Disabled accounts',
                    subtitle:
                        'Stop working within 7 days offline, immediately when online.',
                  ),
                  _PremiumTile(
                    icon: Icons.offline_bolt_outlined,
                    iconColor: _eligibility != null && _eligibility!.eligible
                        ? AppColors.ok
                        : AppColors.warn,
                    title: 'Offline login',
                    subtitle: _eligibility == null
                        ? 'Checking...'
                        : _eligibility!.eligible
                        ? 'Ready • PIN set for this staff account'
                        : _eligibility!.message,
                    trailing: _eligibility == null
                        ? null
                        : AppBadge(
                            label: _eligibility!.eligible
                                ? 'READY'
                                : 'NOT READY',
                            variant: _eligibility!.eligible
                                ? AppBadgeVariant.ok
                                : AppBadgeVariant.neutral,
                          ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ThemeButton extends StatelessWidget {
  const _ThemeButton({
    required this.currentMode,
    required this.targetMode,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final ThemeMode currentMode;
  final ThemeMode targetMode;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isSelected = currentMode == targetMode;

    return Material(
      color: isSelected
          ? AppColors.primary.withValues(alpha: 0.12)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(AppRadius.pill),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.pill),
            border: Border.all(
              color: isSelected
                  ? AppColors.primary.withValues(alpha: 0.3)
                  : Colors.transparent,
              width: 1,
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                icon,
                color: isSelected ? AppColors.primary : AppColors.muted,
                size: 16,
              ),
              const SizedBox(width: 8),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: isSelected ? AppColors.primary : AppColors.muted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PremiumTile extends StatelessWidget {
  const _PremiumTile({
    required this.icon,
    required this.iconColor,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.customWidget,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final Widget? customWidget;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space4,
          vertical: AppSpacing.space3,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: iconColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(AppRadius.m),
              ),
              child: Icon(icon, color: iconColor, size: 22),
            ),
            const SizedBox(width: AppSpacing.space3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 15,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: Theme.of(context).textTheme.bodySmall,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
            if (customWidget != null)
              customWidget!
            else if (trailing != null)
              trailing!
            else if (onTap != null)
              const Padding(
                padding: EdgeInsets.only(left: 8.0),
                child: Icon(
                  Icons.chevron_right_rounded,
                  size: 20,
                  color: Colors.grey,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.auth, required this.lastOnline});

  final AuthState auth;
  final DateTime? lastOnline;

  @override
  Widget build(BuildContext context) {
    final name = auth.displayName;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    final label = lastOnline == null
        ? 'Never verified • connect once to enable offline login'
        : 'Last verified ${ManilaTime.formatTime(lastOnline!)}'
              '${auth.offlineMode ? ' • OFFLINE MODE' : ''}';

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space5),
        child: Column(
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 30,
                  backgroundColor: AppColors.primary.withValues(alpha: 0.12),
                  child: Text(
                    name.isNotEmpty ? name[0].toUpperCase() : '?',
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: AppColors.primary,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.space4),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 4),
                      // FIX: Tinanggal na ang string interpolation warning
                      Text(
                        auth.locationCode ?? "No cart assigned",
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: AppColors.muted,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
                AppBadge(
                  label: auth.roleDisplay,
                  variant: auth.roleDisplay == 'OWNER'
                      ? AppBadgeVariant.warn
                      : AppBadgeVariant.info,
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: Theme.of(context).dividerColor.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(AppRadius.m),
              ),
              child: Row(
                children: [
                  Icon(
                    auth.offlineMode
                        ? Icons.wifi_off_rounded
                        : Icons.verified_outlined,
                    size: 16,
                    color: auth.offlineMode ? AppColors.warn : AppColors.ok,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      label,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: auth.offlineMode ? AppColors.warn : null,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PinSection extends StatelessWidget {
  const _PinSection({
    required this.auth,
    required this.hasPin,
    required this.onSetup,
    required this.onChange,
    required this.onDisable,
  });

  final AuthState auth;
  final bool? hasPin;
  final VoidCallback onSetup;
  final VoidCallback onChange;
  final VoidCallback onDisable;

  @override
  Widget build(BuildContext context) {
    final surfaceColor = Theme.of(context).colorScheme.surface;
    final isStaff = (auth.user?['role'] as String?) == 'STAFF';

    if (!isStaff) {
      return Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: surfaceColor,
          borderRadius: BorderRadius.circular(AppRadius.xl),
          boxShadow: AppShadow.sm(),
        ),
        child: const _PremiumTile(
          icon: Icons.pin_outlined,
          iconColor: Colors.grey,
          title: 'Offline PIN',
          subtitle: 'Staff accounts only. Owners always sign in online.',
        ),
      );
    }

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            _PremiumTile(
              icon: Icons.pin_rounded,
              iconColor: AppColors.primary,
              title: 'Offline PIN',
              subtitle: hasPin == true
                  ? 'On • opens this device without internet'
                  : 'Off • set one to open the app with no signal',
              trailing: AppBadge(
                label: hasPin == true ? 'ON' : 'OFF',
                variant: hasPin == true
                    ? AppBadgeVariant.ok
                    : AppBadgeVariant.neutral,
              ),
            ),
            if (hasPin != null) ...[
              if (!hasPin!)
                _PremiumTile(
                  icon: Icons.add_rounded,
                  iconColor: AppColors.ok,
                  title: 'Set up PIN',
                  onTap: onSetup,
                )
              else ...[
                _PremiumTile(
                  icon: Icons.edit_outlined,
                  iconColor: AppColors.info,
                  title: 'Change PIN',
                  subtitle: 'Works offline with current PIN',
                  onTap: onChange,
                ),
                _PremiumTile(
                  icon: Icons.remove_circle_outline_rounded,
                  iconColor: AppColors.warn,
                  title: 'Disable PIN',
                  subtitle: 'Needs internet',
                  onTap: onDisable,
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _ServerSection extends StatefulWidget {
  const _ServerSection({required this.onChanged});
  final VoidCallback onChanged;
  @override
  State<_ServerSection> createState() => _ServerSectionState();
}

class _ServerSectionState extends State<_ServerSection> {
  bool? _lanEnabled;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = context.read<AuthState>().api;
    final v = await api.getLanDiscovery();
    if (mounted) setState(() => _lanEnabled = v);
  }

  Future<void> _rescan() async {
    final api = context.read<AuthState>().api;
    setState(() => _busy = true);
    try {
      final url = await api.rescan();
      widget.onChanged();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text('Server: $url'),
            duration: const Duration(seconds: 2),
          ),
        );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text('Rescan failed: $e'),
            backgroundColor: AppColors.danger,
            duration: const Duration(seconds: 2),
          ),
        );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _manualEntry() async {
    final controller = TextEditingController();
    String? error;
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Server address'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: controller,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'IP or host',
                  hintText: '192.168.1.5',
                ),
                onSubmitted: (_) => Navigator.pop(dialogContext, true),
              ),
              if (error != null) ...[
                const SizedBox(height: AppSpacing.space2),
                Text(
                  error!,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: AppColors.danger),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () async {
                try {
                  final api = context.read<AuthState>().api;
                  await api.setManualBaseUrl(controller.text);
                  final ok = await api.testConnection();
                  if (!ok) {
                    setDialogState(
                      () => error =
                          'Saved, but the server did not answer. Check the address.',
                    );
                    return;
                  }
                  if (dialogContext.mounted) {
                    Navigator.pop(dialogContext, true);
                  }
                } on ApiException catch (e) {
                  setDialogState(() => error = e.message);
                }
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
    if (saved == true) {
      widget.onChanged();
      if (mounted) setState(() {});
    }
  }

  Future<void> _resetDefault() async {
    final api = context.read<AuthState>().api;
    await api.resetServerToDefault();
    widget.onChanged();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final api = context.watch<AuthState>().api;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            _PremiumTile(
              icon: Icons.dns_outlined,
              iconColor: Colors.deepPurple,
              title: 'Active server',
              subtitle:
                  api.currentBaseUrl +
                  (api.isManualUrl ? ' • manual override' : ''),
            ),
            _PremiumTile(
              icon: Icons.radar_outlined,
              iconColor: AppColors.info,
              title: 'Rescan network',
              trailing: _busy
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.chevron_right_rounded, color: Colors.grey),
              onTap: _busy ? null : _rescan,
            ),
            _PremiumTile(
              icon: Icons.edit_outlined,
              iconColor: Colors.teal,
              title: 'Enter server manually',
              onTap: _manualEntry,
            ),
            _PremiumTile(
              icon: Icons.restart_alt_rounded,
              iconColor: AppColors.warn,
              title: 'Reset to default',
              onTap: _resetDefault,
            ),
            _PremiumTile(
              icon: Icons.wifi_find_rounded,
              iconColor: AppColors.primary,
              title: 'Offline LAN pilot',
              subtitle:
                  'May attach to a same-Wi-Fi dev server instead of production. Off unless piloting.',
              customWidget: Switch(
                // FIX: Gamitin ang activeThumbColor imbes na activeColor
                activeThumbColor: AppColors.primary,
                value: _lanEnabled ?? false,
                onChanged: _lanEnabled == null
                    ? null
                    : (v) async {
                        await api.setLanDiscovery(v);
                        if (!mounted) return;
                        setState(() => _lanEnabled = v);
                        if (!v) {
                          await api.resetServerToDefault();
                          widget.onChanged();
                          if (mounted) setState(() {});
                        }
                      },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SyncSection extends StatelessWidget {
  const _SyncSection({required this.onToast});
  final void Function(String message, {bool error, bool success}) onToast;

  @override
  Widget build(BuildContext context) {
    final sync = context.watch<SyncService>();
    final api = context.read<AuthState>().api;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            FutureBuilder<int>(
              future: sync.queue.count,
              builder: (context, snap) => _PremiumTile(
                icon: Icons.cloud_upload_outlined,
                iconColor: AppColors.primary,
                title: 'Queued sales',
                subtitle: snap.data == null
                    ? '...'
                    : snap.data == 0
                    ? 'All synced'
                    : '${snap.data} waiting to sync',
                customWidget: FilledButton.tonal(
                  onPressed: () async {
                    final result = await sync.syncAll();
                    onToast(
                      result.fullySynced
                          ? 'Synced ${result.synced} sale(s)'
                          : result.online
                          ? '${result.remaining} remaining'
                          : 'Offline • will sync when connected',
                      error: result.dropped.isNotEmpty,
                      success: result.fullySynced,
                    );
                  },
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    minimumSize: const Size(0, 36),
                  ),
                  child: const Text('Sync now', style: TextStyle(fontSize: 12)),
                ),
              ),
            ),
            FutureBuilder<DateTime?>(
              future: api.catalogUpdatedAt(),
              builder: (context, snap) => _PremiumTile(
                icon: Icons.inventory_2_outlined,
                iconColor: AppColors.ok,
                title: 'Catalog cache',
                subtitle: snap.data == null
                    ? 'Never downloaded'
                    : 'Updated ${ManilaTime.formatTime(snap.data!)}',
                customWidget: PopupMenuButton<String>(
                  tooltip: 'Catalog options',
                  icon: const Icon(Icons.more_vert_rounded, color: Colors.grey),
                  onSelected: (v) async {
                    if (v == 'refresh') {
                      final token = context.read<AuthState>().token;
                      if (token == null) return;
                      try {
                        await api.catalog(token, forceRefresh: true);
                        onToast('Catalog refreshed', success: true);
                      } catch (e) {
                        onToast('Refresh failed: $e', error: true);
                      }
                    } else if (v == 'clear') {
                      await api.clearCatalogCache();
                      onToast('Catalog cache cleared');
                    }
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem(value: 'refresh', child: Text('Refresh now')),
                    PopupMenuItem(value: 'clear', child: Text('Clear cache')),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
