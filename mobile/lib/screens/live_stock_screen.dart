import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/data_refresh.dart';
import '../theme.dart';
import '../utils/manila_time.dart';
import '../utils/text_input.dart';
import '../widgets/app_badge.dart';
import '../widgets/app_skeleton.dart';
import '../widgets/app_dialog.dart';
import '../widgets/empty_state.dart';

class LiveStockScreen extends StatefulWidget {
  const LiveStockScreen({super.key});

  @override
  State<LiveStockScreen> createState() => _LiveStockScreenState();
}

class _LiveStockScreenState extends State<LiveStockScreen> {
  List<Map<String, dynamic>> _locations = [];
  List<Map<String, dynamic>> _items = [];
  Map<int, Map<String, dynamic>> _requestsByItem = {};
  String? _selectedCode;
  String _search = '';
  bool _searching = false;
  final _searchController = TextEditingController();
  String? _error;
  String? _restockError;
  DateTime? _lastSynced;
  bool _loading = true;
  bool _submittingRequest = false;

  late final DataRefresh? _dataRefresh;

  @override
  void initState() {
    super.initState();
    _dataRefresh = context.read<DataRefresh?>();
    _dataRefresh?.addListener(_onDataRefresh);
    _loadInventory();
  }

  @override
  void dispose() {
    _dataRefresh?.removeListener(_onDataRefresh);
    _searchController.dispose();
    super.dispose();
  }

  void _onDataRefresh() {
    if (_dataRefresh?.lastReason == 'sale') {
      _loadInventory();
    }
  }

