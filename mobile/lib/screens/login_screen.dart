import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../widgets/brand_hero.dart';
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _serverController = TextEditingController();
  bool _loading = false;
  bool _showPassword = false;
  bool _showServer = false;
  bool _scanning = false;
  String? _error;
  String? _serverMsg;
  bool? _serverOk;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _serverController.dispose();
    super.dispose();
  }

  Future<void> _rescanServer() async {
    setState(() {
      _scanning = true;
      _serverMsg = 'Scanning local network…';
      _serverOk = null;
    });
    try {
      final url = await context.read<AuthState>().api.rescan();
      if (!mounted) return;
      setState(() {
        _serverMsg = 'Found: $url';
        _serverOk = true;
      });
      await Haptics.success();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _serverMsg = 'Scan failed: $e';
        _serverOk = false;
      });
      await Haptics.error();
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _saveServer() async {
    final api = context.read<AuthState>().api;
    setState(() {
      _serverMsg = null;
      _serverOk = null;
    });
    try {
      final url = await api.setManualBaseUrl(_serverController.text);
      final ok = await api.testConnection();
      if (!mounted) return;
      setState(() {
        _serverOk = ok;
        _serverMsg = ok ? 'Connected: $url' : 'Saved $url but no response - is the API running?';
      });
      if (ok) {
        await Haptics.success();
      } else {
        await Haptics.error();
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _serverOk = false;
        _serverMsg = e.message;
      });
      await Haptics.error();
    }
  }

Future<void> _submit() async {
        if (!_formKey.currentState!.validate()) return;
        setState(() {
          _loading = true;
          _error = null;
        });
        try {
          await context.read<AuthState>().signIn(
                _username.text.trim(),
                _password.text,
              );
          if (!mounted) return;
          await Haptics.success();
          // No imperative navigation here: CartIQApp's home rebuilds from
          // AuthState (logged in -> RootShell, logged out -> LoginScreen).
          // A pushReplacement would strand the shell route on top after a
          // later sign-out, so the login page would never reappear.
        } on ApiException catch (e) {
          setState(() => _error = e.message);
          await Haptics.error();
        } finally {
          if (mounted) setState(() => _loading = false);
        }
      }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 380),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const BrandHero(),
                  const SizedBox(height: 20),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(22),
                      child: Form(
                        key: _formKey,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                      TextFormField(
                        controller: _username,
                        decoration: const InputDecoration(
                          labelText: 'Username',
                          prefixIcon: Icon(Icons.person_outline),
                          border: OutlineInputBorder(),
                        ),
                        validator: (v) =>
                            (v == null || v.trim().isEmpty) ? 'Enter username' : null,
                      ),
                      const SizedBox(height: 14),
                      TextFormField(
                        controller: _password,
                        obscureText: !_showPassword,
                        decoration: InputDecoration(
                          labelText: 'Password',
                          prefixIcon: const Icon(Icons.lock_outline),
                          border: const OutlineInputBorder(),
                          suffixIcon: IconButton(
                            icon: Icon(
                              _showPassword
                                  ? Icons.visibility_off_rounded
                                  : Icons.visibility_rounded,
                            ),
                            tooltip: _showPassword ? 'Hide password' : 'Show password',
                            onPressed: () => setState(
                              () => _showPassword = !_showPassword,
                            ),
                          ),
                        ),
                        validator: (v) =>
                            (v == null || v.isEmpty) ? 'Enter password' : null,
                        onFieldSubmitted: (_) => _loading ? null : _submit(),
                      ),
                      const SizedBox(height: 16),
                      if (_error != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Text(
                            _error!,
                            style: TextStyle(color: Theme.of(context).colorScheme.error),
                            textAlign: TextAlign.center,
                          ),
                        ),
                      FilledButton(
                        onPressed: _loading ? null : _submit,
                        child: _loading
                            ? const SizedBox(
                                height: 18,
                                width: 18,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Text('Sign in'),
                      ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  _ServerCard(
                    showServer: _showServer,
                    onToggle: () =>
                        setState(() => _showServer = !_showServer),
                    scanning: _scanning,
                    onRescan: _rescanServer,
                    serverController: _serverController,
                    onSave: _saveServer,
                    serverMsg: _serverMsg,
                    serverOk: _serverOk,
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

class _ServerCard extends StatelessWidget {
  const _ServerCard({
    required this.showServer,
    required this.onToggle,
    required this.scanning,
    required this.onRescan,
    required this.serverController,
    required this.onSave,
    required this.serverMsg,
    required this.serverOk,
  });

  final bool showServer;
  final VoidCallback onToggle;
  final bool scanning;
  final VoidCallback onRescan;
  final TextEditingController serverController;
  final VoidCallback onSave;
  final String? serverMsg;
  final bool? serverOk;

  @override
  Widget build(BuildContext context) {
    final api = context.watch<AuthState>().api;
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextButton.icon(
              onPressed: onToggle,
              icon: Icon(
                showServer
                    ? Icons.expand_less_rounded
                    : Icons.expand_more_rounded,
                size: 18,
              ),
              label: const Text('Server'),
            ),
            if (showServer) ...[
              SelectableText(
                api.currentBaseUrl,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      fontFamily: 'monospace',
                    ),
              ),
              if (api.isManualUrl)
                Text(
                  'manual override',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              const SizedBox(height: 8),
              if (serverMsg != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    serverMsg!,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: serverOk == true
                          ? AppColors.ok
                          : serverOk == false
                              ? Theme.of(context).colorScheme.error
                              : null,
                    ),
                  ),
                ),
              OutlinedButton.icon(
                onPressed: scanning ? null : onRescan,
                icon: scanning
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.radar_rounded, size: 18),
                label: const Text('Rescan'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: serverController,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'Server IP or host',
                  hintText: '192.168.1.5',
                  prefixIcon: Icon(Icons.dns_outlined),
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
                onSubmitted: (_) => onSave(),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: onSave,
                child: const Text('Save & test connection'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
