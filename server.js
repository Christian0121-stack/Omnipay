const path = require('path');
const fs = require('fs');
require('dotenv').config();

const REQUIRED_ENV_VARS = ['FIREBASE_PROJECT_ID', 'STELLAR_HORIZON_URL'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key] || !String(process.env[key]).trim());
if (missingEnvVars.length > 0) {
  console.error(
    `[startup] Missing required environment variable(s): ${missingEnvVars.join(', ')}. ` +
      'Copy .env.example to .env and fill in the missing value(s) before starting the server.'
  );
  process.exit(1);
}

const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const StellarSdk = require('stellar-sdk');

const COLOR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR_ENABLED ? `\x1b[${code}m${text}\x1b[0m` : text);
const LOG_LEVELS = {
  info: { label: 'INFO', code: '36' },
  ok: { label: ' OK ', code: '32' },
  warn: { label: 'WARN', code: '33' },
  error: { label: 'FAIL', code: '31' },
};

function log(level, tag, message) {
  const meta = LOG_LEVELS[level] || LOG_LEVELS.info;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = `${paint('90', time)} ${paint(meta.code, meta.label)} ${paint('35', `[${tag}]`)} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const PORT = process.env.PORT || 3000;
const GATEWAY_MODE = (process.env.SMS_GATEWAY_USE || 'local').toLowerCase();
const USE_CLOUD_GATEWAY = GATEWAY_MODE === 'cloud' || GATEWAY_MODE === 'public';

const DEFAULT_CLOUD_GATEWAY_URL = 'https://api.sms-gate.app/3rdparty/v1';
const configuredGatewayUrl = USE_CLOUD_GATEWAY
  ? process.env.SMS_GATEWAY_PUBLIC_URL || DEFAULT_CLOUD_GATEWAY_URL
  : process.env.SMS_GATEWAY_LOCAL_URL;
const GATEWAY_BASE_URL = configuredGatewayUrl
  ? configuredGatewayUrl.trim().replace(/\/+$/, '')
  : '';
const GATEWAY_MESSAGE_PATH = USE_CLOUD_GATEWAY ? '/messages' : '/message';
const GATEWAY_USER = process.env.SMS_GATEWAY_USERNAME;
const GATEWAY_PASS = process.env.SMS_GATEWAY_PASSWORD;
const GATEWAY_WEBHOOK_SECRET = process.env.SMS_GATEWAY_WEBHOOK_SECRET || '';

const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;
const ASSET_LABEL = process.env.SMS_ASSET_LABEL || 'XLM';
const SOROBAN_RPC_URL = (process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org').trim();
const SOROBAN_CONTRACT_ID = (process.env.SOROBAN_CONTRACT_ID || '').trim();
const SOROBAN_SETTLE_FUNCTION = (process.env.SOROBAN_SETTLE_FUNCTION || 'settle').trim();
const SOROBAN_POLL_ATTEMPTS = parseInt(process.env.SOROBAN_POLL_ATTEMPTS, 10) || 30;
const SOROBAN_POLL_INTERVAL_MS = parseInt(process.env.SOROBAN_POLL_INTERVAL_MS, 10) || 1000;
const SOROBAN_ENABLED = Boolean(SOROBAN_CONTRACT_ID);
const SECRET_HASH_ITERATIONS = 150000;
const REQUIRE_SIGNED_SMS = String(process.env.REQUIRE_SIGNED_SMS || 'true').toLowerCase() === 'true';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const REPLAY_CHECK_ENABLED =
  process.argv.includes('--replay-check') || String(process.env.REPLAY_CHECK || '').toLowerCase() === 'true';
let db;
try {
  const serviceAccountPath = path.resolve(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json'
  );

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Service account file not found at: ${serviceAccountPath}`);
  }

  const serviceAccount = require(serviceAccountPath);

  if (!serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error(
      'Service account JSON is missing private_key or client_email — the file ' +
        'may be corrupted, truncated, or not the correct downloaded JSON.'
    );
  }

  initializeApp({
    credential: cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  db = getFirestore();
  log('ok', 'firebase', `Admin SDK initialized, project: ${process.env.FIREBASE_PROJECT_ID}`);
} catch (err) {
  console.error(
    '[firebase] Failed to initialize Admin SDK. Did you download the service ' +
      'account JSON (Firebase Console -> Project settings -> Service accounts) ' +
      'and point FIREBASE_SERVICE_ACCOUNT_PATH at it?\n',
    err.message
  );
  process.exit(1);
}

const usersCol = () => db.collection('users');
const eventsCol = () => db.collection('omnipay_events');
const smsEventsCol = () => db.collection('omnipay_sms_events');
const relayTransactionsCol = () => db.collection('omnipay_relay_transactions');
const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
const SorobanRpcNamespace = StellarSdk.rpc || StellarSdk.SorobanRpc;
let sorobanServer = null;
if (SOROBAN_ENABLED) {
  if (!SorobanRpcNamespace || !StellarSdk.Contract) {
    console.error('[startup] SOROBAN_CONTRACT_ID is set but the installed stellar-sdk has no Soroban support. Upgrade stellar-sdk to v11 or newer.');
    process.exit(1);
  }
  try {
    StellarSdk.StrKey.decodeContract(SOROBAN_CONTRACT_ID);
  } catch (err) {
    console.error('[startup] SOROBAN_CONTRACT_ID is not a valid contract address (expected a value starting with C).');
    process.exit(1);
  }
  sorobanServer = new SorobanRpcNamespace.Server(SOROBAN_RPC_URL, {
    allowHttp: SOROBAN_RPC_URL.startsWith('http://'),
  });
}

const HORIZON_RETRY_ATTEMPTS = 3;
const HORIZON_RETRY_BASE_DELAY_MS = 300;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableHorizonError(err) {
  if (!err.response) return true;
  const status = err.response.status;
  return status === 502 || status === 503 || status === 504;
}

async function withHorizonRetry(operation, options = {}) {
  const attempts = options.attempts || HORIZON_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs || HORIZON_RETRY_BASE_DELAY_MS;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetriableHorizonError(err)) {
        throw err;
      }
      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      log('warn', 'stellar', `Horizon call failed (attempt ${attempt}/${attempts}), retrying in ${backoffMs}ms - ${err.message}`);
      await delay(backoffMs);
    }
  }
  throw lastErr;
}

async function sendStellarPayment(senderSecret, destinationPublicKey, amount) {
  const senderKeypair = StellarSdk.Keypair.fromSecret(senderSecret);
  const senderAccount = await withHorizonRetry(() => horizon.loadAccount(senderKeypair.publicKey()));

  const tx = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: destinationPublicKey,
        asset: StellarSdk.Asset.native(),
        amount: Number(amount).toFixed(7),
      })
    )
    .setTimeout(60)
    .build();

  tx.sign(senderKeypair);
  const result = await withHorizonRetry(() => horizon.submitTransaction(tx));
  return result.hash;
}
async function getStellarNativeBalance(publicKey) {
  if (!publicKey) return null;
  try {
    const account = await withHorizonRetry(() => horizon.loadAccount(publicKey));
    const nativeBalance = account.balances.find((b) => b.asset_type === 'native');
    return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
  } catch (err) {
    log('error', 'stellar', `Balance lookup failed for ${publicKey} - ${err.message}`);
    return null;
  }
}
function amountToStroops(amount) {
  const [whole, fraction] = Number(amount).toFixed(7).split('.');
  return BigInt(whole + fraction);
}

async function waitForSorobanTransaction(hash) {
  for (let attempt = 1; attempt <= SOROBAN_POLL_ATTEMPTS; attempt += 1) {
    const result = await sorobanServer.getTransaction(hash);
    if (result.status === 'SUCCESS') return result;
    if (result.status === 'FAILED') throw new Error('soroban-transaction-failed');
    await delay(SOROBAN_POLL_INTERVAL_MS);
  }
  throw new Error('soroban-confirmation-timeout');
}

