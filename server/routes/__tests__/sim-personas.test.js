jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../config/team.json', () => ({
  members: [
    { identity: 'tom', name: 'Tom', email: 'tom@joruva.com', role: 'admin' },
  ],
}));
jest.mock('../../lib/vapi', () => ({
  createOutboundCall: jest.fn(),
  stopCall: jest.fn(),
  stopCallAndLog: jest.fn(),
  getCall: jest.fn(),
}));
jest.mock('../../lib/sim-scorer', () => ({
  scoreTranscript: jest.fn(),
}));
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn(),
  sendAdminReport: jest.fn(),
  sendSystemAlert: jest.fn(),
  formatSimScorecard: jest.fn(),
  formatAdminReport: jest.fn(),
}));
jest.mock('../../lib/live-analysis', () => ({
  broadcast: jest.fn(),
}));
jest.mock('../../lib/equipment-pipeline', () => ({
  processEquipmentChunk: jest.fn(),
}));
jest.mock('../../lib/conversation-pipeline', () => ({
  processConversationChunk: jest.fn(),
  getCallEventLog: jest.fn().mockReturnValue([]),
  cleanupConversation: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const API_KEY = 'test-personas-api-key';

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/sim', require('../sim'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

describe('GET /api/sim/personas', () => {
  test('401 without auth', async () => {
    await request(app).get('/api/sim/personas').expect(401);
  });

  test('returns array with the mike-garza row when authed via API key', async () => {
    const res = await request(app)
      .get('/api/sim/personas')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(Array.isArray(res.body.personas)).toBe(true);
    expect(res.body.personas).toHaveLength(1);
    expect(res.body.personas[0]).toMatchObject({
      id: 'mike-garza',
      displayName: 'Mike Garza',
      role: 'CNC shop owner, Mesa AZ',
      difficulties: ['easy', 'medium', 'hard'],
    });
  });

  test('public shape never leaks assistantEnvVars', async () => {
    const res = await request(app)
      .get('/api/sim/personas')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.personas[0].assistantEnvVars).toBeUndefined();
  });

  test('omits assistantInboundNumbers (Architecture B)', async () => {
    const res = await request(app)
      .get('/api/sim/personas')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.personas[0].assistantInboundNumbers).toBeUndefined();
  });

  test('rejects with 401 when x-api-key is wrong', async () => {
    await request(app)
      .get('/api/sim/personas')
      .set('x-api-key', 'wrong-key')
      .expect(401);
  });
});
