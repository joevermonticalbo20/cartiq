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
  RfidRegistrationService({ApiClient? apiClient}) : api = apiClient ?? ApiClient();

  final ApiClient api;

  /// How long to keep polling after the server says the window is still open.
  /// The server enforces its own TTL; this is only a client-side stop so a
  /// wedged response cannot spin here forever.
  static const _maxPollMs = 120000;
  static const _pollIntervalMs = 1500;

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
    try {
      final claim = await api.startRfidClaim(
        token,
        locationCode: locationCode,
        event: event,
      );
      final claimId = claim['claimId'] as String?;
      if (claimId == null || claimId.isEmpty) {
        return const RfidFailed('Server did not return a claim.');
      }
      final expiresAt =
          DateTime.tryParse(claim['expiresAt'] as String? ?? '')?.toLocal() ??
              DateTime.now();

      final deadline = DateTime.now().add(const Duration(milliseconds: _maxPollMs));
      while (true) {
        final left = expiresAt.difference(DateTime.now());
        if (left.isNegative) return const RfidExpired();
        onTick?.call(left.inSeconds);

        await Future<void>.delayed(
          const Duration(milliseconds: _pollIntervalMs),
        );
        if (DateTime.now().isAfter(deadline)) return const RfidExpired();

        final view = await api.rfidClaimStatus(token, claimId);
        final status = view['status'] as String?;
        switch (status) {
          case 'bound':
            final uid = view['rfidUid'] as String?;
            if (uid == null || uid.isEmpty) {
              return const RfidFailed('Registered, but no card number came back.');
            }
            final resolved = view['resolvedEvent'] as String?;
            // Asked to clock in/out but nothing was written: say so instead of
            // showing a success the shift log does not agree with.
            if (event != null && (resolved == null || resolved.isEmpty)) {
              return const RfidNoShift();
            }
            return RfidBound(uid, event: resolved);
          case 'conflict':
            // The server names the holder so the person at the cart knows they
            // grabbed somebody else's card rather than seeing a bare error.
            return RfidConflict(view['holderName'] as String? ?? '');
          case 'expired':
            return const RfidExpired();
          case 'pending':
            break;
          default:
            return RfidFailed('Unexpected claim status: $status');
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
  static String describe(RfidClaimResult result, {String? event}) {
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
      case RfidExpired():
        return 'No card tapped in time.';
      case RfidNoShift():
        return event == 'OUT'
            ? 'Card read, but no time-out recorded.'
            : 'Card read, but no time-in recorded.';
      case RfidUnbound():
        return 'Card removed from this account.';
      case RfidFailed(:final message):
        return message;
    }
  }
}