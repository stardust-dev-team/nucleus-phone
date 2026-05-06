// joruva-dialer-mac-xft: pure-function test for the Twilio Track →
// typed speaker mapping. The route as a whole has no unit-test coverage
// yet; this is the narrow slice that pins the contract iOS depends on.
const { mapSpeaker } = require('../transcription');

describe('mapSpeaker (joruva-dialer-mac-xft)', () => {
  test('outbound_track → agent (the rep speaking)', () => {
    expect(mapSpeaker('outbound_track')).toBe('agent');
  });

  test('inbound_track → customer (the lead speaking)', () => {
    expect(mapSpeaker('inbound_track')).toBe('customer');
  });

  test('both_tracks → unknown (diarization wasn’t set per-chunk)', () => {
    expect(mapSpeaker('both_tracks')).toBe('unknown');
  });

  test('undefined / missing → unknown (Twilio omits Track on some events)', () => {
    expect(mapSpeaker(undefined)).toBe('unknown');
    expect(mapSpeaker(null)).toBe('unknown');
    expect(mapSpeaker('')).toBe('unknown');
  });

  test('iOS TranscriptSpeaker enum values are exactly {agent, customer, unknown}', () => {
    // Pin: any return outside this set will throw DecodingError on iOS.
    // If Twilio adds a new Track variant, add a mapping above; do NOT
    // forward the raw value.
    const valid = new Set(['agent', 'customer', 'unknown']);
    for (const t of ['outbound_track', 'inbound_track', 'both_tracks', undefined, 'future_track_value']) {
      expect(valid.has(mapSpeaker(t))).toBe(true);
    }
  });
});
