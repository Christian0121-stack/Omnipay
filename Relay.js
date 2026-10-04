const { isValidSigningKey } = require('./Signature');

function createRelay({ getDb, FieldValue, log }) {
  const signedRequestsCol = () => getDb().collection('relay_requests');
  const usedNoncesCol = () => getDb().collection('omnipay_used_nonces');
  const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
  const RECORD_TTL_DAYS = parseInt(process.env.RELAY_RECORD_TTL_DAYS, 10) || 7;
  const RECORD_TTL_MS = RECORD_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expiryDate = () => new Date(Date.now() + RECORD_TTL_MS);

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
    if (!NONCE_PATTERN.test(String(nonce))) {
      log('warn', 'nonce', `REJECTED (invalid nonce format) | channel=${meta.channel || 'n/a'} sender=${senderId}`);
      return { claimed: false, reason: 'invalid-nonce' };
    }

    const requestRef = signedRequestsCol().doc(String(requestId));
    const nonceRef = usedNoncesCol().doc(`${senderId}:${nonce}`);
    let previousStatus = null;
    let originalRequestId = null;
    const expiresAt = expiryDate();

    try {
      await getDb().runTransaction(async (tx) => {
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
          expiresAt,
        });
        tx.create(nonceRef, {
          senderId,
          requestId: String(requestId),
          createdAt: FieldValue.serverTimestamp(),
          expiresAt,
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

  return {
    signedRequestsCol,
    usedNoncesCol,
    shortRef,
    getRegisteredSigningKey,
    claimSignedRequest,
    finishSignedRequest,
  };
}

module.exports = { createRelay };