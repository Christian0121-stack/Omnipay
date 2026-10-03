require('dotenv').config();
const crypto = require('crypto');
const StellarSdk = require('stellar-sdk');
const {
  SIGNATURE_MAX_SKEW_MS,
  PAYLOAD_VERSION,
  buildSignedPayloadString,
  verifySignature,
} = require('./Signature');

const FIXED_NOW = 1790000000000;
const bytesToHex = (buf) => Buffer.from(buf).toString('hex');

function makeRequest(keypair, overrides = {}) {
  const base = {
    senderId: 'user_sender_01',
    recipientId: 'juan',
    amount: 12.5,
    timestamp: FIXED_NOW,
    nonce: bytesToHex(crypto.randomBytes(16)),
    requestId: bytesToHex(crypto.randomBytes(16)),
    ...overrides,
  };
  const message = buildSignedPayloadString(base);
  const signature = Buffer.from(keypair.sign(Buffer.from(message, 'utf8'))).toString('base64');
  return { ...base, signature, senderPublicKey: keypair.publicKey() };
}

describe('buildSignedPayloadString', () => {
  test('joins fields in fixed order with a pipe separator', () => {
    const out = buildSignedPayloadString({
      senderId: 'a',
      recipientId: 'b',
      amount: 1,
      timestamp: 100,
      nonce: 'n1',
      requestId: 'r1',
    });
    expect(out).toBe('OMNIPAY-v1|a|b|1.0000000|100|n1|r1');
  });

  test('starts with the payload version prefix', () => {
    const out = buildSignedPayloadString({
      senderId: 'a',
      recipientId: 'b',
      amount: 1,
      timestamp: 100,
      nonce: 'n1',
      requestId: 'r1',
    });
    expect(PAYLOAD_VERSION).toBe('OMNIPAY-v1');
    expect(out.split('|')[0]).toBe(PAYLOAD_VERSION);
  });

  test('formats amount with exactly 7 decimals', () => {
    const base = { senderId: 'a', recipientId: 'b', timestamp: 1, nonce: 'n', requestId: 'r' };
    expect(buildSignedPayloadString({ ...base, amount: 5 }).split('|')[3]).toBe('5.0000000');
    expect(buildSignedPayloadString({ ...base, amount: '0.5' }).split('|')[3]).toBe('0.5000000');
    expect(buildSignedPayloadString({ ...base, amount: 1.23456789 }).split('|')[3]).toBe('1.2345679');
  });

  test('is deterministic for identical input', () => {
    const input = { senderId: 'a', recipientId: 'b', amount: 2, timestamp: 9, nonce: 'n', requestId: 'r' };
    expect(buildSignedPayloadString(input)).toBe(buildSignedPayloadString({ ...input }));
  });
});

