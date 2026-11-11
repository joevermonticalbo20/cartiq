// The Android back button must never close the POS by accident.
//
// From any tab it walks to Home first; only from Home does it ask "Do you
// still want to exit?" with a Yes/No answer. A vendor ringing up an order
// with one hand must not lose the app (or the order) to a stray swipe.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/widgets/app_back_handler.dart';

class _Harness extends StatefulWidget {
  const _Harness({required this.startIndex, this.onExit});

  final int startIndex;
  final VoidCallback? onExit;

  @override
  State<_Harness> createState() => _HarnessState();
}

class _HarnessState extends State<_Harness> {
  late int index = widget.startIndex;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: AppBackHandler(
        currentIndex: index,
        homeIndex: 2,
        onGoHome: () => setState(() => index = 2),
        onExit: widget.onExit,
        exitMessage: 'Your unfinished order is saved on this device.',
        child: Scaffold(
          body: Center(child: Text('tab $index')),
        ),
      ),
    );
  }
}

Future<void> _pressBack(WidgetTester tester) async {
  await tester.binding.handlePopRoute();
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('back on a tab walks to Home instead of closing the app', (
    tester,
  ) async {
    var exited = false;
    await tester.pumpWidget(
      _Harness(startIndex: 4, onExit: () => exited = true),
    );

    await _pressBack(tester);

    expect(find.text('tab 2'), findsOneWidget);
    expect(exited, isFalse);
  });

  testWidgets('back on Home asks before closing the app', (tester) async {
    var exited = false;
    await tester.pumpWidget(
      _Harness(startIndex: 2, onExit: () => exited = true),
    );

    await _pressBack(tester);

    expect(find.text('Do you still want to exit?'), findsOneWidget);
    expect(find.text('Yes'), findsOneWidget);
    expect(find.text('No'), findsOneWidget);
    expect(exited, isFalse, reason: 'the app must stay open until it is said');
  });

  testWidgets('"No" keeps the app open', (tester) async {
    var exited = false;
    await tester.pumpWidget(
      _Harness(startIndex: 2, onExit: () => exited = true),
    );

    await _pressBack(tester);
    await tester.tap(find.text('No'));
    await tester.pumpAndSettle();

    expect(exited, isFalse);
    expect(find.text('Do you still want to exit?'), findsNothing);
    expect(find.text('tab 2'), findsOneWidget);
  });

  testWidgets('"Yes" closes the app', (tester) async {
    var exited = false;
    await tester.pumpWidget(
      _Harness(startIndex: 2, onExit: () => exited = true),
    );

    await _pressBack(tester);
    await tester.tap(find.text('Yes'));
    await tester.pumpAndSettle();

    expect(exited, isTrue);
  });

  test('back on Home is the only tab that may close the app', () {
    expect(
      const AppBackHandler(
        currentIndex: 2,
        homeIndex: 2,
        onGoHome: _noop,
        child: SizedBox.shrink(),
      ).action,
      BackAction.confirmExit,
    );
    for (final tab in [0, 1, 3, 4]) {
      expect(
        const AppBackHandler(
          currentIndex: 0,
          homeIndex: 2,
          onGoHome: _noop,
          child: SizedBox.shrink(),
        ).action,
        BackAction.goHome,
        reason: 'tab $tab must walk to Home',
      );
    }
  });
}

void _noop() {}
