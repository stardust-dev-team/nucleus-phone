// Tests for /api/voice/inbound-conference-join (Phase 2 of
// joruva-dialer-mac-axg / plan tender-stargazing-valley.md § Phase 2).
//
// This TwiML endpoint is fetched by Twilio AFTER iOS accepts the
// CallInvite for a REST-initiated `calls.create({ to: 'client:<id>?...' })`
// from incoming.js. The returned TwiML brings the iOS leg into the
// conference the caller is already in.
//
// customParameters are NOT delivered via this TwiML — they're attached
// to the `to:` query string on calls.create and packaged into the
// PushKit payload's `twi_params` (Twilio changelog 2020-09-15). This
// test file specifically asserts that the TwiML is structurally
// correct for conference joining, not for customParameter delivery.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

const request = require('supertest');
const express = require('express');

let app;
beforeAll(() => {
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/voice', require('../voice'));
});

describe('POST /api/voice/inbound-conference-join', () => {
  test('returns <Dial answerOnBridge><Conference endConferenceOnExit> with the requested name', async () => {
    const res = await request(app)
      .post('/api/voice/inbound-conference-join')
      .query({ conference: 'nucleus-inbound-ios-abc-123' })
      .expect(200);

    expect(res.text).toContain('<Dial');
    expect(res.text).toMatch(/answerOnBridge="true"/);
    expect(res.text).toContain('<Conference');
    expect(res.text).toContain('nucleus-inbound-ios-abc-123</Conference>');
    // endConferenceOnExit=true on the iOS rep leg: rep hangup ends the
    // conference, cleanly tearing down the caller leg. Asymmetric with
    // the caller leg's endConferenceOnExit=false (set in incoming.js)
    // which keeps voicemail-routing alive when the caller leaves.
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
    // startConferenceOnEnter=true so the iOS leg's join immediately
    // un-pauses hold music for the caller.
    expect(res.text).toMatch(/startConferenceOnEnter="true"/);
  });

  test('does NOT emit <Parameter> tags — customParameters travel via the to-query-string', async () => {
    // Pin the negative invariant: if a future refactor adds <Parameter>
    // here thinking it'll deliver customParameters to iOS, the iOS leg
    // would still NOT receive them (this TwiML runs post-accept). This
    // assertion makes the wrong path fail loudly.
    const res = await request(app)
      .post('/api/voice/inbound-conference-join')
      .query({ conference: 'nucleus-inbound-ios-pin' })
      .expect(200);

    expect(res.text).not.toContain('<Parameter');
  });

  test('rejects invalid conference names (path-traversal / TwiML injection)', async () => {
    const res = await request(app)
      .post('/api/voice/inbound-conference-join')
      .query({ conference: '../etc/passwd' })
      .expect(400);

    expect(res.text).toContain('<Say>Invalid conference name.</Say>');
    expect(res.text).toContain('<Hangup');
    expect(res.text).not.toContain('<Conference');
  });

  test('rejects empty conference name', async () => {
    const res = await request(app)
      .post('/api/voice/inbound-conference-join')
      .query({ conference: '' })
      .expect(400);

    expect(res.text).not.toContain('<Conference');
  });

  test('GET is not supported — Twilio always POSTs webhook URLs', async () => {
    await request(app)
      .get('/api/voice/inbound-conference-join')
      .query({ conference: 'nucleus-inbound-ios-get' })
      .expect(404);
  });
});