describe('verifySignature', () => {
  let keypair;
  let nowSpy;

  beforeAll(() => {
    keypair = StellarSdk.Keypair.random();
  });

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  test('accepts a correctly signed request', () => {
    expect(verifySignature(makeRequest(keypair))).toEqual({ ok: true });
  });

  test('accepts a request signed with a string amount', () => {
    const req = makeRequest(keypair, { amount: '3.25' });
    expect(verifySignature(req)).toEqual({ ok: true });
  });

  describe('tampering', () => {
    const fields = [
      ['amount', 99],
      ['recipientId', 'mallory'],
      ['senderId', 'someone_else'],
      ['nonce', 'ffffffffffffffffffffffffffffffff'],
      ['requestId', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
    ];

    test.each(fields)('rejects when %s is changed after signing', (field, value) => {
      const req = { ...makeRequest(keypair), [field]: value };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'signature-mismatch' });
    });

    test('rejects a signature made by a different key', () => {
      const other = StellarSdk.Keypair.random();
      const req = { ...makeRequest(other), senderPublicKey: keypair.publicKey() };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'signature-mismatch' });
    });

    test('rejects when a signature byte is flipped', () => {
      const req = makeRequest(keypair);
      const raw = Buffer.from(req.signature, 'base64');
      raw[0] ^= 0xff;
      expect(verifySignature({ ...req, signature: raw.toString('base64') })).toEqual({
        ok: false,
        reason: 'signature-mismatch',
      });
    });
  });

  describe('timestamp window', () => {
    test('accepts a request just inside the window', () => {
      const req = makeRequest(keypair, { timestamp: FIXED_NOW - (SIGNATURE_MAX_SKEW_MS - 1000) });
      expect(verifySignature(req)).toEqual({ ok: true });
    });

    test('accepts a request exactly at the window edge', () => {
      const req = makeRequest(keypair, { timestamp: FIXED_NOW - SIGNATURE_MAX_SKEW_MS });
      expect(verifySignature(req)).toEqual({ ok: true });
    });

    test('rejects an expired request', () => {
      const req = makeRequest(keypair, { timestamp: FIXED_NOW - SIGNATURE_MAX_SKEW_MS - 1 });
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'timestamp-out-of-window' });
    });

    test('rejects a request timestamped too far in the future', () => {
      const req = makeRequest(keypair, { timestamp: FIXED_NOW + SIGNATURE_MAX_SKEW_MS + 1 });
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'timestamp-out-of-window' });
    });

    test('rejects a non-numeric timestamp', () => {
      const req = { ...makeRequest(keypair), timestamp: 'not-a-number' };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'invalid-timestamp' });
    });
  });

  describe('malformed input', () => {
    test('rejects a missing signature', () => {
      const req = { ...makeRequest(keypair), signature: undefined };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'missing-signature-or-key' });
    });

    test('rejects a missing public key', () => {
      const req = { ...makeRequest(keypair), senderPublicKey: undefined };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'missing-signature-or-key' });
    });

    test('rejects a missing sender or recipient', () => {
      expect(verifySignature({ ...makeRequest(keypair), senderId: '' })).toEqual({
        ok: false,
        reason: 'missing-sender-or-recipient',
      });
      expect(verifySignature({ ...makeRequest(keypair), recipientId: '' })).toEqual({
        ok: false,
        reason: 'missing-sender-or-recipient',
      });
    });

    test('rejects a missing nonce or request id', () => {
      expect(verifySignature({ ...makeRequest(keypair), nonce: '' })).toEqual({
        ok: false,
        reason: 'missing-nonce-or-requestid',
      });
      expect(verifySignature({ ...makeRequest(keypair), requestId: '' })).toEqual({
        ok: false,
        reason: 'missing-nonce-or-requestid',
      });
    });

    test('rejects a field containing the delimiter', () => {
      const req = makeRequest(keypair, { recipientId: 'juan|mallory' });
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'invalid-field-format' });
    });

    test('rejects a non-numeric amount', () => {
      const req = { ...makeRequest(keypair), amount: 'abc' };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'invalid-amount' });
    });

    test('rejects an invalid public key', () => {
      const req = { ...makeRequest(keypair), senderPublicKey: 'GNOTAVALIDKEY' };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'invalid-public-key' });
    });

    test('rejects a signature of the wrong length', () => {
      const req = { ...makeRequest(keypair), signature: Buffer.from('short').toString('base64') };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'malformed-signature' });
    });

    test('rejects a signature that is not base64', () => {
      const req = { ...makeRequest(keypair), signature: '%%%%' };
      expect(verifySignature(req)).toEqual({ ok: false, reason: 'malformed-signature' });
    });
  });
});

