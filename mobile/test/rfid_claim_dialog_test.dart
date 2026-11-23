// The RFID claim dialog must not leave a person staring at a dead spinner
// while the cart's reader has dropped off Wi-Fi mid-window. The countdown
// starts (reader online), the reader then goes offline, and the screen
// switches to a clear "lost connection" message with a Retry.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/rfid_registration.dart';
import 'package:cartiq_mobile/widgets/rfid_claim_dialog.dart';

class _FakeStore implements KeyValueStore {
  final Map<String, String?> values = {};

  @override
  Future<String?> read({required String key}) async => values[key];

  @override
  Future<void> write({required String key, required String? value}) async {
    values[key] = value;
  }

  @override
  Future<void> delete({required String key}) async {
    values.remove(key);
  }
}

/// Scripted claim views: poll 1 reports the reader online, poll 2 reports
/// it lost (emulating an ESP32 brownout / power loss mid-window), and every
/// poll after that expires the claim so the polling loop terminates
/// naturally.
class _FakeApi extends ApiClient {
  _FakeApi() : super(secureStorage: _FakeStore());

  int _statusCalls = 0;

  @override
  Future<Map<String, dynamic>> startRfidClaim(
    String token, {
    String? locationCode,
    String? event,
  }) async =>
      {
        'claimId': 'claim-1',
        'status': 'pending',
        'rfidUid': null,
        'locationCode': locationCode ?? 'CART-01',
        'event': event,
        'expiresAt': DateTime.now()
            .add(const Duration(seconds: 30))
            .toIso8601String(),
      };

  @override
  Future<Map<String, dynamic>> rfidClaimStatus(
    String token,
    String claimId,
  ) async {
    _statusCalls++;
    if (_statusCalls == 1) {
      return {
        'status': 'pending',
        'deviceOnline': true,
        'readerLastSeenSeconds': 3,
      };
    }
    if (_statusCalls == 2) {
      return {
        'status': 'pending',
        'deviceOnline': false,
        'readerLastSeenSeconds': 124,
      };
    }
    return {'status': 'expired'};
  }
}

void main() {
  testWidgets('a reader that drops mid-window shows the lost-connection pane',
      (tester) async {
    final registration = RfidRegistrationService(apiClient: _FakeApi());

    Widget harness() => MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => RfidClaimDialog.show(
                  context,
                  token: 'tok',
                  registration: registration,
                  event: 'IN',
                  title: 'Tap to time in',
                  message: 'Tap your card',
                ),
                child: const Text('open claim'),
              ),
            ),
          ),
        );

    await tester.pumpWidget(harness());
    await tester.tap(find.text('open claim'));
    await tester.pump(); // dialog appears, _run() starts
    await tester.pump(const Duration(milliseconds: 50)); // claim + first poll
    await tester.pump(); // flush the setState from poll 1

    // Reader was online -> the wait is on screen.
    expect(find.textContaining('Waiting for your card'), findsOneWidget);
    expect(find.textContaining('lost its Wi-Fi connection'), findsNothing);

    // Poll 2 says the reader dropped -> the pane must switch.
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();

    expect(find.textContaining('lost its Wi-Fi connection'), findsOneWidget);
    expect(find.textContaining('Waiting for your card'), findsNothing);
    expect(find.text('Retry'), findsOneWidget);

    // End the polling (poll 3 returns "expired"), then close the dialog so
    // it disposes its timers. The test binding demands no timers remain
    // pending at the end of the test.
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.textContaining('No card tapped in time.'), findsOneWidget);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
  });
}