async function invokeSorobanSettlement(senderSecret, recipientPublicKey, amount, requestId) {
  const senderKeypair = StellarSdk.Keypair.fromSecret(senderSecret);
  const senderPublicKey = senderKeypair.publicKey();
  const sourceAccount = await sorobanServer.getAccount(senderPublicKey);
  const contract = new StellarSdk.Contract(SOROBAN_CONTRACT_ID);

  const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        SOROBAN_SETTLE_FUNCTION,
        StellarSdk.nativeToScVal(String(requestId), { type: 'string' }),
        new StellarSdk.Address(senderPublicKey).toScVal(),
        new StellarSdk.Address(recipientPublicKey).toScVal(),
        StellarSdk.nativeToScVal(amountToStroops(amount), { type: 'i128' })
      )
    )
    .setTimeout(60)
    .build();

  const prepared = await sorobanServer.prepareTransaction(tx);
  prepared.sign(senderKeypair);

  const submission = await sorobanServer.sendTransaction(prepared);
  if (submission.status === 'ERROR' || submission.status === 'TRY_AGAIN_LATER') {
    throw new Error(`soroban-submit-${String(submission.status).toLowerCase()}`);
  }

  await waitForSorobanTransaction(submission.hash);
  return submission.hash;
}

const OmniPayBackend = {
  async settlePayment(walletSecret, destinationPublicKey, amount) {
    return sendStellarPayment(walletSecret, destinationPublicKey, amount);
  },
  async recordSettlement(walletSecret, destinationPublicKey, amount, requestId) {
    return invokeSorobanSettlement(walletSecret, destinationPublicKey, amount, requestId);
  },
};
const { buildSignedPayloadString, isValidSigningKey, verifySignature } = require('./Signature');
const signedRequestsCol = () => db.collection('relay_requests');
const usedNoncesCol = () => db.collection('omnipay_used_nonces');
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const REJECTED_SEND_CODES = ['insufficient-balance', 'self-send'];

function getRegisteredSigningKey(user) {
  const key = user && typeof user.walletPublic === 'string' ? user.walletPublic.trim() : '';
  return isValidSigningKey(key) ? key : null;
}

function shortRef(value) {
  const str = String(value);
  return str.length > 12 ? `${str.slice(0, 12)}...` : str;
}