  Future<void> _loadInventory({
    String? locationCode,
    bool notifyPos = false,
  }) async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    final auth = context.read<AuthState>();
    var token = auth.token;
    if (token == null) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = 'Session expired. Please log in again.';
        });
      }
      return;
    }
    try {
      List<dynamic> data;
      try {
        data = await auth.api.inventory(
          token,
          locationCode: locationCode ?? auth.locationCode,
        );
      } on ApiException catch (error) {
        if (error.statusCode != 401 ||
            !await auth.refreshSession() ||
            auth.token == null) {
          rethrow;
        }
        token = auth.token;
        data = await auth.api.inventory(
          token!,
          locationCode: locationCode ?? auth.locationCode,
        );
      }
      final locations = data.cast<Map<String, dynamic>>();

      List<dynamic> requests = [];
      String? restockError;
      try {
        requests = await auth.api.restockRequests(
          token,
          locationCode: locationCode ?? auth.locationCode,
        );
      } on ApiException catch (error) {
        if (error.statusCode != 401 ||
            !await auth.refreshSession() ||
            auth.token == null) {
          restockError = _restockRequestError(error);
        } else {
          token = auth.token;
          try {
            requests = await auth.api.restockRequests(
              token!,
              locationCode: locationCode ?? auth.locationCode,
            );
          } on ApiException catch (retryError) {
            restockError = _restockRequestError(retryError);
          }
        }
      } catch (error) {
        restockError = 'Unable to load restock request status: $error';
      }

      final requestedCode = locationCode ?? auth.locationCode;
      final locationOptions = locationCode != null && _locations.length > 1
          ? _locations
          : locations;
      final selected =
          locations.any((location) => location['code'] == requestedCode)
          ? requestedCode
          : (_selectedCode != null &&
                    locationOptions.any(
                      (location) => location['code'] == _selectedCode,
                    )
                ? _selectedCode
                : locationOptions.firstOrNull?['code'] as String?);

      final location = locations
          .where((item) => item['code'] == selected)
          .firstOrNull;

      if (!mounted) return;
      setState(() {
        _locations = locationOptions;
        _selectedCode = selected;
        _items = ((location?['items'] as List?) ?? const [])
            .cast<Map<String, dynamic>>();
        _requestsByItem = {
          for (final request in requests.cast<Map<String, dynamic>>())
            if (request['ingredientId'] is num)
              (request['ingredientId'] as num).toInt(): request,
        };
        _lastSynced = DateTime.now().toUtc();
        _loading = false;
        _error = null;
        _restockError = restockError;
      });
      if (notifyPos) _dataRefresh?.bump('inventory');
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error is ApiException
            ? error.message
            : 'Unable to load stock: $error';
      });
    }
  }

  String _restockRequestError(ApiException error) {
    if (error.statusCode == 404) {
      return 'Restock requests are not available on this server yet. Stock is still current.';
    }
    return 'Unable to load restock request status: ${error.message}';
  }

  String _formatStock(dynamic stock) {
    final value = stock is num ? stock : num.tryParse('$stock') ?? 0;
    return value.toStringAsFixed(value == value.roundToDouble() ? 0 : 2);
  }

  ({String label, AppBadgeVariant variant}) _status(Map<String, dynamic> item) {
    final stock = item['stock'] is num ? item['stock'] as num : 0;
    final threshold = item['threshold'] is num ? item['threshold'] as num : 0;
    if (item['isOutOfStock'] == true || stock <= 0) {
      return (label: 'Out of Stock', variant: AppBadgeVariant.danger);
    }
    if (item['status'] == 'low' ||
        item['status'] == 'critical' ||
        stock <= threshold) {
      return (label: 'Low Stock', variant: AppBadgeVariant.warn);
    }
    return (label: 'In Stock', variant: AppBadgeVariant.ok);
  }

  Future<void> _requestRestock({
    Map<String, dynamic>? item,
    bool allLowStock = false,
  }) async {
    var urgency = 'normal';
    final noteController = TextEditingController();
    final confirmed = await showAppConfirm(
      context,
      title: allLowStock ? 'Request all low-stock items' : 'Request restock',
      message: allLowStock
          ? 'Send restock requests for every low or out-of-stock ingredient?'
          : 'Request more ${item?['name'] ?? 'stock'}?',
      confirmLabel: 'Send request',
      child: StatefulBuilder(
        builder: (context, setDialogState) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Urgency',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: AppSpacing.space2),
            Wrap(
              spacing: AppSpacing.space2,
              children: [
                for (final value in ['normal', 'urgent', 'critical'])
                  ChoiceChip(
                    label: Text(value[0].toUpperCase() + value.substring(1)),
                    selected: urgency == value,
                    onSelected: (_) => setDialogState(() => urgency = value),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.space2),
            TextField(
              controller: noteController,
              maxLines: 2,
              inputFormatters: const [SingleSpaceFormatter()],
              decoration: const InputDecoration(
                labelText: 'Note (optional)',
                hintText: 'Add a short note for the admin',
              ),
            ),
          ],
        ),
      ),
    );
    if (!confirmed) {
      noteController.dispose();
      return;
    }
    if (!TextInputRules.isValidNote(noteController.text)) {
      noteController.dispose();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Notes must be empty or contain at least two letters.',
            ),
          ),
        );
      }
      return;
    }
    final note = TextInputRules.sanitize(noteController.text).trim();
    noteController.dispose();
    if (_submittingRequest || !mounted) return;
    setState(() => _submittingRequest = true);
    try {
      final auth = context.read<AuthState>();
      final token = auth.token;
      if (token == null) {
        throw ApiException('Session expired. Please log in again.');
      }
      final payload = <String, dynamic>{'urgency': urgency, 'notes': note};
      if (allLowStock) {
        payload['allLowStock'] = true;
      } else {
        payload['ingredientId'] = item?['id'];
      }
      try {
        await auth.api.createRestockRequest(token, payload);
      } on ApiException catch (error) {
        if (error.statusCode != 401 ||
            !await auth.refreshSession() ||
            auth.token == null) {
          rethrow;
        }
        await auth.api.createRestockRequest(auth.token!, payload);
      }
      await _loadInventory();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              allLowStock
                  ? 'Low-stock restock requests sent.'
                  : 'Restock request sent for ${item?['name']}.',
            ),
          ),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              error is ApiException
                  ? error.message
                  : 'Unable to send request: $error',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submittingRequest = false);
    }
  }

  Widget _locationSelector() {
    if (_locations.length <= 1) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space2),
      child: DropdownButtonFormField<String>(
        initialValue: _selectedCode,
        decoration: const InputDecoration(labelText: 'Cart', isDense: true),
        items: _locations
            .map(
              (location) => DropdownMenuItem(
                value: location['code'] as String,
                child: Text(
                  '${location['code']}   ${location['name']}',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            )
            .toList(),
        onChanged: (code) {
          if (code != null) {
            _selectedCode = code;
            _loadInventory(locationCode: code);
          }
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final visibleItems = _items.where((item) {
      final name = (item['name'] as String? ?? '').toLowerCase();
      return name.contains(_search.trim().toLowerCase());
    }).toList();

    final syncedAt = _lastSynced == null
        ? 'Not synced yet'
        : ManilaTime.formatTime12(ManilaTime.parse(_lastSynced)!);

    final lowStockItems = _items.where((item) {
      final stock = item['stock'] is num ? item['stock'] as num : 0;
      final threshold = item['threshold'] is num ? item['threshold'] as num : 0;
      return stock <= threshold;
    }).toList();

    final hasUnrequestedLowStock = lowStockItems.any((item) {
      final id = item['id'];
      return id is! num || !_requestsByItem.containsKey(id.toInt());
    });

    final topPadding = MediaQuery.of(context).padding.top + 90;

    return Scaffold(
      extendBody: true,
      body: Stack(
        children: [
          RefreshIndicator(
            onRefresh: () => _loadInventory(notifyPos: true),
            child: LayoutBuilder(
              builder: (context, constraints) => ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: EdgeInsets.fromLTRB(
                  AppSpacing.space4,
                  topPadding,
                  AppSpacing.space4,
                  AppSpacing
                      .space6, // TINANGGAL ANG 120, Pinalitan ng normal padding
                ),
                children: [
                  if (_error != null && !_loading)
                    SizedBox(
                      height:
                          (constraints.maxHeight -
                                  topPadding -
                                  AppSpacing.space6) // IN-UPDATE DIN DITO
                              .clamp(0.0, double.infinity)
                              .toDouble(),
                      child: Column(
                        children: [
                          Text(
                            'Last synced: $syncedAt',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          _locationSelector(),
                          const SizedBox(height: AppSpacing.space3),
                          Expanded(
                            child: AppUnavailableState(
                              message: _error!,
                              onRetry: _loadInventory,
                            ),
                          ),
                        ],
                      ),
                    )
                  else ...[
                    Text(
                      'Last synced: $syncedAt',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    _locationSelector(),
                    const SizedBox(height: AppSpacing.space3),

                    if (_loading)
                      const AppSkeleton(rows: 5)
                    else ...[
                      if (_restockError != null) ...[
                        Container(
                          margin: const EdgeInsets.only(
                            bottom: AppSpacing.space3,
                          ),
                          padding: const EdgeInsets.all(AppSpacing.space3),
                          decoration: BoxDecoration(
                            color: AppColors.warnBg,
                            borderRadius: BorderRadius.circular(AppRadius.m),
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(
                                Icons.info_outline_rounded,
                                color: AppColors.warn,
                              ),
                              const SizedBox(width: AppSpacing.space2),
                              Expanded(
                                child: Text(
                                  _restockError!,
                                  style: const TextStyle(color: AppColors.warn),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                      if (_locations.isEmpty)
                        const AppEmptyState(
                          icon: Icons.inventory_2_outlined,
                          title: 'No stock locations',
                          subtitle:
                              'No active carts have inventory to display.',
                        )
                      else if (visibleItems.isEmpty)
                        AppEmptyState(
                          icon: Icons.search_off_rounded,
                          title: 'No ingredients match',
                          subtitle: _search.isEmpty
                              ? 'No ingredients are recorded for this cart.'
                              : 'Try a different ingredient name.',
                          compact: true,
                        )
                      else
                        ...visibleItems.map((item) {
                          final status = _status(item);
                          final request = item['id'] is num
                              ? _requestsByItem[(item['id'] as num).toInt()]
                              : null;
                          final pending = request != null;
                          final needsRestock = status.label != 'In Stock';

                          return Card(
                            margin: const EdgeInsets.only(
                              bottom: AppSpacing.space2,
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(AppSpacing.space2),
                              child: Column(
                                children: [
                                  ListTile(
                                    contentPadding: EdgeInsets.zero,
                                    leading: const CircleAvatar(
                                      child: Icon(Icons.inventory_2_outlined),
                                    ),
                                    title: Text(
                                      item['name'] as String? ??
                                          'Unnamed ingredient',
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    subtitle: Text(
                                      '${_formatStock(item['stock'])} ${item['unit'] ?? ''}'
                                          .trim(),
                                    ),
                                    trailing: AppBadge(
                                      label: status.label,
                                      variant: status.variant,
                                    ),
                                  ),
                                  Row(
                                    children: [
                                      if (pending)
                                        AppBadge(
                                          label: 'Request Pending',
                                          variant: AppBadgeVariant.info,
                                        ),
                                      const Spacer(),
                                      OutlinedButton.icon(
                                        onPressed: pending || _submittingRequest
                                            ? null
                                            : () => _requestRestock(item: item),
                                        icon: Icon(
                                          Icons.add_shopping_cart_rounded,
                                          size: 16,
                                          color: needsRestock
                                              ? AppColors.danger
                                              : null,
                                        ),
                                        label: Text(
                                          pending
                                              ? 'Request Pending'
                                              : 'Request Restock',
                                        ),
                                        style: needsRestock && !pending
                                            ? OutlinedButton.styleFrom(
                                                foregroundColor:
                                                    AppColors.danger,
                                                side: const BorderSide(
                                                  color: AppColors.danger,
                                                ),
                                              )
                                            : null,
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          );
                        }),
                    ],
                  ],
                ],
              ),
            ),
          ),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.space4,
                  vertical: AppSpacing.space3,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: _GlassPillContainer(
                        child: Row(
                          children: [
                            // BAGONG BACK BUTTON
                            const SizedBox(width: 4),
                            IconButton(
                              icon: const Icon(
                                Icons.arrow_back_rounded,
                                size: 20,
                              ),
                              tooltip: 'Back',
                              onPressed: () => Navigator.pop(context),
                            ),
                            Expanded(
                              child: AnimatedSwitcher(
                                duration: const Duration(milliseconds: 250),
                                child: _searching
                                    ? TextField(
                                        key: const ValueKey('searchField'),
                                        controller: _searchController,
                                        autofocus: true,
                                        decoration: InputDecoration(
                                          hintText: 'Search ingredients...',
                                          border: InputBorder.none,
                                          enabledBorder: InputBorder.none,
                                          focusedBorder: InputBorder.none,
                                          fillColor: Colors.transparent,
                                          filled: true,
                                          isDense: true,
                                          contentPadding:
                                              const EdgeInsets.fromLTRB(
                                                4,
                                                14,
                                                20,
                                                14,
                                              ),
                                          hintStyle: TextStyle(
                                            color: Theme.of(
                                              context,
                                            ).textTheme.bodySmall?.color,
                                          ),
                                        ),
                                        style: Theme.of(
                                          context,
                                        ).textTheme.titleMedium,
                                        onChanged: (value) => setState(
                                          () => _search = value.trim(),
                                        ),
                                      )
                                    : Container(
                                        key: const ValueKey('titleText'),
                                        width: double.infinity,
                                        padding: const EdgeInsets.fromLTRB(
                                          4,
                                          14,
                                          20,
                                          14,
                                        ),
                                        child: Text(
                                          'Live Stock',
                                          style: Theme.of(context)
                                              .textTheme
                                              .titleLarge
                                              ?.copyWith(
                                                fontWeight: FontWeight.w800,
                                                letterSpacing: -0.5,
                                              ),
                                        ),
                                      ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space2),
                    _GlassPillContainer(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 4,
                          vertical: 4,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: _searching
                              ? [
                                  IconButton(
                                    icon: const Icon(
                                      Icons.close_rounded,
                                      size: 20,
                                    ),
                                    tooltip: 'Close search',
                                    onPressed: () {
                                      setState(() {
                                        _searching = false;
                                        _search = '';
                                        _searchController.clear();
                                      });
                                    },
                                  ),
                                ]
                              : [
                                  if (hasUnrequestedLowStock)
                                    IconButton(
                                      icon: const Icon(
                                        Icons.playlist_add_check_rounded,
                                        size: 20,
                                      ),
                                      color: AppColors.danger,
                                      tooltip: 'Request all low-stock items',
                                      onPressed:
                                          (_loading || _submittingRequest)
                                          ? null
                                          : () => _requestRestock(
                                              allLowStock: true,
                                            ),
                                    ),
                                  IconButton(
                                    icon: const Icon(
                                      Icons.sync_rounded,
                                      size: 20,
                                    ),
                                    tooltip: 'Refresh stock',
                                    onPressed: _loading
                                        ? null
                                        : () => _loadInventory(notifyPos: true),
                                  ),
                                  IconButton(
                                    icon: const Icon(
                                      Icons.search_rounded,
                                      size: 20,
                                    ),
                                    tooltip: 'Search ingredients',
                                    onPressed: () =>
                                        setState(() => _searching = true),
                                  ),
                                ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GlassPillContainer extends StatelessWidget {
  const _GlassPillContainer({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
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
            child: child,
          ),
        ),
      ),
    );
  }
}
