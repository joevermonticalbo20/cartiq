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
  Future<void> reload() async {
    if (mounted) setState(() {});
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
      setState(() {});
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
      setState(() {});
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
    setState(() {});
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
          ? '$queued sale(s) still queued   they stay saved on this device.'
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
          _AccountCard(auth: auth),
          const SizedBox(height: AppSpacing.space4),
          const SectionHeader(
            title: 'Offline PIN',
            eyebrow: 'No-internet login',
          ),
          const SizedBox(height: AppSpacing.space3),
          _PinSection(
            auth: auth,
            onSetup: () => _setupPinFlow(auth),
            onChange: () => _changePinFlow(auth),
            onDisable: () => _disablePinFlow(auth),
          ),
          const SizedBox(height: AppSpacing.space4),
          const SectionHeader(title: 'Appearance', eyebrow: 'Theme'),
          const SizedBox(height: AppSpacing.space3),

          // Theme Switcher Borderless Container
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.l),
              boxShadow: AppShadow.sm(),
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space4),
              child: SegmentedButton<ThemeMode>(
                segments: const [
                  ButtonSegment(
                    value: ThemeMode.light,
                    icon: Icon(Icons.light_mode_outlined),
                    label: Text('Light'),
                  ),
                  ButtonSegment(
                    value: ThemeMode.dark,
                    icon: Icon(Icons.dark_mode_outlined),
                    label: Text('Dark'),
                  ),
                  ButtonSegment(
                    value: ThemeMode.system,
                    icon: Icon(Icons.settings_suggest_outlined),
                    label: Text('Auto'),
                  ),
                ],
                selected: {theme.mode},
                onSelectionChanged: (modes) => theme.setMode(modes.first),
              ),
            ),
          ),

          const SizedBox(height: AppSpacing.space4),
          const SectionHeader(title: 'Server', eyebrow: 'Backend connection'),
          const SizedBox(height: AppSpacing.space3),
          _ServerSection(onChanged: () => setState(() {})),
          const SizedBox(height: AppSpacing.space4),
          const SectionHeader(title: 'Sync & storage', eyebrow: 'Offline data'),
          const SizedBox(height: AppSpacing.space3),
          _SyncSection(onToast: _showSnack),
          const SizedBox(height: AppSpacing.space4),
          const SectionHeader(title: 'Session', eyebrow: 'This device'),
          const SizedBox(height: AppSpacing.space3),

          // Session Container
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.l),
              boxShadow: AppShadow.sm(),
            ),
            child: Material(
              color: Colors.transparent,
              child: Column(
                children: [
                  ListTile(
                    leading: const Icon(Icons.password_outlined),
                    title: const Text('Change password'),
                    subtitle: const Text('Needs internet'),
                    trailing: const Icon(Icons.chevron_right_rounded),
                    onTap: () => _changePasswordFlow(auth),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.logout_rounded),
                    title: const Text('Log out'),
                    trailing: const Icon(Icons.chevron_right_rounded),
                    onTap: () =>
                        _signOutFlow(auth, context.read<SyncService>()),
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: AppSpacing.space4),
          const SectionHeader(title: 'About', eyebrow: 'CartIQ POS'),
          const SizedBox(height: AppSpacing.space3),

          // About Container
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.l),
              boxShadow: AppShadow.sm(),
            ),
            child: Material(
              color: Colors.transparent,
              child: Column(
                children: [
                  const ListTile(
                    leading: Icon(Icons.info_outline_rounded),
                    title: Text('Version'),
                    subtitle: Text('v1.0.0   Pota Fries Operations'),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.dns_outlined),
                    title: const Text('Backend'),
                    subtitle: Text(AppConfig.apiBaseUrl),
                  ),
                  const Divider(height: 1),
                  const ListTile(
                    leading: Icon(Icons.security_outlined),
                    title: Text('Disabled accounts'),
                    subtitle: Text(
                      'Stop working within 7 days offline, immediately when online.',
                    ),
                  ),
                  const Divider(height: 1),
                  FutureBuilder<PinEligibility>(
                    future: auth.checkOfflineEligibility(),
                    builder: (context, snap) {
                      final e = snap.data;
                      final subtitle = e == null
                          ? 'Checking...'
                          : e.eligible
                          ? 'Ready   PIN set for this staff account'
                          : e.message;
                      return ListTile(
                        leading: Icon(
                          e != null && e.eligible
                              ? Icons.offline_bolt_outlined
                              : Icons.offline_bolt_outlined,
                        ),
                        title: const Text('Offline login'),
                        subtitle: Text(subtitle),
                        trailing: e == null
                            ? null
                            : AppBadge(
                                label: e.eligible ? 'READY' : 'NOT READY',
                                variant: e.eligible
                                    ? AppBadgeVariant.ok
                                    : AppBadgeVariant.neutral,
                              ),
                      );
                    },
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

class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.auth});
  final AuthState auth;

  @override
  Widget build(BuildContext context) {
    final name = auth.displayName;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.l),
        boxShadow: AppShadow.sm(),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space4),
        child: Column(
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 24,
                  backgroundColor: AppColors.primary.withValues(alpha: 0.12),
                  child: Text(
                    name.isNotEmpty ? name[0].toUpperCase() : '?',
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: AppColors.primary,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.space3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(name, style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 2),
                      Text(
                        '${auth.locationCode ?? "No cart"}   ${auth.roleDisplay}',
                        style: Theme.of(context).textTheme.bodySmall,
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
            const SizedBox(height: AppSpacing.space3),
            FutureBuilder<DateTime?>(
              future: auth.lastOnline,
              builder: (context, snap) {
                final last = snap.data;
                final label = last == null
                    ? 'Never verified   connect once to enable offline login'
                    : 'Last verified ${ManilaTime.formatTime(ManilaTime.parse(last) ?? last)}'
                          '${auth.offlineMode ? '   OFFLINE MODE' : ''}';
                return Row(
                  children: [
                    Icon(
                      auth.offlineMode
                          ? Icons.wifi_off_rounded
                          : Icons.verified_outlined,
                      size: 16,
                      color: Theme.of(context).textTheme.bodySmall?.color,
                    ),
                    const SizedBox(width: AppSpacing.space2),
                    Expanded(
                      child: Text(
                        label,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ],
                );
              },
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
    required this.onSetup,
    required this.onChange,
    required this.onDisable,
  });

  final AuthState auth;
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
          borderRadius: BorderRadius.circular(AppRadius.l),
          boxShadow: AppShadow.sm(),
        ),
        child: const ListTile(
          leading: Icon(Icons.pin_outlined),
          title: Text('Offline PIN'),
          subtitle: Text('Staff accounts only. Owners always sign in online.'),
        ),
      );
    }

    return FutureBuilder<bool>(
      future: auth.pin.hasPin,
      builder: (context, snap) {
        final hasPin = snap.data ?? false;
        return Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: surfaceColor,
            borderRadius: BorderRadius.circular(AppRadius.l),
            boxShadow: AppShadow.sm(),
          ),
          child: Material(
            color: Colors.transparent,
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.pin_outlined),
                  title: const Text('Offline PIN'),
                  subtitle: Text(
                    hasPin
                        ? 'On   opens this device without internet'
                        : 'Off   set one to open the app with no signal',
                  ),
                  trailing: AppBadge(
                    label: hasPin ? 'ON' : 'OFF',
                    variant: hasPin
                        ? AppBadgeVariant.ok
                        : AppBadgeVariant.neutral,
                  ),
                ),
                if (snap.connectionState == ConnectionState.done) ...[
                  const Divider(height: 1),
                  if (!hasPin)
                    ListTile(
                      leading: const Icon(Icons.add_rounded),
                      title: const Text('Set up PIN'),
                      trailing: const Icon(Icons.chevron_right_rounded),
                      onTap: onSetup,
                    )
                  else ...[
                    ListTile(
                      leading: const Icon(Icons.edit_outlined),
                      title: const Text('Change PIN'),
                      subtitle: const Text('Works offline with current PIN'),
                      trailing: const Icon(Icons.chevron_right_rounded),
                      onTap: onChange,
                    ),
                    const Divider(height: 1),
                    ListTile(
                      leading: const Icon(Icons.remove_circle_outline_rounded),
                      title: const Text('Disable PIN'),
                      subtitle: const Text('Needs internet'),
                      trailing: const Icon(Icons.chevron_right_rounded),
                      onTap: onDisable,
                    ),
                  ],
                ],
              ],
            ),
          ),
        );
      },
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
        borderRadius: BorderRadius.circular(AppRadius.l),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            ListTile(
              leading: const Icon(Icons.dns_outlined),
              title: const Text('Active server'),
              subtitle: Text(
                api.currentBaseUrl +
                    (api.isManualUrl ? '   manual override' : ''),
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.radar_outlined),
              title: const Text('Rescan network'),
              trailing: _busy
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.chevron_right_rounded),
              onTap: _busy ? null : _rescan,
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('Enter server manually'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: _manualEntry,
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.restart_alt_rounded),
              title: const Text('Reset to default'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: _resetDefault,
            ),
            const Divider(height: 1),
            SwitchListTile(
              secondary: const Icon(Icons.wifi_find_rounded),
              title: const Text('Offline LAN pilot'),
              subtitle: const Text(
                'May attach to a same-Wi-Fi dev server instead of production. Off unless piloting.',
              ),
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
        borderRadius: BorderRadius.circular(AppRadius.l),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            FutureBuilder<int>(
              future: sync.queue.count,
              builder: (context, snap) => ListTile(
                leading: const Icon(Icons.cloud_upload_outlined),
                title: const Text('Queued sales'),
                subtitle: Text(
                  snap.data == null
                      ? '...'
                      : snap.data == 0
                      ? 'All synced'
                      : '${snap.data} waiting to sync',
                ),
                trailing: ElevatedButton(
                  onPressed: () async {
                    final result = await sync.syncAll();
                    onToast(
                      result.fullySynced
                          ? 'Synced ${result.synced} sale(s)'
                          : result.online
                          ? '${result.remaining} remaining'
                          : 'Offline   will sync when connected',
                      error: result.dropped.isNotEmpty,
                      success: result.fullySynced,
                    );
                  },
                  child: const Text('Sync now'),
                ),
              ),
            ),
            const Divider(height: 1),
            FutureBuilder<DateTime?>(
              future: api.catalogUpdatedAt(),
              builder: (context, snap) => ListTile(
                leading: const Icon(Icons.inventory_2_outlined),
                title: const Text('Catalog cache'),
                subtitle: Text(
                  snap.data == null
                      ? 'Never downloaded'
                      : 'Updated ${ManilaTime.formatTime(ManilaTime.parse(snap.data) ?? snap.data!)}',
                ),
                trailing: PopupMenuButton<String>(
                  tooltip: 'Catalog options',
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
