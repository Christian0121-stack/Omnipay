# OmniPay SMS Relay

Node.js service that lets an OmniPay user send a Stellar Testnet payment by
plain SMS — no internet connection needed on the sender's phone. An Android
device running the [android-sms-gateway](https://docs.sms-gate.app) app
receives the SMS and forwards it to this server over a webhook; this server
validates the request, executes the payment on the Stellar Testnet, updates
Firestore for the monitoring dashboard, and texts a confirmation back.

```
Phone A (no internet) --SMS--> Gateway Phone (android-sms-gateway)
     --HTTP webhook--> THIS SERVER --> Firestore (lookup + record)
     --> Stellar Testnet payment --> Firestore (update)
     --HTTP (Basic Auth)--> Gateway Phone --SMS--> Recipient (confirmation)
```

## Part of

Instaward SOW — OmniPay (THE MOON PROJECT), Week 1 deliverable: *"Functional
SMS Relay connected to the OmniPay backend with authenticated request
processing."*

## Requirements

- Node.js >= 18
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

## Environment variables

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
| `SMS_GATEWAY_WEBHOOK_SECRET` | yes | Shared secret used to verify the `X-Signature`/`X-Timestamp` headers on inbound webhook calls. |
| `STELLAR_HORIZON_URL` | no | Default `https://horizon-testnet.stellar.org`. |
| `STELLAR_NETWORK_PASSPHRASE` | no | Default Testnet passphrase. |
| `SMS_ASSET_LABEL` | no | Display label for the asset in SMS replies. Default `XLM`. |
| `REQUIRE_SIGNED_SMS` | no | `true`/`false`. When `true`, plain unsigned `SEND` SMS commands are rejected — see **Authentication** below. Default `false`. |

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

The signature is an Ed25519 signature (base64, 64 raw bytes) over
`senderId|recipientId|amount(7dp)|timestamp(ms)|nonce|requestId`, produced
with the sender's existing Stellar keypair. The relay verifies it against
the sender's registered `walletPublic` before anything else runs, rejects
requests with a timestamp more than 5 minutes old/skewed, and rejects any
`requestId`/`nonce` pair it has already seen (replay protection).

## Authentication

- **`/api/send`** (JSON) always requires the full authenticated payload
  (`senderId`, `recipientId`, `amount`, `timestamp`, `nonce`, `requestId`,
  `signature`, `pin`) — this channel is authenticated regardless of
  `REQUIRE_SIGNED_SMS`.
- **Plain-text SMS `SEND`** is authenticated by PIN only, unless
  `REQUIRE_SIGNED_SMS=true`, in which case the signed suffix above is
  mandatory and unsigned SMS is rejected. Keep this `false` until your
  OmniPay app actually builds and sends the signed suffix on every phone —
  flipping it early locks out anyone still on the old app. The server logs
  its current enforcement mode on startup so this is never silent.

## API reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check. Returns `{ ok: true }`. |
| `POST` | `/webhook/sms-received` | Called by android-sms-gateway on every inbound SMS. Requires valid `X-Signature`/`X-Timestamp` headers (see `SMS_GATEWAY_WEBHOOK_SECRET`). |
| `POST` | `/api/send` | Authenticated JSON payment channel. Body: `{ senderId, recipientId, amount, timestamp, nonce, requestId, signature, pin }`. |
| `POST` | `/dev/simulate-sms` | **Localhost only.** Simulates an inbound SMS without a real gateway. Body: `{ sender, message }`. Use this to test both the plain and signed SMS flows locally — see below. |
| `GET` | `/api/relay-transactions` | Recent relay transactions for the monitoring dashboard. Query: `?status=`, `?limit=` (max 200). |
| `GET` | `/api/relay-transactions/:id` | One relay transaction, with full status history. |
| `POST` | `/api/reconcile-balance/:userId` | Overwrites the user's Firestore `xlmBalance` with their live Stellar ledger balance. |

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

```bash
# Plain (PIN-only) command
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"SEND 50 juan_delacruz 1234"}'

# Balance check
curl -X POST http://localhost:3000/dev/simulate-sms \
  -H "Content-Type: application/json" \
  -d '{"sender":"09171234567","message":"BAL 1234"}'
```

## Transaction lifecycle

Every payment attempt (SMS or `/api/send`) gets one Firestore document in
`omnipay_relay_transactions` that moves through:

```
RECEIVED -> VALIDATION_FAILED (terminal, nothing sent to Stellar)
         -> VALIDATED -> SUBMITTED -> CONFIRMED -> SETTLED
                                    -> FAILED
```

The frontend dashboard listens to this collection in real time.

## Firestore collections used

| Collection | Purpose |
|---|---|
| `users` | User profiles, wallet public keys, encrypted PIN-wallet secrets, XLM balances. |
| `omnipay_relay_transactions` | Monitoring-dashboard feed — one doc per payment attempt, full status history. |
| `omnipay_sms_events` | Inbound-SMS idempotency log (dedupe gateway retries). |
| `omnipay_signed_requests` | Anti-replay: claimed `requestId`s for signed requests. |
| `omnipay_used_nonces` | Anti-replay: claimed `(senderId, nonce)` pairs for signed requests. |
| `omnipay_events` | General activity log (used by the existing dashboard UI). |

> Set a Firestore TTL policy on `omnipay_signed_requests` and
> `omnipay_used_nonces`' `createdAt` field (Console → Firestore → Indexes →
> TTL) so old idempotency records don't accumulate forever.

## Project layout

```
.
├── server.js        # SMS Relay + backend logic + Stellar settlement (this service)
├── package.json
├── index.html        # OmniPay web dashboard (served statically by server.js)
├── script.js          # Dashboard frontend logic, Firebase Auth + Firestore client
└── styles.css
```

## Status

Week 1 (project architecture, Firestore sync, Stellar SDK integration, SMS
Relay foundation with authenticated request processing) — complete. Soroban
smart contract settlement is Week 2/3 scope and not yet implemented; current
settlement uses a classic Stellar `payment` operation.