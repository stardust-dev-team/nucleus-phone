/**
 * Integration test (gox1 — bead joruva-dialer-mac-596q): proves the
 * terminal-status guard on call.js's two conference-row writers actually
 * prevents a clobber against REAL Postgres. The unit tests in call.test.js
 * are guard-PRESENCE checks (pool.query is mocked there), so they pin the SQL
 * text but cannot catch a semantically-broken WHERE clause. This test drives
 * the real route handlers against a real planner and asserts ROW STATE.
 *
 * Gated on RUN_DB_TESTS=1 + DATABASE_URL because the rest of the suite is
 * fully mocked and CI does not yet provision a test DB. Run locally with:
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://localhost:5433/nucleus_test \
 *     ./node_modules/.bin/jest call-terminal-status.integration
 *
 * Skipped (suite passes vacuously) without those env vars. SAFE against any
 * DB: every fixture row is scoped to a unique `gox1-itest-<ts>-` conference
 * name and deleted in afterAll — point DATABASE_URL at a throwaway/test DB,
 * never production.
 */

const RUN = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const describeIfDb = RUN ? describe : describe.skip;

// Mock every NON-DB dependency the call router pulls in so the handlers run
// end-to-end while their side effects (Twilio REST, the in-memory conference
// map, Slack) stay inert. `db` is intentionally NOT mocked — real Postgres.
jest.mock('../../lib/conference', () => ({
  createConference: jest.fn(),
  getConference: jest.fn(),
  updateConference: jest.fn(),
  removeConference: jest.fn(),
  listActiveConferences: jest.fn().mockReturnValue([]),
  claimLeadDial: jest.fn(),
}));
jest.mock('../../lib/twilio', () => {
  const conferences = jest.fn(() => ({ update: jest.fn().mockResolvedValue({}) }));
  conferences.list = jest.fn().mockResolvedValue([]);
  return { client: { conferences } };
});
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
  sendSystemAlert: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const express = require('express');
const conference = require('../../lib/conference');

const API_KEY = 'gox1-itest-key';
const PREFIX = `gox1-itest-${Date.now()}`;

// The set guarded by call.js's TERMINAL_STATUS_GUARD. Kept in sync by the
// presence tests in call.test.js; here we prove each one actually survives.
const TERMINAL = ['voicemail', 'missed', 'failed', 'completed'];

let app;
let pool;

// The nucleus_phone_calls DDL, copied verbatim from server/db.js initSchema().
// We create only this one table rather than calling the full initSchema(),
// which also ALTERs sibling tables (e.g. v35_pb_contacts) owned by other
// services and absent on a fresh DB. IF NOT EXISTS makes this a no-op against
// a real provisioned test DB where the app already created the table.
const NPC_DDL = `
  CREATE TABLE IF NOT EXISTS nucleus_phone_calls (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    conference_name VARCHAR(100) UNIQUE,
    conference_sid VARCHAR(50),
    caller_identity VARCHAR(50),
    lead_phone VARCHAR(20),
    lead_name VARCHAR(255),
    lead_company VARCHAR(255),
    hubspot_contact_id VARCHAR(50),
    direction VARCHAR(10) DEFAULT 'outbound',
    status VARCHAR(20) DEFAULT 'connecting',
    duration_seconds INTEGER,
    disposition VARCHAR(30),
    qualification VARCHAR(20),
    products_discussed JSONB DEFAULT '[]',
    notes TEXT,
    recording_url TEXT,
    recording_duration INTEGER,
    fireflies_uploaded BOOLEAN DEFAULT FALSE,
    participants JSONB DEFAULT '[]',
    slack_notified BOOLEAN DEFAULT FALSE,
    hubspot_synced BOOLEAN DEFAULT FALSE
  );
`;

describeIfDb('call.js terminal-status guard — real DB (gox1/596q)', () => {
  beforeAll(async () => {
    process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
    ({ pool } = require('../../db'));
    await pool.query(NPC_DDL);
    app = express();
    app.use(express.json());
    app.use('/api/call', require('../call'));
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM nucleus_phone_calls WHERE conference_name LIKE $1', [`${PREFIX}%`]);
      await pool.end();
    }
    delete process.env.NUCLEUS_PHONE_API_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Both arms read getConference() before the DB write; return a live-ish
    // conf so the handler proceeds to the UPDATE. startedAt is 7s back so the
    // computed duration is a positive integer.
    conference.getConference.mockReturnValue({
      conferenceSid: 'CFold',
      startedAt: new Date(Date.now() - 7000),
      participants: [],
      callerIdentity: 'inbound',
    });
  });

  async function seed(confName, status) {
    const { rows } = await pool.query(
      `INSERT INTO nucleus_phone_calls (conference_name, direction, status)
       VALUES ($1, 'inbound', $2)
       RETURNING id`,
      [confName, status],
    );
    return rows[0].id;
  }

  async function rowOf(id) {
    const { rows } = await pool.query(
      'SELECT status, duration_seconds, conference_sid FROM nucleus_phone_calls WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  /* ── conference-end webhook arm — the path the gox1 bug lived on ── */
  describe('POST /api/call/status (conference-end)', () => {
    test.each(TERMINAL)("leaves a terminal status='%s' untouched", async (status) => {
      const conf = `${PREFIX}-ce-${status}`;
      const id = await seed(conf, status);

      await request(app)
        .post('/api/call/status')
        .send({ StatusCallbackEvent: 'conference-end', FriendlyName: conf, ConferenceSid: 'CFnew' })
        .expect(204);

      const row = await rowOf(id);
      expect(row.status).toBe(status); // NOT clobbered to 'completed'
    });

    test("transitions a non-terminal 'connecting' row to 'completed'", async () => {
      const conf = `${PREFIX}-ce-connecting`;
      const id = await seed(conf, 'connecting');

      await request(app)
        .post('/api/call/status')
        .send({ StatusCallbackEvent: 'conference-end', FriendlyName: conf, ConferenceSid: 'CFnew' })
        .expect(204);

      const row = await rowOf(id);
      expect(row.status).toBe('completed');
      expect(row.conference_sid).toBe('CFnew');
      expect(row.duration_seconds).toBeGreaterThanOrEqual(6);
    });
  });

  /* ── POST /api/call/end — same guard, auth-gated, fired by the iOS rep ── */
  describe('POST /api/call/end', () => {
    test.each(TERMINAL)("leaves a terminal status='%s' untouched", async (status) => {
      const conf = `${PREFIX}-end-${status}`;
      const id = await seed(conf, status);

      await request(app)
        .post('/api/call/end')
        .set('x-api-key', API_KEY)
        .send({ conferenceName: conf })
        .expect(200);

      const row = await rowOf(id);
      expect(row.status).toBe(status);
    });

    test("transitions a non-terminal 'in-progress' row to 'completed'", async () => {
      const conf = `${PREFIX}-end-inprogress`;
      const id = await seed(conf, 'in-progress');

      await request(app)
        .post('/api/call/end')
        .set('x-api-key', API_KEY)
        .send({ conferenceName: conf })
        .expect(200);

      const row = await rowOf(id);
      expect(row.status).toBe('completed');
    });
  });
});
