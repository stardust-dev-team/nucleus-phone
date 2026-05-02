// zht.2: ?mode=mobile flag wires generateAccessToken({ incomingAllow: true })
// for the native iOS dialer. PWA continues to call without the param (default
// incomingAllow:false). Tests stub generateAccessToken and assert the args
// passed through — the lib-level Twilio JWT encoding is not under test here.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/twilio', () => ({
  generateAccessToken: jest.fn(() => 'fake-jwt'),
}));
jest.mock('../auth', () => ({
  isValidIdentity: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const express = require('express');
const { generateAccessToken } = require('../../lib/twilio');
const { apiKeyAuth } = require('../../middleware/auth');
const { rbac } = require('../../middleware/rbac');

const API_KEY = 'test-api-key';

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  app = express();
  app.use(express.json());
  // Mount with apiKeyAuth so we can drive the test via x-api-key (synthetic
  // admin principal). The composer-precedence path is covered separately in
  // history.test.js.
  app.use('/api/token', apiKeyAuth, rbac('external_caller'), require('../token'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
});

beforeEach(() => {
  generateAccessToken.mockClear();
});

describe('GET /api/token', () => {
  test('default (no mode) → incomingAllow:false (PWA path unchanged)', async () => {
    const res = await request(app)
      .get('/api/token?identity=tom')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toEqual({ token: 'fake-jwt', identity: 'tom' });
    expect(generateAccessToken).toHaveBeenCalledWith('tom', { incomingAllow: false });
  });

  test('?mode=mobile → incomingAllow:true (iOS opt-in for TVOCallInvite)', async () => {
    await request(app)
      .get('/api/token?identity=tom&mode=mobile')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(generateAccessToken).toHaveBeenCalledWith('tom', { incomingAllow: true });
  });

  test('?mode=anything-else → incomingAllow:false (only "mobile" opts in)', async () => {
    await request(app)
      .get('/api/token?identity=tom&mode=desktop')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(generateAccessToken).toHaveBeenCalledWith('tom', { incomingAllow: false });
  });
});
