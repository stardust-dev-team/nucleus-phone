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
    date: new Date().toISOString(),
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
  test('Layer 1: skips nucleus-phone title pattern', async () => {
    const npcTitle = makeTranscript({
      title: 'CNC Call — John Smith at Acme Corp — 2026-03-27',
    });
    mockFetchResponse({ data: { transcripts: [npcTitle] } });

    const result = await sync();
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(interactionSync.syncInteraction).not.toHaveBeenCalled();
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

  test('updates sync cursor after processing', async () => {
    const transcript = makeTranscript({ date: '2026-03-27T12:00:00Z' });
    mockFetchResponse({ data: { transcripts: [transcript] } });
    mockFetchResponse(CLAUDE_ANALYSIS);

    await sync();

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ('fireflies'"),
      expect.arrayContaining(['2026-03-27T12:00:00Z'])
    );
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
