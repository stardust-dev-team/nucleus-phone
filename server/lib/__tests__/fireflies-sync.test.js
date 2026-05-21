jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../identity-resolver');
jest.mock('../interaction-sync');
jest.mock('../../config/team.json', () => ({
  members: [
    { name: 'Tom', email: 'tom@joruva.com', identity: 'tom', role: 'admin' },
    { name: 'Kate', email: 'kate@joruva.com', identity: 'kate', role: 'caller' },
  ],
}));

const { installFetchMock, mockFetchResponse } = require('../../__tests__/helpers/mock-fetch');
const { pool } = require('../../db');
const identityResolver = require('../identity-resolver');
const interactionSync = require('../interaction-sync');
const { sync } = require('../fireflies-sync');

beforeEach(() => {
  installFetchMock();
  process.env.FIREFLIES_API_KEY = 'test-ff-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  identityResolver.resolve.mockResolvedValue({ resolved: false, name: null, company: null });
  interactionSync.syncInteraction.mockResolvedValue({ interactionId: 1, contactId: null });

  pool.query.mockImplementation((sql) => {
    if (sql.includes('ucil_sync_state') && sql.includes('SELECT')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('ucil_sync_state')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('customer_interactions')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.FIREFLIES_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

function makeTranscript(overrides = {}) {
  return {
    id: 'ff-001',
    title: 'Sales call with prospect',
    // Fireflies returns DateTime as a Unix-ms integer, not an ISO string.
    // Default to the realistic shape so tests that don't override `date`
    // exercise the same code path as production.
    date: Date.now(),
    duration: 300,
    organizer_email: 'tom@joruva.com',
    participants: ['tom@joruva.com', '+16305551234'],
    sentences: [
      { speaker_name: 'Tom', text: 'Hello', start_time: 0, end_time: 2 },
      { speaker_name: 'Prospect', text: 'Hi', start_time: 2, end_time: 4 },
    ],
    ...overrides,
  };
}

const CLAUDE_ANALYSIS = {
  content: [{ text: JSON.stringify({
    summary: 'Sales call', intent: 'inquiry',
    products_discussed: ['VSD'], sentiment: 'positive',
    competitive_mentions: [], disposition: 'connected',
  }) }],
};

describe('sync', () => {
  test('processes team-member transcripts and calls syncInteraction', async () => {
    mockFetchResponse({ data: { transcripts: [makeTranscript()] } });
    mockFetchResponse(CLAUDE_ANALYSIS);

    const result = await sync();
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(interactionSync.syncInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'voice',
        direction: 'inbound',
        sessionId: 'ff_ff-001',
      })
    );
  });

  test('filters out non-team transcripts', async () => {
    const nonTeam = makeTranscript({
      organizer_email: 'outsider@other.com',
      participants: ['outsider@other.com', '+16305551234'],
    });
    mockFetchResponse({ data: { transcripts: [nonTeam] } });

    const result = await sync();
    expect(result.processed).toBe(0);
    expect(interactionSync.syncInteraction).not.toHaveBeenCalled();
  });

  test('returns {0,0} when no transcripts', async () => {
    mockFetchResponse({ data: { transcripts: [] } });
    const result = await sync();
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe('3-layer dedup', () => {
  test('Layer 1: enriches existing NPC row when title matches', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('ucil_sync_state') && sql.includes('SELECT')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('ucil_sync_state')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("session_id LIKE 'npc_%'")) {
        return { rows: [{ id: 77 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE customer_interactions SET')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const npcTitle = makeTranscript({
      title: 'CNC Call — John Smith at Acme Corp — 2026-03-27',
    });
    mockFetchResponse({ data: { transcripts: [npcTitle] } });
    mockFetchResponse(CLAUDE_ANALYSIS);

    const result = await sync();
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    // Should UPDATE existing row, not call syncInteraction
    expect(interactionSync.syncInteraction).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE customer_interactions SET'),
      expect.arrayContaining([77]),
    );
  });

  test('Layer 1: creates new ff_ row when NPC row not yet created (race)', async () => {
    // NPC title matches but no customer_interactions row exists yet
    pool.query.mockImplementation((sql) => {
      if (sql.includes('ucil_sync_state') && sql.includes('SELECT')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('ucil_sync_state')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('customer_interactions')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const npcTitle = makeTranscript({
      title: 'CNC Call — John Smith at Acme Corp — 2026-03-27',
    });
    mockFetchResponse({ data: { transcripts: [npcTitle] } });
    mockFetchResponse(CLAUDE_ANALYSIS);

    const result = await sync();
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    // Should create new row via syncInteraction (data not lost)
    expect(interactionSync.syncInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ff_ff-001' }),
    );
  });

  test('Layer 2: skips when npc_ session exists in timeframe', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('ucil_sync_state') && sql.includes('SELECT')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('ucil_sync_state')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("session_id LIKE 'npc_%'")) {
        return { rows: [{ id: 42 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    mockFetchResponse({ data: { transcripts: [makeTranscript()] } });
    const result = await sync();
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
  });

  test('Layer 3: skips already-synced Fireflies transcript', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('ucil_sync_state') && sql.includes('SELECT')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('ucil_sync_state')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("session_id LIKE 'npc_%'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('session_id = $1') && params?.[0] === 'ff_ff-001') {
        return { rows: [{ id: 99 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    mockFetchResponse({ data: { transcripts: [makeTranscript()] } });
    const result = await sync();
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
  });
});

describe('analysis fallback', () => {
  test('uses transcript title as summary when Claude unavailable', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockFetchResponse({ data: { transcripts: [makeTranscript()] } });

    await sync();
    expect(interactionSync.syncInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Sales call with prospect',
        disposition: 'connected',
      })
    );
  });
});

describe('sync cursor', () => {
  test('reads last_sync_at from ucil_sync_state', async () => {
    const lastSync = '2026-03-26T00:00:00.000Z';
    pool.query.mockImplementation((sql) => {
      if (sql.includes('ucil_sync_state') && sql.includes('SELECT')) {
        return { rows: [{ last_sync_at: lastSync }], rowCount: 1 };
      }
      if (sql.includes('ucil_sync_state')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    mockFetchResponse({ data: { transcripts: [] } });
    await sync();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.fireflies.ai/graphql',
      expect.objectContaining({
        body: expect.stringContaining(lastSync),
      })
    );
  });

  test('updates sync cursor after processing — coerces Fireflies ms-integer date to Date', async () => {
    // Fireflies API returns transcript.date as a Unix-ms integer (DateTime
    // GraphQL scalar). Use the real shape, not an ISO string, so the bug
    // that previously shipped (passing the raw ms integer to Postgres,
    // which read it as a YEAR and threw out-of-range) gets caught here.
    const recentMs = Date.now() - 3600000; // 1 hour ago
    const transcript = makeTranscript({ date: recentMs });
    mockFetchResponse({ data: { transcripts: [transcript] } });
    mockFetchResponse(CLAUDE_ANALYSIS);

    await sync();

    const upsertCalls = pool.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("VALUES ('fireflies'")
    );
    expect(upsertCalls).toHaveLength(1);
    const [, params] = upsertCalls[0];
    expect(params[0]).toBeInstanceOf(Date);
    expect(params[0].getTime()).toBe(recentMs);
  });

  test('malformed transcript date does not poison the cursor', async () => {
    // Fireflies edge case: a transcript with null/undefined/garbage date.
    // The cursor should hold its prior value rather than advance to NaN/Invalid.
    const goodMs = Date.now() - 7200000; // 2 hours ago
    const badTranscript = makeTranscript({ id: 'ff-bad', date: null });
    const goodTranscript = makeTranscript({ id: 'ff-good', date: goodMs });
    mockFetchResponse({ data: { transcripts: [badTranscript, goodTranscript] } });
    mockFetchResponse(CLAUDE_ANALYSIS);
    mockFetchResponse(CLAUDE_ANALYSIS);

    await sync();

    const upsertCalls = pool.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("VALUES ('fireflies'")
    );
    expect(upsertCalls).toHaveLength(1);
    const [, params] = upsertCalls[0];
    expect(params[0]).toBeInstanceOf(Date);
    expect(params[0].getTime()).toBe(goodMs); // cursor advanced to the good one, not poisoned by the bad
  });
});

describe('error handling', () => {
  test('individual transcript error does not abort sync', async () => {
    const t1 = makeTranscript({ id: 'ff-001' });
    const t2 = makeTranscript({ id: 'ff-002' });
    mockFetchResponse({ data: { transcripts: [t1, t2] } });

    // Claude analysis for both
    mockFetchResponse(CLAUDE_ANALYSIS);
    mockFetchResponse(CLAUDE_ANALYSIS);

    interactionSync.syncInteraction
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValueOnce({ interactionId: 2, contactId: null });

    const result = await sync();
    expect(result.processed).toBe(1);
  });

  test('throws when FIREFLIES_API_KEY not set', async () => {
    delete process.env.FIREFLIES_API_KEY;
    await expect(sync()).rejects.toThrow('FIREFLIES_API_KEY');
  });
});
