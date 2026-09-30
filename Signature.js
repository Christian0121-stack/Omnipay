const StellarSdk = require('stellar-sdk');

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

module.exports = { SIGNATURE_MAX_SKEW_MS, buildSignedPayloadString, verifySignature };