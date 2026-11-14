import 'dart:async';

import 'api_client.dart';

/// Outcome of one registration attempt, in the shape the UI reacts to.
sealed class RfidClaimResult {
  const RfidClaimResult();
}

/// Card registered. [rfidUid] is the tag now on the account.
class RfidBound extends RfidClaimResult {
  const RfidBound(this.rfidUid, {this.event});

  final String rfidUid;

  /// The shift the server actually wrote: `"IN"`, `"OUT"`, or null when the
  /// person was only enrolling a card. Read from the response rather than from
  /// what was requested, so the toast never claims a clock-in that the shift log
  /// does not have.
  final String? event;
}

/// The card belongs to somebody else. [holderName] is who has it, so the person
/// at the cart knows they grabbed the wrong card instead of seeing a bare error.
class RfidConflict extends RfidClaimResult {
  const RfidConflict(this.holderName);
  final String holderName;
}

/// The card is not on any account yet.
///
/// Only possible while clocking in or out: the person pressed Time in / Time
/// out and tapped a tag that belongs to nobody. The tap is NOT a registration -
/// the card must be enrolled deliberately from Settings, so a tag can never be
/// taken over by whoever happens to clock in with it.
class RfidUnregistered extends RfidClaimResult {
  const RfidUnregistered();
}

/// The card is enrolled at another cart.
///
/// A card belongs to the cart where it was enrolled: each cart has its own
/// team, so a card enrolled at CART-01 does not work at CART-02.
/// [cardLocationCode] is the cart it belongs to, so the app can name it.
class RfidWrongCart extends RfidClaimResult {
  const RfidWrongCart(this.cardLocationCode);
  final String cardLocationCode;
}

/// The card is already registered to this account.
///
/// Enrolling it again would change nothing, so the app says that instead of
/// claiming a card was registered. Clocking is not affected: tapping your own
/// card to time in still records the shift.
class RfidAlreadyRegistered extends RfidClaimResult {
  const RfidAlreadyRegistered();
}

/// Nobody tapped before the window closed.
class RfidExpired extends RfidClaimResult {
  const RfidExpired();
}

/// The network or the server failed. Registration needs the server: the claim
/// lives there, and only the reader's tap can complete it.
class RfidFailed extends RfidClaimResult {
  const RfidFailed(this.message);
  final String message;
}

/// The tap registered the card but wrote no shift: the person asked to clock in
/// or out and the server did not record one. Kept separate from [RfidBound] so
/// the card saving and the clocking are never reported as one thing.
class RfidNoShift extends RfidClaimResult {
  const RfidNoShift();
}

/// The server read the card but refused the shift: outside the clock window,
/// already timed in today, or the card belongs to another cart.
///
/// [reason] is the server's own words ("You already timed in today at 8:35
/// PM."), so the app says exactly what happened instead of guessing.
class RfidRefused extends RfidClaimResult {
  const RfidRefused(this.reason);

  final String reason;
}

/// The account's card was removed.
class RfidUnbound extends RfidClaimResult {
  const RfidUnbound();
}

/// Drives one "tap your card" registration against the cart's RFID reader.
///
/// The reader cannot be reached from the phone, so this polls the server for
/// the claim it opened. Polling (rather than a push stream) keeps the app
/// usable on the same flaky connections the offline queue already handles, and
/// the claim TTL is short enough that a handful of polls is enough.
class RfidRegistrationService {
  RfidRegistrationService({ApiClient? apiClient, this.refreshToken})
      : api = apiClient ?? ApiClient();

  final ApiClient api;

  /// Returns a fresh access token, or null when the session cannot be renewed
  /// here. Optional so offline/unit-tested instances behave as before; when
  /// present, a mid-claim 401 is recovered instead of failing the claim.
  final Future<String?> Function()? refreshToken;

  /// How long to keep polling after the server says the window is still open.
  /// The server enforces its own TTL; this is only a client-side stop so a
  /// wedged response cannot spin here forever.
  static const _maxPollMs = 120000;
  static const _pollIntervalMs = 1000;

