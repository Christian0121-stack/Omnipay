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
    const amount = parseFloat(parts[1]);
    const pin = parts[parts.length - 1];
    const recipient = parts.slice(2, parts.length - 1).join(' ');
    if (!isNaN(amount) && amount > 0 && recipient && /^\d{4,6}$/.test(pin)) {
      return { type: 'SEND', amount, recipient, pin };
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
      const { amount, recipient: recipientIdentifier, pin } = command;

      if (isPinLocked(senderPhone)) {
        await sendSms(senderPhone, `OmniPay: Too many wrong PIN attempts. Try again in a bit, or use the app.`);
        return;
      }

      if (!sender.pinWalletSecretEncrypted || !sender.pinWalletSecretSalt || !sender.pinWalletSecretIv || !sender.walletPublic) {
        console.warn('[sms] Sender doc', sender.id, 'has no `pinWalletSecretEncrypted` — log in to the app once to set up SMS payments.');
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
        await sendSms(senderPhone, 'OmniPay: Incorrect PIN. Payment not sent.');
        return;
      }
      clearPinFailures(senderPhone);

      if ((sender.xlmBalance || 0) < amount) {
        await sendSms(senderPhone, `OmniPay: Insufficient balance. You have ${(sender.xlmBalance || 0).toFixed(4)} ${ASSET_LABEL}.`);
        return;
      }

      const recipient = await findRecipient(recipientIdentifier);
      if (!recipient || !recipient.walletPublic) {
        await sendSms(senderPhone, `OmniPay: Recipient "${recipientIdentifier}" not found on OmniPay.`);
        return;
      }
      if (recipient.id === sender.id) {
        await sendSms(senderPhone, "OmniPay: You can't send money to yourself.");
        return;
      }

      const senderName = sender.username || sender.id;
      const recipientName = recipient.username || recipient.id;

      try {
        const txHash = await sendStellarPayment(walletSecret, recipient.walletPublic, amount);

        const newSenderBal = (sender.xlmBalance || 0) - amount;
        const newRecipientBal = (recipient.xlmBalance || 0) + amount;

        await usersCol().doc(sender.id).update({ xlmBalance: newSenderBal });
        await usersCol().doc(recipient.id).update({ xlmBalance: newRecipientBal });
        const base = { id: 'tx-' + txHash.substring(0, 8), amount, status: 'synced', mode: 'sms', txHash, ts: Date.now(), icon: '📱' };
        await recordTransaction(sender.id, { ...base, type: 'send', name: `To @${recipientName}`, note: 'Sent via SMS' });
        await recordTransaction(recipient.id, { ...base, type: 'receive', name: `From @${senderName}`, note: 'Received via SMS' });

        await sendSms(
          senderPhone,
          `OmniPay: Sent ${amount} ${ASSET_LABEL} to ${recipientName}. TX: ${txHash.slice(0, 12)}... New balance: ${newSenderBal.toFixed(4)} ${ASSET_LABEL}.`
        );
        if (recipient.phone) {
          await sendSms(
            recipient.phone,
            `OmniPay: You received ${amount} ${ASSET_LABEL} from ${senderName}. New balance: ${newRecipientBal.toFixed(4)} ${ASSET_LABEL}.`
          );
        }
      } catch (err) {
        const detail = err.response?.data?.extras?.result_codes || err.message;
        console.error('[stellar] payment failed:', detail);
        await logEvent(sender.id, '❌', `SMS payment failed: ${JSON.stringify(detail)}`, 'error');
        await sendSms(senderPhone, `OmniPay: Payment failed (${JSON.stringify(detail)}). Nothing was deducted.`);
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

app.listen(PORT, () => {
  console.log(`OmniPay SMS relay listening on port ${PORT}`);
  console.log(`Gateway mode: ${USE_CLOUD_GATEWAY ? 'cloud' : 'local'}`);
  console.log(`Gateway target: ${GATEWAY_BASE_URL || '(not configured)'}`);
  console.log(`Gateway message path: ${GATEWAY_MESSAGE_PATH}`);
});