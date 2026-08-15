// jsec-z4ff regression tests: the live-analysis WebSocket carries the live
// TRANSCRIPT, sentiment, equipment detections and coach cues of a real customer
// call, keyed by conference name. Before this change the upgrade verified a JWT
// signature and nothing else, and `subscribe` had no ownership check at all —
// so any authenticated principal, including a commission contractor, could name
// any conference and read that rep's call.
//
// These run against a REAL WebSocket server over a REAL socket, with REAL JWTs
// and conferences seeded through the REAL lib/conference store. Two reasons,
// both learned the hard way in this repo:
//   * jsec-vr1s — guards that were only ever exercised against hand-built
//     objects stayed dead for two months, because the mock had a shape
//     production never produces.
//   * The upgrade path (JWT parse, user load, 401 write) is where half the
//     authorization lives, and it does not exist at all under a mocked socket.
//
// Binding: 127.0.0.1 explicitly, never a bare listen(0). A bare bind lands on
// the IPv6 wildcard and can hand back a port an unrelated IPv4 listener already
// owns (jsec-kh7h); the no-bare-listen tripwire fails the run if you forget.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

const http = require('node:http');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const { pool } = require('../../db');
const { attachWebSocket, broadcast } = require('../live-analysis');
const { createConference, removeConference, updateConference } = require('../conference');
const { invalidateUser } = require('../../middleware/auth');

const KATES_CALL = 'nucleus-call-kates-live-customer-call';
const SECRET = 'test-jwt-secret-for-live-analysis';

// Row shapes loadUserById expects. `is_active:false` is the deactivation case.
const USERS = {
  1: { id: 1, email: 'kate@joruva.com', identity: 'kate', role: 'caller', display_name: 'Kate', is_active: true },
  2: { id: 2, email: 'blake@joruva.com', identity: 'blake', role: 'external_caller', display_name: 'Blake', is_active: true },
  3: { id: 3, email: 'tom@joruva.com', identity: 'tom', role: 'admin', display_name: 'Tom', is_active: true },
  4: { id: 4, email: 'gone@joruva.com', identity: 'gone', role: 'caller', display_name: 'Gone', is_active: false },
};

