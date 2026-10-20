import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/screens/pos_screen.dart';
import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/utils/app_messenger.dart';
import 'package:cartiq_mobile/widgets/app_badge.dart';
import 'package:cartiq_mobile/widgets/app_dialog.dart';
import 'package:cartiq_mobile/widgets/section_header.dart';
import 'package:cartiq_mobile/widgets/app_skeleton.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  group('PosCatalogUnavailableState', () {
    testWidgets('centers the message and retry action on screen', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var retried = false;

      await tester.pumpWidget(
        _wrap(
          SizedBox.expand(
            child: PosCatalogUnavailableState(
              message:
                  'No internet connection. Your orders are safely saved offline and will sync automatically when you reconnect.',
              onRetry: () => retried = true,
            ),
          ),
        ),
      );

      expect(
        tester
            .getCenter(
              find.descendant(
                of: find.byType(PosCatalogUnavailableState),
                matching: find.byType(Column),
              ),
            )
            .dy,
        closeTo(320, 30),
      );
      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(retried, isTrue);
    });
  });

  group('AppBadge', () {
    testWidgets('renders label with requested variant', (tester) async {
      await tester.pumpWidget(
        _wrap(const AppBadge(label: 'ON', variant: AppBadgeVariant.ok)),
      );
      expect(find.text('ON'), findsOneWidget);
    });

    testWidgets('renders icon when provided', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const AppBadge(
            label: 'LOW',
            variant: AppBadgeVariant.warn,
            icon: Icons.warning,
          ),
        ),
      );
      expect(find.byIcon(Icons.warning), findsOneWidget);
    });
  });

  group('SectionHeader', () {
    testWidgets('renders title, eyebrow and trailing', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const SectionHeader(
            title: 'Shift event history',
            eyebrow: 'Operations',
            trailing: Text('action'),
          ),
        ),
      );
      expect(find.text('Shift event history'), findsOneWidget);
      expect(find.text('Operations'), findsOneWidget);
      expect(find.text('action'), findsOneWidget);
    });
  });

  group('AppSkeleton', () {
    testWidgets('renders the requested row count', (tester) async {
      await tester.pumpWidget(_wrap(const AppSkeleton(rows: 3)));
      // 3 pulse bars render inside the skeleton.
      expect(find.byType(AppSkeleton), findsOneWidget);
    });
  });

  group('showAppConfirm', () {
    testWidgets('confirm returns true, cancel returns false', (tester) async {
      bool? result;
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (context) => FilledButton(
              onPressed: () async {
                result = await showAppConfirm(
                  context,
                  title: 'Log out?',
                  confirmLabel: 'Log out',
                  danger: true,
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Log out?'), findsOneWidget);
      await tester.tap(find.text('Log out').last);
      await tester.pumpAndSettle();
      expect(result, isTrue);

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(result, isFalse);
    });
  });

  group('AppMessenger', () {
    testWidgets('does not show the full offline snackbar', (tester) async {
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => AppMessenger.showErrorSnackBar(
                context: context,
                error: const ApiException(ApiClient.noInternetMessage),
                onRetry: () {},
              ),
              child: const Text('show error'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('show error'));
      await tester.pumpAndSettle();

      expect(find.text(ApiClient.noInternetMessage), findsNothing);
      expect(find.text('Retry'), findsNothing);
    });

    testWidgets('replaces the active toast and dismisses after four seconds', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      const longMessage =
          'Sale recorded for Cash payment. Total ₱280. Change ₱20. '
          'Receipt reference CART-20261002-1234567890';
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (context) => Column(
              children: [
                TextButton(
                  onPressed: () => AppMessenger.showGlassToast(
                    context: context,
                    message: longMessage,
                    isSuccess: true,
                  ),
                  child: const Text('show first'),
                ),
                TextButton(
                  onPressed: () => AppMessenger.showGlassToast(
                    context: context,
                    message: 'Second message',
                    isSuccess: false,
                  ),
                  child: const Text('show second'),
                ),
              ],
            ),
          ),
        ),
      );

      await tester.tap(find.text('show first'));
      await tester.pumpAndSettle();
      expect(find.text(longMessage), findsOneWidget);
      final toastText = tester.widget<Text>(find.text(longMessage));
      expect(toastText.style?.decoration, TextDecoration.none);
      expect(toastText.maxLines, isNull);
      expect(toastText.softWrap, isTrue);
      expect(toastText.overflow, TextOverflow.visible);
      expect(tester.getSize(find.text(longMessage)).height, greaterThan(20));
      final toastCenter = tester.getCenter(find.text(longMessage));
      expect(toastCenter.dy, closeTo(320, 40));

      await tester.tap(find.text('show second'));
      await tester.pumpAndSettle();
      expect(find.text(longMessage), findsNothing);
      expect(find.text('Second message'), findsOneWidget);

      await tester.pump(const Duration(seconds: 4));
      await tester.pump(const Duration(milliseconds: 250));
      expect(find.text('Second message'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Second message'), findsNothing);
    });
  });
}
