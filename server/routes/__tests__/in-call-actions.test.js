jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

const request = require('supertest');
const express = require('express');

const API_KEY = 'test-api-key';

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  app = express();
  app.use(express.json());
  app.use('/api/in-call', require('../in-call-actions'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.ENABLE_QUICK_ACTIONS;
});

beforeEach(() => {
  delete process.env.ENABLE_QUICK_ACTIONS;
});

describe('POST /api/in-call/cue-response (bd-9tk Phase F MVP)', () => {
  test('logs accept action + returns { ok: true, recordedAt }', async () => {
    const res = await request(app)
      .post('/api/in-call/cue-response')
      .set('x-api-key', API_KEY)
      .send({ callId: 'nucleus-call-x', suggestionKey: 'rapport.tone.warm', action: 'accept' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.recordedAt).toBe('string');
    expect(new Date(res.body.recordedAt).toString()).not.toBe('Invalid Date');
  });

  test.each(['accept', 'refine', 'dismiss'])('accepts action=%s', async (action) => {
    await request(app)
      .post('/api/in-call/cue-response')
      .set('x-api-key', API_KEY)
      .send({ callId: 'c', suggestionKey: 'k', action })
      .expect(200);
  });

  test('rejects missing required fields', async () => {
    await request(app)
      .post('/api/in-call/cue-response')
      .set('x-api-key', API_KEY)
      .send({})
      .expect(400);
  });

  test('rejects unknown action', async () => {
    await request(app)
      .post('/api/in-call/cue-response')
      .set('x-api-key', API_KEY)
      .send({ callId: 'c', suggestionKey: 'k', action: 'shrug' })
      .expect(400);
  });

  test('fires regardless of ENABLE_QUICK_ACTIONS — analytics always on', async () => {
    process.env.ENABLE_QUICK_ACTIONS = 'false';
    await request(app)
      .post('/api/in-call/cue-response')
      .set('x-api-key', API_KEY)
      .send({ callId: 'c', suggestionKey: 'k', action: 'accept' })
      .expect(200);
  });
});

describe('Quick action stubs (gated by ENABLE_QUICK_ACTIONS)', () => {
  const verbs = ['book-meeting', 'send-followup', 'crm-update', 'send-spec'];

  test.each(verbs)('/%s returns feature_disabled when flag is off', async (verb) => {
    process.env.ENABLE_QUICK_ACTIONS = 'false';
    const res = await request(app)
      .post(`/api/in-call/${verb}`)
      .set('x-api-key', API_KEY)
      .send({})
      .expect(200);
    expect(res.body).toEqual({ ok: false, reason: 'feature_disabled' });
  });

  test.each(verbs)('/%s returns not_implemented when flag is on', async (verb) => {
    process.env.ENABLE_QUICK_ACTIONS = 'true';
    const res = await request(app)
      .post(`/api/in-call/${verb}`)
      .set('x-api-key', API_KEY)
      .send({})
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe('not_implemented');
    expect(typeof res.body.message).toBe('string');
  });
});
