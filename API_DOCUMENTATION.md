# OmniPay SMS Relay — API Documentation

**Project:** OmniPay (INSTAWAG SOW v2)
**Component:** Node.js SMS Relay + Stellar Testnet Integration
**Milestone:** Week 1 — Project architecture, Firestore sync, Stellar SDK integration, Node.js SMS Relay foundation
**Status:** Functional foundation, running locally. Not yet publicly deployed. Signature verification exists on `/api/send` and signed-SMS; the plain-PIN SMS `SEND` channel remains active until `REQUIRE_SIGNED_SMS=true` is enabled for production. The web wallet's `/api/submit-payment` path is separate from this (client signs the transaction itself before sending it in) — see 3.3, it doesn't go through the same signature check.

*(Corrected this doc on second pass — it was missing the web submit endpoint and the admin key requirement on the dashboard endpoints. Both are in now.)*

---

## 1. Overview

The SMS Relay is an Express.js server that connects three systems:

1. **Android SMS Gateway** — receives SMS commands from users with no internet access and forwards them to this server via webhook.
2. **Firestore** — stores users, wallets (PIN-encrypted), transactions, events, and the relay-transaction status ledger.
3. **Stellar Testnet (via Horizon)** — executes the actual XLM payment once a request is authenticated.

Three ways a payment can actually get triggered:
- **SMS channel** — a user texts `SEND <amount> <recipient> <pin>` to the gateway number, optionally with a signed `SIG` suffix.
- **API channel** (`/api/send`) — a fully authenticated JSON request with a digital signature, used by the app or other trusted integrations.
- **Web wallet channel** (`/api/submit-payment`) — the browser app builds and signs the Stellar transaction itself (via Freighter or the user's decrypted local key) and just hands the relay a signed XDR to submit. No PIN or signature check happens server-side on this path since the signing already happened client-side.

The SMS and API channels converge on the same internal payment executor, so behavior (balance checks, self-send prevention, Stellar submission, Firestore updates) is identical regardless of entry point. The web wallet channel is thinner — it mostly just forwards an already-signed transaction to Horizon and logs it, so it skips most of that shared logic.

**Base URL (local dev):** `http://localhost:3000`

---

## 2. Authentication Model

| Layer | Purpose | Applies to |
|---|---|---|
| **PIN** (4–6 digits) | Decrypts the user's AES-GCM–encrypted Stellar secret key (PBKDF2-SHA256, 150,000 iterations, matches `script.js`) | SMS `SEND`/`BAL`, `/api/send` |
| **Digital signature** (Ed25519, using the user's existing Stellar keypair) | Proves the request truly came from `senderId` and wasn't tampered with in transit — stops SIM/caller-ID spoofing | `/api/send` (always required), signed SMS (optional unless `REQUIRE_SIGNED_SMS=true`) |
| **Webhook HMAC signature** (`X-Signature` / `X-Timestamp`) | Verifies the inbound webhook really came from the SMS gateway | `/webhook/sms-received` (only enforced if `SMS_GATEWAY_WEBHOOK_SECRET` is set) |
| **Admin API key** (`X-Admin-Key` header) | Gates the internal/dashboard endpoints so they're not wide open | `/api/relay-transactions`, `/api/relay-transactions/:id`, `/api/reconcile-balance/:userId` — all three via a shared `requireAdminKey` check. If `ADMIN_API_KEY` isn't set in the env, these routes respond `503` and stay disabled rather than falling open. |

**Canonical signed string** (must match byte-for-byte between client and server):
```
senderId|recipientId|amount(7dp)|timestamp(ms)|nonce|requestId
```
Signed with the sender's Stellar secret key; verified with their stored `walletPublic`. Signature ≠ authorization to spend — the PIN is still required to decrypt the wallet secret and actually move funds. This is an intentional two-factor design.

**Anti-replay:** Each `requestId` may only be claimed once (Firestore transaction against `omnipay_signed_requests` and `omnipay_used_nonces`). A reused `requestId` or `nonce` is rejected.

**PIN brute-force guard:** 5 wrong attempts locks the sender's phone/id for 15 minutes (in-memory, resets on server restart).

**SMS rate limit:** Max 10 inbound commands per sender per 60-second window.

---

## 3. Endpoints

### 3.1 `GET /health`

Basic liveness check.

**Request:** none

**Response `200`:**
```json
{ "ok": true }
```

**Errors:** none — this route cannot fail short of the server being down.

---

### 3.2 `POST /webhook/sms-received`

Inbound webhook called by the Android SMS Gateway every time a new SMS arrives at the gateway phone. This is how `SEND` and `BAL` commands reach the relay.

**Headers (optional, if `SMS_GATEWAY_WEBHOOK_SECRET` is configured):**
| Header | Description |
|---|---|
| `X-Signature` | HMAC-SHA256 of `rawBody + timestamp`, hex-encoded |
| `X-Timestamp` | Timestamp used in the HMAC |

**Request body:**
```json
{
  "event": "sms:received",
  "payload": {
    "sender": "09171234567",
    "message": "SEND 50 09179876543 1234",
    "id": "provider-message-id"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `event` | string | Yes | Must equal `"sms:received"`; other event types are acknowledged but ignored |
| `payload.sender` / `payload.phoneNumber` | string | Yes | Sender's phone number |
| `payload.message` | string | Yes | Raw SMS text — parsed as `SEND` or `BAL` |
| `payload.id` / `messageId` / `uuid` / `eventId` / `smsId` | string | No | Used to deduplicate retried webhook deliveries |

**Response `200` (ack — actual processing happens asynchronously):**
```json
{ "received": true }
```
or, for ignored event types:
```json
{ "ignored": true }
```

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `401` | `{ "error": "invalid signature" }` | HMAC signature missing/invalid when a webhook secret is configured |
| `400` | `{ "error": "missing sender/message" }` | Payload missing `sender` or `message` |

**Notes:**
- The server responds `200` immediately and processes the SMS asynchronously (`handleIncomingSms`), so the gateway isn't kept waiting.
- Duplicate deliveries of the same event (same provider message ID, or same sender+text+time bucket) are silently ignored — no double-processing, no double-charge.
- Outcomes (success, wrong PIN, insufficient balance, etc.) are communicated back to the user via an outbound SMS, not via this HTTP response.

---

### 3.3 `POST /api/send`

Authenticated payment endpoint. This is the "Node.js SMS Relay foundation with authenticated request processing" channel referenced in the SOW — signature-verified, replay-protected, PIN-gated.

**Request body:**
```json
{
  "senderId": "firebaseUid123",
  "recipientId": "juan_delacruz",
  "amount": 50,
  "timestamp": 1737350400000,
  "nonce": "b16f1e...",
  "requestId": "req-9f2a...",
  "signature": "base64-ed25519-signature",
  "pin": "1234"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `senderId` | string | Yes | Sender's Firestore/Firebase Auth UID |
| `recipientId` | string | Yes | Recipient's UID, username, or phone number — resolved in that order |
| `amount` | number | Yes | Must be > 0; formatted to 7 decimal places for signing/Stellar |
| `timestamp` | number (ms) | Yes | Must be within ±5 minutes of server time |
| `nonce` | string | Yes | Single-use, scoped per `senderId` |
| `requestId` | string | Yes | Single-use globally; idempotency key |
| `signature` | string (base64) | Yes | Raw Ed25519 signature (64 bytes decoded), signed with sender's Stellar secret key over the canonical payload string |
| `pin` | string (4–6 digits) | Yes | Decrypts sender's wallet secret to actually submit the Stellar transaction |

**Response `200` (success):**
```json
{
  "ok": true,
  "txHash": "a1b2c3...",
  "newSenderBalance": 449.9999900,
  "relayId": "relayDocId123"
}
```

**Errors:**
| Status | Body (`error` field) | Cause |
|---|---|---|
| `400` | `missing required authenticated-payload fields` | One of the required fields is absent |
| `400` | `invalid amount` | `amount` is not a positive finite number |
| `404` | `sender not found` | `senderId` has no matching user doc |
| `401` | `invalid signature` (+ `reason`) | Signature check failed — see reason codes below |
| `409` | `duplicate-request` / `nonce-reused` | Replay attempt |
| `500` | `could not process request` | Internal error while claiming the request |
| `423` | `too many wrong PIN attempts, try again later` | PIN lockout active (15 min) |
| `400` | `wallet not set up for signed payments — log in to the app once` | Sender has no encrypted wallet secret on file |
| `401` | `incorrect pin` | PIN failed to decrypt the wallet secret |
| `404` | `recipient not found` | `recipientId` doesn't resolve to any user |
| `422` | `insufficient-balance` / `self-send` / `stellar-failed` (+ `detail`) | Business-rule or Stellar submission failure |
| `500` | `internal error` | Unhandled exception |

**Signature-rejection reason codes** (nested under `reason` when status is `401 invalid signature`):
`missing-signature-or-key`, `missing-sender-or-recipient`, `missing-nonce-or-requestid`, `invalid-timestamp`, `timestamp-out-of-window`, `invalid-public-key`, `malformed-signature`, `signature-mismatch`.

Every request — successful or not — is tracked in `omnipay_relay_transactions` (see §3.7/3.8) via a `relayId`, walking through the lifecycle: `received → validated → submitted → confirmed → settled` (or `validation_failed` / `failed` on any rejection).

---

### 3.4 `POST /api/submit-payment`

This one was missing from the first draft of this doc. It's the endpoint the web wallet (index.html / script.js) actually calls when a logged-in user sends a payment from the browser — either through the Freighter extension or by signing locally with the user's decrypted Stellar secret. Either way, the transaction is already fully signed by the time it reaches the relay; this endpoint's job is just to build the relay record, submit the signed XDR to Horizon, and update the status.

**Request body:**
```json
{
  "senderId": "firebaseUid123",
  "recipientId": "juan_delacruz",
  "amount": 50,
  "signedXdr": "base64-encoded-signed-transaction-envelope"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `senderId` | string | Yes | Used to tag the relay record — not verified against a session server-side |
| `recipientId` | string | Yes | Recipient's UID or username |
| `amount` | number | Yes | Must be > 0 |
| `signedXdr` | string | Yes | Already-signed transaction envelope, built and signed entirely client-side |

**Response `200` (success):**
```json
{ "ok": true, "txHash": "a1b2c3...", "relayId": "relayDocId123" }
```

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `400` | `{ "error": "missing required fields" }` | One of the required fields is absent |
| `400` | `{ "error": "invalid amount", "relayId": ... }` | `amount` not a positive finite number |
| `400` | `{ "error": "malformed transaction", "relayId": ... }` | `signedXdr` can't be parsed with `TransactionBuilder.fromXDR` |
| `502` | `{ "error": "payment submission failed", "detail": ..., "relayId": ... }` | Horizon rejected the submitted transaction |

Worth flagging: unlike `/api/send`, this endpoint does **not** verify that `senderId` actually corresponds to the account that signed `signedXdr` — the trust boundary here is "whoever holds the signed transaction can submit it," which is fine for a Testnet MVP but should be revisited (e.g. checking the XDR's source account against `senderId`'s registered `walletPublic`) before this goes anywhere near Mainnet.

---

### 3.5 `POST /dev/simulate-sms`

Developer-only endpoint to trigger the SMS-processing pipeline without a real SMS or gateway — used for local testing and for reproducing the Week 1 evidence.

**Access restriction:** localhost only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Any other origin is rejected.

**Request body:**
```json
{
  "sender": "09171234567",
  "message": "SEND 50 09179876543 1234"
}
```

| Field | Type | Required |
|---|---|---|
| `sender` | string | Yes |
| `message` | string | Yes — same format as a real SMS command (`SEND ...` or `BAL ...`) |

**Response `200`:**
```json
{ "ok": true }
```
(Actual outcome of the simulated command is written to Firestore/console logs, same as a real inbound SMS — this endpoint just acknowledges that processing started.)

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `403` | `{ "error": "dev endpoint is localhost-only" }` | Called from a non-localhost origin |
| `400` | `{ "error": "sender and message required" }` | Missing field |
| `500` | `{ "error": "<message>" }` | Unhandled exception during processing |

---

### 3.6 `GET /api/relay-transactions`

Monitoring-dashboard feed — recent relay transactions across all channels (SMS, API, web).

**Headers:** requires `X-Admin-Key: <ADMIN_API_KEY>` — see the Admin API Key row in §2. Without it (or with the wrong key), this returns before touching Firestore at all.

**Query parameters:**
| Param | Type | Required | Notes |
|---|---|---|---|
| `status` | string | No | Filter by lifecycle status, e.g. `?status=settled` |
| `limit` | number | No | Default 50, capped at 200 |

**Response `200`:**
```json
{
  "transactions": [
    {
      "id": "relayDocId123",
      "channel": "sms",
      "senderPhone": "09171234567",
      "senderId": "firebaseUid123",
      "recipient": "09179876543",
      "amount": 50,
      "status": "settled",
      "statusHistory": [
        { "status": "received", "at": 1737350400000 },
        { "status": "validated", "at": 1737350400500 },
        { "status": "submitted", "at": 1737350401000 },
        { "status": "confirmed", "at": 1737350402500, "detail": "..." },
        { "status": "settled", "at": 1737350403000 }
      ],
      "txHash": "a1b2c3..."
    }
  ]
}
```

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "admin endpoints disabled — set ADMIN_API_KEY" }` | Server has no `ADMIN_API_KEY` configured |
| `401` | `{ "error": "unauthorized" }` | `X-Admin-Key` missing or wrong |
| `500` | `{ "error": "internal error" }` | Firestore query failure |

**Note:** Filtering by `status` while ordering by `createdAt` requires a Firestore composite index — Firestore logs a console link to create it on first use.

---

### 3.7 `GET /api/relay-transactions/:id`

Fetch a single relay transaction with full status history.

**Headers:** also requires `X-Admin-Key` — same as §3.6.

**Path parameter:** `id` — the relay transaction's Firestore document ID.

**Response `200`:** same shape as one item in §3.6.

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "admin endpoints disabled — set ADMIN_API_KEY" }` | Server has no `ADMIN_API_KEY` configured |
| `401` | `{ "error": "unauthorized" }` | `X-Admin-Key` missing or wrong |
| `404` | `{ "error": "not found" }` | No transaction with that ID |
| `500` | `{ "error": "internal error" }` | Firestore query failure |

---

### 3.8 `POST /api/reconcile-balance/:userId`

Forces a user's Firestore `xlmBalance` to match their real on-chain Stellar balance. Useful when local bookkeeping and the ledger drift (e.g. after a failed update).

**Headers:** also requires `X-Admin-Key` — same as §3.6/§3.7.

**Path parameter:** `userId` — Firestore user doc ID.

**Response `200`:**
```json
{
  "ok": true,
  "userId": "firebaseUid123",
  "xlmBalance": 449.9999900
}
```

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "admin endpoints disabled — set ADMIN_API_KEY" }` | Server has no `ADMIN_API_KEY` configured |
| `401` | `{ "error": "unauthorized" }` | `X-Admin-Key` missing or wrong |
| `404` | `{ "error": "user not found" }` | No user doc with that ID |
| `400` | `{ "error": "user has no walletPublic on file" }` | User has no Stellar public key registered |
| `502` | `{ "error": "could not read balance from Stellar/Horizon" }` | Horizon read failed |
| `500` | `{ "error": "internal error" }` | Unhandled exception |

---

## 4. SMS Command Reference

Sent as plain text to the gateway phone number.

| Command | Format | Example |
|---|---|---|
| Send payment | `SEND <amount> <recipient> <pin>` | `SEND 50 09171234567 1234` |
| Send payment (signed, optional) | `SEND <amount> <recipient> <pin> SIG <timestamp> <nonce> <requestId> <signature>` | — built by the app via `buildAndSignPayload()` |
| Check balance | `BAL <pin>` or `BALANCE <pin>` | `BAL 1234` |

`<recipient>` may be another user's registered mobile number or username.

Replies are sent back via SMS (not HTTP), e.g.:
- `OmniPay: Sent 50 XLM to juan_delacruz. TX: a1b2c3d4e5f6... New balance: 449.9999 XLM.`
- `OmniPay: Incorrect PIN. Payment not sent.`
- `OmniPay: Insufficient balance. You have 12.5000 XLM.`

---

## 5. How to Replicate Locally (Week 1 evidence)

```bash
npm install
# create .env with: FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_PROJECT_ID,
# STELLAR_HORIZON_URL (optional, defaults to testnet), etc.
node server.js
```

Then, from the same machine (required — the endpoint is localhost-only):
```bash
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"SEND 50 09179876543 1234"}'
```

Check the health endpoint:
```bash
curl http://localhost:3000/health
```

Inspect the resulting relay transaction:
```bash
curl http://localhost:3000/api/relay-transactions?limit=5
```

---

## 6. Firestore Data Model

Firestore itself is **not a custom REST API this project built** — it's Google's managed database, reached two different ways in this codebase. Both are documented here since "Firestore sync" is explicit Week 1 scope in the SOW, but neither is an HTTP endpoint like §3.

| Access path | Used by | Auth boundary |
|---|---|---|
| **Firebase Client SDK** (`firebase.firestore()`) | `script.js` / `index.html` (the browser app) | Firestore Security Rules — the client talks to Firestore directly, no relay server involved |
| **Firebase Admin SDK** (`firebase-admin/firestore`) | `server.js` | Bypasses security rules entirely (trusted server context) — this is what powers every endpoint in §3 |

### Collections

| Collection | Written by | Purpose | Key fields |
|---|---|---|---|
| `users` | Client (profile fields) + Server (balance, transactions) | One doc per user, keyed by Firebase Auth UID | `phone`, `username`, `walletPublic`, `xlmBalance`, `pinWalletSecretEncrypted`, `pinWalletSecretSalt`, `pinWalletSecretIv`, `transactions[]` |
| `usernames` | Client | Username → UID lookup, used at signup/login to resolve a typed username | doc ID = lowercased username |
| `omnipay_events` | Server (`logEvent`) | Activity/error feed shown in the app UI (e.g. "Incorrect PIN") | `userId`, `icon`, `message`, `type`, `createdAt` |
| `omnipay_sms_events` | Server | Inbound-SMS idempotency ledger — prevents a gateway retry from double-processing the same SMS | `kind`, `status`, `senderPhone`, `messageHash`, `createdAt` |
| `omnipay_relay_transactions` | Server | The transaction-lifecycle ledger exposed via `GET /api/relay-transactions` (§3.6/3.7) | `channel`, `senderId`/`senderPhone`, `recipient`, `amount`, `status`, `statusHistory[]`, `txHash` |
| `omnipay_signed_requests` | Server | Replay-protection: one doc per `requestId`, created exactly once | `senderId`, `nonce`, `status` |
| `omnipay_used_nonces` | Server | Replay-protection: one doc per `senderId:nonce` pair | `senderId`, `requestId` |

### Notes

- The client's `firebaseConfig.apiKey` visible in `script.js` is expected to be public for a Firebase web app — actual protection comes from **Firestore Security Rules**, not from hiding that key. Those rules aren't in this repo yet and should be reviewed/tightened before public launch (e.g. a client should never be able to write its own `xlmBalance` or `pinWalletSecretEncrypted` directly).
- The client keeps a **realtime listener** (`onSnapshot`) on its own `users/{uid}` doc, which is how the app UI updates live when the server changes a balance or appends a transaction — no polling, no extra endpoint needed.
- `omnipay_signed_requests` and `omnipay_used_nonces` should get a Firestore TTL policy so old entries don't grow forever (noted again in §7).

## 7. Known Limitations (Week 1 stage)

- Not yet deployed publicly — runs on localhost only.
- `REQUIRE_SIGNED_SMS=false` by default — plain PIN-only SMS `SEND` is still accepted alongside the signed variant.
- No Soroban smart contract integration yet (planned Week 2).
- PIN lockout and SMS rate limiting are in-memory only — reset on server restart; not yet persisted or shared across instances.
- No Firestore TTL policy yet configured on `omnipay_signed_requests` / `omnipay_used_nonces` (recommended before production).
- `/api/submit-payment` (§3.4) doesn't check that `senderId` actually matches the account that signed the transaction — anyone holding a validly-signed XDR could post it with an arbitrary `senderId`. Fine for a Testnet MVP demo, but should be tied to a real session check before this is treated as production-ready.
- `ADMIN_API_KEY` is a single shared secret with no rotation or per-admin scoping — acceptable for a 30-day sprint, not for the eventual multi-admin dashboard.