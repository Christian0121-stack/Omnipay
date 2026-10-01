const StellarSdk = require('stellar-sdk');

const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;
const PAYLOAD_VERSION = 'OMNIPAY-v1';
const FIELD_DELIMITER = '|';

function hasDelimiter(value) {
  return String(value).includes(FIELD_DELIMITER);
}

function buildSignedPayloadString({ senderId, recipientId, amount, timestamp, nonce, requestId }) {
  const amt = Number(amount).toFixed(7);
  return [PAYLOAD_VERSION, senderId, recipientId, amt, timestamp, nonce, requestId].join(FIELD_DELIMITER);
}

function isValidSigningKey(key) {
  return typeof key === 'string' && StellarSdk.StrKey.isValidEd25519PublicKey(key.trim());
}

function verifySignature({ senderId, recipientId, amount, timestamp, nonce, requestId, signature, senderPublicKey }) {
  if (!senderPublicKey || !signature) return { ok: false, reason: 'missing-signature-or-key' };
  if (!senderId || !recipientId) return { ok: false, reason: 'missing-sender-or-recipient' };
  if (!nonce || !requestId) return { ok: false, reason: 'missing-nonce-or-requestid' };
  if ([senderId, recipientId, nonce, requestId, timestamp].some(hasDelimiter)) {
    return { ok: false, reason: 'invalid-field-format' };
  }
  if (!Number.isFinite(Number(amount))) return { ok: false, reason: 'invalid-amount' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid-timestamp' };
  if (Math.abs(Date.now() - ts) > SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, reason: 'timestamp-out-of-window' };
  }

  let keypair;
  try {
    keypair = StellarSdk.Keypair.fromPublicKey(String(senderPublicKey).trim());
  } catch (err) {
    return { ok: false, reason: 'invalid-public-key' };
  }

  const sigBuf = Buffer.from(String(signature), 'base64');
  if (sigBuf.length !== 64) return { ok: false, reason: 'malformed-signature' };

  const message = buildSignedPayloadString({ senderId, recipientId, amount, timestamp, nonce, requestId });

  let valid = false;
  try {
    valid = keypair.verify(Buffer.from(message, 'utf8'), sigBuf);
  } catch (err) {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'signature-mismatch' };
}

module.exports = {
  SIGNATURE_MAX_SKEW_MS,
  PAYLOAD_VERSION,
  buildSignedPayloadString,
  isValidSigningKey,
  verifySignature,
};