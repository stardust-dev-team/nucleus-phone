jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../lib/twilio', () => ({
  client: { messages: { create: jest.fn().mockResolvedValue({ sid: 'SM123' }) } },
  VoiceResponse: jest.fn(),
  generateAccessToken: jest.fn(),
}));
jest.mock('../../lib/slack', () => ({
  sendSlackDM: jest.fn().mockResolvedValue(true),
  sendSlackAlert: jest.fn(),
  formatCallAlert: jest.fn(),
}));

// Mock the Anthropic API (ask-nucleus.js uses global fetch)
const originalFetch = global.fetch;

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { client: twilioClient } = require('../../lib/twilio');
const { sendSlackDM } = require('../../lib/slack');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/ask', require('../ask'));
  return app;
}

function mockSession(identity, role = 'caller') {
  jwt.verify.mockReturnValue({ identity, role, email: `${identity}@joruva.com` });
}

let app;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.PHONE_TOM = '+16304416374';
  process.env.TWILIO_PHONE_NUMBER = '+16026000188';
  process.env.TOM_SLACK_USER_ID = 'U09QE6KDHNK';
  app = makeApp();
});

afterAll(() => {
  global.fetch = originalFetch;
  delete process.env.JWT_SECRET;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.PHONE_TOM;
  delete process.env.TWILIO_PHONE_NUMBER;
  delete process.env.TOM_SLACK_USER_ID;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  global.fetch = originalFetch;
});

/* ───────────── Auth ───────────── */

describe('Auth', () => {
  test('POST /api/ask returns 401 without session', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app)
      .post('/api/ask')
      .send({ message: 'hello' })
      .expect(401);
  });

  test('POST /api/ask returns 401 with API key (session only)', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app)
      .post('/api/ask')
      .set('x-api-key', 'some-key')
      .send({ message: 'hello' })
      .expect(401);
  });
});

/* ───────────── POST /api/ask validation ───────────── */

describe('POST /api/ask validation', () => {
  test('returns 400 without message', async () => {
    mockSession('ryann');
    await request(app)
      .post('/api/ask')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({})
      .expect(400);
  });

  test('returns 400 for empty message', async () => {
    mockSession('ryann');
    await request(app)
      .post('/api/ask')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({ message: '   ' })
      .expect(400);
  });

  test('returns 400 for message over 4000 chars', async () => {
    mockSession('ryann');
    await request(app)
      .post('/api/ask')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({ message: 'x'.repeat(4001) })
      .expect(400);
  });
});

/* ───────────── Conversation CRUD ───────────── */

describe('GET /api/ask/conversations', () => {
  test('lists own conversations for caller', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, caller_identity: 'ryann', created_at: '2026-04-10', updated_at: '2026-04-10', message_count: 5 }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/ask/conversations')
      .set('Cookie', 'nucleus_session=fake')
      .expect(200);

    expect(res.body.conversations).toHaveLength(1);
    // Verify caller filter applied
    expect(pool.query.mock.calls[0][1]).toContain('ryann');
  });

  test('admin sees all conversations', async () => {
    mockSession('tom', 'admin');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/ask/conversations')
      .set('Cookie', 'nucleus_session=fake')
      .expect(200);

    // Admin query should not filter by caller_identity
    const query = pool.query.mock.calls[0][0];
    expect(query).not.toContain('caller_identity =');
  });
});

describe('GET /api/ask/conversations/:id', () => {
  test('returns 404 for non-existent conversation', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/ask/conversations/999')
      .set('Cookie', 'nucleus_session=fake')
      .expect(404);
  });

  test('non-admin cannot access other users conversation', async () => {
    mockSession('kate');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/ask/conversations/1')
      .set('Cookie', 'nucleus_session=fake')
      .expect(404);

    // Should filter by caller_identity
    expect(pool.query.mock.calls[0][1]).toContain('kate');
  });

  test('returns conversation for owner', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, caller_identity: 'ryann', messages: [], created_at: '2026-04-10', updated_at: '2026-04-10' }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/ask/conversations/1')
      .set('Cookie', 'nucleus_session=fake')
      .expect(200);

    expect(res.body.id).toBe(1);
  });
});

