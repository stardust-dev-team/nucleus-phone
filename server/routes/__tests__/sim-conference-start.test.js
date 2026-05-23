/**
 * Tests for the B2b sim branch of POST /api/call/status.
 *
 * Architecture B: when Twilio fires the conference-start callback for a
 * `sim-{id}` FriendlyName, the server reads the sim_call_scores row under
 * SELECT FOR UPDATE, dials Vapi outbound to NUCLEUS_SIM_CONFERENCE_NUMBER,
 * and UPDATEs vapi_call_id / monitor URLs / conference_sid before the
 * transaction commits. Concurrent retries see vapi_call_id NOT NULL and
 * short-circuit.
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

jest.mock('../../lib/conference', () => ({
  createConference: jest.fn(),
  updateConference: jest.fn(),
  removeConference: jest.fn(),
  getConference: jest.fn(),
  listActiveConferences: jest.fn().mockReturnValue([]),
  claimLeadDial: jest.fn(),
}));

jest.mock('../../lib/twilio', () => {
  const conferences = jest.fn(() => ({
    update: jest.fn().mockResolvedValue({}),
    participants: {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
  }));
  conferences.list = jest.fn().mockResolvedValue([]);
  return { client: { conferences } };
});

jest.mock('../../lib/vapi', () => ({
  createOutboundCall: jest.fn(),
}));

jest.mock('../../lib/personas', () => ({
  resolveAssistantId: jest.fn(),
}));

jest.mock('../../lib/sim-greetings', () => ({
  pickGreeting: jest.fn().mockReturnValue('mock-greeting'),
}));

jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
  sendSystemAlert: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../lib/live-analysis', () => ({ cleanupCall: jest.fn() }));
jest.mock('../../lib/conversation-pipeline', () => ({ cleanupConversation: jest.fn() }));
jest.mock('../../lib/equipment-pipeline', () => ({ cleanupPipelineState: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { client } = require('../../lib/twilio');
const { createOutboundCall } = require('../../lib/vapi');
const { resolveAssistantId } = require('../../lib/personas');
const { sendSystemAlert } = require('../../lib/slack');
const conference = require('../../lib/conference');
const callRouter = require('../call');

let app;
beforeAll(() => {
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/call', callRouter);
  process.env.NUCLEUS_SIM_CONFERENCE_NUMBER = '+18885550000';
  process.env.NODE_ENV = 'test'; // disables twilioWebhook signature validation
});

afterAll(() => {
  delete process.env.NUCLEUS_SIM_CONFERENCE_NUMBER;
});

// Mock-pool's connect() returns { query, release } but the default query is a
// bare jest.fn() with no resolved value — handleSimConferenceStart needs
// each query() call (BEGIN, SELECT, UPDATE, COMMIT) to resolve.
function mockTransaction({ selectRows = [], updateRows = [] } = {}) {
  const queryMock = jest.fn().mockImplementation((sql) => {
    if (/^BEGIN$/.test(sql)) return Promise.resolve();
    if (/^COMMIT$/.test(sql)) return Promise.resolve();
    if (/^ROLLBACK$/.test(sql)) return Promise.resolve();
    if (/^SELECT/i.test(sql)) return Promise.resolve({ rows: selectRows });
    if (/^UPDATE/i.test(sql)) return Promise.resolve({ rows: updateRows, rowCount: updateRows.length });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const releaseMock = jest.fn();
  pool.connect.mockResolvedValue({ query: queryMock, release: releaseMock });
  return { queryMock, releaseMock };
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  conference.getConference.mockReturnValue(null);
  resolveAssistantId.mockReturnValue('assistant-mock-123');
});

const send = (body) =>
  request(app)
    .post('/api/call/status')
    .type('form')
    .send({ StatusCallbackEvent: 'conference-start', ConferenceSid: 'CF100', ...body });

describe('POST /api/call/status — sim branch (B2b)', () => {
  test('happy path: dials Vapi and persists vapi_call_id + monitor URLs', async () => {
    const { queryMock, releaseMock } = mockTransaction({
      selectRows: [{ id: 42, persona_id: 'mike-garza', difficulty: 'easy', vapi_call_id: null, status: 'in-progress' }],
    });
    createOutboundCall.mockResolvedValue({
      id: 'vapi-uuid-1',
      monitor: { listenUrl: 'wss://listen', controlUrl: 'wss://control' },
    });
    conference.getConference.mockReturnValue({ type: 'sim', personaId: 'mike-garza', difficulty: 'easy', assistantId: 'assistant-from-memory' });

    await send({ FriendlyName: 'sim-42' }).expect(204);

    // Transaction shape: BEGIN, SELECT FOR UPDATE, UPDATE, COMMIT
    const calls = queryMock.mock.calls.map(c => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls.some(c => /SELECT.*FROM sim_call_scores.*WHERE conference_name = \$1 FOR UPDATE/s.test(c))).toBe(true);
    expect(calls.some(c => /UPDATE sim_call_scores[\s\S]*vapi_call_id/.test(c))).toBe(true);
    expect(calls[calls.length - 1]).toBe('COMMIT');

    // Vapi dialed with in-memory assistantId (preferred over DB resolution)
    expect(createOutboundCall).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: 'assistant-from-memory',
      customerNumber: '+18885550000',
      assistantOverrides: expect.objectContaining({
        firstMessage: 'mock-greeting',
        variableValues: expect.objectContaining({ simCallId: '42', conferenceName: 'sim-42' }),
      }),
    }));

    // UPDATE persisted vapi.id, monitor URLs, conference_sid
    const updateCall = queryMock.mock.calls.find(c => /UPDATE sim_call_scores[\s\S]*vapi_call_id/.test(c[0]));
    expect(updateCall[1]).toEqual(['vapi-uuid-1', 'wss://listen', 'wss://control', 'CF100', 42]);

    // In-memory map updated with conference SID for downstream events
    expect(conference.updateConference).toHaveBeenCalledWith('sim-42', { conferenceSid: 'CF100' });

    expect(releaseMock).toHaveBeenCalled();
  });

  test('idempotency: short-circuits when vapi_call_id already set', async () => {
    const { queryMock } = mockTransaction({
      selectRows: [{ id: 42, persona_id: 'mike-garza', difficulty: 'easy', vapi_call_id: 'vapi-existing-id', status: 'in-progress' }],
    });

    await send({ FriendlyName: 'sim-42' }).expect(204);

    expect(createOutboundCall).not.toHaveBeenCalled();
    // Transaction still BEGIN/SELECT/COMMIT (no UPDATE)
    const calls = queryMock.mock.calls.map(c => c[0]);
    expect(calls.filter(c => /^UPDATE/i.test(c))).toHaveLength(0);
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  test('no-op when sim row is missing (row was deleted or never created)', async () => {
    const { queryMock } = mockTransaction({ selectRows: [] });

    await send({ FriendlyName: 'sim-999' }).expect(204);

    expect(createOutboundCall).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith('COMMIT');
  });

  test('no-op when sim row status is not in-progress (cancelled/swept before bridge)', async () => {
    mockTransaction({
      selectRows: [{ id: 42, persona_id: 'mike-garza', difficulty: 'easy', vapi_call_id: null, status: 'cancelled' }],
    });

    await send({ FriendlyName: 'sim-42' }).expect(204);

    expect(createOutboundCall).not.toHaveBeenCalled();
  });

  test('DB fallback: in-memory map empty, recovers persona/difficulty from DB row', async () => {
    mockTransaction({
      selectRows: [{ id: 42, persona_id: 'mike-garza', difficulty: 'hard', vapi_call_id: null, status: 'in-progress' }],
    });
    createOutboundCall.mockResolvedValue({ id: 'vapi-1', monitor: {} });
    conference.getConference.mockReturnValue(null);

    await send({ FriendlyName: 'sim-42' }).expect(204);

    expect(resolveAssistantId).toHaveBeenCalledWith({ personaId: 'mike-garza', difficulty: 'hard' });
    expect(createOutboundCall).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: 'assistant-mock-123',
    }));
  });

  test('Vapi dial failure: flips status on locked row + COMMITs (closes retry-race), ends conference, alerts', async () => {
    const { queryMock } = mockTransaction({
      selectRows: [{ id: 42, persona_id: 'mike-garza', difficulty: 'easy', vapi_call_id: null, status: 'in-progress' }],
    });
    createOutboundCall.mockRejectedValue(Object.assign(new Error('Vapi 500'), { status: 500 }));
    const conferenceUpdate = jest.fn().mockResolvedValue({});
    client.conferences.mockReturnValueOnce({
      update: conferenceUpdate,
      participants: { list: jest.fn(), create: jest.fn() },
    });

    await send({ FriendlyName: 'sim-42' }).expect(204);

    // CRITICAL: the failure UPDATE runs on the SAME transactional dbClient
    // that holds the SELECT FOR UPDATE lock, and we COMMIT (not ROLLBACK).
    // A blocked Twilio retry unblocks on COMMIT, sees status='score-failed',
    // and short-circuits via the existing in-progress guard. ROLLBACK would
    // release the lock with the row still 'in-progress' and the retry would
    // re-dial Vapi.
    const calls = queryMock.mock.calls.map(c => c[0]);
    expect(calls).not.toContain('ROLLBACK');
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(calls.some(c => /UPDATE sim_call_scores[\s\S]*status = 'score-failed'/.test(c))).toBe(true);

    // The locked-row UPDATE uses row.id, not conference_name (markSimFailed's
    // separate-connection path). Pinned via the second argument.
    const failedUpdate = queryMock.mock.calls.find(c => /status = 'score-failed'/.test(c[0]));
    expect(failedUpdate[1]).toEqual([
      expect.stringContaining('Vapi dial failed: Vapi 500'),
      42,
    ]);

    // Conference ended so iOS leg drops cleanly
    expect(client.conferences).toHaveBeenCalledWith('CF100');
    expect(conferenceUpdate).toHaveBeenCalledWith({ status: 'completed' });

    // Slack alert fired
    expect(sendSystemAlert).toHaveBeenCalled();
  });

  test('assistantId unresolvable: flips status on locked row + COMMIT (no separate-connection race)', async () => {
    const { queryMock } = mockTransaction({
      selectRows: [{ id: 42, persona_id: 'unknown', difficulty: 'easy', vapi_call_id: null, status: 'in-progress' }],
    });
    resolveAssistantId.mockReturnValue(undefined);

    await send({ FriendlyName: 'sim-42' }).expect(204);

    expect(createOutboundCall).not.toHaveBeenCalled();

    // Status flip happens on the locked row inside the transaction, NOT via
    // a separate-connection markSimFailed call against the pool.
    const calls = queryMock.mock.calls.map(c => c[0]);
    expect(calls.some(c => /UPDATE sim_call_scores[\s\S]*status = 'score-failed'/.test(c))).toBe(true);
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
  });

  test('NUCLEUS_SIM_CONFERENCE_NUMBER unset: marks failed and alerts', async () => {
    delete process.env.NUCLEUS_SIM_CONFERENCE_NUMBER;

    await send({ FriendlyName: 'sim-42' }).expect(204);

    expect(pool.connect).not.toHaveBeenCalled(); // we bail before opening a connection
    expect(createOutboundCall).not.toHaveBeenCalled();
    expect(sendSystemAlert).toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(`status = 'score-failed'`),
      expect.arrayContaining(['sim-42']),
    );

    process.env.NUCLEUS_SIM_CONFERENCE_NUMBER = '+18885550000';
  });

  test('non-sim conferences are NOT routed through the sim branch', async () => {
    conference.getConference.mockReturnValue(null);

    await send({ FriendlyName: 'nucleus-call-xyz', ConferenceSid: 'CF999' }).expect(204);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(createOutboundCall).not.toHaveBeenCalled();
  });

  test('participant-join on sim FriendlyName triggers the bridge (Twilio sometimes skips conference-start for REST-created bridge calls — q0z 2026-05-22)', async () => {
    mockTransaction({
      selectRows: [{ id: 42, persona_id: 'mike-garza', difficulty: 'easy', vapi_call_id: null, status: 'in-progress' }],
    });
    createOutboundCall.mockResolvedValue({
      id: 'vapi-uuid-pj',
      monitor: { listenUrl: 'wss://listen', controlUrl: 'wss://control' },
    });
    conference.getConference.mockReturnValue({ type: 'sim', personaId: 'mike-garza', difficulty: 'easy', assistantId: 'assistant-from-memory' });

    await request(app)
      .post('/api/call/status')
      .type('form')
      .send({
        StatusCallbackEvent: 'participant-join',
        FriendlyName: 'sim-42',
        ConferenceSid: 'CF100',
        CallSid: 'CA50',
      })
      .expect(204);

    expect(pool.connect).toHaveBeenCalled();
    expect(createOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: 'assistant-from-memory',
        customerNumber: '+18885550000',
        assistantOverrides: expect.objectContaining({
          variableValues: expect.objectContaining({
            simCallId: '42',
            conferenceName: 'sim-42',
          }),
        }),
      })
    );
  });

  test('non-trigger conference events on sim FriendlyName do NOT trigger the bridge', async () => {
    for (const event of ['participant-leave', 'conference-end', 'announcement-end']) {
      await request(app)
        .post('/api/call/status')
        .type('form')
        .send({
          StatusCallbackEvent: event,
          FriendlyName: 'sim-42',
          ConferenceSid: 'CF100',
          CallSid: 'CA50',
        })
        .expect(204);
    }

    expect(pool.connect).not.toHaveBeenCalled();
    expect(createOutboundCall).not.toHaveBeenCalled();
  });
});
