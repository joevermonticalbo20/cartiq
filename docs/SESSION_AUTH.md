# Session & Auth — CartIQ

The design for sitting in front of the panel. Everything listed here is
implemented in `api/src/routes/auth.js` (Express) and mirrored in
`supabase/functions/api/index.ts` (production Edge). Both copies are tested.

## The short version

- Access token: **15 minutes**, HS256, short-lived by design.
- Refresh token: **30 days**, one-time use, rotated on every refresh.
- Refresh tokens are stored **hashed (SHA-256)** — read access to the
  database never exposes a live session.
- A replay of a rotated refresh token is treated as an attack and
  **revokes every session of that user** (break-glass).
- Web sessions live in **sessionStorage** (per-tab), never localStorage.
- Password change/reset goes through **email OTP**, not password-hints.
- Repeated wrong passwords lock the account; PIN unlock for offline use is
  rate-limited on the device, the server validates it on the next contact.

## The seven layers

### 1. Short-lived access tokens

`POST /auth/login` returns a pair: an access token (`expiresIn: 15m`) and a
refresh token (`expiresIn: 30d`). The access token carries `type: "access"`
and the refresh token carries `type: "refresh"`, so one can never stand in
for the other. Verification checks the `type` claim explicitly.

An attacker who obtains an access token has 15 minutes of value, not a
permanent credential.

### 2. Refresh-token rotation

Every call to `POST /auth/refresh`:

1. verifies the JWT signature and `type: "refresh"`,
2. finds the matching row in `refreshTokens` (by hash),
3. deletes that row (one-time use),
4. mints a fresh pair.

Making the token one-time-use closes the "read it once, replay it forever"
window: a stolen refresh token that is rotated once becomes unusable on its
second presentation, and a second presentation is a signal, not just an
error.

### 3. Token theft detection (break-glass)

`POST /auth/refresh` deliberately treats a **valid-signed refresh token with
no row in `refreshTokens`** as a replay of an already-rotated token:

```
delete all refreshTokens for that user
→ 401 Session invalid - please sign in again
```

Every session the user had — on every device — is invalidated the moment a
stolen token is replayed. The legitimate user simply logs in again; the
attacker never mints an access token. This is strictly more protective than
the usual "401, try again" and stops lateral movement.

Same protection when the token record vanished (e.g., device cleared its
token): the attacker gets nothing.

### 4. Hashed at rest

The `refreshTokens` collection stores `SHA-256(token)`, not the token. A
read-only database breach (e.g., a leaked service account) exposes digests
that cannot be replayed — the verifier hashes the presented token before the
lookup. Plaintext JWTs never appear in the collection.

Tokens are hashed the same way for OTP codes and e-mail hashes, following
the app's existing pattern.

### 5. Session revocation is one-way and total

| Event | Sessions destroyed |
|---|---|
| `POST /auth/logout` | that refresh token only |
| Password change (OTP) | every token of the user |
| Recovery email change | every token of the user |
| Account deleted | every token of the user |
| Refresh replay detected | every token of the user (break-glass) |

No session can be selectively revoked from the outside — the server is
always authoritative about who may hold a token.

### 6. Defense in depth on the door

- Login lockout: **5 wrong passwords → 5-minute wait** (`login_lockout.js`),
  plus a coarse per-IP spray guard.
- Forgot password / change password / OTP verification all have per-IP and
  per-account rate limits.
- OTP codes: 6 digits, hashed at rest, max 5 attempts, 60 s resend cooldown,
  deleted on use; the reset surface is deliberately silent on whether an
  account exists.
- PIN unlock: 6-digit device PIN, the server re-verifies the account the
  moment the device is back online; offline access is capped at 7 days.

### 7. The phone keeps its own secrets in the keystore

The access/refresh pair lives in `flutter_secure_storage` (Android Keystore
on device). The web dashboard keeps its token in `sessionStorage`, one
tab at a time: closing the tab or the browser clears the session. The CSP
headers on the hosting make the XSS blast radius small too.

## What the panel should remember

> Short-lived tokens, one-time refresh rotation, replay ⇒ full
> family-revocation, hashed at rest, session storage per tab, and a
> verification step for every password change. CartIQ refuses to hand out
> a session that can be kept.
