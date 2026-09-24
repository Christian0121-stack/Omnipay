# OmniPay SMS Relay

Node.js service that lets an OmniPay user send a Stellar Testnet payment by
plain SMS — no internet connection needed on the sender's phone. An Android
device running the [android-sms-gateway](https://docs.sms-gate.app) app
receives the SMS and forwards it to this server over a webhook; this server
validates the request, executes the payment on the Stellar Testnet, records
every step in Firestore for the monitoring dashboard, and texts a
confirmation back.

```
Phone A (no internet) --SMS--> Gateway Phone (android-sms-gateway)
     --HTTP webhook--> THIS SERVER --> Firestore (lookup + record)
     --> Stellar Testnet payment --> Firestore (update)
     --HTTP (Basic Auth)--> Gateway Phone --SMS--> Recipient (confirmation)
```

## Part of

Instaward SOW — OmniPay (THE MOON PROJECT), Week 1 deliverable: *"Functional
SMS Relay connected to the OmniPay backend with authenticated request
processing."* See [Status](#status) for what is done and what is still open.

## Requirements

- Node.js >= 22 (required by `firebase-admin` 14.x)
- A Firebase project with Firestore enabled, and a downloaded service
  account JSON (Firebase Console → Project settings → Service accounts →
  Generate new private key)
- An Android phone running [android-sms-gateway](https://sms-gate.app)
  (local server or cloud mode), with SIM/SMS capability
- A funded Stellar Testnet account for each OmniPay user (via
  [Friendbot](https://friendbot.stellar.org))

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values below
npm start
```

The server listens on `PORT` (default `3000`) and also serves the existing
frontend (`index.html`, `script.js`, `styles.css`) as static files.

> **Never commit `.env` or `serviceAccountKey.json`.** Both must be listed in
> `.gitignore`. They contain gateway credentials, the webhook signing secret
> and the Firebase Admin private key.

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
| `ADMIN_API_KEY` | for admin endpoints | Secret sent by callers in the `x-admin-key` header to use `/api/relay-transactions*` and `/api/reconcile-balance/*`. If unset, those endpoints return `503`. |
| `STELLAR_HORIZON_URL` | no | Default `https://horizon-testnet.stellar.org`. |
| `STELLAR_NETWORK_PASSPHRASE` | no | Default Testnet passphrase. |
| `SMS_ASSET_LABEL` | no | Display label for the asset in SMS replies. Default `XLM`. |
| `REQUIRE_SIGNED_SMS` | no | `true`/`false`. When `true`, plain unsigned `SEND` SMS commands are rejected — see [Authentication](#authentication). Default `false`. |

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

### Signed (authenticated) variant

```
SEND <amount> <recipient> <pin> SIG <timestamp> <nonce> <requestId> <signature>
```

The signature is an Ed25519 signature (base64, 64 raw bytes) over the string

```
senderId|recipientId|amount|timestamp|nonce|requestId
```

produced with the sender's existing Stellar keypair, where:

- `senderId` is the sender's Firestore `users` document ID (the Firebase Auth
  UID) — **not** the phone number.
- `recipientId` is the recipient exactly as written in the command.
- `amount` is formatted with 7 decimal places (`50` → `50.0000000`).
- `timestamp` is Unix time in milliseconds.

The relay verifies the signature against the sender's registered
`walletPublic` before anything else runs, rejects requests whose timestamp is
more than 5 minutes old or ahead, and rejects any `requestId` or
`(senderId, nonce)` pair it has already seen (replay protection).

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

The generated `nonce` (8 hex chars) and `requestId` (12 hex chars) are kept
short on purpose: the 88-character signature already takes most of a single
SMS, and with a UUID request ID the line would exceed 160 characters and be
sent as a multi-part SMS.

## Authentication

- **`/api/send`** (JSON) always requires the full authenticated payload
  (`senderId`, `recipientId`, `amount`, `timestamp`, `nonce`, `requestId`,
  `signature`, `pin`) — this channel is authenticated regardless of
  `REQUIRE_SIGNED_SMS`.
- **Plain-text SMS `SEND`** is authenticated by PIN only, unless
  `REQUIRE_SIGNED_SMS=true`, in which case the signed suffix above is
  mandatory and unsigned SMS is rejected. Keep this `false` until something
  actually builds and sends the signed suffix on every phone — flipping it
  early locks out anyone still sending unsigned commands. The server logs its
  current enforcement mode on startup so this is never silent.
- **Inbound webhooks** are authenticated with the gateway's `X-Signature`
  header (hex HMAC-SHA256 of the raw request body followed by the
  `X-Timestamp` value), using `SMS_GATEWAY_WEBHOOK_SECRET` as the key.
- **PIN brute-force protection:** 5 wrong PINs lock the sender out for 15
  minutes (`/api/send` and SMS). Inbound SMS is also rate-limited to 10
  messages per minute per sender.
- **Admin endpoints** require the `x-admin-key` header (`ADMIN_API_KEY`).

## API reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check. Returns `{ ok: true }`. |
| `POST` | `/webhook/sms-received` | Called by android-sms-gateway on every inbound SMS. Requires valid `X-Signature`/`X-Timestamp` headers (see `SMS_GATEWAY_WEBHOOK_SECRET`). |
| `POST` | `/api/send` | Authenticated JSON payment channel. Body: `{ senderId, recipientId, amount, timestamp, nonce, requestId, signature, pin }`. |
| `POST` | `/api/submit-payment` | Relays a payment that the client already signed as a Stellar transaction. Body: `{ senderId, recipientId, amount, signedXdr }`. Submits the XDR to Horizon and records a relay entry. It does **no** signature/PIN check of its own — the Stellar signature inside the XDR is what authorizes the payment, and `senderId`/`recipientId`/`amount` are recorded for monitoring only (not cross-checked against the XDR). Used by the current web send flow. |
| `POST` | `/dev/simulate-sms` | **Localhost only.** Simulates an inbound SMS without a real gateway (skips webhook signature checks). Body: `{ sender, message }`. |
| `GET` | `/api/relay-transactions` | Recent relay transactions. Query: `?status=`, `?limit=` (max 200). Requires `x-admin-key`. |
| `GET` | `/api/relay-transactions/:id` | One relay transaction, with full status history. Requires `x-admin-key`. |
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
    "nonce": "a1b2c3d4",
    "requestId": "0123456789ab",
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
stores the wallet public key and the PIN-encrypted wallet secret that the
relay needs. Accounts without those fields are rejected
(`wallet-not-setup` or `no-registered-signing-key`).

```bash
# Plain (PIN-only) command
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
| Replay | Send the exact same line twice | 2nd: `validation_failed`, detail `duplicate-request` |
| Reused nonce | New `--request-id`, same `--nonce` | `validation_failed`, detail `nonce-reused` |
| Expired | `--timestamp` older than 5 minutes | `validation_failed`, detail `bad-signature:timestamp-out-of-window` |
| Tampered | Change the amount in the line after signing | `validation_failed`, detail `bad-signature:signature-mismatch` |
| Wrong key | Sign with a different secret | `validation_failed`, detail `bad-signature:signature-mismatch` |

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

Each document keeps the full `statusHistory`. The monitoring dashboard is
meant to read from this collection; it is **not yet wired into the web app**.
Until then the data can be queried through the admin-key-protected
`/api/relay-transactions` endpoints or directly in the Firebase Console.

## Firestore collections used

| Collection | Purpose |
|---|---|
| `users` | User profiles, wallet public keys, encrypted PIN-wallet secrets, XLM balances, transaction history. |
| `omnipay_relay_transactions` | Monitoring feed — one doc per payment attempt, full status history. |
| `omnipay_sms_events` | Inbound-SMS idempotency log (dedupe gateway retries). |
| `omnipay_signed_requests` | Anti-replay: claimed `requestId`s for signed requests. |
| `omnipay_used_nonces` | Anti-replay: claimed `(senderId, nonce)` pairs for signed requests. |
| `omnipay_events` | Server-side activity/error log (e.g. wrong-PIN and failed-payment events). |

> Set a Firestore TTL policy on `omnipay_signed_requests` and
> `omnipay_used_nonces`' `createdAt` field (Console → Firestore → Indexes →
> TTL) so old idempotency records don't accumulate forever.

## Project layout

```
.
├── server.js         # SMS Relay + backend logic + Stellar settlement (this service)
├── package.json
├── .env.example      # template for .env (never commit the real .env)
├── sign-sms.js       # test helper: builds signed SMS lines / /api/send bodies
├── index.html        # OmniPay web app (served statically by server.js)
├── script.js         # Web app logic, Firebase Auth + Firestore client
└── styles.css
```

## Status

**Week 1** — project architecture, Firestore sync, Stellar SDK integration,
SMS Relay foundation with authenticated request processing.

Implemented in `server.js`:

- [x] Gateway webhook receiver with HMAC verification and duplicate-event protection
- [x] SMS command parsing (`SEND`, `BAL`) and the signed `SIG` variant
- [x] Ed25519 signature verification, 5-minute timestamp window, `requestId` + nonce replay protection
- [x] Authenticated `/api/send` channel
- [x] Stellar Testnet settlement (classic `payment` operation) and SMS confirmations
- [x] Firestore relay records with the lifecycle above
- [x] PIN lockout and per-sender SMS rate limiting
- [x] `sign-sms.js` helper for producing signed SMS lines and `/api/send` bodies

**Still open before Week 1 is signed off:**

- [ ] Signed-request test: run `sign-sms.js` against a registered user through `/dev/simulate-sms` (or `/api/send`) and record the results: the valid request is accepted, and the replayed and expired requests are rejected (see the table above)

**Recommended (not required by the Week 1 wording; the SOW places end-to-end testing in Weeks 2-4):**

- [ ] One recorded end-to-end run: real SMS -> gateway -> webhook -> `settled` in `omnipay_relay_transactions`, with the Testnet transaction hash and screenshots
- [ ] The same demo with `REQUIRE_SIGNED_SMS=true`, showing that an unsigned SMS is rejected

**Later in the sprint (not yet implemented):**

- Soroban smart contract settlement (settlement currently uses a classic Stellar `payment`)
- Web app routed through `/api/send` with in-app signing (it currently uses `/api/submit-payment`, and the Freighter flow submits directly to Horizon). At that point, stop the browser from overwriting `users.transactions` (`syncSenderTxsToFirestore`) so the backend is the only writer of transaction history.
- Monitoring dashboard in the web app
- OmniCard authentication prototype (optional stretch goal)

**Known MVP limitations:**

- Relay and backend logic run in one process (`server.js`) rather than as separate services.
- For SMS and `/api/send` payments the server decrypts the user's PIN-encrypted wallet secret to sign the Stellar transaction. This differs from the SOW's target that the private key is never exposed to the backend.
- `/api/submit-payment` does not authenticate the caller beyond the Stellar signature on the transaction itself.