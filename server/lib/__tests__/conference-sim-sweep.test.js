// post-merge C1: the stale sweeper must not reap a practice call.
//
// registerSimConference creates `sim-<id>` with conferenceSid:null, and nothing
// ever sets one — a practice call is Vapi (WebRTC or outbound), not a Twilio
// conference, and conferenceSid is written only by the Twilio conference
// webhooks in routes/call.js. The no-SID arm of the sweeper therefore reaped
// every browser/phone sim ~5 minutes in. Once removal began notifying
// live-analysis (jsec-z4ff), that closed the cockpit socket with code 1000,
// which useLiveAnalysis treats as intentional and does not reconnect from — so
// transcript, equipment detections and the Navigator went silent MID-CALL with
// no error surfaced. Shipped and merged before anyone reviewed the fix that
// introduced it.

const {
  createConference, updateConference, removeConference, getConference,
  _sweepStaleForTest,
} = require('../conference');

const SIM = 'sim-4242';
const REAL = 'nucleus-call-real';

afterEach(() => { removeConference(SIM); removeConference(REAL); jest.restoreAllMocks(); });

function seed(name, extra) {
  createConference(name, { callerIdentity: 'kate', to: null, contactName: 'x', dbRowId: 1 });
  if (extra) updateConference(name, extra);
}

describe('stale sweep vs practice calls (post-merge C1)', () => {
  test('a sim with no conferenceSid SURVIVES the no-SID sweep', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    seed(SIM, { type: 'sim', direction: 'sim' });
    // 10 minutes on — well past STALE_NO_SID_MS (5 min).
    _sweepStaleForTest(Date.now() + 10 * 60 * 1000);
    expect(getConference(SIM)).toBeDefined();
  });

  test('a NON-sim with no conferenceSid is still reaped — the guard is scoped, not disabled', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    seed(REAL);
    _sweepStaleForTest(Date.now() + 10 * 60 * 1000);
    expect(getConference(REAL)).toBeUndefined();
  });

  test('a sim still has the 2h backstop — it is exempt from no-SID, not immortal', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    seed(SIM, { type: 'sim', direction: 'sim' });
    _sweepStaleForTest(Date.now() + 3 * 60 * 60 * 1000);
    expect(getConference(SIM)).toBeUndefined();
  });
});