async function claimSignedRequest(requestId, nonce, senderId, meta = {}) {
  if (!requestId) {
    log('warn', 'nonce', `REJECTED (missing requestId) | channel=${meta.channel || 'n/a'} sender=${senderId}`);
    return { claimed: false, reason: 'missing-requestid' };
  }
  if (!nonce) {
    log('warn', 'nonce', `REJECTED (missing nonce) | channel=${meta.channel || 'n/a'} sender=${senderId}`);
    return { claimed: false, reason: 'missing-nonce' };
  }
  if (!REQUEST_ID_PATTERN.test(String(requestId))) {
    log('warn', 'nonce', `REJECTED (invalid requestId format) | channel=${meta.channel || 'n/a'} sender=${senderId}`);
    return { claimed: false, reason: 'invalid-requestid' };
  }

  const requestRef = signedRequestsCol().doc(String(requestId));
  const nonceRef = usedNoncesCol().doc(`${senderId}:${nonce}`);
  let previousStatus = null;
  let originalRequestId = null;

  try {
    await db.runTransaction(async (tx) => {
      const [existingRequest, existingNonce] = await Promise.all([
        tx.get(requestRef),
        tx.get(nonceRef),
      ]);
      if (existingRequest.exists) {
        previousStatus = (existingRequest.data() || {}).status || null;
        originalRequestId = String(requestId);
        throw new Error('duplicate-request');
      }
      if (existingNonce.exists) {
        originalRequestId = (existingNonce.data() || {}).requestId || null;
        throw new Error('nonce-reused');
      }

      tx.create(requestRef, {
        requestId: String(requestId),
        senderId,
        nonce: String(nonce),
        channel: meta.channel || null,
        relayId: meta.relayId || null,
        status: 'processing',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(nonceRef, {
        senderId,
        requestId: String(requestId),
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    log('ok', 'nonce', `ACCEPTED | channel=${meta.channel || 'n/a'} sender=${senderId} nonce=${shortRef(nonce)} requestId=${shortRef(requestId)}`);
    return { claimed: true };
  } catch (err) {
    if (err.message === 'duplicate-request') {
      const tracked = await trackReplayAttempt(originalRequestId, meta.channel);
      log('warn', 'nonce', `REPLAY REJECTED (duplicate request) | channel=${meta.channel || 'n/a'} sender=${senderId} nonce=${shortRef(nonce)} requestId=${shortRef(requestId)} previousStatus=${previousStatus || 'unknown'} replayCount=${tracked.replayCount || 'n/a'} originalTx=${tracked.txHash ? shortRef(tracked.txHash) : 'none'} newSettlement=no`);
      return { claimed: false, reason: 'duplicate-request', previousStatus, originalTxHash: tracked.txHash || null };
    }
    if (err.message === 'nonce-reused') {
      const tracked = await trackReplayAttempt(originalRequestId, meta.channel);
      log('warn', 'nonce', `REPLAY REJECTED (nonce already used) | channel=${meta.channel || 'n/a'} sender=${senderId} nonce=${shortRef(nonce)} requestId=${shortRef(requestId)} replayCount=${tracked.replayCount || 'n/a'} originalTx=${tracked.txHash ? shortRef(tracked.txHash) : 'none'} newSettlement=no`);
      return { claimed: false, reason: 'nonce-reused', previousStatus: tracked.status || null, originalTxHash: tracked.txHash || null };
    }
    log('error', 'signed-request', `Claim failed: ${err.message}`);
    return { claimed: false, reason: 'claim-error' };
  }
}

async function trackReplayAttempt(originalRequestId, channel) {
  if (!originalRequestId) return {};
  const ref = signedRequestsCol().doc(String(originalRequestId));
  try {
    await ref.update({
      replayCount: FieldValue.increment(1),
      lastReplayAt: FieldValue.serverTimestamp(),
      lastReplayChannel: channel || null,
    });
    const snap = await ref.get();
    const data = snap.data() || {};
    return { txHash: data.txHash || null, status: data.status || null, replayCount: data.replayCount || 0 };
  } catch (err) {
    log('error', 'nonce', `Replay tracking failed: ${err.message}`);
    return {};
  }
}

async function finishSignedRequest(requestId, status, extra = {}) {
  if (!requestId) return;
  const fields = { status: status || 'processed', updatedAt: FieldValue.serverTimestamp() };
  if (extra.txHash) fields.txHash = extra.txHash;
  if (extra.sorobanTxHash) fields.sorobanTxHash = extra.sorobanTxHash;
  if (extra.detail) fields.detail = String(extra.detail);
  try {
    await signedRequestsCol().doc(String(requestId)).update(fields);
  } catch (err) {
    log('error', 'signed-request', `Finalize failed: ${err.message}`);
  }
}
function verifyPinHash(pin, hash, saltHex) {
  if (!pin || !hash || !saltHex) return false;
  const PREFIX = 'pbkdf2-sha256$';
  if (String(hash).indexOf(PREFIX) !== 0) return false;
  const parts = String(hash).slice(PREFIX.length).split('$');
  const iterations = parseInt(parts[0], 10);
  const expectedHex = parts[1] || '';
  if (!iterations || !expectedHex || !/^[0-9a-f]+$/i.test(expectedHex)) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const derived = crypto.pbkdf2Sync(String(pin), salt, iterations, 32, 'sha256');
    const actual = crypto.createHmac('sha256', derived).update('OmniPay secret record').digest('hex');
    const actualBuf = Buffer.from(actual, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch (err) {
    return false;
  }
}

function decryptWalletSecretByPin(ciphertextB64, saltHex, ivB64, pin) {
  if (!ciphertextB64 || !saltHex || !ivB64 || !pin) return '';
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const key = crypto.pbkdf2Sync(String(pin), salt, SECRET_HASH_ITERATIONS, 32, 'sha256');
    const iv = Buffer.from(ivB64, 'base64');
    const data = Buffer.from(ciphertextB64, 'base64');
    if (data.length < 17) return '';

    const authTag = data.subarray(data.length - 16);
    const encrypted = data.subarray(0, data.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    return '';
  }
}
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
const pinAttempts = new Map();

function isPinLocked(phone) {
  const key = normalizePhone(phone);
  const rec = pinAttempts.get(key);
  if (!rec) return false;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    pinAttempts.delete(key);
  }
  return false;
}

function registerPinFailure(phone) {
  const key = normalizePhone(phone);
  const rec = pinAttempts.get(key) || { count: 0, lockedUntil: 0, lastAttempt: 0 };
  rec.count += 1;
  rec.lastAttempt = Date.now();
  if (rec.count >= PIN_MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
  }
  pinAttempts.set(key, rec);
}

function cleanupExpiredPinAttempts() {
  const now = Date.now();
  let removed = 0;
  for (const [key, rec] of pinAttempts.entries()) {
    const isExpiredLock = rec.lockedUntil && now >= rec.lockedUntil;
    const isStaleUnlocked = !rec.lockedUntil && now - (rec.lastAttempt || 0) > PIN_LOCKOUT_MS;
    if (isExpiredLock || isStaleUnlocked) {
      pinAttempts.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) {
    log('info', 'cleanup', `Removed ${removed} expired pinAttempts entr${removed === 1 ? 'y' : 'ies'} (${pinAttempts.size} remaining)`);
  }
}

function clearPinFailures(phone) {
  pinAttempts.delete(normalizePhone(phone));
}
function normalizePhone(raw) {
  if (!raw) return '';
  return raw.trim();
}
const SMS_RATE_LIMIT_MAX = 10;
const SMS_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const smsRateLimits = new Map();

function consumeSmsRateLimit(phone) {
  const key = normalizePhone(phone);
  const now = Date.now();
  const rec = smsRateLimits.get(key);

  if (!rec || now - rec.windowStartedAt >= SMS_RATE_LIMIT_WINDOW_MS) {
    smsRateLimits.set(key, { count: 1, windowStartedAt: now });
    return true;
  }

  if (rec.count >= SMS_RATE_LIMIT_MAX) {
    return false;
  }

  rec.count += 1;
  smsRateLimits.set(key, rec);
  return true;
}

function cleanupExpiredSmsRateLimits() {
  const now = Date.now();
  let removed = 0;
  for (const [key, rec] of smsRateLimits.entries()) {
    if (now - rec.windowStartedAt >= SMS_RATE_LIMIT_WINDOW_MS) {
      smsRateLimits.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) {
    log('info', 'cleanup', `Removed ${removed} expired smsRateLimits entr${removed === 1 ? 'y' : 'ies'} (${smsRateLimits.size} remaining)`);
  }
}

const MAP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  cleanupExpiredPinAttempts();
  cleanupExpiredSmsRateLimits();
}, MAP_CLEANUP_INTERVAL_MS).unref();

async function findUserByPhone(phone) {
  const clean = normalizePhone(phone);
  if (!clean) return null;

  const snap = await usersCol().where('phone', '==', clean).limit(2).get();
  if (snap.size === 1) {
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  if (snap.size > 1) return null;
  const last9 = clean.replace(/\D/g, '').slice(-9);
  if (!last9) return null;

  const all = await usersCol().get();
  const matches = all.docs.filter((d) => {
    const p = (d.data().phone || '').replace(/\D/g, '').slice(-9);
    return p === last9;
  });
  return matches.length === 1 ? { id: matches[0].id, ...matches[0].data() } : null;
}

async function findRecipient(identifier) {
  const raw = identifier.trim().replace(/^@/, '');
  try {
    const byId = await usersCol().doc(raw).get();
    if (byId.exists) return { id: byId.id, ...byId.data() };
  } catch (err) {
  }
  for (const candidate of [...new Set([raw, raw.toLowerCase()])]) {
    const snap = await usersCol().where('username', '==', candidate).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  return findUserByPhone(raw);
}
async function sendSms(toNumber, text) {
  if (!GATEWAY_BASE_URL) {
    log('warn', 'sms', `No gateway URL configured, skipping send to ${toNumber}`);
    return;
  }
  log('info', 'sms', `Sending reply to ${toNumber} via ${GATEWAY_BASE_URL}${GATEWAY_MESSAGE_PATH}`);
  try {
    const response = await axios.post(
      `${GATEWAY_BASE_URL}${GATEWAY_MESSAGE_PATH}`,
      { textMessage: { text }, phoneNumbers: [toNumber] },
      {
        auth: { username: GATEWAY_USER, password: GATEWAY_PASS },
        timeout: 15000,
      }
    );
    const data = response.data || {};
    const state = data.state ? `, ${data.state}` : '';
    const id = data.id ? `, id ${data.id}` : '';
    log('ok', 'sms', `Reply accepted by gateway for ${toNumber} (HTTP ${response.status}${state}${id})`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    const status = err.response?.status ? `HTTP ${err.response.status} - ` : '';
    log('error', 'sms', `Failed to send reply to ${toNumber}: ${status}${detail}`);
  }
}
function verifyWebhookSignature(rawBody, headers) {
  if (!GATEWAY_WEBHOOK_SECRET) {
    log('error', 'webhook', 'SMS_GATEWAY_WEBHOOK_SECRET is not set — rejecting all webhook calls until it is configured.');
    return false;
  }
  const signature = headers['x-signature'];
  const timestamp = headers['x-timestamp'];
  if (!signature || !timestamp) return false;

  const expected = crypto
    .createHmac('sha256', GATEWAY_WEBHOOK_SECRET)
    .update(rawBody + timestamp)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
async function logEvent(userId, icon, message, type) {
  try {
    await eventsCol().add({
      userId,
      icon,
      message,
      type,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log('error', 'firestore', `logEvent failed: ${err.message}`);
  }
}

async function recordTransaction(userDocId, txRecord) {
  try {
    await usersCol()
      .doc(userDocId)
      .update({
        transactions: FieldValue.arrayUnion(txRecord),
      });
  } catch (err) {
    log('error', 'firestore', `recordTransaction failed: ${err.message}`);
  }
}
const RELAY_STATUS = {
  RECEIVED: 'received',
  VALIDATION_FAILED: 'validation_failed',
  VALIDATED: 'validated',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  SETTLED: 'settled',
  FAILED: 'failed',
};
async function createRelayRecord({ channel, senderPhone, senderId, recipient, amount, signedPayload }) {
  const ref = relayTransactionsCol().doc();
  const now = Date.now();
  try {
    await ref.set({
      channel,
      senderPhone: senderPhone || null,
      senderId: senderId || null,
      recipient: recipient != null ? String(recipient) : null,
      amount: amount != null ? Number(amount) : null,
      signedPayload: signedPayload || null,
      signatureValidation: null,
      status: RELAY_STATUS.RECEIVED,
      statusHistory: [{ status: RELAY_STATUS.RECEIVED, at: now }],
      txHash: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log('error', 'relay', `Failed to create record: ${err.message}`);
  }
  return ref.id;
}
async function updateRelayStatus(relayId, status, fields = {}) {
  if (!relayId) return;
  const { detail, ...rest } = fields;
  const historyEntry = { status, at: Date.now() };
  if (detail !== undefined) {
    historyEntry.detail = typeof detail === 'string' ? detail : JSON.stringify(detail);
  }
  try {
    await relayTransactionsCol()
      .doc(relayId)
      .update({
        status,
        ...rest,
        statusHistory: FieldValue.arrayUnion(historyEntry),
        updatedAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    log('error', 'relay', `Failed to update ${relayId} to ${status}: ${err.message}`);
  }
}
async function updateRelayFields(relayId, fields) {
  if (!relayId) return;
  try {
    await relayTransactionsCol()
      .doc(relayId)
      .update({ ...fields, updatedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    log('error', 'relay', `Failed to update fields on ${relayId}: ${err.message}`);
  }
}
async function recordSignatureValidation(relayId, ok, reason) {
  if (!relayId) return;
  try {
    await relayTransactionsCol()
      .doc(relayId)
      .update({
        signatureValidation: {
          result: ok ? 'passed' : 'failed',
          reason: ok ? null : reason || 'unknown',
          checkedAt: Date.now(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    log('error', 'relay', `Failed to record signature validation for ${relayId}: ${err.message}`);
  }
}

function logSignedPayload(signedPayload, ok, reason) {
  if (!signedPayload) return;
  const sigPreview = String(signedPayload.signature || '').slice(0, 16);
  const outcome = ok ? 'PASSED' : `FAILED (${reason})`;
  log(
    ok ? 'ok' : 'warn',
    'sms',
    `Signed payload | senderId=${signedPayload.senderId} recipientId=${signedPayload.recipientId} amount=${signedPayload.amount} timestamp=${signedPayload.timestamp} nonce=${signedPayload.nonce} requestId=${signedPayload.requestId} signature=${sigPreview}... | validation=${outcome}`
  );
}

function buildSmsEventKey(senderPhone, messageText, payload) {
  const providerId =
    payload &&
    (payload.id || payload.messageId || payload.uuid || payload.eventId || payload.smsId);

  if (providerId) {
    return `provider-${crypto.createHash('sha256').update(String(providerId)).digest('hex')}`;
  }

  const sourceTimestamp =
    payload &&
    (payload.timestamp || payload.createdAt || payload.receivedAt || payload.date);
  const timeBucket = sourceTimestamp ? String(sourceTimestamp) : String(Math.floor(Date.now() / 30000));
  const fingerprint = [
    normalizePhone(senderPhone),
    String(messageText || '').trim(),
    timeBucket,
  ].join('\n');

  return `fingerprint-${crypto.createHash('sha256').update(fingerprint).digest('hex')}`;
}

async function claimSmsEvent(eventKey, senderPhone, messageText) {
  if (!eventKey) return true;

  const eventRef = smsEventsCol().doc(eventKey);
  try {
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(eventRef);
      if (existing.exists) {
        throw new Error('duplicate-sms-event');
      }

      transaction.create(eventRef, {
        kind: 'sms:received',
        status: 'processing',
        senderPhone: normalizePhone(senderPhone),
        messageHash: crypto
          .createHash('sha256')
          .update(String(messageText || ''))
          .digest('hex'),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return true;
  } catch (err) {
    if (err.message === 'duplicate-sms-event') {
      log('info', 'webhook', `Duplicate SMS event ignored: ${eventKey}`);
    } else {
      log('error', 'webhook', `Could not claim SMS event: ${err.message}`);
    }
    return false;
  }
}

async function finishSmsEvent(eventKey, status) {
  if (!eventKey) return;
  try {
    await smsEventsCol().doc(eventKey).update({
      status: status || 'processed',
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log('error', 'webhook', `Could not finalize SMS event: ${err.message}`);
  }
}
const MAX_AMOUNT_DECIMALS = 7;
const STRICT_AMOUNT_PATTERN = new RegExp(`^\\d+(\\.\\d{1,${MAX_AMOUNT_DECIMALS}})?$`);

function parseStrictAmount(raw) {
  if (raw === undefined || raw === null) return { ok: false, reason: 'amount-missing' };
  const str = typeof raw === 'string' ? raw.trim() : String(raw);
  if (!str) return { ok: false, reason: 'amount-missing' };
  if (!STRICT_AMOUNT_PATTERN.test(str)) return { ok: false, reason: 'amount-invalid-format' };
  const num = Number(str);
  if (!Number.isFinite(num)) return { ok: false, reason: 'amount-not-finite' };
  if (num <= 0) return { ok: false, reason: 'amount-not-positive' };
  return { ok: true, amount: num };
}

function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] || '').toUpperCase();

  if (cmd === 'SEND' && parts.length >= 4) {
    const sigIdx = parts.findIndex((p, i) => i >= 4 && p.toUpperCase() === 'SIG');

    let sendParts = parts;
    let sig = null;
    if (sigIdx !== -1) {
      sendParts = parts.slice(0, sigIdx);
      const sigParts = parts.slice(sigIdx + 1);
      if (sigParts.length !== 4) return { type: 'UNKNOWN' };
      sig = { timestamp: sigParts[0], nonce: sigParts[1], requestId: sigParts[2], signature: sigParts[3] };
    }

    const amountResult = parseStrictAmount(sendParts[1]);
    const pin = sendParts[sendParts.length - 1];
    const recipient = sendParts.slice(2, sendParts.length - 1).join(' ');
    if (amountResult.ok && recipient && isValidPin(pin)) {
      return { type: 'SEND', amount: amountResult.amount, recipient, pin, sig };
    }
  }
  if (
    (cmd === 'BAL' || cmd === 'BALANCE') &&
    parts.length === 2 &&
    /^\d{4,6}$/.test(parts[1])
  ) {
    return { type: 'BALANCE', pin: parts[1] };
  }
  return { type: 'UNKNOWN' };
}
async function executeSend({ sender, recipient, amount, walletSecret, mode, relayId, requestId }) {
  if ((sender.xlmBalance || 0) < amount) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'insufficient-balance' });
    return { ok: false, code: 'insufficient-balance', senderBalance: sender.xlmBalance || 0 };
  }
  if (recipient.id === sender.id) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'self-send' });
    return { ok: false, code: 'self-send' };
  }

  await updateRelayStatus(relayId, RELAY_STATUS.VALIDATED);

  const senderName = sender.username || sender.id;
  const recipientName = recipient.username || recipient.id;
  const icon = mode === 'sms' ? '📱' : '🔐';
  const channelNote = mode === 'sms' ? 'SMS' : 'signed API';

  try {
    await updateRelayStatus(relayId, RELAY_STATUS.SUBMITTED);

    let sorobanTxHash = null;
    if (SOROBAN_ENABLED) {
      try {
        sorobanTxHash = await OmniPayBackend.recordSettlement(
          walletSecret,
          recipient.walletPublic,
          amount,
          requestId || relayId
        );
        await updateRelayFields(relayId, {
          sorobanTxHash,
          sorobanContractId: SOROBAN_CONTRACT_ID,
        });
        log('ok', 'soroban', `Settlement recorded on contract ${SOROBAN_CONTRACT_ID.slice(0, 8)}... | tx ${sorobanTxHash.slice(0, 12)}...`);
      } catch (sorobanErr) {
        const sorobanDetail = `soroban:${sorobanErr.message}`;
        log('error', 'soroban', `Contract invocation failed: ${sorobanErr.message}`);
        await logEvent(sender.id, '❌', `${channelNote} payment blocked: contract settlement failed`, 'error');
        await updateRelayStatus(relayId, RELAY_STATUS.FAILED, { detail: sorobanDetail });
        return { ok: false, code: 'soroban-failed', detail: sorobanDetail, relayId };
      }
    }

    const txHash = await OmniPayBackend.settlePayment(walletSecret, recipient.walletPublic, amount);
    await updateRelayStatus(relayId, RELAY_STATUS.CONFIRMED, { txHash });
    const senderPublicKey = StellarSdk.Keypair.fromSecret(walletSecret).publicKey();
    const [chainSenderBal, chainRecipientBal] = await Promise.all([
      getStellarNativeBalance(senderPublicKey),
      getStellarNativeBalance(recipient.walletPublic),
    ]);

    const newSenderBal = chainSenderBal != null ? chainSenderBal : (sender.xlmBalance || 0) - amount;
    const newRecipientBal = chainRecipientBal != null ? chainRecipientBal : (recipient.xlmBalance || 0) + amount;

    await usersCol().doc(sender.id).update({ xlmBalance: newSenderBal });
    await usersCol().doc(recipient.id).update({ xlmBalance: newRecipientBal });

    const base = { id: 'tx-' + txHash.substring(0, 8), amount, status: 'synced', mode, txHash, ts: Date.now(), icon };
    if (sorobanTxHash) base.sorobanTxHash = sorobanTxHash;
    await recordTransaction(sender.id, { ...base, type: 'send', name: `To @${recipientName}`, note: `Sent via ${channelNote}` });
    await recordTransaction(recipient.id, { ...base, type: 'receive', name: `From @${senderName}`, note: `Received via ${channelNote}` });

    await updateRelayStatus(relayId, RELAY_STATUS.SETTLED);

    log('ok', 'payment', `${amount} ${ASSET_LABEL} settled via ${channelNote} | @${senderName} -> @${recipientName} | tx ${txHash.slice(0, 12)}...`);
    return { ok: true, txHash, sorobanTxHash, newSenderBal, newRecipientBal, relayId };
  } catch (err) {
    const detail = err.response?.data?.extras?.result_codes || err.message;
    log('error', 'stellar', `Payment failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    await logEvent(sender.id, '❌', `${channelNote} payment failed: ${JSON.stringify(detail)}`, 'error');
    await updateRelayStatus(relayId, RELAY_STATUS.FAILED, { detail });
    return { ok: false, code: 'stellar-failed', detail, relayId };
  }
}
async function handleIncomingSms(senderPhone, messageText, eventKey) {
  if (!consumeSmsRateLimit(senderPhone)) {
    log('warn', 'sms', `Rate limit exceeded for sender: ${senderPhone}`);
    return;
  }

  const claimed = await claimSmsEvent(eventKey, senderPhone, messageText);
  if (!claimed) return;

  try {
    const command = parseCommand(messageText);
    log('info', 'sms', `Command ${command.type} from ${senderPhone}`);

    const sender = await findUserByPhone(senderPhone);
    if (!sender) {
      log('warn', 'sms', `No account linked to ${senderPhone}`);
      if (command.type === 'SEND') {
        const unknownRelayId = await createRelayRecord({
          channel: 'sms',
          senderPhone: normalizePhone(senderPhone),
          senderId: null,
          recipient: command.recipient,
          amount: command.amount,
          signedPayload: null,
        });
        await recordSignatureValidation(unknownRelayId, false, 'unknown-sender');
        await updateRelayStatus(unknownRelayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'unknown-sender' });
      }
      await sendSms(
        senderPhone,
        "OmniPay: This number isn't linked to an OmniPay account. Register in the app first."
      );
      return;
    }

    if (command.type === 'BALANCE') {
      if (isPinLocked(senderPhone)) {
        await sendSms(
          senderPhone,
          'OmniPay: Too many wrong PIN attempts. Try again in a bit, or use the app.'
        );
        return;
      }

      if (!sender.smsPinHash || !sender.smsPinSalt) {
        log('warn', 'sms', `Sender doc ${sender.id} has no smsPinHash for BALANCE.`);
        await sendSms(
          senderPhone,
          'OmniPay: Balance PIN is not enabled yet. Log in to the app to set up your wallet.'
        );
        return;
      }
      const balancePinCheck = verifyPinHash(command.pin, sender.smsPinHash, sender.smsPinSalt);

      if (!balancePinCheck) {
        registerPinFailure(senderPhone);
        await logEvent(sender.id, '❌', 'SMS balance blocked: incorrect PIN', 'error');
        await sendSms(senderPhone, 'OmniPay: Incorrect PIN. Balance not sent.');
        return;
      }

      clearPinFailures(senderPhone);
      await sendSms(
        senderPhone,
        `OmniPay: Your balance is ${(sender.xlmBalance || 0).toFixed(4)} ${ASSET_LABEL}.`
      );
      return;
    }

    if (command.type === 'SEND') {
      const { amount, recipient: recipientIdentifier, pin, sig } = command;

      const signedPayload = sig
        ? {
            senderId: sender.id,
            recipientId: recipientIdentifier,
            amount: Number(amount).toFixed(7),
            timestamp: sig.timestamp,
            nonce: sig.nonce,
            requestId: sig.requestId,
            signature: sig.signature,
          }
        : null;

      const relayId = await createRelayRecord({
        channel: 'sms',
        senderPhone: normalizePhone(senderPhone),
        senderId: sender.id,
        recipient: recipientIdentifier,
        amount,
        signedPayload,
      });

      if (REQUIRE_SIGNED_SMS && !sig) {
        await recordSignatureValidation(relayId, false, 'signature-required');
        await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'signature-required' });
        await sendSms(senderPhone, 'OmniPay: This command must be signed. Update your OmniPay app to the latest version.');
        return;
      }

      if (sig) {
        const signingKey = getRegisteredSigningKey(sender);
        if (!signingKey) {
          logSignedPayload(signedPayload, false, 'no-registered-signing-key');
          await recordSignatureValidation(relayId, false, 'no-registered-signing-key');
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'no-registered-signing-key' });
          await sendSms(senderPhone, 'OmniPay: Your account has no registered signing key yet. Log in to the app once.');
          return;
        }
        const verifyResult = verifySignature({
          senderId: sender.id,
          recipientId: recipientIdentifier,
          amount,
          timestamp: sig.timestamp,
          nonce: sig.nonce,
          requestId: sig.requestId,
          signature: sig.signature,
          senderPublicKey: signingKey,
        });
        if (!verifyResult.ok) {
          log('warn', 'sms', `Signature rejected: ${verifyResult.reason} (sender: ${sender.id})`);
          logSignedPayload(signedPayload, false, verifyResult.reason);
          await recordSignatureValidation(relayId, false, verifyResult.reason);
          await logEvent(sender.id, '❌', `SMS payment blocked: bad signature (${verifyResult.reason})`, 'error');
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: `bad-signature:${verifyResult.reason}` });
          await sendSms(senderPhone, 'OmniPay: Signature check failed. Payment not sent.');
          return;
        }
        const claim = await claimSignedRequest(sig.requestId, sig.nonce, sender.id, { channel: 'sms', relayId });
        if (!claim.claimed) {
          logSignedPayload(signedPayload, false, claim.reason || 'duplicate-request');
          await recordSignatureValidation(relayId, false, claim.reason || 'duplicate-request');
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: claim.reason || 'duplicate-request' });
          if (claim.reason === 'claim-error') {
            await sendSms(senderPhone, 'OmniPay: Could not process your request right now. Nothing was deducted. Please try again.');
          } else if (claim.reason === 'invalid-requestid') {
            await sendSms(senderPhone, 'OmniPay: Invalid request. Payment not sent.');
          } else if (['duplicate-request', 'nonce-reused'].includes(claim.reason)) {
            await sendSms(senderPhone, 'OmniPay: Duplicate request ignored. No additional payment was made.');
          }
          return;
        }
        logSignedPayload(signedPayload, true);
        await recordSignatureValidation(relayId, true);
      }

      let requestOutcome = 'rejected';
      let requestExtra = {};
      try {
        if (isPinLocked(senderPhone)) {
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'pin-locked' });
          await sendSms(senderPhone, `OmniPay: Too many wrong PIN attempts. Try again in a bit, or use the app.`);
          return;
        }

        if (!sender.pinWalletSecretEncrypted || !sender.pinWalletSecretSalt || !sender.pinWalletSecretIv || !sender.walletPublic) {
          log('warn', 'sms', `Sender doc ${sender.id} has no pinWalletSecretEncrypted — log in to the app once to set up SMS payments.`);
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'wallet-not-setup' });
          await sendSms(senderPhone, 'OmniPay: SMS payments are not enabled for your wallet yet. Log in to the app to set it up.');
          return;
        }
        const walletSecret = decryptWalletSecretByPin(
          sender.pinWalletSecretEncrypted,
          sender.pinWalletSecretSalt,
          sender.pinWalletSecretIv,
          pin
        );
        if (!walletSecret) {
          registerPinFailure(senderPhone);
          await logEvent(sender.id, '❌', 'SMS payment blocked: incorrect PIN', 'error');
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'incorrect-pin' });
          await sendSms(senderPhone, 'OmniPay: Incorrect PIN. Payment not sent.');
          return;
        }
        clearPinFailures(senderPhone);

        const recipient = await findRecipient(recipientIdentifier);
        if (!recipient || !recipient.walletPublic) {
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'recipient-not-found' });
          await sendSms(senderPhone, `OmniPay: Recipient "${recipientIdentifier}" not found on OmniPay.`);
          return;
        }

        requestOutcome = 'failed';
        const result = await executeSend({
          sender,
          recipient,
          amount,
          walletSecret,
          mode: 'sms',
          relayId,
          requestId: sig ? sig.requestId : relayId,
        });

        if (!result.ok) {
          requestOutcome = REJECTED_SEND_CODES.includes(result.code) ? 'rejected' : 'failed';
          requestExtra = { detail: result.code };
          if (result.code === 'insufficient-balance') {
            await sendSms(senderPhone, `OmniPay: Insufficient balance. You have ${result.senderBalance.toFixed(4)} ${ASSET_LABEL}.`);
          } else if (result.code === 'self-send') {
            await sendSms(senderPhone, "OmniPay: You can't send money to yourself.");
          } else {
            await sendSms(senderPhone, `OmniPay: Payment failed (${JSON.stringify(result.detail)}). Nothing was deducted.`);
          }
          return;
        }

        requestOutcome = 'processed';
        requestExtra = { txHash: result.txHash, sorobanTxHash: result.sorobanTxHash };
        const recipientName = recipient.username || recipient.id;
        const senderName = sender.username || sender.id;
        await sendSms(
          senderPhone,
          `OmniPay: Sent ${amount} ${ASSET_LABEL} to ${recipientName}. TX: ${result.txHash.slice(0, 12)}... New balance: ${result.newSenderBal.toFixed(4)} ${ASSET_LABEL}.`
        );
        if (recipient.phone) {
          await sendSms(
            recipient.phone,
            `OmniPay: You received ${amount} ${ASSET_LABEL} from ${senderName}. New balance: ${result.newRecipientBal.toFixed(4)} ${ASSET_LABEL}.`
          );
        }
      } finally {
        if (sig) await finishSignedRequest(sig.requestId, requestOutcome, requestExtra);
      }
      return;
    }
    await sendSms(
      senderPhone,
      'OmniPay commands: "SEND <amount> <username|number> <pin>" or "BAL <pin>" to check your balance.'
    );
  } finally {
    await finishSmsEvent(eventKey, 'processed');
  }
}
const app = express();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://www.gstatic.com',
          'https://cdnjs.cloudflare.com',
          'https://cdn.jsdelivr.net',
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: [
          "'self'",
          'https://horizon-testnet.stellar.org',
          'https://friendbot.stellar.org',
          'https://api.coingecko.com',
          'https://min-api.cryptocompare.com',
          'https://firestore.googleapis.com',
          'https://identitytoolkit.googleapis.com',
          'https://securetoken.googleapis.com',
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
    methods: ['GET', 'POST'],
  })
);

app.use(
  express.json({
    limit: '20kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore' }));
} else {
  const FRONTEND_FILES = ['index.html', 'styles.css', 'script.js'];
  FRONTEND_FILES.forEach((name) => {
    const filePath = path.join(__dirname, name);
    app.get('/' + (name === 'index.html' ? '' : name), (_req, res) => {
      if (!fs.existsSync(filePath)) return res.status(404).end();
      res.sendFile(filePath);
    });
  });
}
const paymentEndpointLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, please try again later' },
});

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkFirestore() {
  const started = Date.now();
  try {
    if (!db) throw new Error('Firestore not initialized');
    await withTimeout(db.listCollections(), 4000);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - started, message: err.message };
  }
}

async function checkHorizon() {
  const started = Date.now();
  try {
    await withTimeout(axios.get(HORIZON_URL, { timeout: 4000 }), 4000);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - started, message: err.message };
  }
}

async function checkSoroban() {
  const started = Date.now();
  try {
    await withTimeout(sorobanServer.getHealth(), 4000);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - started, message: err.message };
  }
}

app.get('/health', async (_req, res) => {
  const [firestoreCheck, horizonCheck, sorobanCheck] = await Promise.all([
    checkFirestore(),
    checkHorizon(),
    SOROBAN_ENABLED ? checkSoroban() : Promise.resolve(null),
  ]);
  const services = { firestore: firestoreCheck, horizon: horizonCheck };
  if (sorobanCheck) services.soroban = sorobanCheck;
  const allOk = Object.values(services).every((svc) => svc.status === 'ok');
  res.status(allOk ? 200 : 503).json({
    ok: allOk,
    timestamp: new Date().toISOString(),
    services,
  });
});
function requireAdminKey(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ error: 'admin endpoints disabled — set ADMIN_API_KEY' });
  }
  const provided = req.headers['x-admin-key'];
  const expected = Buffer.from(ADMIN_API_KEY);
  const got = Buffer.from(String(provided || ''));
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
app.post('/webhook/sms-received', async (req, res) => {
  log('info', 'webhook', `Request received from ${req.ip}`);

  if (!verifyWebhookSignature(req.rawBody, req.headers)) {
    log('warn', 'webhook', 'Rejected: bad or missing signature');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { event, payload } = req.body || {};
  if (event !== 'sms:received' || !payload) {
    log('info', 'webhook', `Ignored event: ${event || 'unknown'}`);
    return res.status(200).json({ ignored: true });
  }

  const senderPhone = payload.sender || payload.phoneNumber;
  const message = payload.message;
  if (!senderPhone || !message) {
    log('warn', 'webhook', 'Rejected: missing sender/message');
    return res.status(400).json({ error: 'missing sender/message' });
  }
  log('ok', 'webhook', `SMS received from ${senderPhone}`);
  const eventKey = buildSmsEventKey(senderPhone, message, payload);
  res.status(200).json({ received: true });

  handleIncomingSms(senderPhone, message, eventKey).catch((err) => {
    console.error('[handleIncomingSms] unhandled error:', err);
  });
});
function matchesAmount(xdrAmount, expectedAmount) {
  const parsed = Number(xdrAmount);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(parsed - expectedAmount) < 1e-7;
}

function crossCheckSignedXdr({ tx, senderPublicKey, recipientPublicKey, amount }) {
  if (!tx || !Array.isArray(tx.operations) || tx.operations.length !== 1) {
    return { ok: false, reason: 'unexpected-operation-count' };
  }
  const op = tx.operations[0];
  if (op.type !== 'payment') {
    return { ok: false, reason: 'not-a-payment-operation' };
  }
  if (op.asset && typeof op.asset.isNative === 'function' && !op.asset.isNative()) {
    return { ok: false, reason: 'unexpected-asset' };
  }
  const opSource = op.source || tx.source;
  if (!senderPublicKey || opSource !== senderPublicKey) {
    return { ok: false, reason: 'sender-mismatch' };
  }
  if (!recipientPublicKey || op.destination !== recipientPublicKey) {
    return { ok: false, reason: 'recipient-mismatch' };
  }
  if (!matchesAmount(op.amount, amount)) {
    return { ok: false, reason: 'amount-mismatch' };
  }
  return { ok: true };
}

app.post('/api/submit-payment', paymentEndpointLimiter, async (req, res) => {
  const { senderId, recipientId, amount, signedXdr } = req.body || {};

  if (!senderId || !recipientId || !signedXdr) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  const amountResult = parseStrictAmount(amount);
  if (!amountResult.ok) {
    return res.status(400).json({ error: 'invalid amount', reason: amountResult.reason });
  }
  const amt = amountResult.amount;

  const relayId = await createRelayRecord({
    channel: 'web',
    senderId,
    recipient: recipientId,
    amount: amt,
  });

  let tx;
  try {
    tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  } catch (err) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'malformed-transaction' });
    return res.status(400).json({ error: 'malformed transaction', relayId });
  }

  const senderDoc = await usersCol().doc(String(senderId)).get();
  if (!senderDoc.exists) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'sender-not-found' });
    return res.status(404).json({ error: 'sender not found', relayId });
  }
  const senderRecord = senderDoc.data();

  const recipientRecord = await findRecipient(String(recipientId));
  if (!recipientRecord || !recipientRecord.walletPublic) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'recipient-not-found' });
    return res.status(404).json({ error: 'recipient not found', relayId });
  }

  const crossCheck = crossCheckSignedXdr({
    tx,
    senderPublicKey: senderRecord.walletPublic,
    recipientPublicKey: recipientRecord.walletPublic,
    amount: amt,
  });
  if (!crossCheck.ok) {
    log('warn', 'api/submit-payment', `Signed XDR rejected: ${crossCheck.reason} (sender: ${senderId})`);
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: `xdr-mismatch:${crossCheck.reason}` });
    return res.status(400).json({ error: 'signed transaction does not match request', reason: crossCheck.reason, relayId });
  }

  await updateRelayStatus(relayId, RELAY_STATUS.VALIDATED);

  try {
    await updateRelayStatus(relayId, RELAY_STATUS.SUBMITTED);
    const result = await withHorizonRetry(() => horizon.submitTransaction(tx));

    await updateRelayStatus(relayId, RELAY_STATUS.CONFIRMED, { txHash: result.hash });
    await updateRelayStatus(relayId, RELAY_STATUS.SETTLED);

    return res.json({ ok: true, txHash: result.hash, relayId });
  } catch (err) {
    const extras = (err.response && err.response.data && err.response.data.extras) || {};
    const detail = (extras.result_codes && extras.result_codes.transaction) || err.message || 'submit-failed';
    log('error', 'api/submit-payment', `Failed: ${detail}`);
    await updateRelayStatus(relayId, RELAY_STATUS.FAILED, { detail });
    return res.status(502).json({ error: 'payment submission failed', detail, relayId });
  }
});

app.post('/api/send', paymentEndpointLimiter, async (req, res) => {
  const { senderId, recipientId, amount, timestamp, nonce, requestId, signature, pin } = req.body || {};

  if (!senderId || !recipientId || !timestamp || !nonce || !requestId || !signature) {
    return res.status(400).json({ error: 'missing required authenticated-payload fields' });
  }
  const amountResult = parseStrictAmount(amount);
  if (!amountResult.ok) {
    return res.status(400).json({ error: 'invalid amount', reason: amountResult.reason });
  }
  const amt = amountResult.amount;
  if (!isValidPin(pin)) {
    return res.status(400).json({ error: 'missing or invalid pin' });
  }

  const relayId = await createRelayRecord({
    channel: 'api',
    senderId,
    recipient: recipientId,
    amount: amt,
  });

  const senderDoc = await usersCol().doc(String(senderId)).get();
  if (!senderDoc.exists) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'unknown-sender' });
    return res.status(401).json({ error: 'unauthorized sender', relayId });
  }
  const sender = { id: senderDoc.id, ...senderDoc.data() };

  const signingKey = getRegisteredSigningKey(sender);
  if (!signingKey) {
    log('warn', 'api/send', `No registered signing key (sender: ${senderId})`);
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'no-registered-signing-key' });
    return res.status(401).json({ error: 'unauthorized sender', relayId });
  }

  const verifyResult = verifySignature({
    senderId,
    recipientId,
    amount: amt,
    timestamp,
    nonce,
    requestId,
    signature,
    senderPublicKey: signingKey,
  });
  if (!verifyResult.ok) {
    log('warn', 'api/send', `Signature rejected: ${verifyResult.reason} (sender: ${senderId})`);
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: `bad-signature:${verifyResult.reason}` });
    return res.status(401).json({ error: 'invalid signature', reason: verifyResult.reason, relayId });
  }

  const claim = await claimSignedRequest(requestId, nonce, senderId, { channel: 'api', relayId });
  if (!claim.claimed) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: claim.reason || 'claim-error' });
    let status = 500;
    if (['duplicate-request', 'nonce-reused'].includes(claim.reason)) status = 409;
    else if (claim.reason === 'invalid-requestid') status = 400;
    const replayed = ['duplicate-request', 'nonce-reused'].includes(claim.reason);
    return res.status(status).json({
      error: claim.reason || 'could not process request',
      previousStatus: claim.previousStatus || undefined,
      originalTxHash: replayed ? claim.originalTxHash || null : undefined,
      settlementCreated: replayed ? false : undefined,
      relayId,
    });
  }

  try {
    const lockKey = sender.phone || sender.id;
    if (isPinLocked(lockKey)) {
      await finishSignedRequest(requestId, 'rejected');
      await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'pin-locked' });
      return res.status(423).json({ error: 'too many wrong PIN attempts, try again later', relayId });
    }
    if (!sender.pinWalletSecretEncrypted || !sender.pinWalletSecretSalt || !sender.pinWalletSecretIv) {
      await finishSignedRequest(requestId, 'rejected');
      await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'wallet-not-setup' });
      return res.status(400).json({ error: 'wallet not set up for signed payments — log in to the app once', relayId });
    }

    const walletSecret = decryptWalletSecretByPin(
      sender.pinWalletSecretEncrypted,
      sender.pinWalletSecretSalt,
      sender.pinWalletSecretIv,
      pin
    );
    if (!walletSecret) {
      registerPinFailure(lockKey);
      await logEvent(sender.id, '❌', 'Signed API payment blocked: incorrect PIN', 'error');
      await finishSignedRequest(requestId, 'rejected');
      await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'incorrect-pin' });
      return res.status(401).json({ error: 'incorrect pin', relayId });
    }
    clearPinFailures(lockKey);
    const recipient = await findRecipient(String(recipientId));
    if (!recipient || !recipient.walletPublic) {
      await finishSignedRequest(requestId, 'rejected');
      await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'recipient-not-found' });
      return res.status(404).json({ error: 'recipient not found', relayId });
    }

    const result = await executeSend({ sender, recipient, amount: amt, walletSecret, mode: 'api', relayId, requestId });
    if (!result.ok) {
      await finishSignedRequest(requestId, REJECTED_SEND_CODES.includes(result.code) ? 'rejected' : 'failed', { detail: result.code });
      return res.status(422).json({ error: result.code, detail: result.detail, relayId });
    }

    await finishSignedRequest(requestId, 'processed', { txHash: result.txHash, sorobanTxHash: result.sorobanTxHash });
    return res.json({
      ok: true,
      txHash: result.txHash,
      sorobanTxHash: result.sorobanTxHash || null,
      newSenderBalance: result.newSenderBal,
      relayId,
    });
  } catch (err) {
    console.error('[api/send] unhandled error:', err);
    await finishSignedRequest(requestId, 'failed', { detail: 'internal-error' });
    await updateRelayStatus(relayId, RELAY_STATUS.FAILED, { detail: 'internal-error' });
    return res.status(500).json({ error: 'internal error', relayId });
  }
});
app.post('/dev/simulate-sms', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
    return res.status(403).json({ error: 'dev endpoint is localhost-only' });
  }
  const { sender, message } = req.body || {};
  if (!sender || !message) return res.status(400).json({ error: 'sender and message required' });
  try {
    const eventKey = `dev-${crypto.randomBytes(16).toString('hex')}`;
    await handleIncomingSms(sender, message, eventKey);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/relay-transactions/:id', requireAdminKey, async (req, res) => {
  try {
    const doc = await relayTransactionsCol().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error('[api/relay-transactions/:id] failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});
app.get('/api/relay-transactions', requireAdminKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    let query = relayTransactionsCol().orderBy('createdAt', 'desc');
    if (req.query.status) query = query.where('status', '==', String(req.query.status));
    const snap = await query.limit(limit).get();
    res.json({ transactions: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    console.error('[api/relay-transactions] failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});
app.get('/api/replay-audit/:requestId', requireAdminKey, async (req, res) => {
  try {
    const doc = await signedRequestsCol().doc(String(req.params.requestId)).get();
    if (!doc.exists) return res.status(404).json({ error: 'not found' });
    const data = doc.data() || {};
    res.json({
      requestId: doc.id,
      status: data.status || null,
      channel: data.channel || null,
      txHash: data.txHash || null,
      settlements: data.txHash ? 1 : 0,
      replayCount: data.replayCount || 0,
      lastReplayAt: data.lastReplayAt && data.lastReplayAt.toDate ? data.lastReplayAt.toDate().toISOString() : null,
      lastReplayChannel: data.lastReplayChannel || null,
    });
  } catch (err) {
    console.error('[api/replay-audit] failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/reconcile-balance/:userId', requireAdminKey, async (req, res) => {
  try {
    const userDoc = await usersCol().doc(req.params.userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'user not found' });
    const user = userDoc.data();
    if (!user.walletPublic) return res.status(400).json({ error: 'user has no walletPublic on file' });

    const chainBalance = await getStellarNativeBalance(user.walletPublic);
    if (chainBalance == null) {
      return res.status(502).json({ error: 'could not read balance from Stellar/Horizon' });
    }

    await usersCol().doc(req.params.userId).update({ xlmBalance: chainBalance });
    res.json({ ok: true, userId: req.params.userId, xlmBalance: chainBalance });
  } catch (err) {
    console.error('[api/reconcile-balance] failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[error]', err && err.stack ? err.stack : err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.publicMessage || 'internal error',
    detail: err.expose ? err.detail || err.message : undefined,
  });
});

async function runReplayCheck() {
  const REPLAYS = 3;
  const suffix = crypto.randomBytes(6).toString('hex');
  const requestId = `replaycheck_${Date.now().toString(36)}_${suffix}`;
  const nonce = `nonce_${Date.now().toString(36)}_${suffix}`;
  const senderId = 'replay-check';
  const nonceDocId = `${senderId}:${nonce}`;
  const txHash = crypto.randomBytes(32).toString('hex');
  const startingBalance = 100;
  const amount = 10;
  let balance = startingBalance;
  let settlements = 0;
  const evidence = { requestId, startedAt: new Date().toISOString(), steps: [], checks: [] };

  const settle = async () => {
    settlements += 1;
    balance -= amount;
    await finishSignedRequest(requestId, 'processed', { txHash });
  };
  const check = (name, pass, detail) => {
    evidence.checks.push({ name, pass, detail });
    log(pass ? 'ok' : 'error', 'replay-check', `${pass ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
  };

  log('info', 'replay-check', `Started | requestId=${shortRef(requestId)} replays=${REPLAYS}`);
  try {
    const first = await claimSignedRequest(requestId, nonce, senderId, { channel: 'replay-check' });
    evidence.steps.push({ step: 'original', claimed: first.claimed, reason: first.reason || null });
    if (first.claimed) await settle();
    const balanceAfterOriginal = balance;

    for (let i = 1; i <= REPLAYS; i += 1) {
      const replay = await claimSignedRequest(requestId, nonce, senderId, { channel: 'replay-check' });
      evidence.steps.push({
        step: `replay-${i}`,
        claimed: replay.claimed,
        reason: replay.reason || null,
        originalTxHash: replay.originalTxHash || null,
      });
      if (replay.claimed) await settle();
    }

    const otherId = `${requestId}_b`;
    const nonceReplay = await claimSignedRequest(otherId, nonce, senderId, { channel: 'replay-check' });
    evidence.steps.push({ step: 'nonce-reuse', claimed: nonceReplay.claimed, reason: nonceReplay.reason || null });
    if (nonceReplay.claimed) await settle();

    const snap = await signedRequestsCol().doc(requestId).get();
    const record = snap.exists ? snap.data() : {};
    const replaySteps = evidence.steps.filter((s) => s.step.startsWith('replay-'));

    check('Original request accepted', first.claimed === true, `claimed=${first.claimed}`);
    check(
      'Replayed request rejected',
      replaySteps.length === REPLAYS && replaySteps.every((s) => !s.claimed && s.reason === 'duplicate-request'),
      `${replaySteps.filter((s) => !s.claimed).length}/${REPLAYS} rejected`
    );
    check('Reused nonce rejected', !nonceReplay.claimed && nonceReplay.reason === 'nonce-reused', `reason=${nonceReplay.reason || 'none'}`);
    check('Single settlement only', settlements === 1, `settlements=${settlements}`);
    check('Single tx hash', record.txHash === txHash && replaySteps.every((s) => s.originalTxHash === txHash), `tx=${shortRef(record.txHash || 'none')}`);
    check('Balance unchanged after replays', balance === balanceAfterOriginal, `before=${balanceAfterOriginal} after=${balance}`);
    check('Replay attempts recorded', record.replayCount === REPLAYS + 1, `replayCount=${record.replayCount || 0}`);

    evidence.txHash = txHash;
    evidence.settlements = settlements;
    evidence.balance = { start: startingBalance, afterOriginal: balanceAfterOriginal, final: balance };
    evidence.replayCount = record.replayCount || 0;
  } catch (err) {
    check('Replay check completed', false, err.message);
  } finally {
    try {
      await signedRequestsCol().doc(requestId).delete();
      await usedNoncesCol().doc(nonceDocId).delete();
    } catch (err) {
      log('warn', 'replay-check', `Cleanup failed: ${err.message}`);
    }
  }

  const passed = evidence.checks.length > 0 && evidence.checks.every((c) => c.pass);
  evidence.result = passed ? 'PASS' : 'FAIL';
  evidence.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(path.join(__dirname, 'replay-evidence.json'), JSON.stringify(evidence, null, 2));
    log('info', 'replay-check', 'Evidence saved to replay-evidence.json');
  } catch (err) {
    log('error', 'replay-check', `Could not save evidence: ${err.message}`);
  }
  log(passed ? 'ok' : 'error', 'replay-check', `RESULT: ${evidence.result} | settlements=${settlements} | replayCount=${evidence.replayCount || 0}`);
}

app.listen(PORT, () => {
  const rule = paint('90', '-'.repeat(64));
  console.log('');
  console.log(rule);
  console.log(`  ${paint('1', 'OmniPay SMS Relay')}  ${paint('32', 'online')}`);
  console.log(rule);
  console.log(`  ${paint('90', 'Port       ')} ${PORT}`);
  console.log(`  ${paint('90', 'Gateway    ')} ${USE_CLOUD_GATEWAY ? 'cloud' : 'local'}  ${GATEWAY_BASE_URL || '(not configured)'}`);
  console.log(`  ${paint('90', 'Send path  ')} ${GATEWAY_MESSAGE_PATH}`);
  console.log(`  ${paint('90', 'Webhook    ')} POST /webhook/sms-received`);
  console.log(`  ${paint('90', 'Signed SMS ')} ${REQUIRE_SIGNED_SMS ? 'required' : 'optional (PIN-only accepted)'}`);
  console.log(`  ${paint('90', 'Soroban    ')} ${SOROBAN_ENABLED ? `${SOROBAN_CONTRACT_ID.slice(0, 8)}...${SOROBAN_CONTRACT_ID.slice(-4)}  ${SOROBAN_RPC_URL}` : '(contract not configured)'}`);
  console.log(rule);
  console.log('');
  if (!GATEWAY_USER || !GATEWAY_PASS) {
    log('warn', 'auth', 'SMS_GATEWAY_USERNAME / SMS_GATEWAY_PASSWORD are not set — outgoing SMS will be rejected by the gateway.');
  }
  if (!GATEWAY_WEBHOOK_SECRET) {
    log('warn', 'auth', 'SMS_GATEWAY_WEBHOOK_SECRET is not set — /webhook/sms-received will reject all requests until it is configured.');
  }
  if (!ADMIN_API_KEY) {
    log('warn', 'auth', 'ADMIN_API_KEY is not set — /api/relay-transactions* and /api/reconcile-balance are disabled until it is configured.');
  }
  if (!SOROBAN_ENABLED) {
    log('warn', 'soroban', 'SOROBAN_CONTRACT_ID is not set — payments settle on Horizon only, without contract-level settlement recording.');
  }
  if (REQUIRE_SIGNED_SMS) {
    log('info', 'auth', 'REQUIRE_SIGNED_SMS=true -> plain unsigned "SEND" SMS commands are REJECTED. Only signed SMS (SIG <ts> <nonce> <reqId> <sig>) is accepted.');
  } else {
    log('warn', 'auth', 'REQUIRE_SIGNED_SMS=false -> plain unsigned "SEND <amount> <recipient> <pin>" SMS is still ACCEPTED (PIN-only auth). Set REQUIRE_SIGNED_SMS=true in .env once the signing app has rolled out.');
  }
  log('info', 'ready', 'Waiting for incoming SMS. Every webhook hit and SMS reply will be logged here.');
  if (REPLAY_CHECK_ENABLED) runReplayCheck();
});