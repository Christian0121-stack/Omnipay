# OmniPay SMS Relay — API Documentation

**Project:** OmniPay (INSTAWAG SOW v2)
**Component:** Node.js SMS Relay + Soroban / Stellar Testnet Integration
**Milestone:** Week 2 — Node.js SMS Relay, authenticated SMS payload validation, signature verification, nonce and timestamp replay protection, Soroban smart contract integration, initial SMS transaction testing
**Status:** Running locally. Not yet publicly deployed. Signed SMS is required by default (`REQUIRE_SIGNED_SMS=true`). The Soroban contract is invoked when `SOROBAN_CONTRACT_ID` is set; contract deployment on Stellar Testnet is Week 3. The web wallet's `/api/submit-payment` path is separate (the client signs the transaction itself before sending it in) — see 3.5.

---

## 1. Overview

The SMS Relay is an Express.js server that connects four systems:

1. **Android SMS Gateway** — receives SMS commands from users with no internet access and forwards them to this server via webhook.
2. **Firestore** — stores users, wallets, transactions, events, the replay-protection records and the relay-transaction status ledger.
3. **Soroban smart contract (via Soroban RPC)** — records the settlement and the Request ID for each approved payment.
4. **Stellar Testnet (via Horizon)** — executes the actual XLM payment once a request is authenticated.

