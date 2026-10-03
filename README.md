# OmniPay SMS Relay

Node.js service that lets an OmniPay user send a Stellar Testnet payment by
plain SMS — no internet connection needed on the sender's phone. An Android
device running the [android-sms-gateway](https://docs.sms-gate.app) app
receives the SMS and forwards it to this server over a webhook; this server
validates the request, records the settlement through a Soroban smart contract,
executes the payment on the Stellar Testnet, records every step in Firestore
for the monitoring dashboard, and texts a confirmation back.

```
Phone A (no internet) --SMS--> Gateway Phone (android-sms-gateway)
     --HTTP webhook--> THIS SERVER --> Firestore (lookup + record)
     --> Soroban settle() + Stellar Testnet payment --> Firestore (update)
     --HTTP (Basic Auth)--> Gateway Phone --SMS--> Recipient (confirmation)
```

## Part of

Instaward SOW — OmniPay (THE MOON PROJECT), Week 2 deliverable: *"Functional
SMS Relay with authenticated request validation, replay protection, Soroban
integration, and successful SMS transaction testing."* See [Status](#status)
for what is done and what is still open.

## Requirements

- Node.js >= 22 (required by `firebase-admin` 14.x)
- A Firebase project with Firestore enabled, and a downloaded service
  account JSON (Firebase Console → Project settings → Service accounts →
  Generate new private key)
- An Android phone running [android-sms-gateway](https://sms-gate.app)
  (local server or cloud mode), with SIM/SMS capability
- A funded Stellar Testnet account for each OmniPay user (via
  [Friendbot](https://friendbot.stellar.org))
- A Stellar Testnet account for the settlement signer, added as a signer on
  each user account (see `GET /api/settlement-signer`)
- `stellar-sdk` v11 or newer when `SOROBAN_CONTRACT_ID` is set

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values below
npm start
```

The server listens on `PORT` (default `3000`) and also serves the existing
frontend (`index.html`, `script.js`, `styles.css`) as static files.

> **Never commit `.env` or `serviceAccountKey.json`.** Both must be listed in
> `.gitignore`. They contain gateway credentials, the webhook signing secret,
> the settlement signer secret and the Firebase Admin private key.

## Environment variables

Set each variable **once** in `.env`.

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Port to listen on. Default `3000`. |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | no | Path to the Firebase service account JSON. Default `./serviceAccountKey.json`. |
| `FIREBASE_PROJECT_ID` | yes | Your Firebase project ID. |
| `SMS_GATEWAY_USE` | no | `local` or `cloud`. Default `local`. |
| `SMS_GATEWAY_LOCAL_URL` | if `local` | Base URL of the gateway phone's Local Server, e.g. `http://192.168.1.50:8080`. |
| `SMS_GATEWAY_PUBLIC_URL` | no | Override for the Cloud Server URL. Defaults to `https://api.sms-gate.app/3rdparty/v1`. |
| `SMS_GATEWAY_USERNAME` | yes | Basic-auth username for sending SMS back through the gateway. |
| `SMS_GATEWAY_PASSWORD` | yes | Basic-auth password for the gateway. |
| `SMS_GATEWAY_WEBHOOK_SECRET` | yes | Signing key from the gateway app (Settings → Webhooks). Used to verify the `X-Signature`/`X-Timestamp` headers on inbound webhook calls. **If empty, every webhook call is rejected.** |
| `ADMIN_API_KEY` | for admin endpoints | Secret sent by callers in the `x-admin-key` header to use `/api/relay-transactions*`, `/api/replay-audit/*` and `/api/reconcile-balance/*`. If unset, those endpoints return `503`. |
| `SETTLEMENT_SIGNER_SECRET` | yes | Secret key of the settlement signer. Signs the Soroban invocation and the Stellar payment. If unset, payments cannot be settled. |
| `STELLAR_HORIZON_URL` | no | Default `https://horizon-testnet.stellar.org`. |
| `STELLAR_NETWORK_PASSPHRASE` | no | Default Testnet passphrase. |
| `SOROBAN_RPC_URL` | no | Default `https://soroban-testnet.stellar.org`. |
| `SOROBAN_CONTRACT_ID` | for Soroban | Settlement contract address (starts with `C`). If empty, payments settle on Horizon only and a warning is logged at startup. |
| `SOROBAN_SETTLE_FUNCTION` | no | Contract function invoked for settlement. Default `settle`. |
| `SOROBAN_POLL_ATTEMPTS` | no | Confirmation polling attempts. Default `30`. |
| `SOROBAN_POLL_INTERVAL_MS` | no | Delay between polling attempts. Default `1000`. |
| `SMS_ASSET_LABEL` | no | Display label for the asset in SMS replies. Default `XLM`. |
| `REQUIRE_SIGNED_SMS` | no | `true`/`false`. When `true`, plain unsigned `SEND` SMS commands are rejected — see [Authentication](#authentication). Default `true`. |
| `ALLOWED_ORIGINS` | no | Comma-separated list of allowed CORS origins. |
| `EXPLORER_BASE_URL` | no | Explorer base URL printed by `--proof-check`. Default `https://stellar.expert/explorer/testnet`. |

## SMS command format

Texted *to* the gateway phone's number, case-insensitive:

```
SEND <amount> <recipient> <pin>
  e.g. SEND 50 09171234567 1234
  e.g. SEND 50 juan_delacruz 1234

BAL <pin>
  -> replies with the sender's XLM balance
```

`<recipient>` can be another OmniPay user's registered mobile number or
username — both are matched against the `users` Firestore collection.
`<amount>` must be a positive number with at most 7 decimal places.

### Signed (authenticated) variant

```
SEND <amount> <recipient> <pin> SIG <timestamp> <nonce> <requestId> <signature>
```

The signature is an Ed25519 signature (base64, 64 raw bytes) over the string

```
OMNIPAY-v1|senderId|recipientId|amount|timestamp|nonce|requestId
```

produced with the sender's existing Stellar keypair, where:

- `senderId` is the sender's Firestore `users` document ID (the Firebase Auth
  UID) — **not** the phone number.
- `recipientId` is the recipient exactly as written in the command.
- `amount` is formatted with 7 decimal places (`50` → `50.0000000`).
- `timestamp` is Unix time in milliseconds.
- `nonce` and `requestId` must not contain `|`. `requestId` must match
  `^[A-Za-z0-9_-]{16,128}$`.

The relay verifies the signature against the sender's registered
`walletPublic` before anything else runs, rejects requests whose timestamp is
more than 5 minutes old or ahead, and rejects any `requestId` or
`(senderId, nonce)` pair it has already seen (replay protection).

The web app (`script.js`) builds this payload in **Send via SMS → Sign &
Prepare SMS**: it generates a 16-byte random `nonce` and `requestId` (hex),
signs with the wallet key and opens the phone's SMS app with the message
addressed to the gateway number.

#### Producing a signed request: `sign-sms.js`

The repo includes `sign-sms.js`, a small helper that signs a request with the
sender's Stellar **Testnet** secret key (read from the `SENDER_SECRET`
environment variable, never from an argument) and prints either the SMS line
or the `/api/send` body:

```bash
# SMS line
SENDER_SECRET=S... node sign-sms.js \
  --sender-id SENDER_FIRESTORE_USER_ID --recipient juan_delacruz --amount 50 --pin 1234

# Request body for POST /api/send
SENDER_SECRET=S... node sign-sms.js --json \
  --sender-id SENDER_FIRESTORE_USER_ID --recipient juan_delacruz --amount 50 --pin 1234
```

It also prints the signing public key on stderr; that key must equal
`users/<sender id>.walletPublic` in Firestore. For negative tests it accepts
`--timestamp <ms>`, `--request-id <text>` and `--nonce <text>` overrides.

A signed SMS line can exceed 160 characters (the signature alone is 88) and is
then delivered as a multi-part SMS.

## Authentication

- **`/api/send`** (JSON) always requires the full authenticated payload
  (`senderId`, `recipientId`, `amount`, `timestamp`, `nonce`, `requestId`,
  `signature`, `pin`) — this channel is authenticated regardless of
  `REQUIRE_SIGNED_SMS`.
- **Plain-text SMS `SEND`** is authenticated by PIN only when
  `REQUIRE_SIGNED_SMS=false`. With the default `true`, the signed suffix above
  is mandatory and unsigned SMS is rejected. The server logs its current
  enforcement mode on startup.
- **PIN verification:** the PIN is checked against the PBKDF2-SHA256 hash
  stored on the user record (`smsPinHash`, `smsPinSalt`) with a constant-time
  comparison. A valid signature does not replace the PIN; both are required.
- **Settlement signing:** the Soroban invocation and the Stellar payment are
  signed by the settlement signer (`SETTLEMENT_SIGNER_SECRET`), which must be
  an enabled signer on the sender's Stellar account. The user's wallet secret
  is not decrypted by the server.
- **Inbound webhooks** are authenticated with the gateway's `X-Signature`
  header (hex HMAC-SHA256 of the raw request body followed by the
  `X-Timestamp` value), using `SMS_GATEWAY_WEBHOOK_SECRET` as the key.
- **PIN brute-force protection:** 5 wrong PINs lock the sender out for 15
  minutes (`/api/send` and SMS). Inbound SMS is also rate-limited to 10
  messages per minute per sender, and `/api/send` and `/api/submit-payment`
  to 20 requests per minute.
- **Admin endpoints** require the `x-admin-key` header (`ADMIN_API_KEY`).

## API reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check. Verifies Firestore and Stellar Horizon connectivity, plus Soroban RPC when `SOROBAN_CONTRACT_ID` is set, and returns `{ ok, timestamp, services }`. Responds `200` when all checks pass, `503` otherwise. |
| `POST` | `/webhook/sms-received` | Called by android-sms-gateway on every inbound SMS. Requires valid `X-Signature`/`X-Timestamp` headers (see `SMS_GATEWAY_WEBHOOK_SECRET`). |
| `POST` | `/api/send` | Authenticated JSON payment channel. Body: `{ senderId, recipientId, amount, timestamp, nonce, requestId, signature, pin }`. Returns `txHash` and `sorobanTxHash` on success. |
| `GET` | `/api/settlement-signer` | Returns the settlement signer public key and network passphrase. `503` if the signer is not configured. |
| `POST` | `/api/submit-payment` | Relays a payment that the client already signed as a Stellar transaction. Body: `{ senderId, recipientId, amount, signedXdr }`. Submits the XDR to Horizon and records a relay entry. It does **no** signature/PIN check of its own — the Stellar signature inside the XDR is what authorizes the payment, and `senderId`/`recipientId`/`amount` are recorded for monitoring only (not cross-checked against the XDR). Used by the current web send flow. |
| `POST` | `/dev/simulate-sms` | **Localhost only.** Simulates an inbound SMS without a real gateway (skips webhook signature checks). Body: `{ sender, message }`. |
| `GET` | `/api/relay-transactions` | Recent relay transactions. Query: `?status=`, `?limit=` (max 200). Requires `x-admin-key`. |
| `GET` | `/api/relay-transactions/:id` | One relay transaction, with full status history. Requires `x-admin-key`. |
| `GET` | `/api/replay-audit/:requestId` | Replay evidence for a request ID: `status`, `channel`, `txHash`, `settlements` (0 or 1), `replayCount`, `lastReplayAt`, `lastReplayChannel`. Requires `x-admin-key`. |
| `POST` | `/api/reconcile-balance/:userId` | Overwrites the user's Firestore `xlmBalance` with their live Stellar ledger balance. Requires `x-admin-key`. |

`/api/send` example. The `timestamp`, `nonce`, `requestId` and `signature`
values are placeholders: generate real ones with `sign-sms.js --json`
(a real timestamp must be within 5 minutes of the server's clock).

```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "senderId": "SENDER_FIRESTORE_USER_ID",
    "recipientId": "juan_delacruz",
    "amount": 50,
    "timestamp": 1790000000000,
    "nonce": "a1b2c3d4e5f60718",
    "requestId": "0123456789abcdef0123456789abcdef",
    "signature": "<base64 signature>",
    "pin": "1234"
  }'
```

### Registering the webhook with the gateway

**Cloud Server:**
```bash
curl -X POST -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"id":"omnipay-sms","url":"https://YOUR_PUBLIC_SERVER/webhook/sms-received","event":"sms:received","device_id":"YOUR_CLOUD_DEVICE_ID"}' \
  https://api.sms-gate.app/3rdparty/v1/webhooks
```

**Local Server:**
```bash
curl -X POST -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"id":"omnipay-sms","url":"https://YOUR_PUBLIC_SERVER/webhook/sms-received","event":"sms:received"}' \
  http://YOUR_GATEWAY_LOCAL_IP:8080/webhooks
```

`YOUR_PUBLIC_SERVER` must be an HTTPS URL reachable by the gateway.

### Testing locally without a real phone

The sender must be an OmniPay user registered through the app: registration
stores the wallet public key and the PIN hash that the relay needs. Accounts
without those fields are rejected (`wallet-not-setup` or
`no-registered-signing-key`).

```bash
# Plain (PIN-only) command — accepted only when REQUIRE_SIGNED_SMS=false
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"SEND 50 juan_delacruz 1234"}'

# Balance check
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"BAL 1234"}'

# Signed command — paste the line printed by sign-sms.js as "message"
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"SEND 50 juan_delacruz 1234 SIG <timestamp> <nonce> <requestId> <signature>"}'
```

What to expect from signed requests (the relay records the outcome in
`omnipay_relay_transactions`; `/api/send` answers `401` or `409` with the same
reason):

| Test | How | Expected result |
|---|---|---|
| Valid request | `sign-sms.js` defaults | Accepted, continues to PIN check and settlement |
| Unsigned | Plain `SEND` with `REQUIRE_SIGNED_SMS=true` | `validation_failed`, detail `signature-required` |
| Replay | Send the exact same line twice | 2nd: `validation_failed`, detail `duplicate-request` |
| Reused nonce | New `--request-id`, same `--nonce` | `validation_failed`, detail `nonce-reused` |
| Invalid request ID | `--request-id` shorter than 16 characters | `validation_failed`, detail `invalid-requestid` |
| Expired | `--timestamp` older than 5 minutes | `validation_failed`, detail `bad-signature:timestamp-out-of-window` |
| Tampered | Change the amount in the line after signing | `validation_failed`, detail `bad-signature:signature-mismatch` |
| Wrong key | Sign with a different secret | `validation_failed`, detail `bad-signature:signature-mismatch` |

## Tests

```bash
npx jest Signature.test.js          # 27 offline tests
node server.js --replay-check       # replay harness, writes replay-evidence.json
node server.js --proof-check        # signed settlement proof with explorer links
```

- **`Signature.test.js` (offline, 27 tests):** payload format (field order,
  `OMNIPAY-v1` prefix, 7-decimal amount, determinism); valid signatures;
  tampering of amount, recipient, sender, nonce and request ID, wrong key and
  flipped signature byte; timestamp window (inside, at the edge, expired,
  future, non-numeric); malformed input (missing fields, `|` in a field,
  non-numeric amount, invalid public key, wrong-length or non-base64
  signature).
- **Live SMS relay tests (5 tests):** enabled with `RUN_LIVE_SMS_TESTS=true`
  and run against a running server through `/dev/simulate-sms`. They use a
  wrong PIN with valid signatures so no funds move. Required variables:
  `TEST_SENDER_PHONE`, `TEST_SENDER_ID`, `TEST_SENDER_SECRET`,
  `TEST_RECIPIENT`, `ADMIN_API_KEY` (optional: `TEST_SERVER_URL`,
  `TEST_WRONG_PIN`). Cases: unsigned `SEND`, tampered signature, expired
  timestamp, replayed request ID, reused nonce.
- **`--replay-check`:** one original request, three replays and a nonce reuse
  through the claim logic; seven checks (original accepted, replays rejected,
  nonce reuse rejected, single settlement, single transaction hash, balance
  unchanged, replay attempts recorded).
- **`--proof-check`:** requires `TEST_SENDER_ID`, `TEST_SENDER_SECRET`,
  `TEST_SENDER_PIN` and `TEST_RECIPIENT`. Runs a signed `/api/send` success
  case, a Soroban idempotency case and no-settlement cases, and prints
  Testnet explorer links.

## Transaction lifecycle

Every SMS `SEND` from a registered sender, every `/api/send` call and every
`/api/submit-payment` call gets one Firestore document in
`omnipay_relay_transactions` that moves through the states below. (`BAL`
requests, unrecognized messages, SMS from unregistered numbers and
rate-limited senders do not create one.)

```
RECEIVED -> VALIDATION_FAILED (terminal, nothing sent to Stellar)
         -> VALIDATED -> SUBMITTED -> CONFIRMED -> SETTLED
                                    -> FAILED
```

Each document keeps the full `statusHistory`. When Soroban is enabled, the
document also stores `sorobanTxHash` and `sorobanContractId`. The monitoring
dashboard is meant to read from this collection; it is **not yet wired into
the web app**. Until then the data can be queried through the admin-key-protected
`/api/relay-transactions` endpoints or directly in the Firebase Console.

## Firestore collections used

| Collection | Purpose |
|---|---|
| `users` | User profiles, wallet public keys, PIN hashes, XLM balances, transaction history. |
| `omnipay_relay_transactions` | Monitoring feed — one doc per payment attempt, full status history. |
| `omnipay_sms_events` | Inbound-SMS idempotency log (dedupe gateway retries). |
| `relay_requests` | Anti-replay: claimed `requestId`s for signed requests, with `replayCount` and the settlement `txHash`. |
| `omnipay_used_nonces` | Anti-replay: claimed `(senderId, nonce)` pairs for signed requests. |
| `omnipay_events` | Server-side activity/error log (e.g. wrong-PIN and failed-payment events). |

> Set a Firestore TTL policy on `relay_requests` and
> `omnipay_used_nonces`' `createdAt` field (Console → Firestore → Indexes →
> TTL) so old idempotency records don't accumulate forever.

## Project layout

```
.
├── server.js            # SMS Relay + backend logic + Soroban/Stellar settlement
├── Signature.js         # Signed payload format and Ed25519 verification
├── Relay.js             # Request ID and nonce claim (replay protection)
├── Signature.test.js    # Signature unit tests and live SMS relay tests
├── package.json
├── .env.example         # template for .env (never commit the real .env)
├── sign-sms.js          # test helper: builds signed SMS lines / /api/send bodies
├── index.html           # OmniPay web app (served statically by server.js)
├── script.js            # Web app logic, Firebase Auth + Firestore client, SMS signing
└── styles.css
```

## Status

**Week 2** — Node.js SMS Relay, authenticated SMS payload validation,
signature verification, nonce and timestamp replay protection, Soroban smart
contract integration, initial SMS transaction testing.

Implemented:

- [x] Gateway webhook receiver with HMAC verification and duplicate-event protection
- [x] SMS command parsing (`SEND`, `BAL`) and the signed `SIG` variant
- [x] Ed25519 signature verification over the `OMNIPAY-v1` payload (`Signature.js`)
- [x] 5-minute timestamp window, `requestId` format check, `requestId` and nonce uniqueness through an atomic Firestore claim (`Relay.js`)
- [x] Replay tracking (`replayCount`, original transaction hash) and `GET /api/replay-audit/:requestId`
- [x] `REQUIRE_SIGNED_SMS` enforced by default
- [x] Client-side payload signing and SMS composition in the web app
- [x] Authenticated `/api/send` channel
- [x] Soroban `settle()` invocation with confirmation polling, recorded before the Stellar payment
- [x] Stellar Testnet settlement (classic `payment` operation) and SMS confirmations
- [x] Firestore relay records with the lifecycle above
- [x] PIN lockout and per-sender SMS rate limiting
- [x] `Signature.test.js` (27 offline tests, 5 live SMS relay tests), `--replay-check` and `--proof-check`
- [x] `sign-sms.js` helper for producing signed SMS lines and `/api/send` bodies

**Later in the sprint (not yet implemented):**

- Deployment of the Soroban contract on Stellar Testnet, with the contract ID and explorer links as evidence (Week 3)
- Public deployment of the web application (Week 3)
- Web app routed through `/api/send` (it currently uses `/api/submit-payment`, and the Freighter flow submits directly to Horizon). At that point, stop the browser from overwriting `users.transactions` (`syncSenderTxsToFirestore`) so the backend is the only writer of transaction history.
- Monitoring dashboard in the web app
- OmniCard authentication prototype (optional stretch goal)

**Known MVP limitations:**

- Relay and backend logic run in one process (`server.js`) rather than as separate services.
- The Soroban record is written before the Stellar payment. If the payment fails after a successful contract call, the two records can differ.
- PIN lockout and SMS rate limiting are held in memory and reset when the server restarts.
- The 4–6 digit PIN is an MVP-stage secret and is sent together with the signature in the SMS body.
- `/api/submit-payment` does not authenticate the caller beyond the Stellar signature on the transaction itself.