jest.mock('./Signature', () => ({ isValidSigningKey: jest.fn() }));

const { createRelay } = require('./Relay');

const SENDER = 'user_sender_01';
const OTHER_SENDER = 'user_sender_02';
const REQUEST_ID = 'a'.repeat(32);
const OTHER_REQUEST_ID = 'c'.repeat(32);
const NONCE = 'b'.repeat(32);
const OTHER_NONCE = 'd'.repeat(32);
const REQUESTS = 'relay_requests';
const NONCES = 'omnipay_used_nonces';
const TIMESTAMP = { __op: 'serverTimestamp' };

const FieldValue = {
  serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  increment: (by) => ({ __op: 'increment', by }),
};

function createFakeFirestore() {
  const store = new Map();
  const queue = { tail: Promise.resolve() };

  const snapshot = (key) => ({
    exists: store.has(key),
    data: () => (store.has(key) ? { ...store.get(key) } : undefined),
  });

  const docRef = (collection, id) => {
    const key = `${collection}/${id}`;
    return {
      key,
      get: async () => snapshot(key),
      update: async (fields) => {
        if (!store.has(key)) throw new Error('NOT_FOUND: no document to update');
        const next = { ...store.get(key) };
        Object.entries(fields).forEach(([field, value]) => {
          next[field] = value && value.__op === 'increment' ? (next[field] || 0) + value.by : value;
        });
        store.set(key, next);
      },
    };
  };

  return {
    collection: (name) => ({ name, doc: (id) => docRef(name, id) }),
    runTransaction: (work) => {
      const run = queue.tail.then(async () => {
        const pending = [];
        const tx = {
          get: async (ref) => snapshot(ref.key),
          create: (ref, data) => {
            pending.push({ key: ref.key, data });
          },
        };
        const result = await work(tx);
        if (pending.some(({ key }) => store.has(key))) throw new Error('ALREADY_EXISTS');
        pending.forEach(({ key, data }) => store.set(key, { ...data }));
        return result;
      });
      queue.tail = run.catch(() => {});
      return run;
    },
    seed: (collection, id, data) => {
      store.set(`${collection}/${id}`, { ...data });
    },
    read: (collection, id) => {
      const value = store.get(`${collection}/${id}`);
      return value ? { ...value } : undefined;
    },
    count: (collection) => [...store.keys()].filter((key) => key.startsWith(`${collection}/`)).length,
  };
}