Three ways a payment can actually get triggered:
- **SMS channel** — a user texts `SEND <amount> <recipient> <pin> SIG <timestamp> <nonce> <requestId> <signature>` to the gateway number. Unsigned `SEND` is rejected unless `REQUIRE_SIGNED_SMS=false`.
- **API channel** (`/api/send`) — a fully authenticated JSON request with a digital signature, used by the app or other trusted integrations.
- **Web wallet channel** (`/api/submit-payment`) — the browser app builds and signs the Stellar transaction itself (via Freighter or the user's local key) and hands the relay a signed XDR to submit. No PIN or signature check happens server-side on this path since the signing already happened client-side.

The SMS and API channels converge on the same internal payment executor, so behavior (balance checks, self-send prevention, Soroban recording, Stellar submission, Firestore updates) is identical regardless of entry point. The web wallet channel forwards an already-signed transaction to Horizon and logs it, so it skips most of that shared logic.

**Base URL (local dev):** `http://localhost:3000`

---

## 2. Authentication Model

| Layer | Purpose | Applies to |
|---|---|---|
| **PIN** (4–6 digits) | Verified against the PBKDF2-SHA256 hash stored on the user record, with a constant-time comparison | SMS `SEND`/`BAL`, `/api/send` |
| **Digital signature** (Ed25519, using the user's existing Stellar keypair) | Proves the request came from `senderId` and was not altered in transit — stops SIM/caller-ID spoofing | `/api/send` (always required), SMS `SEND` (required unless `REQUIRE_SIGNED_SMS=false`) |
| **Webhook HMAC signature** (`X-Signature` / `X-Timestamp`) | Verifies the inbound webhook came from the SMS gateway | `/webhook/sms-received` (all requests are rejected until `SMS_GATEWAY_WEBHOOK_SECRET` is configured) |
| **Settlement signer** (`SETTLEMENT_SIGNER_SECRET`) | Signs the Soroban invocation and the Stellar payment. Must be an enabled signer on the sender's Stellar account | Every SMS and `/api/send` settlement |
| **Admin API key** (`X-Admin-Key` header) | Gates the internal/dashboard endpoints | `/api/relay-transactions`, `/api/relay-transactions/:id`, `/api/replay-audit/:requestId`, `/api/reconcile-balance/:userId` — all via a shared `requireAdminKey` check. If `ADMIN_API_KEY` isn't set, these routes respond `503` and stay disabled. |

**Canonical signed string** (must match byte-for-byte between client and server):
```
OMNIPAY-v1|senderId|recipientId|amount(7dp)|timestamp(ms)|nonce|requestId
```
Signed with the sender's Stellar secret key; verified with their stored `walletPublic`. No field may contain `|`. The signature is base64 and exactly 64 bytes when decoded. A valid signature is not authorization to spend — the PIN is still required. This is an intentional two-factor design.

**Timestamp window:** the timestamp must be within ±5 minutes of server time.

**Anti-replay:** each `requestId` may only be claimed once, and each `(senderId, nonce)` pair may only be used once. Both are written in a single Firestore transaction against `relay_requests` and `omnipay_used_nonces`. `requestId` must match `^[A-Za-z0-9_-]{16,128}$`. A repeated attempt is rejected, `replayCount` on the original record is incremented, and the original transaction hash is returned without creating a new settlement.

**Request ID & idempotency on-chain:** the `requestId` is passed to the Soroban contract with every settlement so the contract can reject duplicate settlement.

**PIN brute-force guard:** 5 wrong attempts locks the sender's phone/id for 15 minutes (in-memory, resets on server restart).

**SMS rate limit:** max 10 inbound commands per sender per 60-second window. `/api/send` and `/api/submit-payment` are limited to 20 requests per minute.

---

## 3. Endpoints

### 3.1 `GET /health`

Liveness and dependency check.

**Request:** none

**Response `200`:**
```json
{
  "ok": true,
  "timestamp": "2026-08-20T10:00:00.000Z",
  "services": {
    "firestore": { "status": "ok" },
    "horizon": { "status": "ok" },
    "soroban": { "status": "ok" }
  }
}
```
`services.soroban` is present only when `SOROBAN_CONTRACT_ID` is set.

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | same shape with `"ok": false` | Firestore, Horizon or Soroban RPC is unreachable |

---

### 3.2 `POST /webhook/sms-received`

Inbound webhook called by the Android SMS Gateway every time a new SMS arrives at the gateway phone. This is how `SEND` and `BAL` commands reach the relay.

**Headers (required):**
| Header | Description |
|---|---|
| `X-Signature` | HMAC-SHA256 of `rawBody + timestamp`, hex-encoded, keyed with `SMS_GATEWAY_WEBHOOK_SECRET` |
| `X-Timestamp` | Timestamp used in the HMAC |

**Request body:**
```json
{
  "event": "sms:received",
  "payload": {
    "sender": "09171234567",
    "message": "SEND 50.0000000 09179876543 1234 SIG 1790000000000 9f2c... 4b7a... MEUCIQ...",
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
or, for ignored event types or non-phone senders:
```json
{ "ignored": true }
```

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `401` | `{ "error": "invalid signature" }` | HMAC signature missing/invalid, or no webhook secret configured |
| `400` | `{ "error": "missing sender/message" }` | Payload missing `sender` or `message` |

**Notes:**
- The server responds `200` immediately and processes the SMS asynchronously, so the gateway isn't kept waiting.
- Duplicate deliveries of the same event (same provider message ID, or same sender+text+time bucket) are ignored — no double-processing, no double-charge.
- Outcomes (success, wrong PIN, signature failure, duplicate request, insufficient balance, etc.) are communicated back to the user via an outbound SMS, not via this HTTP response.

**Validation order for a `SEND` command:**
1. Webhook HMAC check
2. SMS event de-duplication and rate limit
3. Sender lookup and command parsing
4. Signature required check (`REQUIRE_SIGNED_SMS`)
5. Registered signing key lookup
6. Ed25519 signature and timestamp verification
7. Request ID and nonce claim
8. PIN lockout and PIN check
9. Recipient lookup, self-send and balance checks
10. Soroban settlement record, then Stellar payment

A request rejected at any step is recorded in `omnipay_relay_transactions` as `validation_failed` (or `failed`) with a `detail`, and is never sent to Soroban or Stellar.

**SMS replies for rejected signed requests:**
| Detail | Reply |
|---|---|
| `signature-required` | `OmniPay: This command must be signed. Update your OmniPay app to the latest version.` |
| `no-registered-signing-key` | `OmniPay: Your account has no registered signing key yet. Log in to the app once.` |
| `bad-signature:<reason>` | `OmniPay: Signature check failed. Payment not sent.` |
| `invalid-requestid` | `OmniPay: Invalid request. Payment not sent.` |
| `duplicate-request` / `nonce-reused` | `OmniPay: Duplicate request ignored. No additional payment was made.` |
| `claim-error` | `OmniPay: Could not process your request right now. Nothing was deducted. Please try again.` |

---

### 3.3 `POST /api/send`

Authenticated payment endpoint. This is the signature-verified, replay-protected, PIN-gated channel referenced in the SOW.

**Request body:**
```json
{
  "senderId": "firebaseUid123",
  "recipientId": "juan_delacruz",
  "amount": 50,
  "timestamp": 1790000000000,
  "nonce": "b16f1e0a9c3d4e5f",
  "requestId": "0123456789abcdef0123456789abcdef",
  "signature": "base64-ed25519-signature",
  "pin": "1234"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `senderId` | string | Yes | Sender's Firestore/Firebase Auth UID |
| `recipientId` | string | Yes | Recipient's UID, username, or phone number — resolved in that order |
| `amount` | number or string | Yes | Positive, at most 7 decimal places; formatted to 7 decimal places for signing/Stellar |
| `timestamp` | number (ms) | Yes | Must be within ±5 minutes of server time |
| `nonce` | string | Yes | Single-use, scoped per `senderId` |
| `requestId` | string | Yes | Single-use globally; 16–128 characters of `A-Z a-z 0-9 _ -` |
| `signature` | string (base64) | Yes | Raw Ed25519 signature (64 bytes decoded) over the canonical payload string |
| `pin` | string (4–6 digits) | Yes | Verified against the stored PIN hash |

**Response `200` (success):**
```json
{
  "ok": true,
  "txHash": "a1b2c3...",
  "sorobanTxHash": "d4e5f6...",
  "newSenderBalance": 449.99999,
  "relayId": "relayDocId123"
}
```
`sorobanTxHash` is `null` when no contract is configured.

**Errors:**
| Status | Body (`error` field) | Cause |
|---|---|---|
| `400` | `missing required authenticated-payload fields` | One of the required fields is absent |
| `400` | `invalid amount` (+ `reason`) | `amount` is missing, malformed, not finite or not positive |
| `400` | `missing or invalid pin` | `pin` is not 4–6 digits |
| `401` | `unauthorized sender` | `senderId` has no user record, or the user has no registered signing key |
| `401` | `invalid signature` (+ `reason`) | Signature check failed — see reason codes below |
| `409` | `duplicate-request` / `nonce-reused` (+ `previousStatus`, `originalTxHash`, `settlementCreated: false`) | Replay attempt |
| `400` | `invalid-requestid` | `requestId` does not match the allowed format |
| `500` | `claim-error` | Internal error while claiming the request |
| `423` | `too many wrong PIN attempts, try again later` | PIN lockout active (15 min) |
| `400` | `wallet not set up for signed payments — log in to the app once` | Sender has no PIN record on file |
| `401` | `incorrect pin` | PIN did not match the stored hash |
| `404` | `recipient not found` | `recipientId` doesn't resolve to any user |
| `422` | `insufficient-balance` / `self-send` / `settlement-not-configured` / `signer-not-enabled` / `soroban-failed` / `stellar-failed` (+ `detail`) | Business-rule, Soroban or Stellar failure |
| `500` | `internal error` | Unhandled exception |

**Signature-rejection reason codes** (nested under `reason` when status is `401 invalid signature`):
`missing-signature-or-key`, `missing-sender-or-recipient`, `missing-nonce-or-requestid`, `invalid-field-format`, `invalid-amount`, `invalid-timestamp`, `timestamp-out-of-window`, `invalid-public-key`, `malformed-signature`, `signature-mismatch`.

Every request — successful or not — is tracked in `omnipay_relay_transactions` (see §3.7/3.8) via a `relayId`, walking through the lifecycle: `received → validated → submitted → confirmed → settled` (or `validation_failed` / `failed` on any rejection). When Soroban is enabled the record also stores `sorobanTxHash` and `sorobanContractId`.

---

### 3.4 `GET /api/settlement-signer`

Returns the public key of the settlement signer. The client uses it to check that the signer is enabled on the user's Stellar account.

**Response `200`:**
```json
{ "publicKey": "G...", "networkPassphrase": "Test SDF Network ; September 2015" }
```

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "settlement signer not configured" }` | `SETTLEMENT_SIGNER_SECRET` is not set |

---

### 3.5 `POST /api/submit-payment`

The endpoint the web wallet (index.html / script.js) calls when a logged-in user sends a payment from the browser — either through the Freighter extension or by signing locally. The transaction is already fully signed by the time it reaches the relay; this endpoint builds the relay record, submits the signed XDR to Horizon, and updates the status. Rate limited to 20 requests per minute.

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

Unlike `/api/send`, this endpoint does **not** verify that `senderId` corresponds to the account that signed `signedXdr`: whoever holds the signed transaction can submit it. This is acceptable for a Testnet MVP but should be tied to the XDR's source account and `senderId`'s registered `walletPublic` before any Mainnet use.

---

### 3.6 `POST /dev/simulate-sms`

Developer-only endpoint to trigger the SMS-processing pipeline without a real SMS or gateway — used for local testing and for reproducing the evidence.

**Access restriction:** localhost only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Any other origin is rejected.

**Request body:**
```json
{
  "sender": "09171234567",
  "message": "SEND 50.0000000 09179876543 1234 SIG <timestamp> <nonce> <requestId> <signature>"
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
(The outcome of the simulated command is written to Firestore/console logs, same as a real inbound SMS — this endpoint acknowledges that processing started.)

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `403` | `{ "error": "dev endpoint is localhost-only" }` | Called from a non-localhost origin |
| `400` | `{ "error": "sender and message required" }` | Missing field |
| `500` | `{ "error": "<message>" }` | Unhandled exception during processing |

---

### 3.7 `GET /api/relay-transactions`

Monitoring-dashboard feed — recent relay transactions across all channels (SMS, API, web).

**Headers:** requires `X-Admin-Key: <ADMIN_API_KEY>` — see the Admin API Key row in §2. Without it (or with the wrong key), this returns before touching Firestore.

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
        { "status": "received", "at": 1790000000000 },
        { "status": "validated", "at": 1790000000500 },
        { "status": "submitted", "at": 1790000001000 },
        { "status": "confirmed", "at": 1790000002500 },
        { "status": "settled", "at": 1790000003000 }
      ],
      "txHash": "a1b2c3...",
      "sorobanTxHash": "d4e5f6...",
      "sorobanContractId": "C..."
    }
  ]
}
```
A rejected request has `status: "validation_failed"` and the rejection reason in the last `statusHistory` entry's `detail` (for example `duplicate-request`, `nonce-reused`, `bad-signature:timestamp-out-of-window`).

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "admin endpoints disabled — set ADMIN_API_KEY" }` | Server has no `ADMIN_API_KEY` configured |
| `401` | `{ "error": "unauthorized" }` | `X-Admin-Key` missing or wrong |
| `500` | `{ "error": "internal error" }` | Firestore query failure |