describe('DELETE /api/ask/conversations/:id', () => {
  test('deletes own conversation', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    const res = await request(app)
      .delete('/api/ask/conversations/1')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .expect(200);

    expect(res.body.deleted).toBe(true);
    // Atomic ownership check
    expect(pool.query.mock.calls[0][1]).toContain('ryann');
  });

  test('returns 404 for other users conversation (non-admin)', async () => {
    mockSession('kate');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .delete('/api/ask/conversations/1')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .expect(404);
  });

  test('admin can delete any conversation', async () => {
    mockSession('tom', 'admin');
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    await request(app)
      .delete('/api/ask/conversations/1')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .expect(200);

    // Admin query should not filter by caller_identity
    expect(pool.query.mock.calls[0][1]).toEqual([1]);
  });
});

/* ───────────── POST /api/ask/escalate ───────────── */

describe('POST /api/ask/escalate', () => {
  test('returns 400 without question', async () => {
    mockSession('ryann');
    await request(app)
      .post('/api/ask/escalate')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({})
      .expect(400);
  });

  test('sends SMS + Slack DM', async () => {
    mockSession('ryann');

    const res = await request(app)
      .post('/api/ask/escalate')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({ question: 'What is the custom quote for 50HP?', context: 'Customer needs 50HP system', company: 'Acme' })
      .expect(200);

    expect(res.body.sent).toBe(true);
    expect(res.body.channels).toContain('sms');
    expect(res.body.channels).toContain('slack');
    expect(twilioClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+16304416374', from: '+16026000188' })
    );
    expect(sendSlackDM).toHaveBeenCalledWith(
      'U09QE6KDHNK',
      expect.stringContaining('ryann'),
      expect.any(Array)
    );
  });

  test('rate limits to 1 per rep per 5 min', async () => {
    mockSession('alex');

    // First call succeeds
    await request(app)
      .post('/api/ask/escalate')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({ question: 'first' })
      .expect(200);

    // Second call within 5 min is rate-limited
    const res = await request(app)
      .post('/api/ask/escalate')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({ question: 'second' })
      .expect(429);

    expect(res.body.error).toBe('rate_limited');
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('marks escalation in conversation if conversationId provided', async () => {
    mockSession('britt');
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await request(app)
      .post('/api/ask/escalate')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({ question: 'pricing help', conversationId: 42 })
      .expect(200);

    // Should have called UPDATE to append escalation marker
    const updateCall = pool.query.mock.calls.find(c => c[0].includes('messages = messages ||'));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][1]).toBe(42);
  });

  test('partial failure returns which channels succeeded', async () => {
    mockSession('lily');
    twilioClient.messages.create.mockRejectedValueOnce(new Error('twilio down'));

    const res = await request(app)
      .post('/api/ask/escalate')
      .set('Cookie', 'nucleus_session=fake')
      .set('X-Requested-With', 'fetch')
      .send({ question: 'help' })
      .expect(200);

    // SMS failed, Slack succeeded
    expect(res.body.sent).toBe(true);
    expect(res.body.channels).toContain('slack');
    expect(res.body.channels).not.toContain('sms');
  });
});

/* ───────────── Escalation detection unit test ───────────── */

describe('detectAndStripEscalation', () => {
  const { detectAndStripEscalation } = require('../../lib/ask-nucleus');

  test('detects valid escalation marker', () => {
    const input = 'I cannot answer that. Want me to ask Tom?<!--ESCALATE:{"question":"pricing","context":"50HP system"}-->';
    const { text, escalation } = detectAndStripEscalation(input);
    expect(text).toBe('I cannot answer that. Want me to ask Tom?');
    expect(escalation.question).toBe('pricing');
    expect(escalation.context).toBe('50HP system');
  });

  test('returns null escalation for no marker', () => {
    const { text, escalation } = detectAndStripEscalation('Just a normal response.');
    expect(text).toBe('Just a normal response.');
    expect(escalation).toBeNull();
  });

  test('handles malformed JSON in marker gracefully', () => {
    const input = 'text<!--ESCALATE:{bad json}-->';
    const { text, escalation } = detectAndStripEscalation(input);
    expect(text).toBe('text');
    expect(escalation).toBeNull();
  });
});