describe('claimSignedRequest', () => {
  let firestore;
  let log;
  let relay;
  let txSpy;

  beforeEach(() => {
    firestore = createFakeFirestore();
    txSpy = jest.spyOn(firestore, 'runTransaction');
    log = jest.fn();
    relay = createRelay({ getDb: () => firestore, FieldValue, log });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('duplicate-request', () => {
    beforeEach(async () => {
      await relay.claimSignedRequest(REQUEST_ID, NONCE, SENDER, { channel: 'sms' });
      log.mockClear();
    });

    test('rejects a repeated requestId', async () => {
      const result = await relay.claimSignedRequest(REQUEST_ID, OTHER_NONCE, SENDER, { channel: 'api' });
      expect(result).toEqual({
        claimed: false,
        reason: 'duplicate-request',
        previousStatus: 'processing',
        originalTxHash: null,
      });
    });

    test('rejects a requestId reused by a different sender', async () => {
      const result = await relay.claimSignedRequest(REQUEST_ID, OTHER_NONCE, OTHER_SENDER);
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe('duplicate-request');
    });

    test('does not store the nonce of the rejected replay', async () => {
      await relay.claimSignedRequest(REQUEST_ID, OTHER_NONCE, SENDER);
      expect(firestore.read(NONCES, `${SENDER}:${OTHER_NONCE}`)).toBeUndefined();
      expect(firestore.count(REQUESTS)).toBe(1);
      expect(firestore.count(NONCES)).toBe(1);
    });

    test('records the replay on the original request', async () => {
      await relay.claimSignedRequest(REQUEST_ID, OTHER_NONCE, SENDER, { channel: 'api' });
      const record = firestore.read(REQUESTS, REQUEST_ID);
      expect(record.replayCount).toBe(1);
      expect(record.lastReplayAt).toEqual(TIMESTAMP);
      expect(record.lastReplayChannel).toBe('api');
      expect(record.nonce).toBe(NONCE);
      expect(record.status).toBe('processing');
    });

    test('increments the replay count on every attempt', async () => {
      await relay.claimSignedRequest(REQUEST_ID, OTHER_NONCE, SENDER);
      await relay.claimSignedRequest(REQUEST_ID, 'e'.repeat(32), SENDER);
      expect(firestore.read(REQUESTS, REQUEST_ID).replayCount).toBe(2);
    });

    test('returns the status and transaction hash of a finished original', async () => {
      const txHash = 'f'.repeat(64);
      firestore.seed(REQUESTS, REQUEST_ID, { ...firestore.read(REQUESTS, REQUEST_ID), status: 'settled', txHash });
      const result = await relay.claimSignedRequest(REQUEST_ID, OTHER_NONCE, SENDER, { channel: 'api' });
      expect(result).toEqual({
        claimed: false,
        reason: 'duplicate-request',
        previousStatus: 'settled',
        originalTxHash: txHash,
      });
    });

    test('logs the replay without a new settlement', async () => {
      await relay.claimSignedRequest(REQUEST_ID, OTHER_NONCE, SENDER, { channel: 'api' });
      expect(log).toHaveBeenCalledWith('warn', 'nonce', expect.stringContaining('REPLAY REJECTED (duplicate request)'));
      expect(log).toHaveBeenCalledWith('warn', 'nonce', expect.stringContaining('replayCount=1'));
      expect(log).toHaveBeenCalledWith('warn', 'nonce', expect.stringContaining('newSettlement=no'));
    });
  });

  describe('nonce-reused', () => {
    beforeEach(async () => {
      await relay.claimSignedRequest(REQUEST_ID, NONCE, SENDER, { channel: 'sms' });
      log.mockClear();
    });

    test('rejects a reused nonce under a new requestId', async () => {
      const result = await relay.claimSignedRequest(OTHER_REQUEST_ID, NONCE, SENDER, { channel: 'api' });
      expect(result).toEqual({
        claimed: false,
        reason: 'nonce-reused',
        previousStatus: 'processing',
        originalTxHash: null,
      });
    });

    test('does not create a record for the rejected requestId', async () => {
      await relay.claimSignedRequest(OTHER_REQUEST_ID, NONCE, SENDER);
      expect(firestore.read(REQUESTS, OTHER_REQUEST_ID)).toBeUndefined();
      expect(firestore.count(REQUESTS)).toBe(1);
      expect(firestore.count(NONCES)).toBe(1);
    });

    test('records the replay on the original request', async () => {
      await relay.claimSignedRequest(OTHER_REQUEST_ID, NONCE, SENDER, { channel: 'api' });
      const record = firestore.read(REQUESTS, REQUEST_ID);
      expect(record.replayCount).toBe(1);
      expect(record.lastReplayAt).toEqual(TIMESTAMP);
      expect(record.lastReplayChannel).toBe('api');
    });

    test('allows the same nonce from a different sender', async () => {
      const result = await relay.claimSignedRequest(OTHER_REQUEST_ID, NONCE, OTHER_SENDER);
      expect(result).toEqual({ claimed: true });
    });

    test('returns the status and transaction hash of a finished original', async () => {
      const txHash = '9'.repeat(64);
      firestore.seed(REQUESTS, REQUEST_ID, { ...firestore.read(REQUESTS, REQUEST_ID), status: 'settled', txHash });
      const result = await relay.claimSignedRequest(OTHER_REQUEST_ID, NONCE, SENDER);
      expect(result).toEqual({
        claimed: false,
        reason: 'nonce-reused',
        previousStatus: 'settled',
        originalTxHash: txHash,
      });
    });

    test('logs the replay without a new settlement', async () => {
      await relay.claimSignedRequest(OTHER_REQUEST_ID, NONCE, SENDER, { channel: 'api' });
      expect(log).toHaveBeenCalledWith('warn', 'nonce', expect.stringContaining('REPLAY REJECTED (nonce already used)'));
      expect(log).toHaveBeenCalledWith('warn', 'nonce', expect.stringContaining('replayCount=1'));
      expect(log).toHaveBeenCalledWith('warn', 'nonce', expect.stringContaining('newSettlement=no'));
    });

    test('still rejects when the original request record cannot be found', async () => {
      firestore.seed(NONCES, `${OTHER_SENDER}:${OTHER_NONCE}`, { senderId: OTHER_SENDER, requestId: 'z'.repeat(20) });
      const result = await relay.claimSignedRequest(OTHER_REQUEST_ID, OTHER_NONCE, OTHER_SENDER);
      expect(result).toEqual({
        claimed: false,
        reason: 'nonce-reused',
        previousStatus: null,
        originalTxHash: null,
      });
      expect(log).toHaveBeenCalledWith('error', 'nonce', expect.stringContaining('Replay tracking failed'));
    });
  });

  describe('invalid format', () => {
    const expectNothingClaimed = () => {
      expect(txSpy).not.toHaveBeenCalled();
      expect(firestore.count(REQUESTS)).toBe(0);
      expect(firestore.count(NONCES)).toBe(0);
    };

    test.each([undefined, null, '', 0])('rejects a missing requestId (%p)', async (value) => {
      const result = await relay.claimSignedRequest(value, NONCE, SENDER, { channel: 'sms' });
      expect(result).toEqual({ claimed: false, reason: 'missing-requestid' });
      expectNothingClaimed();
    });

    test.each([undefined, null, '', 0])('rejects a missing nonce (%p)', async (value) => {
      const result = await relay.claimSignedRequest(REQUEST_ID, value, SENDER, { channel: 'sms' });
      expect(result).toEqual({ claimed: false, reason: 'missing-nonce' });
      expectNothingClaimed();
    });

    test.each([
      ['too short', 'a'.repeat(15)],
      ['too long', 'a'.repeat(129)],
      ['contains a space', 'request id 1234567890'],
      ['contains a slash', 'request/id/1234567890'],
      ['contains a pipe', 'request|id|1234567890'],
      ['contains non-ASCII characters', 'request-ñ-1234567890'],
    ])('rejects a requestId that is %s', async (_label, requestId) => {
      const result = await relay.claimSignedRequest(requestId, NONCE, SENDER, { channel: 'sms' });
      expect(result).toEqual({ claimed: false, reason: 'invalid-requestid' });
      expect(log).toHaveBeenCalledWith(
        'warn',
        'nonce',
        `REJECTED (invalid requestId format) | channel=sms sender=${SENDER}`
      );
      expectNothingClaimed();
    });

    test.each([
      ['too short', 'a'.repeat(7)],
      ['too long', 'a'.repeat(129)],
      ['contains a space', 'nonce 1234'],
      ['contains punctuation', 'nonce!1234'],
      ['contains a pipe', 'nonce|1234'],
      ['contains non-ASCII characters', 'nonce-ñ-1234'],
    ])('rejects a nonce that is %s', async (_label, nonce) => {
      const result = await relay.claimSignedRequest(REQUEST_ID, nonce, SENDER, { channel: 'sms' });
      expect(result).toEqual({ claimed: false, reason: 'invalid-nonce' });
      expect(log).toHaveBeenCalledWith(
        'warn',
        'nonce',
        `REJECTED (invalid nonce format) | channel=sms sender=${SENDER}`
      );
      expectNothingClaimed();
    });

    test('accepts identifiers at the length boundaries', async () => {
      const shortest = await relay.claimSignedRequest('r'.repeat(16), 'n'.repeat(8), SENDER);
      const longest = await relay.claimSignedRequest('R'.repeat(128), 'N'.repeat(128), SENDER);
      expect(shortest).toEqual({ claimed: true });
      expect(longest).toEqual({ claimed: true });
    });
  });
});