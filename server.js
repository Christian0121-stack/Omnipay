const path = require('path');
const fs = require('fs');
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const StellarSdk = require('stellar-sdk');
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
const SECRET_HASH_ITERATIONS = 150000;

const REQUIRE_SIGNED_SMS = String(process.env.REQUIRE_SIGNED_SMS || 'false').toLowerCase() === 'true';

let db;
try {
  const serviceAccountPath = path.resolve(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json'
  );
  console.log('[debug] Resolved service account path:', serviceAccountPath);
  console.log('[debug] File exists at that path:', fs.existsSync(serviceAccountPath));

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Service account file not found at: ${serviceAccountPath}`);
  }

  const serviceAccount = require(serviceAccountPath);
  console.log('[debug] Service account project_id:', serviceAccount.project_id);

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
  console.log('[firebase] Admin SDK initialized, project:', process.env.FIREBASE_PROJECT_ID);
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

async function sendStellarPayment(senderSecret, destinationPublicKey, amount) {
  const senderKeypair = StellarSdk.Keypair.fromSecret(senderSecret);
  const senderAccount = await horizon.loadAccount(senderKeypair.publicKey());

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
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

async function getStellarNativeBalance(publicKey) {
  if (!publicKey) return null;
  try {
    const account = await horizon.loadAccount(publicKey);
    const nativeBalance = account.balances.find((b) => b.asset_type === 'native');
    return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
  } catch (err) {
    console.error('[stellar] getStellarNativeBalance failed for', publicKey, '-', err.message);
    return null;
  }
}

const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

function buildSignedPayloadString({ senderId, recipientId, amount, timestamp, nonce, requestId }) {
  const amt = Number(amount).toFixed(7);
  return [senderId, recipientId, amt, timestamp, nonce, requestId].join('|');
}

function verifySignature({ senderId, recipientId, amount, timestamp, nonce, requestId, signature, senderPublicKey }) {
  if (!senderPublicKey || !signature) return { ok: false, reason: 'missing-signature-or-key' };
  if (!senderId || !recipientId) return { ok: false, reason: 'missing-sender-or-recipient' };
  if (!nonce || !requestId) return { ok: false, reason: 'missing-nonce-or-requestid' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid-timestamp' };
  if (Math.abs(Date.now() - ts) > SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, reason: 'timestamp-out-of-window' };
  }

  let keypair;
  try {
    keypair = StellarSdk.Keypair.fromPublicKey(senderPublicKey);
  } catch (err) {
    return { ok: false, reason: 'invalid-public-key' };
  }

  let sigBuf;
  try {
    sigBuf = Buffer.from(String(signature), 'base64');
    if (sigBuf.length !== 64) return { ok: false, reason: 'malformed-signature' };
  } catch (err) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const message = buildSignedPayloadString({ senderId, recipientId, amount, timestamp, nonce, requestId });

  let valid = false;
  try {
    valid = keypair.verify(Buffer.from(message, 'utf8'), sigBuf);
  } catch (err) {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'signature-mismatch' };
}

const signedRequestsCol = () => db.collection('omnipay_signed_requests');
const usedNoncesCol = () => db.collection('omnipay_used_nonces');

async function claimSignedRequest(requestId, nonce, senderId) {
  if (!requestId) return { claimed: false, reason: 'missing-requestid' };
  if (!nonce) return { claimed: false, reason: 'missing-nonce' };

  const requestRef = signedRequestsCol().doc(String(requestId));
  const nonceRef = usedNoncesCol().doc(`${senderId}:${nonce}`);

  try {
    await db.runTransaction(async (tx) => {
      const [existingRequest, existingNonce] = await Promise.all([
        tx.get(requestRef),
        tx.get(nonceRef),
      ]);
      if (existingRequest.exists) throw new Error('duplicate-request');
      if (existingNonce.exists) throw new Error('nonce-reused');

      tx.create(requestRef, {
        senderId,
        nonce: String(nonce),
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
    return { claimed: true };
  } catch (err) {
    if (err.message === 'duplicate-request') return { claimed: false, reason: 'duplicate-request' };
    if (err.message === 'nonce-reused') return { claimed: false, reason: 'nonce-reused' };
    console.error('[signed-request] claim failed:', err.message);
    return { claimed: false, reason: 'claim-error' };
  }
}

async function finishSignedRequest(requestId, status) {
  if (!requestId) return;
  try {
    await signedRequestsCol()
      .doc(String(requestId))
      .update({ status: status || 'processed', updatedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error('[signed-request] finalize failed:', err.message);
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
  const rec = pinAttempts.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= PIN_MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
  }
  pinAttempts.set(key, rec);
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

async function findUserByPhone(phone) {
  const clean = normalizePhone(phone);
  if (!clean) return null;
  console.log('[debug] findUserByPhone: incoming raw =', JSON.stringify(phone), '-> clean =', JSON.stringify(clean));

  const snap = await usersCol().where('phone', '==', clean).limit(1).get();
  if (!snap.empty) {
    console.log('[debug] findUserByPhone: exact match on doc', snap.docs[0].id);
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  const last9 = clean.replace(/\D/g, '').slice(-9);
  console.log('[debug] findUserByPhone: no exact match, falling back. last9 =', last9);
  if (!last9) return null;

  const all = await usersCol().get();
  console.log('[debug] findUserByPhone: total docs in users collection =', all.size);
  all.docs.forEach((d) => {
    const rawPhone = d.data().phone;
    const p = (rawPhone || '').replace(/\D/g, '').slice(-9);
    console.log(
      '[debug]   doc', d.id,
      'phone=', JSON.stringify(rawPhone),
      '-> last9=', JSON.stringify(p),
      p === last9 ? '<-- MATCH' : ''
    );
  });

  const match = all.docs.find((d) => {
    const p = (d.data().phone || '').replace(/\D/g, '').slice(-9);
    return p === last9;
  });
  if (match) {
    console.log('[debug] findUserByPhone: matched via last9 on doc', match.id);
  } else {
    console.log('[debug] findUserByPhone: NO MATCH FOUND for last9 =', last9);
  }
  return match ? { id: match.id, ...match.data() } : null;
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
    console.warn('[sms] No gateway URL configured, skipping send:', text);
    return;
  }
  try {
    await axios.post(
      `${GATEWAY_BASE_URL}${GATEWAY_MESSAGE_PATH}`,
      { textMessage: { text }, phoneNumbers: [toNumber] },
      {
        auth: { username: GATEWAY_USER, password: GATEWAY_PASS },
        timeout: 15000,
      }
    );
  } catch (err) {
    console.error('[sms] Failed to send confirmation SMS:', err.response?.data || err.message);
  }
}
function verifyWebhookSignature(rawBody, headers) {
  if (!GATEWAY_WEBHOOK_SECRET) return true;
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
    console.error('[firestore] logEvent failed:', err.message);
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
    console.error('[firestore] recordTransaction failed:', err.message);
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

async function createRelayRecord({ channel, senderPhone, senderId, recipient, amount }) {
  const ref = relayTransactionsCol().doc();
  const now = Date.now();
  try {
    await ref.set({
      channel,
      senderPhone: senderPhone || null,
      senderId: senderId || null,
      recipient: recipient != null ? String(recipient) : null,
      amount: amount != null ? Number(amount) : null,
      status: RELAY_STATUS.RECEIVED,
      statusHistory: [{ status: RELAY_STATUS.RECEIVED, at: now }],
      txHash: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[relay] failed to create record:', err.message);
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
    console.error('[relay] failed to update status:', relayId, status, err.message);
  }
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
      console.log('[webhook] Duplicate SMS event ignored:', eventKey);
    } else {
      console.error('[webhook] Could not claim SMS event:', err.message);
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
    console.error('[webhook] Could not finalize SMS event:', err.message);
  }
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

    const amount = parseFloat(sendParts[1]);
    const pin = sendParts[sendParts.length - 1];
    const recipient = sendParts.slice(2, sendParts.length - 1).join(' ');
    if (!isNaN(amount) && amount > 0 && recipient && /^\d{4,6}$/.test(pin)) {
      return { type: 'SEND', amount, recipient, pin, sig };
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

async function executeSend({ sender, recipient, amount, walletSecret, mode, relayId }) {
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
    const txHash = await sendStellarPayment(walletSecret, recipient.walletPublic, amount);
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
    await recordTransaction(sender.id, { ...base, type: 'send', name: `To @${recipientName}`, note: `Sent via ${channelNote}` });
    await recordTransaction(recipient.id, { ...base, type: 'receive', name: `From @${senderName}`, note: `Received via ${channelNote}` });

    await updateRelayStatus(relayId, RELAY_STATUS.SETTLED);

    return { ok: true, txHash, newSenderBal, newRecipientBal, relayId };
  } catch (err) {
    const detail = err.response?.data?.extras?.result_codes || err.message;
    console.error('[stellar] payment failed:', detail);
    await logEvent(sender.id, '❌', `${channelNote} payment failed: ${JSON.stringify(detail)}`, 'error');
    await updateRelayStatus(relayId, RELAY_STATUS.FAILED, { detail });
    return { ok: false, code: 'stellar-failed', detail, relayId };
  }
}

async function handleIncomingSms(senderPhone, messageText, eventKey) {
  if (!consumeSmsRateLimit(senderPhone)) {
    console.warn('[sms] Rate limit exceeded for sender:', normalizePhone(senderPhone));
    return;
  }

  const claimed = await claimSmsEvent(eventKey, senderPhone, messageText);
  if (!claimed) return;

  try {
    const command = parseCommand(messageText);

    const sender = await findUserByPhone(senderPhone);
    if (!sender) {
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

      if (
        !sender.pinWalletSecretEncrypted ||
        !sender.pinWalletSecretSalt ||
        !sender.pinWalletSecretIv ||
        !sender.walletPublic
      ) {
        console.warn(
          '[sms] Sender doc',
          sender.id,
          'has no encrypted wallet PIN data for BALANCE.'
        );
        await sendSms(
          senderPhone,
          'OmniPay: Balance PIN is not enabled yet. Log in to the app to set up your wallet.'
        );
        return;
      }

      const balancePinCheck = decryptWalletSecretByPin(
        sender.pinWalletSecretEncrypted,
        sender.pinWalletSecretSalt,
        sender.pinWalletSecretIv,
        command.pin
      );

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

      const relayId = await createRelayRecord({
        channel: 'sms',
        senderPhone: normalizePhone(senderPhone),
        senderId: sender.id,
        recipient: recipientIdentifier,
        amount,
      });

      if (REQUIRE_SIGNED_SMS && !sig) {
        await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'signature-required' });
        await sendSms(senderPhone, 'OmniPay: This command must be signed. Update your OmniPay app to the latest version.');
        return;
      }

      if (sig) {
        if (!sender.walletPublic) {
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
          senderPublicKey: sender.walletPublic,
        });
        if (!verifyResult.ok) {
          console.warn('[sms] signature rejected:', verifyResult.reason, 'sender:', sender.id);
          await logEvent(sender.id, '❌', `SMS payment blocked: bad signature (${verifyResult.reason})`, 'error');
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: `bad-signature:${verifyResult.reason}` });
          await sendSms(senderPhone, 'OmniPay: Signature check failed. Payment not sent.');
          return;
        }
        const claim = await claimSignedRequest(sig.requestId, sig.nonce, sender.id);
        if (!claim.claimed) {
          console.log('[sms] duplicate signed SMS request ignored:', sig.requestId);
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: claim.reason || 'duplicate-request' });
          return;
        }
      }

      try {
        if (isPinLocked(senderPhone)) {
          await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'pin-locked' });
          await sendSms(senderPhone, `OmniPay: Too many wrong PIN attempts. Try again in a bit, or use the app.`);
          return;
        }

        if (!sender.pinWalletSecretEncrypted || !sender.pinWalletSecretSalt || !sender.pinWalletSecretIv || !sender.walletPublic) {
          console.warn('[sms] Sender doc', sender.id, 'has no `pinWalletSecretEncrypted` — log in to the app once to set up SMS payments.');
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
        }        const result = await executeSend({ sender, recipient, amount, walletSecret, mode: 'sms', relayId });

        if (!result.ok) {
          if (result.code === 'insufficient-balance') {
            await sendSms(senderPhone, `OmniPay: Insufficient balance. You have ${result.senderBalance.toFixed(4)} ${ASSET_LABEL}.`);
          } else if (result.code === 'self-send') {
            await sendSms(senderPhone, "OmniPay: You can't send money to yourself.");
          } else {
            await sendSms(senderPhone, `OmniPay: Payment failed (${JSON.stringify(result.detail)}). Nothing was deducted.`);
          }
          return;
        }

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
        if (sig) await finishSignedRequest(sig.requestId, 'processed');
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
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(express.static(path.join(__dirname)));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/webhook/sms-received', async (req, res) => {
  if (!verifyWebhookSignature(req.rawBody, req.headers)) {
    console.warn('[webhook] Rejected: bad or missing signature');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { event, payload } = req.body || {};
  if (event !== 'sms:received' || !payload) {
    return res.status(200).json({ ignored: true });
  }

  const senderPhone = payload.sender || payload.phoneNumber;
  const message = payload.message;
  if (!senderPhone || !message) {
    return res.status(400).json({ error: 'missing sender/message' });
  }
  const eventKey = buildSmsEventKey(senderPhone, message, payload);
  res.status(200).json({ received: true });

  handleIncomingSms(senderPhone, message, eventKey).catch((err) => {
    console.error('[handleIncomingSms] unhandled error:', err);
  });
});

app.post('/api/send', async (req, res) => {
  const { senderId, recipientId, amount, timestamp, nonce, requestId, signature, pin } = req.body || {};

  if (!senderId || !recipientId || amount == null || !timestamp || !nonce || !requestId || !signature) {
    return res.status(400).json({ error: 'missing required authenticated-payload fields' });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }

  const relayId = await createRelayRecord({
    channel: 'api',
    senderId,
    recipient: recipientId,
    amount: amt,
  });

  const senderDoc = await usersCol().doc(String(senderId)).get();
  if (!senderDoc.exists) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: 'sender-not-found' });
    return res.status(404).json({ error: 'sender not found', relayId });
  }
  const sender = { id: senderDoc.id, ...senderDoc.data() };

  const verifyResult = verifySignature({
    senderId,
    recipientId,
    amount: amt,
    timestamp,
    nonce,
    requestId,
    signature,
    senderPublicKey: sender.walletPublic,
  });
  if (!verifyResult.ok) {
    console.warn('[api/send] signature rejected:', verifyResult.reason, 'sender:', senderId);
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: `bad-signature:${verifyResult.reason}` });
    return res.status(401).json({ error: 'invalid signature', reason: verifyResult.reason, relayId });
  }

  const claim = await claimSignedRequest(requestId, nonce, senderId);
  if (!claim.claimed) {
    await updateRelayStatus(relayId, RELAY_STATUS.VALIDATION_FAILED, { detail: claim.reason || 'claim-error' });
    const status = ['duplicate-request', 'nonce-reused'].includes(claim.reason) ? 409 : 500;
    return res.status(status).json({ error: claim.reason || 'could not process request', relayId });
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

    const result = await executeSend({ sender, recipient, amount: amt, walletSecret, mode: 'api', relayId });
    if (!result.ok) {
      await finishSignedRequest(requestId, 'failed');
      return res.status(422).json({ error: result.code, detail: result.detail, relayId });
    }

    await finishSignedRequest(requestId, 'processed');
    return res.json({
      ok: true,
      txHash: result.txHash,
      newSenderBalance: result.newSenderBal,
      relayId,
    });
  } catch (err) {
    console.error('[api/send] unhandled error:', err);
    await finishSignedRequest(requestId, 'failed');
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

app.get('/api/relay-transactions/:id', async (req, res) => {
  try {
    const doc = await relayTransactionsCol().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error('[api/relay-transactions/:id] failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/relay-transactions', async (req, res) => {
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

app.post('/api/reconcile-balance/:userId', async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`OmniPay SMS relay listening on port ${PORT}`);
  console.log(`Gateway mode: ${USE_CLOUD_GATEWAY ? 'cloud' : 'local'}`);
  console.log(`Gateway target: ${GATEWAY_BASE_URL || '(not configured)'}`);
  console.log(`Gateway message path: ${GATEWAY_MESSAGE_PATH}`);
});