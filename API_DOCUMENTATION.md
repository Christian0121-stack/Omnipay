# OmniPay SMS Relay — API Documentation

**Project:** OmniPay (INSTAWAG SOW v2)
**Component:** Node.js SMS Relay + Backend + Soroban / Stellar Testnet integration + Monitoring dashboard
**Milestone:** Week 3 — deploy the OmniPay web application, integrate transaction monitoring and dashboard synchronization, deploy the Soroban smart contract on Stellar Testnet, perform end-to-end integration testing
**Status:** Deployed on Render. Stellar **Testnet only**. Signed SMS is required by default (`REQUIRE_SIGNED_SMS=true`).

| | |
|---|---|
| **Base URL (production)** | `https://omnipay-m6hl.onrender.com` (also served at `https://omnipay.website`) |
| **Base URL (local dev)** | `http://localhost:3000` |
| **Admin dashboard** | `GET /admin` — [Render](https://omnipay-m6hl.onrender.com/admin) · [omnipay.website](https://omnipay.website/admin) |
| **Web app** | https://omnipay.website/ |
| **X post** | https://x.com/Omnipay0121/status/2108564661176279097 |
| **GitHub (Week 3 branch)** | https://github.com/Christian0121-stack/Omnipay/tree/week-3-deliverables |
| **Hosting (Render)** | https://omnipay-m6hl.onrender.com |
| **Domain (GoDaddy)** | https://omnipay.website/ |
| **SMS gateway number** | `09612490625` (+63 961 249 0625) |
| **Soroban contract (Testnet)** | `CCR4IAHHPOKX6SEM2ED5N5AKIO4QRBEJ7AA5UH4LZYBUTRAIH7XTD6TH` — [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCR4IAHHPOKX6SEM2ED5N5AKIO4QRBEJ7AA5UH4LZYBUTRAIH7XTD6TH) |
| **Network** | Horizon `https://horizon-testnet.stellar.org` · Soroban RPC `https://soroban-testnet.stellar.org` · Passphrase `Test SDF Network ; September 2015` |

---

## Contents

1. [Overview](#1-overview)
2. [Authentication model](#2-authentication-model)
3. [Endpoint index](#3-endpoint-index)
4. [Payment and relay endpoints](#4-payment-and-relay-endpoints)
5. [Monitoring dashboard endpoints (admin)](#5-monitoring-dashboard-endpoints-admin)
6. [User endpoints (Firebase ID token)](#6-user-endpoints-firebase-id-token)
7. [Relay record lifecycle](#7-relay-record-lifecycle)
8. [SMS command reference](#8-sms-command-reference)
9. [Soroban settlement](#9-soroban-settlement)
10. [Rate limits and security headers](#10-rate-limits-and-security-headers)
11. [Firestore data model](#11-firestore-data-model)
12. [End-to-end test cases](#12-end-to-end-test-cases)
13. [How to replicate and verify](#13-how-to-replicate-and-verify)
14. [Known limitations (Week 3)](#14-known-limitations-week-3)

---

## 1. Overview

The relay is a single Express.js service that also serves the web app, the PWA files and the admin dashboard, so the app and the relay always run the same version. It connects five systems:

1. **Android SMS Gateway** — receives SMS commands from users with no internet access and forwards them to `POST /webhook/sms-received`. Replies are sent back through the gateway.
2. **Node.js SMS Relay (this server)** — verifies the Ed25519 signature, the 5-minute timestamp window, the nonce and the Request ID, and rejects malformed, expired, duplicated or replayed requests *before* any backend or blockchain processing.
3. **OmniPay Backend** — checks business rules (PIN, recipient, self-send, balance) and authorizes settlement.
4. **Stellar Testnet (Horizon)** — executes the XLM payment.
5. **Soroban smart contract (Soroban RPC)** — records each settled payment and its Request ID on-chain and rejects a Request ID it has already recorded (idempotency).

**Firestore** holds application state only (users, relay records, replay-protection records) and feeds the monitoring dashboard. It is **not** the settlement source of truth and is not used to authorize or settle payments. The Stellar Testnet is the authoritative settlement record.

### Payment channels

| Channel | Entry point | Checks | Relay record `channel` |
|---|---|---|---|
| **SMS** | `POST /webhook/sms-received` (from the gateway) | Gateway HMAC, Ed25519 signature, timestamp, nonce, Request ID, PIN, balance | `sms` |
| **Signed API** | `POST /api/send` | Same checks as SMS | `api` |
| **Web wallet (Freighter path)** | `POST /api/submit-payment` | The browser signs the Stellar transaction itself; the server cross-checks the signed XDR against the sender's registered wallet, the recipient and the amount | `web` |

The web app's normal send flow (digital signature plus PIN) calls `POST /api/send`, so it shares the Signed API channel and records the Soroban contract entry like an SMS payment. `POST /api/submit-payment` is used for payments the browser has already signed as a Stellar transaction (Freighter).

The SMS and Signed API channels converge on one internal payment executor, so behavior is identical regardless of entry point (balance check, self-send check, XLM payment, Soroban record, Firestore update).

### Offline operation

The web app checks connectivity with `navigator.onLine` and a probe request to Horizon (5 s timeout). When the device is offline the pay screen switches to **Offline Mode · Pay by SMS**: the app signs the `OMNIPAY-v1` payload locally with the wallet key, then hands the signed `SEND ... SIG ...` message to the phone's SMS app addressed to the gateway number. No network access is needed for signing. The service worker (`sw.js`, cache `omnipay-v2`) pre-caches the app shell and CDN libraries; `/api`, `/webhook`, `/dev`, `/health` and `/admin` are never cached.

### Order of operations (changed in Week 3)

```
validate → submit XLM payment (Horizon) → confirmed → write Soroban record → settled
```

The XLM payment is submitted **first**; the Soroban record is written **after** the payment succeeds. If the payment fails, nothing is recorded on the contract. If the payment settled but the contract call fails, the payment stands, the relay record keeps its `txHash` and is marked `sorobanRecordStatus: "failed"` (see §9).

Each settled payment therefore leaves two public Testnet transactions: the XLM payment (`txHash`) and the contract call (`sorobanTxHash`).

---

## 2. Authentication model

| Layer | Purpose | Applies to |
|---|---|---|
| **PIN** (4–6 digits) | Verified against the PBKDF2-SHA256 hash on the user record, with a constant-time comparison | SMS `SEND` / `BAL`, `POST /api/send` |
| **Digital signature** (Ed25519, the user's Stellar keypair) | Proves the request came from `senderId` and was not altered. The private key stays on the user's device and is never sent. | `POST /api/send` (always), SMS `SEND` (unless `REQUIRE_SIGNED_SMS=false`) |
| **Registered public key** | The relay looks up the sender's `walletPublic` in the user record (key registry) to verify the signature | Signed SMS and `/api/send` |
| **Webhook HMAC** (`X-Signature` / `X-Timestamp`) | Verifies the inbound webhook came from the SMS gateway | `POST /webhook/sms-received` |
| **Settlement signer** (`SETTLEMENT_SIGNER_SECRET`) | Signs the Soroban contract call and the XLM payment. Must be an enabled signer on the sender's Stellar account | Every SMS and `/api/send` settlement |
| **Admin API key** (`X-Admin-Key` header) | Gates the monitoring and audit endpoints | §5 endpoints. If `ADMIN_API_KEY` is not set they answer `503`. Compared in constant time. |
| **Firebase ID token** (`Authorization: Bearer <token>`) | Identifies the signed-in web user | §6 endpoints |

**Canonical signed string** (must match byte-for-byte between client and server):

```
OMNIPAY-v1|senderId|recipientId|amount(7dp)|timestamp(ms)|nonce|requestId
```

Signed with the sender's Stellar secret key and verified with the registered `walletPublic`. No field may contain `|`. The signature is base64 and exactly 64 bytes when decoded. A valid signature is not authorization to spend — the PIN is still required (two-factor by design).

**Timestamp window:** within ±5 minutes of server time (`SIGNATURE_MAX_SKEW_MS`, default `300000`).

**Anti-replay:** each `requestId` can be claimed once and each `(senderId, nonce)` pair can be used once. Both are written in one Firestore transaction to `relay_requests` and `omnipay_used_nonces`.
- `requestId` must match `^[A-Za-z0-9_-]{16,128}$`; `nonce` must match `^[A-Za-z0-9_-]{8,128}$`.
- A repeated attempt is rejected, `replayCount` on the original record is incremented, and the original transaction hash is reported without creating a new settlement.
- Claim records carry an `expiresAt` (`RELAY_RECORD_TTL_DAYS`, default 7). Enable a Firestore TTL policy on `expiresAt` for both collections to have them removed automatically.

**Request ID idempotency on-chain:** the same `requestId` is passed to the Soroban contract, which rejects a duplicate with contract error `#2` (`AlreadyRecorded`). The relay treats this as "already recorded" and does not create a second record.

**PIN brute-force guard:** 5 wrong attempts lock the sender (phone or id) for 15 minutes. In memory — resets when the server restarts.

---

## 3. Endpoint index

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Firestore, Horizon and Soroban status with latency |
| GET | `/api/settlement-signer` | Public | Settlement signer public key and network passphrase |
| GET | `/admin` | Public page | Monitoring dashboard (data needs the admin key) |
| POST | `/webhook/sms-received` | Gateway HMAC | Inbound SMS from the Android gateway |
| POST | `/api/send` | Signature + PIN | Signed API payment |
| POST | `/api/submit-payment` | Signed XDR | Web wallet payment |
| POST | `/dev/simulate-sms` | Localhost only | Simulate an inbound SMS |
| GET | `/api/relay-transactions` | `X-Admin-Key` | Latest relay records |
| GET | `/api/relay-transactions/stream` | `X-Admin-Key` | Live relay records (server-sent events) |
| GET | `/api/relay-transactions/:id` | `X-Admin-Key` | One relay record |
| GET | `/api/replay-audit/:requestId` | `X-Admin-Key` | Replay audit for a Request ID |
| POST | `/api/reconcile-balance/:userId` | `X-Admin-Key` | Re-sync a Firestore balance from the ledger |
| GET | `/api/my-transactions` | Firebase token | The signed-in user's relay records |
| GET | `/api/my-transactions/stream` | Firebase token | Live stream of the user's records |
| GET | `/api/search-recipients` | Firebase token | Find a recipient |
| GET / PUT | `/api/contacts` | Firebase token | Saved contacts |
| GET / POST | `/api/privacy-settings` | Firebase token | Privacy toggles |
| POST | `/api/change-phone` | Firebase token | Change the linked mobile number |
| POST | `/api/activity/login` | Firebase token | Record a sign-in |
| POST | `/api/activity/event` | Firebase token | Record a client event |
| GET | `/api/activity` | Firebase token | Activity feed and devices |

---

## 4. Payment and relay endpoints

### 4.1 `GET /health`

Dependency check used for monitoring.

**Response `200`** (all dependencies ok):
```json
{
  "ok": true,
  "timestamp": "2026-10-09T16:16:09.593Z",
  "services": {
    "firestore": { "status": "ok", "latencyMs": 336 },
    "horizon":   { "status": "ok", "latencyMs": 255 },
    "soroban":   { "status": "ok", "latencyMs": 137 }
  }
}
```
`services.soroban` is present only when `SOROBAN_CONTRACT_ID` is set. Each check times out after 4 s.

**Response `503`:** same shape with `"ok": false`. A failing service reports `{ "status": "error", "latencyMs": <n>, "message": "<reason>" }`.

---

### 4.2 `GET /api/settlement-signer`

Returns the public key of the settlement signer. The client uses it to check that the signer is enabled on the user's Stellar account.

**Response `200`:**
```json
{ "publicKey": "G...", "networkPassphrase": "Test SDF Network ; September 2015" }
```

**Errors:** `503` `{ "error": "settlement signer not configured" }` when `SETTLEMENT_SIGNER_SECRET` is missing or invalid.

---

### 4.3 `GET /admin`

Serves `admin.html` with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`. The page itself is public; every data call it makes needs the admin key (§5). See §5 for what the dashboard shows.

---

### 4.4 `POST /webhook/sms-received`

Inbound webhook called by the Android SMS Gateway for every new SMS. This is how `SEND` and `BAL` commands reach the relay.

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
    "sender": "+639171234567",
    "message": "SEND 50.0000000 juan_delacruz 1234 SIG 1790000000000 9f2c... 4b7a... MEUCIQ...",
    "id": "provider-message-id"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `event` | string | Yes | Must equal `"sms:received"`; other events are acknowledged and ignored |
| `payload.sender` / `payload.phoneNumber` | string | Yes | 7–15 digits, optional leading `+`. Non-phone senders are ignored |
| `payload.message` | string | Yes | Raw SMS text (`SEND` or `BAL`) |
| `payload.id` / `messageId` / `uuid` / `eventId` / `smsId` | string | No | Used to de-duplicate retried deliveries |

**Response `200`** (acknowledgement — processing continues asynchronously):
```json
{ "received": true }
```
or `{ "ignored": true }` for other events and non-phone senders.

**Errors:**

| Status | Body | Cause |
|---|---|---|
| `401` | `{ "error": "invalid signature" }` | HMAC missing or invalid, or `SMS_GATEWAY_WEBHOOK_SECRET` not configured |
| `400` | `{ "error": "missing sender/message" }` | Payload missing `sender` or `message` |

**Notes**
- The server answers `200` immediately so the gateway is not kept waiting. Outcomes are sent back to the user by SMS, not in this HTTP response.
- Duplicate deliveries (same provider message id, or the same sender + text within `SMS_DEDUP_WINDOW_MS`, default 3000 ms) are ignored.
- Signed SMS signatures are base64 and may be split by the SMS transport; the parser rejoins the parts after `SIG <timestamp> <nonce> <requestId>`.

**Validation order for a `SEND` command**

1. Gateway HMAC check
2. SMS de-duplication and per-sender rate limit (10 per 60 s)
3. Sender lookup by phone number and command parsing
4. Signature-required check (`REQUIRE_SIGNED_SMS`)
5. Registered signing key lookup
6. Ed25519 signature and timestamp-window verification
7. Request ID and nonce claim (replay protection)
8. PIN lockout and PIN check
9. Recipient lookup, self-send check, balance check, settlement signer check
10. XLM payment on Stellar, then the Soroban record

A request rejected at any step is stored in `omnipay_relay_transactions` as `validation_failed` (or `failed`) with a `detail`, and **never reaches the payment or the contract**.

**SMS replies for rejected requests**

| Detail | Reply |
|---|---|
| `signature-required` | `OmniPay: This command must be signed. Update your OmniPay app to the latest version.` |
| `no-registered-signing-key` | `OmniPay: Your account has no registered signing key yet. Log in to the app once.` |
| `bad-signature:<reason>` | `OmniPay: Signature check failed. Payment not sent.` |
| `invalid-requestid` / `invalid-nonce` | `OmniPay: Invalid request. Payment not sent.` |
| `duplicate-request` / `nonce-reused` | `OmniPay: Duplicate request ignored. No additional payment was made.` |
| `claim-error` | `OmniPay: Could not process your request right now. Nothing was deducted. Please try again.` |
| `pin-locked` | `OmniPay: Too many wrong PIN attempts. Try again in a bit, or use the app.` |
| `wallet-not-setup` | `OmniPay: SMS payments are not enabled for your wallet yet. Log in to the app to set it up.` |
| `incorrect-pin` | `OmniPay: Incorrect PIN. Payment not sent.` |
| `recipient-not-found` | `OmniPay: Recipient "<recipient>" not found on OmniPay.` |
| `insufficient-balance` | `OmniPay: Insufficient balance. You have <balance> XLM.` |
| `self-send` | `OmniPay: You can't send money to yourself.` |
| `signer-not-enabled` | `OmniPay: SMS payments are not enabled for your wallet yet. Open the app and prepare an SMS payment once to enable it.` |
| other payment failure | `OmniPay: Payment failed (<detail>). Nothing was deducted.` |

**Replies for `BAL`**

| Case | Reply |
|---|---|
| Correct PIN | `OmniPay: Your balance is <balance> XLM.` |
| Wrong PIN | `OmniPay: Incorrect PIN. Balance not sent.` |
| No PIN record on the account | `OmniPay: Balance PIN is not enabled yet. Log in to the app to set up your wallet.` |
| PIN locked | `OmniPay: Too many wrong PIN attempts. Try again in a bit, or use the app.` |

`BAL` requests do not create a relay record.

**Senders and commands that get no reply**
- A `SEND` from a phone number with no linked account is recorded on the dashboard as `validation_failed` / `unknown-sender` (shown with the "No linked account" badge). No SMS is sent back.
- A malformed `SEND` from a known sender is recorded as `validation_failed` / `malformed-command` and the sender receives the commands help text: `OmniPay commands: "SEND <amount> <username|number> <pin>" or "BAL <pin>" to check your balance.`

---

### 4.5 `POST /api/send`

Signed API channel. Same validation and settlement as SMS, returned as JSON.

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
| `senderId` | string | Yes | Sender's Firebase Auth UID |
| `recipientId` | string | Yes | Recipient's UID, username or phone number |
| `amount` | number or string | Yes | Positive, at most 7 decimal places; formatted to 7 decimals for signing and Stellar |
| `timestamp` | number (ms) | Yes | Within ±5 minutes of server time |
| `nonce` | string | Yes | Single-use per `senderId`; 8–128 chars of `A-Z a-z 0-9 _ -` |
| `requestId` | string | Yes | Single-use globally; 16–128 chars of `A-Z a-z 0-9 _ -` |
| `signature` | string (base64) | Yes | Raw Ed25519 signature (64 bytes) over the canonical payload string |
| `pin` | string (4–6 digits) | Yes | Verified against the stored PIN hash |

**Response `200`:**
```json
{
  "ok": true,
  "txHash": "faebe2d33e599fc8fff420c520e454ca70c1810852b361de7374ac68d1a12d2b",
  "sorobanTxHash": "d4e5f6...",
  "newSenderBalance": 4815.2886,
  "relayId": "relayDocId123"
}
```
`sorobanTxHash` is `null` when no contract is configured, when the contract reported the Request ID as already recorded, or when the contract call failed after the payment settled (the payment is still successful — see §9). After a successful payment the sender and recipient each receive a confirmation SMS when a phone number is on file (disable with `APP_PAYMENT_SMS=false`). A failed SMS never affects the payment result.

**Errors**

| Status | `error` | Cause |
|---|---|---|
| `400` | `missing required authenticated-payload fields` | A required field is absent |
| `400` | `invalid amount` (+ `reason`) | Missing, malformed, not finite or not positive |
| `400` | `missing or invalid pin` | `pin` is not 4–6 digits |
| `401` | `unauthorized sender` | No user record for `senderId`, or the user has no registered signing key |
| `401` | `invalid signature` (+ `reason`) | Signature check failed (reason codes below) |
| `400` | `invalid-requestid` / `invalid-nonce` | Format not allowed |
| `409` | `duplicate-request` / `nonce-reused` (+ `previousStatus`, `originalTxHash`, `settlementCreated: false`) | Replay attempt |
| `500` | `claim-error` | Internal error while claiming the Request ID |
| `423` | `too many wrong PIN attempts, try again later` | PIN lockout active (15 min) |
| `400` | `wallet not set up for signed payments — log in to the app once` | Sender has no PIN record |
| `401` | `incorrect pin` | PIN did not match |
| `404` | `recipient not found` | `recipientId` does not resolve to a user with a wallet |
| `422` | `insufficient-balance`, `self-send`, `settlement-not-configured`, `signer-not-enabled`, `stellar-failed` (+ `detail`) | Business-rule or Stellar failure |
| `500` | `internal error` | Unhandled exception |

Every error response includes the `relayId` of the record created for the request. `429` `{ "error": "too many requests, please try again later" }` is returned above 20 requests per minute.

**Signature reason codes** (under `reason` when the status is `401 invalid signature`): `missing-signature-or-key`, `missing-sender-or-recipient`, `missing-nonce-or-requestid`, `invalid-field-format`, `invalid-amount`, `invalid-timestamp`, `timestamp-out-of-window`, `invalid-public-key`, `malformed-signature`, `signature-mismatch`.

---

### 4.6 `POST /api/submit-payment`

Used by the web wallet (`script.js`) for payments the browser has already signed as a Stellar transaction, for example with Freighter. The transaction is already signed when it reaches the relay. The app's standard send flow uses `POST /api/send` (§4.5).

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
| `senderId` | string | Yes | Sender's user id |
| `recipientId` | string | Yes | Recipient's UID, username or phone |
| `amount` | number or string | Yes | Positive, at most 7 decimal places |
| `signedXdr` | string | Yes | Signed transaction envelope, built and signed client-side |

**What the server checks before submitting to Horizon**
- The XDR parses on the configured network passphrase.
- The sender exists and the recipient resolves to a user with a wallet.
- The XDR contains **exactly one operation**, a native-asset `payment`.
- The operation source equals the sender's registered `walletPublic`, the destination equals the recipient's `walletPublic`, and the amount equals `amount`.

The relay record moves `received → validated → submitted → confirmed → settled`. This channel does not call the Soroban contract and does not update Firestore balances.

**Response `200`:**
```json
{ "ok": true, "txHash": "a1b2c3...", "relayId": "relayDocId123" }
```

**Errors**

| Status | Body | Cause |
|---|---|---|
| `400` | `{ "error": "missing required fields" }` | A required field is absent |
| `400` | `{ "error": "invalid amount", "reason": "..." }` | Amount invalid |
| `400` | `{ "error": "malformed transaction", "relayId": "..." }` | `signedXdr` cannot be parsed |
| `404` | `{ "error": "sender not found", "relayId": "..." }` | No user record for `senderId` |
| `404` | `{ "error": "recipient not found", "relayId": "..." }` | Recipient does not resolve |
| `400` | `{ "error": "signed transaction does not match request", "reason": "...", "relayId": "..." }` | Cross-check failed. `reason`: `unexpected-operation-count`, `not-a-payment-operation`, `unexpected-asset`, `sender-mismatch`, `recipient-mismatch`, `amount-mismatch` |
| `502` | `{ "error": "payment submission failed", "detail": "...", "relayId": "..." }` | Horizon rejected the transaction |

Rate limited to 20 requests per minute. `senderId` is not tied to a login session on this endpoint; the signed XDR must still be sourced from that user's registered wallet and cannot be redirected to another recipient or amount.

---

### 4.7 `POST /dev/simulate-sms`

Developer endpoint that runs the SMS pipeline without a real SMS. Used for local testing and the live relay tests.

**Access:** localhost only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Behind Render's proxy it is not reachable from outside.

**Request body:** `{ "sender": "09171234567", "message": "SEND 50.0000000 juan_delacruz 1234 SIG <timestamp> <nonce> <requestId> <signature>" }`

**Response `200`:** `{ "ok": true }`. The outcome is written to Firestore and the logs like a real SMS.

**Errors:** `403` `dev endpoint is localhost-only` · `400` `sender and message required` · `500` `{ "error": "<message>" }`

---

## 5. Monitoring dashboard endpoints (admin)

All endpoints in this section require `X-Admin-Key: <ADMIN_API_KEY>`.

| Status | Body | Cause |
|---|---|---|
| `503` | `{ "error": "admin endpoints disabled — set ADMIN_API_KEY" }` | `ADMIN_API_KEY` is not configured |
| `401` | `{ "error": "unauthorized" }` | Header missing or wrong |

### Dashboard (`/admin`, `admin.html` + `admin.js`)

A single-page dashboard for every relay request, including rejected ones from unknown senders. It does not need a page refresh.

| Area | Behavior |
|---|---|
| Access | Admin key entry screen. The key is sent as `X-Admin-Key` and kept in `sessionStorage` only. A wrong key returns to the gate with "Invalid admin key". |
| Live sync | Uses `GET /api/relay-transactions/stream`. Shows "Live · Firestore". If the stream drops it reconnects, then falls back to polling every 5 s. |
| KPI cards | Total requests (latest 200), Settled with success rate and total XLM settled, In progress, Rejected, Failed |
| Outcome breakdown | Stacked bar for Settled / In progress / Rejected / Failed, plus the top four rejection reasons |
| Filters | Status chips, channel filter (SMS, Signed API, App), search by sender, phone, recipient, reason or Request ID |
| Request card | Amount, sender → recipient, status pill, channel badge, five-stage tracker (Received, Validated, Submitted, Confirmed, Settled), human-readable rejection reason |
| Details view | Relay ID, sender, recipient, phone, signature result, Request ID, nonce, received time, full status timeline, Explorer links for the Payment TX and the Contract TX |
| Replay audit | Enter a Request ID to call `GET /api/replay-audit/:requestId` |

### 5.1 `GET /api/relay-transactions`

Latest relay records across all channels.

| Param | Type | Notes |
|---|---|---|
| `status` | string | Optional filter, e.g. `?status=settled` (needs a Firestore composite index on first use; Firestore logs a link) |
| `limit` | number | Default 50, maximum 200 |

**Response `200`:**
```json
{
  "transactions": [
    {
      "id": "relayDocId123",
      "channel": "sms",
      "senderPhone": "+639121083548",
      "senderId": "firebaseUid123",
      "senderUsername": "christian0121",
      "recipient": "aidan123",
      "recipientUsername": "aidan123",
      "amount": 50,
      "status": "settled",
      "statusHistory": [
        { "status": "received",  "at": 1791554286000 },
        { "status": "validated", "at": 1791554286500 },
        { "status": "submitted", "at": 1791554287000 },
        { "status": "confirmed", "at": 1791554288000 },
        { "status": "settled",   "at": 1791554290000 }
      ],
      "signatureValidation": { "result": "passed", "reason": null, "checkedAt": 1791554286300 },
      "txHash": "faebe2d33e599fc8fff420c520e454ca70c1810852b361de7374ac68d1a12d2b",
      "sorobanTxHash": "d4e5f6...",
      "sorobanContractId": "CCR4IAHHPOKX6SEM2ED5N5AKIO4QRBEJ7AA5UH4LZYBUTRAIH7XTD6TH",
      "sorobanRecordStatus": "recorded",
      "createdAt": { "_seconds": 1791554286, "_nanoseconds": 0 }
    }
  ]
}
```
`senderUsername` and `recipientUsername` are looked up from the user directory (cached for 60 s) and may be empty. `createdAt` / `updatedAt` are Firestore timestamp objects. `signatureValidation.result` is `passed` or `failed`; a failed result carries the `reason`. Each `statusHistory` entry has `status`, `at` (ms) and an optional `detail`.

A rejected request has `status: "validation_failed"` and the reason in the last `statusHistory` entry's `detail` (for example `duplicate-request`, `nonce-reused`, `bad-signature:timestamp-out-of-window`, `unknown-sender`, `malformed-command`).

**Errors:** `500` `{ "error": "internal error" }` on Firestore failure (plus the table above).

### 5.2 `GET /api/relay-transactions/stream`

Server-sent event stream fed by a Firestore `onSnapshot` listener on the latest 200 records.

- Content type `text/event-stream`. The first line is `retry: 5000`.
- Each change pushes the **full list**: `data: {"transactions":[ ... ]}` (same item shape as §5.1).
- Heartbeat comment `: ping` every 25 s. Each stream closes after 50 minutes; the client reconnects.
- At most **5** open streams; above that the server answers `429` `{ "error": "too many open streams" }`.

### 5.3 `GET /api/relay-transactions/:id`

One relay record, same shape as an item in §5.1. `:id` is the relay document ID. **Errors:** `404` `{ "error": "not found" }`, `500` `{ "error": "internal error" }`.

### 5.4 `GET /api/replay-audit/:requestId`

Shows what happened to a signed Request ID, including every replay attempt. Evidence that a replay does not settle twice.

**Response `200`:**
```json
{
  "requestId": "12ed09456ef05a6b343c4b294052a5e6",
  "status": "processed",
  "channel": "sms",
  "txHash": "faebe2d33e59...",
  "settlements": 1,
  "replayCount": 3,
  "lastReplayAt": "2026-10-09T14:05:00.000Z",
  "lastReplayChannel": "sms"
}
```
`settlements` is `1` when a transaction hash is recorded and `0` otherwise. **Errors:** `404` `{ "error": "not found" }` (Request ID never claimed), `500`.

### 5.5 `POST /api/reconcile-balance/:userId`

Forces a user's Firestore `xlmBalance` to match the on-chain Stellar balance.

**Response `200`:** `{ "ok": true, "userId": "firebaseUid123", "xlmBalance": 4815.2886 }`

**Errors:** `404` `user not found` · `400` `user has no walletPublic on file` · `502` `could not read balance from Stellar/Horizon` · `500` `internal error`

---

## 6. User endpoints (Firebase ID token)

All endpoints in this section require `Authorization: Bearer <Firebase ID token>`. Missing header → `401` `{ "error": "authentication required" }`. Invalid or expired token → `401` `{ "error": "invalid or expired session" }`.

### 6.1 `GET /api/my-transactions`

The signed-in user's own relay records (latest 200, newest first), used by the app History screen.

**Response `200`:**
```json
{
  "transactions": [
    {
      "id": "relayDocId123",
      "channel": "sms",
      "recipient": "aidan123",
      "amount": 50,
      "status": "settled",
      "statusHistory": [ { "status": "received", "at": 1791554286000, "detail": null } ],
      "signatureValidation": { "result": "passed", "reason": null },
      "txHash": "faebe2d3...",
      "sorobanTxHash": "d4e5f6...",
      "createdAt": 1791554286000
    }
  ]
}
```
Limit: 30 requests per minute per user. **Errors:** `500` `{ "error": "could not load transactions" }`.

### 6.2 `GET /api/my-transactions/stream`

Live version of §6.1 (server-sent events). Each change pushes `data: {"transactions":[ ... ]}`. Heartbeat every 25 s, lifetime 50 minutes, at most **3** open streams per user (`429` `too many open streams` above that).

### 6.3 `GET /api/search-recipients?q=<text>`

Finds other users by name, username or phone. `q` shorter than 2 characters returns `{ "results": [] }`. Returns at most 8 results; names and phone numbers are masked according to each user's privacy settings.

**Response `200`:** `{ "results": [ { "uid", "name", "username", "phone", "walletPublic" } ], "selfMatch": false }` (`selfMatch` is `true` when the only match is the caller). Limits: 30 per minute and 300 per hour. **Errors:** `500` `search unavailable`.

### 6.4 `GET /api/contacts` and `PUT /api/contacts`

`GET` → `{ "contacts": [ ... ], "updatedAt": <ms> }`. `PUT` with `{ "contacts": [ ... ] }` replaces the list and returns the sanitized list and `updatedAt`. **Errors:** `404` `account not found`, `400` `invalid contacts`, `500`.

### 6.5 `GET /api/privacy-settings` and `POST /api/privacy-settings`

`GET` → `{ "privacy": { ... } }`. `POST` with `{ "privacy": { <flag>: true|false, ... } }` — every known flag must be a boolean. Returns `{ "privacy": { ... } }`. **Errors:** `400` `privacy settings required` / `invalid value for <flag>`, `404`, `500`.

### 6.6 `POST /api/change-phone`

Changes the mobile number linked to the account (used by SMS payments). Body `{ "phone": "+63 912 345 6789", "deviceId": "..." }`. Requires a recent sign-in (within 10 minutes). Both the old and new numbers get a notification SMS.

**Response `200`:** `{ "ok": true, "phone": "+63 912 345 6789" }`

**Errors:** `400` `invalid-phone` / `same-phone` · `403` `recent-verification-required` · `404` `account not found` · `409` `phone-in-use` · `500` `could not change number`. Limit: 5 per hour per user.

### 6.7 `POST /api/activity/login`

Records a sign-in and reports a new device or a wallet-key change. Body `{ "deviceId": "<random id stored in the browser>" }`. Response `200`: `{ "alerts": [ { "type": "new-device" | "key-changed", "device": "Chrome on Android", "location": "Manila, PH" } ] }`. The first device seen for an account is the baseline and raises no alert. IP addresses are stored masked.

### 6.8 `POST /api/activity/event`

Records a client event. Body `{ "type": "password-changed" | "profile-updated" | "logout", "deviceId": "..." }`. Other types return `400`.

### 6.9 `GET /api/activity`

Up to 60 recent activity events and the signed-in devices. Optional query `deviceId` marks the current device. Response `200`: `{ "events": [ ... ], "devices": [ { "label", "firstSeen", "lastSeen", "thisDevice" } ] }`.

Event types: `login`, `new-device`, `key-changed`, `password-changed`, `profile-updated`, `privacy-changed`, `phone-changed`, `logout`, `payment-sent`, `payment-rejected`, `payment-pending`.

---

## 7. Relay record lifecycle

Every request is tracked in `omnipay_relay_transactions`, including rejected ones.

```
received → validation_failed
received → validated → submitted → confirmed → settled
received → validated → submitted → failed
```

| Status | Meaning |
|---|---|
| `received` | Request received |
| `validation_failed` | Authentication or validation failed. Never reaches the payment or the contract |
| `validated` | Passed all relay and backend checks |
| `submitted` | XLM payment submitted to the Stellar network |
| `confirmed` | Payment accepted by Stellar Testnet (`txHash` stored) |
| `settled` | Payment recorded; Soroban record written (or attempted — see `sorobanRecordStatus`) |
| `failed` | Settlement or processing could not be completed |

Each record keeps `statusHistory` (status, timestamp, optional `detail`). Common `detail` values: `signature-required`, `no-registered-signing-key`, `bad-signature:<reason>`, `duplicate-request`, `nonce-reused`, `invalid-requestid`, `claim-error`, `pin-locked`, `wallet-not-setup`, `incorrect-pin`, `recipient-not-found`, `insufficient-balance`, `self-send`, `unknown-sender`, `malformed-command`, `malformed-transaction`, `sender-not-found`, `xdr-mismatch:<reason>`, `settlement-signer-not-configured`, `settlement-signer-not-enabled`, `internal-error`.

Soroban fields on the record: `sorobanTxHash`, `sorobanContractId`, `sorobanRecordStatus` (`recorded` or `failed`), `sorobanRecordError`.

---

## 8. SMS command reference

Sent as plain text to the gateway number **09612490625** (+63 961 249 0625).

| Command | Format | Example |
|---|---|---|
| Send payment (signed) | `SEND <amount> <recipient> <pin> SIG <timestamp> <nonce> <requestId> <signature>` | Built by the app: **Send via SMS → Sign & Prepare SMS** |
| Send payment (unsigned) | `SEND <amount> <recipient> <pin>` | Accepted only when `REQUIRE_SIGNED_SMS=false` |
| Check balance | `BAL <pin>` or `BALANCE <pin>` | `BAL 1234` |

`<recipient>` can be another user's registered mobile number or username. `<amount>` has at most 7 decimals.

Example replies:
- `OmniPay: Sent 50 XLM to aidan123. TX: faebe2d33e59... New balance: 4815.2886 XLM.`
- `OmniPay: You received 50 XLM from christian0121. New balance: 4865.2886 XLM.` (sent to the recipient)
- `OmniPay: Your balance is 4815.2886 XLM.`
- Rejection replies: see §4.4.

The signing happens on the device with no network access; the signed message is handed to the phone's SMS app and travels over the cellular network, not mobile data or Wi-Fi.

---

## 9. Soroban settlement

When `SOROBAN_CONTRACT_ID` is set, each settled payment is recorded on the contract **after** the XLM payment succeeds.

| Item | Value |
|---|---|
| Contract (Testnet) | `CCR4IAHHPOKX6SEM2ED5N5AKIO4QRBEJ7AA5UH4LZYBUTRAIH7XTD6TH` |
| RPC | `SOROBAN_RPC_URL` (default `https://soroban-testnet.stellar.org`) |
| Function | `SOROBAN_SETTLE_FUNCTION` (default `settle`) |
| Call | `settle(request_id: string, sender: Address, recipient: Address, amount: i128)` — amount in stroops (7 decimals). `request_id` is the signed Request ID (the relay id when the request was unsigned) |
| Signer | Settlement signer (`SETTLEMENT_SIGNER_SECRET`); the user must have enabled it on their Stellar account |
| Idempotency | Contract error `#2` (`AlreadyRecorded`) is handled: logged as already recorded, no second record, no second payment |
| Send retry | `sendTransaction` retried up to `SOROBAN_SEND_ATTEMPTS` (default 3) on `TRY_AGAIN_LATER`, with `SOROBAN_SEND_RETRY_DELAY_MS` (default 1500) steps |
| Confirmation | `getTransaction` polled up to `SOROBAN_POLL_ATTEMPTS` (default 30) times every `SOROBAN_POLL_INTERVAL_MS` (default 1000). `FAILED` and timeout are not retried (`soroban-transaction-failed`, `soroban-confirmation-timeout`) |
| Failure after payment | The payment stays settled. The relay record keeps `txHash`, sets `sorobanRecordStatus: "failed"` and `sorobanRecordError`, the user event log shows "payment settled; contract record pending", and `sorobanTxHash` is `null` in the API response |
| Startup checks | The contract ID must be a valid `C...` address and `stellar-sdk` must be v11 or newer |
| No contract ID | The server logs a warning at startup and settles on Horizon only (`services.soroban` is absent from `/health`) |

**Verify on-chain:** open `https://stellar.expert/explorer/testnet/tx/<txHash>` for the payment and `https://stellar.expert/explorer/testnet/tx/<sorobanTxHash>` for the contract call. Both are shown with Explorer links in the dashboard.

---

## 10. Rate limits and security headers

| Scope | Limit |
|---|---|
| Inbound SMS commands | 10 per sender per 60 s (in memory) |
| `POST /api/send`, `POST /api/submit-payment` | 20 per minute |
| `GET /api/search-recipients` | 30 per minute and 300 per hour per user |
| `GET /api/my-transactions` | 30 per minute per user |
| `/api/activity/*` | 30 per minute per user |
| `/api/contacts` | 30 per minute |
| `POST /api/privacy-settings` | 20 per minute |
| `POST /api/change-phone` | 5 per hour per user |
| Admin stream | 5 open streams |
| User stream | 3 open streams per user |
| PIN attempts | 5 wrong attempts → 15 minute lockout (in memory) |

Rate-limited responses return `429` `{ "error": "too many requests, please try again later" }`.

Security headers: `helmet` with a Content Security Policy (script, style, font and connect sources are restricted to the app, Firebase, the Stellar Horizon testnet and the CDNs it uses; `frame-ancestors 'none'`). CORS is limited to `ALLOWED_ORIGINS` and allows `GET` and `POST` for cross-origin callers; the web app and the dashboard are served from the same origin as the API. `trust proxy` is enabled for Render.

---

## 11. Firestore data model

Firestore is used for application state only.

| Access path | Used by | Auth boundary |
|---|---|---|
| **Firebase Client SDK** | `script.js` / `index.html` (browser) | Firestore Security Rules |
| **Firebase Admin SDK** | `server.js`, `Relay.js` | Trusted server context (bypasses rules); powers every endpoint above |

| Collection | Written by | Purpose | Key fields |
|---|---|---|---|
| `users` | Client + server | One doc per user (Firebase UID) | `phone`, `username`, `walletPublic`, `smsPinHash`, `smsPinSalt`, `xlmBalance`, `transactions[]`, `contacts`, `privacy`, `knownDevices`, `lastKnownWalletPublic` |
| `usernames` | Client | Username → UID lookup | doc id = lowercased username |
| `omnipay_events` | Server | Activity/error feed shown in the app | `userId`, `icon`, `message`, `type`, `createdAt` |
| `omnipay_sms_events` | Server | Inbound-SMS idempotency ledger | `kind`, `status`, `senderPhone`, `messageHash`, `createdAt` |
| `omnipay_relay_transactions` | Server | Transaction lifecycle ledger behind the dashboard | `channel`, `senderId`, `senderPhone`, `recipient`, `amount`, `signedPayload`, `signatureValidation`, `status`, `statusHistory[]`, `txHash`, `sorobanTxHash`, `sorobanContractId`, `sorobanRecordStatus`, `sorobanRecordError`, `createdAt`, `updatedAt` |
| `relay_requests` | Server (`Relay.js`) | Replay protection: one doc per Request ID, created once | `requestId`, `senderId`, `nonce`, `channel`, `relayId`, `status`, `txHash`, `sorobanTxHash`, `replayCount`, `lastReplayAt`, `lastReplayChannel`, `expiresAt` |
| `omnipay_used_nonces` | Server (`Relay.js`) | Replay protection: one doc per `senderId:nonce` | `senderId`, `requestId`, `createdAt`, `expiresAt` |
| `users/{uid}/activity` | Server | Sign-in and security event log | `type`, `device`, `location`, `ip` (masked), `detail`, `createdAt` |

Notes
- The Firebase web `apiKey` in `script.js` is public by design; protection comes from Firestore Security Rules (not stored in this repo — review them before any production use; a client should never be able to write its own `xlmBalance`).
- The client listens to its own `users/{uid}` document with `onSnapshot`, which is how the app updates live.

---

## 12. End-to-end test cases

Run against the deployed server. Both wallets must be funded on Stellar Testnet. SMS limit: 10 per minute per sender.

| # | Case | Expected relay record / dashboard | Expected SMS reply |
|---|---|---|---|
| E1 | Valid signed `SEND`, phone with no Wi-Fi and no mobile data, correct PIN | `received → validated → submitted → confirmed → settled`; Payment TX and Contract TX open in the Explorer | `Sent ... XLM to ... TX: ...` |
| E2 | Same SMS sent again (same Request ID) | `validation_failed: duplicate-request`; `replayCount` +1; replay audit shows `settlements: 1` | `Duplicate request ignored. No additional payment was made.` |
| E3 | Amount or signature changed after signing | `validation_failed: bad-signature:signature-mismatch` | `Signature check failed. Payment not sent.` |
| E4 | Timestamp older than 5 minutes | `validation_failed: bad-signature:timestamp-out-of-window` | `Signature check failed. Payment not sent.` |
| E5 | New Request ID with a reused nonce | `validation_failed: nonce-reused` | `Duplicate request ignored. No additional payment was made.` |
| E6 | SMS from a number with no linked account | `validation_failed: unknown-sender`, "No linked account" badge | none |
| E7 | Same Request ID submitted to the contract again | `AlreadyRecorded` handled; no second contract record, no second payment | n/a (admin check) |
| E8 | Wrong admin key at the dashboard | Data endpoints return `401`; the dashboard shows "Invalid admin key"; no data returned | n/a |
| E9 | Dashboard stream interrupted | Status changes to Reconnecting, then Polling every 5 s, then Live again | n/a |

---

## 13. How to replicate and verify

### Reviewer (no setup)

1. Open `https://omnipay-m6hl.onrender.com/admin` (or `https://omnipay.website/admin`) and enter the admin key supplied with the submission.
2. Open any **Settled** request, choose **View details**, and open **Payment TX** and **Contract TX** in the Stellar Explorer.
3. Paste a Request ID in **Replay audit** to see settlements, replay count and the original transaction.
4. Open `https://omnipay.website/health` to see Firestore, Horizon and Soroban status.

### Run locally

```bash
npm install
# create .env — see README for the full list. Minimum
# (the server exits at startup without FIREBASE_PROJECT_ID, STELLAR_HORIZON_URL
# or a readable service account file):
# FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT_PATH, STELLAR_HORIZON_URL,
# SMS_GATEWAY_WEBHOOK_SECRET, ADMIN_API_KEY, SETTLEMENT_SIGNER_SECRET,
# SOROBAN_CONTRACT_ID, REQUIRE_SIGNED_SMS=true
node server.js                 # expect: "Admin SDK initialized", then the "OmniPay SMS Relay online" banner with the port
curl http://localhost:3000/health
```

### Automated tests

```bash
npm test                       # 27 offline signature tests (Jest)
node server.js --replay-check  # replay evidence (writes replay-evidence.json), expect RESULT: PASS
node server.js --proof-check   # signed success case + Soroban idempotency case, prints Explorer links (writes proof-evidence.json)
```

The offline tests cover signed-payload construction, tampering detection, the timestamp window and malformed-input handling (last recorded run: 27 passed, 5 skipped, 32 total). The 5 live relay tests are skipped unless enabled:

```bash
RUN_LIVE_SMS_TESTS=true TEST_SENDER_PHONE=... TEST_SENDER_ID=... TEST_SENDER_SECRET=... \
TEST_RECIPIENT=... ADMIN_API_KEY=... npm run test:live
```
They run against `/dev/simulate-sms`, so the server must be running locally. They use valid signatures with a wrong PIN, so no funds move.

| Live test | Expected record |
|---|---|
| Unsigned `SEND` | `validation_failed`, `signature-required` |
| Tampered signature | `validation_failed`, `bad-signature:signature-mismatch` |
| Expired timestamp | `validation_failed`, `bad-signature:timestamp-out-of-window` |
| Replayed Request ID | 1st `incorrect-pin`; 2nd `validation_failed`, `duplicate-request` |
| Reused nonce | 1st `incorrect-pin`; 2nd `validation_failed`, `nonce-reused` |

### Simulate an SMS locally

```bash
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"SEND 50.0000000 juan_delacruz 1234 SIG <timestamp> <nonce> <requestId> <signature>"}'

curl -H "x-admin-key: $ADMIN_API_KEY" "http://localhost:3000/api/relay-transactions?limit=5"
curl -H "x-admin-key: $ADMIN_API_KEY" http://localhost:3000/api/replay-audit/<requestId>
```

### Real SMS test

In the app open **Send via SMS**, enter recipient, amount and SMS PIN, tap **Sign & Prepare SMS**, then send the prepared message to 09612490625. The relay server and the gateway phone must be online; coordinate a test window with the builder.

---

## 14. Known limitations (Week 3)

- **OmniCard:** Deliverable 3 (optional stretch goal) is not included. The OmniCard screens in the app are a simulated UI demo only.
- **Two-step settlement:** the XLM payment and the contract record are two separate transactions. If the contract call fails after the payment settled, the record is marked `sorobanRecordStatus: "failed"` and the payment still shows on the dashboard. It is retried up to 3 times within the request; there is no deferred retry after all attempts fail (planned for Week 4).
- **In-memory counters:** PIN lockout and the SMS rate limit reset when the Render service restarts. Request ID and nonce records stay in Firestore.
- **Signing key:** the wallet signing key is held by the web client. A native Android SMS bridge is not part of this submission; the client hands the signed message to the phone's SMS app.
- **PIN in SMS:** the 4–6 digit PIN is still sent together with the signature in the SMS body (MVP-stage choice).
- **`/api/submit-payment`:** `senderId` is not tied to a login session. The signed XDR is bound to the sender's registered wallet, the recipient and the amount, but session binding should be added before any Mainnet use.
- **`REQUIRE_SIGNED_SMS=false`:** re-enables PIN-only SMS `SEND`; for legacy testing only.
- **Firestore TTL:** `expiresAt` is written on `relay_requests` and `omnipay_used_nonces`; enable a TTL policy on that field in the Firebase console to remove old entries automatically.
- **Admin key:** `ADMIN_API_KEY` is a single shared secret with no per-admin scoping. The reviewer key is shared privately and is rotated after the review.
- **Dashboard window:** the dashboard shows the latest 200 relay records; use the replay audit to look up older Request IDs.
- **Gateway dependency:** live SMS testing needs the gateway phone to be powered and online.
- **Scope:** Testnet only. Production security hardening, audits, telecom integration and Mainnet deployment are out of scope for this MVP (SOW Section 4.1).