**Note:** Filtering by `status` while ordering by `createdAt` requires a Firestore composite index — Firestore logs a console link to create it on first use.

---

### 3.8 `GET /api/relay-transactions/:id`

Fetch a single relay transaction with full status history.

**Headers:** requires `X-Admin-Key` — same as §3.7.

**Path parameter:** `id` — the relay transaction's Firestore document ID.

**Response `200`:** same shape as one item in §3.7.

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "admin endpoints disabled — set ADMIN_API_KEY" }` | Server has no `ADMIN_API_KEY` configured |
| `401` | `{ "error": "unauthorized" }` | `X-Admin-Key` missing or wrong |
| `404` | `{ "error": "not found" }` | No transaction with that ID |
| `500` | `{ "error": "internal error" }` | Firestore query failure |

---

### 3.9 `GET /api/replay-audit/:requestId`

Shows what happened to a signed request ID, including every replay attempt. Used as evidence that a replayed request does not create a second settlement.

**Headers:** requires `X-Admin-Key` — same as §3.7.

**Path parameter:** `requestId` — the signed request's Request ID.

**Response `200`:**
```json
{
  "requestId": "0123456789abcdef0123456789abcdef",
  "status": "processed",
  "channel": "sms",
  "txHash": "a1b2c3...",
  "settlements": 1,
  "replayCount": 3,
  "lastReplayAt": "2026-08-20T10:05:00.000Z",
  "lastReplayChannel": "sms"
}
```
`settlements` is `1` when a transaction hash is recorded and `0` otherwise.

**Errors:**
| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "admin endpoints disabled — set ADMIN_API_KEY" }` | Server has no `ADMIN_API_KEY` configured |
| `401` | `{ "error": "unauthorized" }` | `X-Admin-Key` missing or wrong |
| `404` | `{ "error": "not found" }` | Request ID was never claimed |
| `500` | `{ "error": "internal error" }` | Firestore query failure |