const LIVE = String(process.env.RUN_LIVE_SMS_TESTS || '').toLowerCase() === 'true';
const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe('SMS relay via /dev/simulate-sms', () => {
  const BASE_URL = process.env.TEST_SERVER_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const ADMIN_KEY = process.env.ADMIN_API_KEY || '';
  const SENDER_PHONE = process.env.TEST_SENDER_PHONE;
  const SENDER_ID = process.env.TEST_SENDER_ID;
  const SENDER_SECRET = process.env.TEST_SENDER_SECRET;
  const RECIPIENT = process.env.TEST_RECIPIENT;
  const WRONG_PIN = process.env.TEST_WRONG_PIN || '000000';

  let keypair;

  beforeAll(() => {
    ['TEST_SENDER_PHONE', 'TEST_SENDER_ID', 'TEST_SENDER_SECRET', 'TEST_RECIPIENT', 'ADMIN_API_KEY'].forEach(
      (key) => {
        if (!process.env[key]) throw new Error(`${key} must be set to run the live SMS tests`);
      }
    );
    keypair = StellarSdk.Keypair.fromSecret(SENDER_SECRET);
  });

  function buildSmsText({ amount = 1, timestamp = Date.now(), nonce, requestId, tamper = false } = {}) {
    const amtStr = Number(amount).toFixed(7);
    const n = nonce || bytesToHex(crypto.randomBytes(16));
    const r = requestId || bytesToHex(crypto.randomBytes(16));
    const payload = buildSignedPayloadString({
      senderId: SENDER_ID,
      recipientId: RECIPIENT,
      amount: amtStr,
      timestamp,
      nonce: n,
      requestId: r,
    });
    let sig = Buffer.from(keypair.sign(Buffer.from(payload, 'utf8')));
    if (tamper) sig[0] ^= 0xff;
    return `SEND ${amtStr} ${RECIPIENT} ${WRONG_PIN} SIG ${timestamp} ${n} ${r} ${sig.toString('base64')}`;
  }

  async function simulate(message) {
    const res = await fetch(`${BASE_URL}/dev/simulate-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: SENDER_PHONE, message }),
    });
    expect(res.status).toBe(200);
  }

  async function latestRelayRecord() {
    const res = await fetch(`${BASE_URL}/api/relay-transactions?limit=10`, {
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.transactions.find((t) => t.channel === 'sms' && t.senderId === SENDER_ID);
  }

  test('rejects an unsigned SEND command', async () => {
    await simulate(`SEND 1.0000000 ${RECIPIENT} ${WRONG_PIN}`);
    const record = await latestRelayRecord();
    expect(record.status).toBe('validation_failed');
    expect(record.statusHistory.pop().detail).toBe('signature-required');
  });

  test('rejects a tampered signature', async () => {
    await simulate(buildSmsText({ tamper: true }));
    const record = await latestRelayRecord();
    expect(record.status).toBe('validation_failed');
    expect(record.statusHistory.pop().detail).toBe('bad-signature:signature-mismatch');
  });

  test('rejects an expired timestamp', async () => {
    await simulate(buildSmsText({ timestamp: Date.now() - SIGNATURE_MAX_SKEW_MS - 60000 }));
    const record = await latestRelayRecord();
    expect(record.status).toBe('validation_failed');
    expect(record.statusHistory.pop().detail).toBe('bad-signature:timestamp-out-of-window');
  });

  test('rejects a replayed request id', async () => {
    const nonce = bytesToHex(crypto.randomBytes(16));
    const requestId = bytesToHex(crypto.randomBytes(16));
    const message = buildSmsText({ nonce, requestId });

    await simulate(message);
    const first = await latestRelayRecord();
    expect(first.statusHistory.pop().detail).toBe('incorrect-pin');

    await simulate(message);
    const second = await latestRelayRecord();
    expect(second.status).toBe('validation_failed');
    expect(second.statusHistory.pop().detail).toBe('duplicate-request');
  });

  test('rejects a reused nonce under a new request id', async () => {
    const nonce = bytesToHex(crypto.randomBytes(16));

    await simulate(buildSmsText({ nonce }));
    const first = await latestRelayRecord();
    expect(first.statusHistory.pop().detail).toBe('incorrect-pin');

    await simulate(buildSmsText({ nonce }));
    const second = await latestRelayRecord();
    expect(second.status).toBe('validation_failed');
    expect(second.statusHistory.pop().detail).toBe('nonce-reused');
  });
});