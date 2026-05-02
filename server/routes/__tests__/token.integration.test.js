// zht.2 follow-up (Linus review): JWT-decode integration test for /api/token.
//
// The companion token.test.js mocks generateAccessToken and asserts the args
// it was called with — that proves the route forwards the flag, but it does
// NOT prove the issued JWT actually carries the incoming-call grant. A future
// refactor that ignored the param at the lib level (e.g., hardcoded
// incomingAllow:false in the VoiceGrant) would still pass those mocked tests.
//
// This file loads the real lib/twilio.js, hits the route, decodes the JWT
// with TWILIO_API_KEY_SECRET, and inspects the VoiceGrant payload.
//
// Twilio contract (node_modules/twilio/lib/jwt/AccessToken.js — VoiceGrant
// .toPayload): the `incoming` key is emitted ONLY when incomingAllow === true.
// When incomingAllow is false/undefined the key is OMITTED, not set to false.
// Tests assert key presence/absence, not boolean value — that is the actual
// wire contract Twilio honors.

// Twilio's client constructor runs at lib/twilio.js module load and rejects
// missing/malformed SIDs. Seed env BEFORE any require so the lib loads cleanly.
const HEX32 = 'a'.repeat(32);
process.env.TWILIO_ACCOUNT_SID = `AC${HEX32}`;
process.env.TWILIO_AUTH_TOKEN = `tok_${HEX32}`;
process.env.TWILIO_API_KEY_SID = `SK${HEX32}`;
process.env.TWILIO_API_KEY_SECRET = `secret_${HEX32}`;
process.env.TWILIO_TWIML_APP_SID = `AP${HEX32}`;
process.env.NUCLEUS_PHONE_API_KEY = 'test-api-key';

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../auth', () => ({
  isValidIdentity: jest.fn().mockResolvedValue(true),
}));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const express = require('express');
const { apiKeyAuth } = require('../../middleware/auth');
const { rbac } = require('../../middleware/rbac');

const API_KEY = 'test-api-key';

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/token', apiKeyAuth, rbac('external_caller'), require('../token'));
});

function decode(token) {
  // Twilio AccessToken signs HS256 with TWILIO_API_KEY_SECRET. jsonwebtoken
  // verifies signature + exp; we don't care about issuer/audience here.
  return jwt.verify(token, process.env.TWILIO_API_KEY_SECRET);
}

describe('GET /api/token (JWT integration)', () => {
  test('default mode → VoiceGrant has NO incoming key (PWA contract)', async () => {
    const res = await request(app)
      .get('/api/token?identity=tom')
      .set('x-api-key', API_KEY)
      .expect(200);

    const decoded = decode(res.body.token);
    const voiceGrant = decoded.grants.voice;

    expect(voiceGrant).toBeDefined();
    expect(voiceGrant.incoming).toBeUndefined();
    expect(voiceGrant.outgoing.application_sid).toBe(process.env.TWILIO_TWIML_APP_SID);
  });

  test('?mode=mobile → VoiceGrant has incoming.allow:true (iOS PushKit contract)', async () => {
    const res = await request(app)
      .get('/api/token?identity=tom&mode=mobile')
      .set('x-api-key', API_KEY)
      .expect(200);

    const decoded = decode(res.body.token);
    expect(decoded.grants.voice.incoming).toEqual({ allow: true });
  });

  test('?mode=desktop → VoiceGrant has NO incoming key (only "mobile" opts in)', async () => {
    const res = await request(app)
      .get('/api/token?identity=tom&mode=desktop')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(decode(res.body.token).grants.voice.incoming).toBeUndefined();
  });
});