---

### 3.10 `POST /api/reconcile-balance/:userId`

Forces a user's Firestore `xlmBalance` to match their real on-chain Stellar balance. Useful when local bookkeeping and the ledger drift (e.g. after a failed update).

**Headers:** requires `X-Admin-Key` — same as §3.7.

**Path parameter:** `userId` — Firestore user doc ID.

**Response `200`:**
```json
{
  "ok": true,
  "userId": "firebaseUid123",
  "xlmBalance": 449.99999
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

### 3.11 `POST /api/activity/login`

Records a sign-in for the authenticated user and reports whether it came from a new device or after a wallet key change. Requires `Authorization: Bearer <Firebase ID token>`.

**Body:** `{ "deviceId": "<random id stored in the browser>" }`

**Response `200`:** `{ "alerts": [ { "type": "new-device" | "key-changed", "device": "Chrome on Android", "location": "Manila, PH" } ] }`

The first device seen for an account is stored as the baseline and does not raise an alert. Location is approximate and uses proxy geo headers, or `geoip-lite` when installed. IP addresses are stored masked.

### 3.12 `POST /api/activity/event`

Records a client-initiated security event. Requires a Firebase ID token. **Body:** `{ "type": "password-changed", "deviceId": "..." }`. Other types return `400`.

### 3.13 `GET /api/activity`

Returns the latest 50 activity events and the devices signed in to the account. Requires a Firebase ID token. Optional query `deviceId` marks the current device.

**Response `200`:** `{ "events": [ { "id", "type", "device", "location", "ip", "detail", "thisDevice", "createdAt" } ], "devices": [ { "label", "firstSeen", "lastSeen", "thisDevice" } ] }`

Event types: `login`, `new-device`, `key-changed`, `password-changed`.

---

## 4. SMS Command Reference

Sent as plain text to the gateway phone number.

| Command | Format | Example |
|---|---|---|
| Send payment (signed) | `SEND <amount> <recipient> <pin> SIG <timestamp> <nonce> <requestId> <signature>` | Built by the app in **Send via SMS → Sign & Prepare SMS**, or by `sign-sms.js` |
| Send payment (unsigned) | `SEND <amount> <recipient> <pin>` | `SEND 50 09171234567 1234` — accepted only when `REQUIRE_SIGNED_SMS=false` |
| Check balance | `BAL <pin>` or `BALANCE <pin>` | `BAL 1234` |

`<recipient>` may be another user's registered mobile number or username.

Replies are sent back via SMS (not HTTP), e.g.:
- `OmniPay: Sent 50 XLM to juan_delacruz. TX: a1b2c3d4e5f6... New balance: 449.9999 XLM.`
- `OmniPay: Incorrect PIN. Payment not sent.`
- `OmniPay: Too many wrong PIN attempts. Try again in a bit, or use the app.`
- `OmniPay: Signature check failed. Payment not sent.`
- `OmniPay: Duplicate request ignored. No additional payment was made.`
- `OmniPay: Your balance is 449.9999 XLM.`

---

## 5. Soroban Settlement

When `SOROBAN_CONTRACT_ID` is set, each approved payment invokes the settlement contract before the Stellar payment is submitted.

| Item | Value |
|---|---|
| RPC | `SOROBAN_RPC_URL` (default `https://soroban-testnet.stellar.org`) |
| Function | `SOROBAN_SETTLE_FUNCTION` (default `settle`) |
| Arguments | `request_id` (string), `sender` (Address), `recipient` (Address), `amount` (i128, in stroops) |
| Signer | Settlement signer (`SETTLEMENT_SIGNER_SECRET`) |
| Confirmation | Polls `getTransaction` up to `SOROBAN_POLL_ATTEMPTS` times (default 30) every `SOROBAN_POLL_INTERVAL_MS` (default 1000) |
| Failure | Relay record becomes `failed` with detail `soroban:<error>` (`soroban-transaction-failed`, `soroban-confirmation-timeout`, `soroban-submit-error`, `soroban-submit-try_again_later`); no XLM payment is sent and the API returns `422 soroban-failed` |
| Startup checks | The contract ID must be a valid `C...` address and `stellar-sdk` must be v11 or newer |