let server;
let port;

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  attachWebSocket(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  // loadUserById caches by id — clear between tests so a deactivation in one
  // test cannot be masked by another test's cached row.
  for (const id of Object.keys(USERS)) invalidateUser(Number(id));
  pool.query.mockImplementation((sql, params) => {
    if (typeof sql === 'string' && sql.includes('FROM nucleus_phone_users')) {
      const row = sql.includes('LOWER(identity)')
        ? Object.values(USERS).find((u) => u.identity === String(params[0]).toLowerCase())
        : USERS[params[0]];
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  createConference(KATES_CALL, {
    callerIdentity: 'kate', to: '+16025550001', contactName: 'Real Customer', dbRowId: 1,
  });
});

afterEach(() => removeConference(KATES_CALL));

/** Open a socket as a given user id, or reject with the HTTP status. */
function connectAs(userId, { legacy = false } = {}) {
  const payload = legacy
    ? { identity: USERS[userId].identity, role: USERS[userId].role, email: USERS[userId].email }
    : { userId };
  const token = jwt.sign(payload, SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live-analysis`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

/** Subscribe and resolve with the first frame the server sends back, if any. */
function subscribeAndAwait(ws, callId, { timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.once('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw)); });
    ws.send(JSON.stringify({ type: 'subscribe', callId }));
  });
}

describe('live-analysis upgrade — a valid signature is not enough (jsec-z4ff)', () => {
  test('an unsigned / forged token cannot open the socket', async () => {
    const bad = jwt.sign({ userId: 1 }, 'not-the-secret');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live-analysis`, {
      headers: { Authorization: `Bearer ${bad}` },
    });
    await expect(new Promise((resolve, reject) => {
      ws.on('open', () => resolve('opened'));
      ws.on('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on('error', reject);
    })).rejects.toThrow(/401/);
  });

  test('SECURITY: a DEACTIVATED user is refused even holding a perfectly valid token', async () => {
    // The old code verified the signature and never read the row, so a
    // deactivated account kept live-call access for the remaining life of a
    // 30-day token. Revocation has to reach this socket.
    await expect(connectAs(4)).rejects.toThrow(/401/);
  });

  test('SECURITY: a DB failure during the user lookup fails CLOSED, not open', async () => {
    // The lookup is the only thing standing between a valid signature and a
    // live customer call. If a transient DB error let the socket through, an
    // outage would become an open door — and it would open for EVERYONE at
    // once, silently, exactly when nobody is watching logs.
    pool.query.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    await expect(connectAs(1)).rejects.toThrow(/500|401/);
  });

  test('SECURITY: a legacy token cannot smuggle in a role the database does not grant', async () => {
    // Pre-e5p tokens carry role inline. Honouring that claim would mean a token
    // minted while someone was an admin keeps admin powers here forever, and a
    // demotion would never take effect. The role must come from the row.
    const token = jwt.sign(
      { identity: 'blake', role: 'admin', email: 'blake@joruva.com' },  // claims admin
      SECRET
    );
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live-analysis`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await once(ws, 'open');

    // Blake's actual row is external_caller, so Kate's call stays closed.
    const frame = await subscribeAndAwait(ws, KATES_CALL);
    expect(frame?.type).toBe('subscribe_denied');
    expect(frame?.data.reason).toBe('not your call');
    ws.close();
  });

  test('a live user connects', async () => {
    const ws = await connectAs(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test('a legacy token is re-resolved against the CURRENT row, not its own claims', async () => {
    // Pre-e5p tokens carry identity/role/email inline. Trusting the embedded
    // role would let a token minted while someone was an admin keep admin
    // powers here forever; the role must come from the database.
    const ws = await connectAs(2, { legacy: true });
    const denied = await subscribeAndAwait(ws, KATES_CALL);
    expect(denied?.type).toBe('subscribe_denied');   // external_caller, not admin
    ws.close();
  });
});

describe('live-analysis subscribe — ownership decides who reads a call (jsec-z4ff)', () => {
  test('SECURITY: a commission contractor cannot read another rep\'s live transcript', async () => {
    // The exact scenario in the bead. Blake is external_caller.
    const ws = await connectAs(2);
    const frame = await subscribeAndAwait(ws, KATES_CALL);

    expect(frame).toEqual({
      type: 'subscribe_denied',
      data: { callId: KATES_CALL, reason: 'not your call' },
    });

    // And the refusal must be REAL, not just a message: a broadcast on that
    // conference must not reach this socket.
    const leaked = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 200);
      ws.once('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw)); });
    });
    broadcast(KATES_CALL, { type: 'transcript', data: { text: 'customer pricing discussion' } });
    expect(await leaked).toBeNull();
    ws.close();
  });

  test('the rep who owns the call receives its broadcasts', async () => {
    const ws = await connectAs(1);
    const denial = await subscribeAndAwait(ws, KATES_CALL);
    expect(denial).toBeNull();                       // no refusal frame

    const received = new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    broadcast(KATES_CALL, { type: 'transcript', data: { text: 'hello' } });
    expect((await received).data.text).toBe('hello');
    ws.close();
  });

  test('an admin may read any call', async () => {
    const ws = await connectAs(3);
    expect(await subscribeAndAwait(ws, KATES_CALL)).toBeNull();
    ws.close();
  });

  test('owner match is case-insensitive, so a display-cased owner is not a silent lockout', async () => {
    updateConference(KATES_CALL, { startedBy: 'Kate' });
    const ws = await connectAs(1);
    expect(await subscribeAndAwait(ws, KATES_CALL)).toBeNull();
    ws.close();
  });

  test('SECURITY: an unknown conference is refused, not treated as ownerless-and-open', async () => {
    const ws = await connectAs(2);
    const frame = await subscribeAndAwait(ws, 'nucleus-call-does-not-exist');
    expect(frame?.data.reason).toBe('unknown or ended conference');
    ws.close();
  });

  test('SECURITY: an ownerless conference is admin-only (fail closed)', async () => {
    updateConference(KATES_CALL, { startedBy: undefined });

    const rep = await connectAs(1);
    expect((await subscribeAndAwait(rep, KATES_CALL))?.type).toBe('subscribe_denied');
    rep.close();

    const admin = await connectAs(3);
    expect(await subscribeAndAwait(admin, KATES_CALL)).toBeNull();
    admin.close();
  });

  test('a refused subscribe does not disturb an existing valid subscription', async () => {
    // ws._callId is reassigned during subscribe; an early return on refusal
    // must not have already torn down the previous, legitimate subscription.
    const ws = await connectAs(1);
    await subscribeAndAwait(ws, KATES_CALL);          // legitimate
    await subscribeAndAwait(ws, 'nucleus-call-nope');  // refused

    const received = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 250);
      ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.type === 'transcript') { clearTimeout(timer); resolve(m); }
      });
    });
    broadcast(KATES_CALL, { type: 'transcript', data: { text: 'still mine' } });
    expect((await received)?.data.text).toBe('still mine');
    ws.close();
  });
});
