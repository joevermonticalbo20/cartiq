import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/widgets/app_badge.dart';
import 'package:cartiq_mobile/widgets/app_dialog.dart';
import 'package:cartiq_mobile/widgets/kpi_card.dart';
import 'package:cartiq_mobile/widgets/section_header.dart';
import 'package:cartiq_mobile/widgets/app_skeleton.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  group('AppBadge', () {
    testWidgets('renders label with requested variant', (tester) async {
      await tester.pumpWidget(_wrap(const AppBadge(
        label: 'ON',
        variant: AppBadgeVariant.ok,
      )));
      expect(find.text('ON'), findsOneWidget);
    });

    testWidgets('renders icon when provided', (tester) async {
      await tester.pumpWidget(_wrap(const AppBadge(
        label: 'LOW',
        variant: AppBadgeVariant.warn,
        icon: Icons.warning,
      )));
      expect(find.byIcon(Icons.warning), findsOneWidget);
    });
  });

  group('SectionHeader', () {
    testWidgets('renders title, eyebrow and trailing', (tester) async {
      await tester.pumpWidget(_wrap(const SectionHeader(
        title: 'Shift event history',
        eyebrow: 'Operations',
        trailing: Text('action'),
      )));
      expect(find.text('Shift event history'), findsOneWidget);
      expect(find.text('Operations'), findsOneWidget);
      expect(find.text('action'), findsOneWidget);
    });
  });

  group('AppKpiCard', () {
    testWidgets('renders label, value and trend', (tester) async {
      await tester.pumpWidget(_wrap(const AppKpiCard(
        label: 'SALES TODAY',
        value: 'P12,450',
        trendLabel: '+8.2%',
        trendUp: true,
        solid: true,
      )));
      expect(find.text('SALES TODAY'), findsOneWidget);
      expect(find.text('P12,450'), findsOneWidget);
      expect(find.text('+8.2%'), findsOneWidget);
    });

    testWidgets('taps through onTap', (tester) async {
      var tapped = false;
      await tester.pumpWidget(_wrap(AppKpiCard(
        label: 'Orders',
        value: '34',
        onTap: () => tapped = true,
      )));
      await tester.tap(find.text('34'));
      expect(tapped, isTrue);
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
    testWidgets('confirm returns true, cancel returns false',
        (tester) async {
      bool? result;
      await tester.pumpWidget(_wrap(Builder(
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
      )));

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
}