  /// Open a claim and poll it until it resolves.
  ///
  /// [onTick] fires on every poll with the seconds left, so the dialog can show
  /// a countdown instead of an open-ended spinner.
  Future<RfidClaimResult> register({
    required String token,
    String? locationCode,
    String? event,
    void Function(int secondsLeft)? onTick,
  }) async {
    // The token can lapse while the person is walking to the reader. The claim
    // lives on the server, so refreshing and continuing is correct — never a
    // reason to throw away a pending card or tell the user to start over.
    var activeToken = token;
    Future<Map<String, dynamic>> callWithRefresh(
      Future<Map<String, dynamic>> Function(String) call,
    ) async {
      try {
        return await call(activeToken);
      } on ApiException catch (e) {
        if (e.statusCode != 401 || refreshToken == null) rethrow;
        final fresh = await refreshToken!();
        if (fresh == null || fresh.isEmpty || fresh == activeToken) rethrow;
        activeToken = fresh;
        return call(activeToken);
      }
    }

    try {
      final claim = await callWithRefresh(
        (t) => api.startRfidClaim(t, locationCode: locationCode, event: event),
      );
      final claimId = claim['claimId'] as String?;
      if (claimId == null || claimId.isEmpty) {
        return const RfidFailed('Server did not return a claim.');
      }
      final expiresAt =
          DateTime.tryParse(claim['expiresAt'] as String? ?? '')?.toLocal() ??
              DateTime.now();

      final deadline = DateTime.now().add(const Duration(milliseconds: _maxPollMs));
      // Fully connected BEFORE the countdown starts: the dialog must stay on
      // "Connecting..." until the first status poll succeeds. Polling right
      // away (instead of waiting a second) also means a tap that happens in
      // the first second is seen immediately.
      //
      // Ticks run on a fixed 1s grid anchored to the first successful poll,
      // so the number drops by exactly 1 every second regardless of how long
      // each HTTP request takes. The old loop waited a full second AFTER
      // every request, so a slow network turned a 1s countdown into 2s steps.
      var firstPoll = true;
      var nextAt = DateTime.now();
      while (true) {
        if (!firstPoll) {
          final wait = nextAt.difference(DateTime.now());
          if (wait.inMilliseconds > 0) {
            await Future<void>.delayed(wait);
          }
          if (DateTime.now().isAfter(deadline)) return const RfidExpired();
        }

        final view = await callWithRefresh((t) => api.rfidClaimStatus(t, claimId));
        final status = view['status'] as String?;
        switch (status) {
          case 'bound':
            final uid = view['rfidUid'] as String?;
            if (uid == null || uid.isEmpty) {
              return const RfidFailed('Registered, but no card number came back.');
            }
            final resolved = view['resolvedEvent'] as String?;
            // Asked to clock in/out but nothing was written: say so instead of
            // showing a success the shift log does not agree with. The server
            // sends its own words for the refusal ("You already timed in
            // today at 8:35 PM."), so the toast is the truth.
            if (event != null && (resolved == null || resolved.isEmpty)) {
              final reason = (view['reason'] as String? ?? '').trim();
              return reason.isEmpty ? const RfidNoShift() : RfidRefused(reason);
            }
            return RfidBound(uid, event: resolved);
          case 'conflict':
            // The server names the holder so the person at the cart knows they
            // grabbed somebody else's card rather than seeing a bare error.
            return RfidConflict(view['holderName'] as String? ?? '');
          case 'unregistered':
            // Clocking with a card that is on nobody's account. The server
            // refused to enrol it, so the app says so instead of pretending
            // the shift was recorded.
            return const RfidUnregistered();
          case 'wrong_cart':
            // The card is enrolled at another cart. It does not work here, so
            // the app names the cart it belongs to.
            return RfidWrongCart(view['cardLocationCode'] as String? ?? '');
          case 'already_registered':
            // The card is already on this account. Nothing changed, and the
            // app says so instead of claiming a card was registered.
            return const RfidAlreadyRegistered();
          case 'expired':
            return const RfidExpired();
          case 'pending':
            break;
          default:
            return RfidFailed('Unexpected claim status: $status');
        }

        // Still waiting. Anchor/advance the 1s grid first, then tick with the
        // authoritative server expiry so the display is always true to the
        // 90s window, no matter how long the request above took.
        //
        // Only tick once the cart's reader is actually online: while
        // deviceOnline is false the dialog must stay on "Connecting..." so
        // the 90s window never burns down for an offline ESP32. Older
        // servers omit the field; missing is treated as online so they keep
        // the previous (always-counting) behavior instead of hanging a claim.
        if (firstPoll) {
          nextAt = DateTime.now().add(const Duration(milliseconds: _pollIntervalMs));
          firstPoll = false;
        } else {
          nextAt = nextAt.add(const Duration(milliseconds: _pollIntervalMs));
          if (nextAt.isBefore(DateTime.now())) {
            nextAt = DateTime.now().add(const Duration(milliseconds: _pollIntervalMs));
          }
        }
        if (view['deviceOnline'] != false) {
          final left = expiresAt.difference(DateTime.now());
          if (left.isNegative) return const RfidExpired();
          onTick?.call(left.inSeconds);
        }
      }
    } on ApiException catch (e) {
      return RfidFailed(e.message);
    } catch (e) {
      return RfidFailed('Registration failed: $e');
    }
  }

  /// One-line summary for a finished attempt.
  /// One-line summary for a finished attempt.
  ///
  /// [event] is what the person pressed ("IN"/"OUT"), because the outcome object
  /// is shared between clocking and card enrolment. The wording always follows
  /// [RfidBound.event] - what the server wrote - never the request.
  ///
  /// [hasRegisteredCard] says whether the account already has a card: it
  /// decides whether the person is told to tap the card they have, or to
  /// register one first.
  static String describe(
    RfidClaimResult result, {
    String? event,
    bool hasRegisteredCard = true,
  }) {
    switch (result) {
      case RfidBound():
        final written = result.event;
        if (event != null && (written == 'IN' || written == 'OUT')) {
          return written == 'IN' ? 'Time in' : 'Time out';
        }
        return 'Card registered  ${result.rfidUid}';
      case RfidConflict(:final holderName):
        return holderName.isEmpty
            ? 'That card is already registered to someone else.'
            : 'That card already belongs to $holderName.';
      case RfidUnregistered():
        // The card is on nobody's account. Clocking never enrols a card, so
        // the person is pointed back at the card they already have.
        return hasRegisteredCard
            ? 'This card is not registered here. Please tap the registered card.'
            : 'This card is not registered here. Register your card first.';
      case RfidWrongCart(:final cardLocationCode):
        return cardLocationCode.isEmpty
            ? 'That card belongs to another cart.'
            : 'That card is registered at $cardLocationCode.';
      case RfidAlreadyRegistered():
        return 'This card is already registered.';
      case RfidExpired():
        return 'No card tapped in time.';
      case RfidNoShift():
        return event == 'OUT'
            ? 'Card read, but no time-out recorded.'
            : 'Card read, but no time-in recorded.';
      case RfidRefused(:final reason):
        // The server's own words. Fall back to the vague line only when it
        // sent none.
        return reason.isEmpty
            ? (event == 'OUT'
                ? 'Card read, but no time-out recorded.'
                : 'Card read, but no time-in recorded.')
            : reason;
      case RfidUnbound():
        return 'Card removed from this account.';
      case RfidFailed(:final message):
        return message;
    }
  }
}