Without a contract ID the server logs a warning at startup and settles on Horizon only.

---

## 6. How to Replicate Locally (Week 2 evidence)

```bash
npm install
# create .env with: FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_PROJECT_ID,
# SMS_GATEWAY_WEBHOOK_SECRET, ADMIN_API_KEY, SETTLEMENT_SIGNER_SECRET,
# SOROBAN_CONTRACT_ID (optional), REQUIRE_SIGNED_SMS, etc.
node server.js
```

Check the health endpoint:
```bash
curl http://localhost:3000/health
```

Run the offline signature tests (27 tests):
```bash
npx jest Signature.test.js
```

Run the replay harness (writes `replay-evidence.json`):
```bash
node server.js --replay-check
```

Send a signed SMS from the same machine (the endpoint is localhost-only). Generate the line with `sign-sms.js`, then:
```bash
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"SEND 50.0000000 juan_delacruz 1234 SIG <timestamp> <nonce> <requestId> <signature>"}'
```

Inspect the resulting relay transaction and replay audit:
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" "http://localhost:3000/api/relay-transactions?limit=5"
curl -H "x-admin-key: $ADMIN_API_KEY" http://localhost:3000/api/replay-audit/<requestId>
```

Live SMS relay tests (no funds move; a wrong PIN is used with valid signatures):
```bash
RUN_LIVE_SMS_TESTS=true TEST_SENDER_PHONE=... TEST_SENDER_ID=... TEST_SENDER_SECRET=... \
TEST_RECIPIENT=... ADMIN_API_KEY=... npx jest Signature.test.js -t "SMS relay"
```

Expected relay records for the live tests:

| Test | Expected record |
|---|---|
| Unsigned `SEND` | `validation_failed`, `signature-required` |
| Tampered signature | `validation_failed`, `bad-signature:signature-mismatch` |
| Expired timestamp | `validation_failed`, `bad-signature:timestamp-out-of-window` |
| Replayed request ID | 1st `incorrect-pin`; 2nd `validation_failed`, `duplicate-request` |
| Reused nonce | 1st `incorrect-pin`; 2nd `validation_failed`, `nonce-reused` |

---

## 7. Firestore Data Model

Firestore is Google's managed database, reached two different ways in this codebase. Neither is an HTTP endpoint like §3.

| Access path | Used by | Auth boundary |
|---|---|---|
| **Firebase Client SDK** (`firebase.firestore()`) | `script.js` / `index.html` (the browser app) | Firestore Security Rules — the client talks to Firestore directly, no relay server involved |
| **Firebase Admin SDK** (`firebase-admin/firestore`) | `server.js`, `Relay.js` | Bypasses security rules entirely (trusted server context) — this is what powers every endpoint in §3 |

### Collections

| Collection | Written by | Purpose | Key fields |
|---|---|---|---|
| `users` | Client (profile fields) + Server (balance, transactions) | One doc per user, keyed by Firebase Auth UID | `phone`, `username`, `walletPublic`, `smsPinHash`, `smsPinSalt`, `xlmBalance`, `transactions[]` |
| `usernames` | Client | Username → UID lookup, used at signup/login to resolve a typed username | doc ID = lowercased username |
| `omnipay_events` | Server (`logEvent`) | Activity/error feed shown in the app UI (e.g. "Incorrect PIN") | `userId`, `icon`, `message`, `type`, `createdAt` |
| `omnipay_sms_events` | Server | Inbound-SMS idempotency ledger — prevents a gateway retry from double-processing the same SMS | `kind`, `status`, `senderPhone`, `messageHash`, `createdAt` |
| `omnipay_relay_transactions` | Server | The transaction-lifecycle ledger exposed via `GET /api/relay-transactions` (§3.7/3.8) | `channel`, `senderId`/`senderPhone`, `recipient`, `amount`, `status`, `statusHistory[]`, `txHash`, `sorobanTxHash`, `sorobanContractId` |
| `relay_requests` | Server (`Relay.js`) | Replay protection: one doc per `requestId`, created exactly once | `requestId`, `senderId`, `nonce`, `channel`, `relayId`, `status`, `txHash`, `sorobanTxHash`, `replayCount`, `lastReplayAt`, `lastReplayChannel` |
| `omnipay_used_nonces` | Server (`Relay.js`) | Replay protection: one doc per `senderId:nonce` pair | `senderId`, `requestId`, `createdAt` |
| `users/{uid}/activity` | Server | Sign-in and security event log shown in Settings > Activity | `type`, `device`, `location`, `ip` (masked), `detail`, `createdAt` |

### Notes

- The client's `firebaseConfig.apiKey` visible in `script.js` is expected to be public for a Firebase web app — actual protection comes from **Firestore Security Rules**, not from hiding that key. Those rules aren't in this repo yet and should be reviewed/tightened before public launch (e.g. a client should never be able to write its own `xlmBalance` directly).
- The client keeps a **realtime listener** (`onSnapshot`) on its own `users/{uid}` doc, which is how the app UI updates live when the server changes a balance or appends a transaction.
- `relay_requests` and `omnipay_used_nonces` should get a Firestore TTL policy so old entries don't grow forever (noted again in §8).

## 8. Known Limitations (Week 2 stage)

- Not yet deployed publicly — runs on localhost only.
- The Soroban contract is invoked when `SOROBAN_CONTRACT_ID` is set. Deployment of the contract on Stellar Testnet, with the contract ID and explorer links, is Week 3.
- The Soroban record is written before the Stellar payment. If the payment fails after a successful contract call, the two records can differ.
- `REQUIRE_SIGNED_SMS=false` re-enables PIN-only SMS `SEND`; it should be used for legacy testing only.
- PIN lockout and SMS rate limiting are in-memory only — reset on server restart; not persisted or shared across instances.
- No Firestore TTL policy yet configured on `relay_requests` / `omnipay_used_nonces` (recommended before production).
- `/api/submit-payment` (§3.5) doesn't check that `senderId` matches the account that signed the transaction. Fine for a Testnet MVP demo, but should be tied to a real session check before production use.
- `ADMIN_API_KEY` is a single shared secret with no rotation or per-admin scoping — acceptable for a 30-day sprint, not for the eventual multi-admin dashboard.
- The monitoring dashboard UI is not yet built (Week 3); relay records are available through the admin API.