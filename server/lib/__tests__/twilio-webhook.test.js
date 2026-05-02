// Verifies the lazy-eval contract: NODE_ENV is read on every request, not
// frozen at module-load. The earlier per-route `twilio.webhook({ validate:
// process.env.NODE_ENV === 'production' })` pattern would have failed this
// test — toggling NODE_ENV between calls had no effect because the validate
// flag was captured once at require time. d74 closure depended on this.

const request = require('supertest');
const express = require('express');
const { makeTwilioWebhook } = require('../twilio-webhook');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/hook', makeTwilioWebhook('/hook'), (_req, res) => res.sendStatus(204));
  return app;
}

describe('makeTwilioWebhook lazy NODE_ENV evaluation', () => {
  const originalEnv = process.env.NODE_ENV;
  afterAll(() => { process.env.NODE_ENV = originalEnv; });

  test('NODE_ENV=test: passes through (no signature required)', async () => {
    process.env.NODE_ENV = 'test';
    await request(makeApp()).post('/hook').send({}).expect(204);
  });

  test('NODE_ENV=production: 400 without X-Twilio-Signature', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(makeApp()).post('/hook').send({});
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/X-Twilio-Signature/);
  });

  test('NODE_ENV toggled between requests on a SHARED app: each request sees current env', async () => {
    // Critical: same Express app, same middleware closure, env flips between
    // calls. Old eager-eval pattern would freeze whichever value was first
    // and ignore the second toggle — exactly the d74 footgun.
    const app = makeApp();
    process.env.NODE_ENV = 'test';
    await request(app).post('/hook').send({}).expect(204);
    process.env.NODE_ENV = 'production';
    const blocked = await request(app).post('/hook').send({});
    expect(blocked.status).toBe(400);
    process.env.NODE_ENV = 'test';
    await request(app).post('/hook').send({}).expect(204);
  });
});
