// jsec-gsx0: the parser that turns a Twilio `from` value into an identity we
// are willing to authorize on, plus the resolver that reads that value from the
// AUTHORITATIVE source (the REST Call resource) rather than the webhook body.
//
// The distinction is the whole point of this module: the body's `From` shares a
// namespace with client-supplied Device.connect params, so it looks right on
// every legitimate call and cannot be trusted. Everything downstream trusts
// this output, so its failure mode must be "return null", never "return
// something plausible".

const {
  parseClientIdentity, resolveCallerIdentity, LOOKUP_TIMEOUT_MS,
} = require('../twilio-caller-identity');

describe('parseClientIdentity', () => {
  test('recovers the identity from the shape production actually sends', () => {
    // Verified against 300 real calls on the account 2026-08-14: Voice SDK legs
    // carry client:<identity>, lowercase, e.g. client:tom / client:paul.
    expect(parseClientIdentity('client:tom')).toBe('tom');
    expect(parseClientIdentity('client:paul')).toBe('paul');
  });

  test('normalises case, because the comparison downstream is exact', () => {
    // The registry is canonically lowercase (001z). If Twilio ever echoed a
    // display-cased identity, a strict === against startedBy would silently
    // never match — a fail-open-shaped bug that returns a clean 403 forever.
    expect(parseClientIdentity('Client:Tom')).toBe('tom');
    expect(parseClientIdentity('CLIENT:PAUL')).toBe('paul');
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseClientIdentity('  client:tom  ')).toBe('tom');
    expect(parseClientIdentity('client: tom ')).toBe('tom');
  });

  test('a PSTN leg is NOT an identity — returns null, never the phone number', () => {
    // The dangerous failure would be returning '+16025551234' and letting it be
    // compared against startedBy. Refusing is correct: no phone number is a rep.
    expect(parseClientIdentity('+16025551234')).toBeNull();
    expect(parseClientIdentity('16025551234')).toBeNull();
  });

  test('returns null — never throws — for every junk shape', () => {
    for (const junk of [undefined, null, '', '   ', 42, {}, [], true, 'client:', 'client:   ']) {
      expect(parseClientIdentity(junk)).toBeNull();
    }
  });

  test('a name that merely CONTAINS client: is not accepted', () => {
    // Only a leading client: counts. Anything else is not the documented shape
    // and must not be coerced into one.
    expect(parseClientIdentity('sip:client:tom@example.com')).toBeNull();
    expect(parseClientIdentity('notclient:tom')).toBeNull();
  });

  test('an identity containing a colon survives intact', () => {
    // Only the FIRST client: prefix is stripped; the rest is the identity.
    expect(parseClientIdentity('client:tom:mobile')).toBe('tom:mobile');
  });
});

describe('resolveCallerIdentity — reads the AUTHORITATIVE source, fails closed', () => {
  const clientWith = (impl) => ({ calls: jest.fn(() => ({ fetch: impl })) });
  const SID = 'CA0000000000000000000000000000abcd';

  test('resolves the identity from the REST Call resource', async () => {
    const twilio = clientWith(jest.fn().mockResolvedValue({ from: 'client:tom' }));
    await expect(resolveCallerIdentity(twilio, SID)).resolves.toEqual({ identity: 'tom', error: null });
    expect(twilio.calls).toHaveBeenCalledWith(SID);
  });

  test('a Twilio API failure REFUSES rather than admitting an unverified caller', async () => {
    // Fail closed. This adds no new outage class — routes/call.js already needs
    // the Twilio REST API to dial the lead in, so a call cannot succeed without
    // it either way — but it must never fail OPEN.
    const twilio = clientWith(jest.fn().mockRejectedValue(new Error('503 Service Unavailable')));
    const out = await resolveCallerIdentity(twilio, SID);
    expect(out.identity).toBeNull();
    expect(out.error).toMatch(/lookup unavailable/);
    expect(out.infrastructure).toBe(true);
  });

  test('a PSTN leg resolves to no identity', async () => {
    const twilio = clientWith(jest.fn().mockResolvedValue({ from: '+16025551234' }));
    const out = await resolveCallerIdentity(twilio, SID);
    expect(out.identity).toBeNull();
    expect(out.error).toMatch(/not an identified Voice SDK client/);
  });

  test('a missing CallSid is refused without calling Twilio at all', async () => {
    const twilio = clientWith(jest.fn());
    for (const sid of [undefined, null, '', 42]) {
      const out = await resolveCallerIdentity(twilio, sid);
      expect(out.identity).toBeNull();
      expect(out.error).toMatch(/no usable CallSid/);
    }
    expect(twilio.calls).not.toHaveBeenCalled();
  });
});

describe('resolveCallerIdentity — the CallSid is still client-adjacent, so its SHAPE is enforced', () => {
  const clientWith = (impl) => ({ calls: jest.fn(() => ({ fetch: impl })) });
  const SID = 'CA0000000000000000000000000000abcd';

  test('SECURITY: duplicate CallSid params arrive as an ARRAY and are refused', () => {
    // `?CallSid=a&CallSid=b` parses to an array under express/qs extended:true
    // (server/index.js). This is the shape that saves us if Twilio ever sends
    // both its own CallSid and a client-supplied one — see the module header on
    // what is and is not proven about that. Pin it so the save is deliberate
    // rather than accidental.
    const twilio = clientWith(jest.fn());
    return resolveCallerIdentity(twilio, [SID, 'CA1111111111111111111111111111beef'])
      .then((out) => {
        expect(out.identity).toBeNull();
        expect(out.error).toMatch(/duplicate CallSid/);
        expect(twilio.calls).not.toHaveBeenCalled();
      });
  });

  test('a malformed CallSid never reaches the Twilio client', async () => {
    const twilio = clientWith(jest.fn());
    for (const bad of ['CA123', 'notasid', 'CA' + 'z'.repeat(32), `${SID} `]) {
      const out = await resolveCallerIdentity(twilio, bad);
      expect(out.identity).toBeNull();
    }
    expect(twilio.calls).not.toHaveBeenCalled();
  });

  test('a SLOW Twilio lookup is abandoned well inside the TwiML deadline', async () => {
    // twilio-node defaults to a 30s timeout and Twilio abandons a TwiML request
    // at ~15s, so an unbounded wait means our refusal never renders: the caller
    // gets a silently dropped call and no alert fires. The fail-closed path has
    // to be REACHABLE in the failure it exists for.
    const twilio = clientWith(jest.fn(() => new Promise(() => {})));  // never settles
    const started = Date.now();
    const out = await resolveCallerIdentity(twilio, SID, { timeoutMs: 40 });
    expect(out.identity).toBeNull();
    expect(out.error).toMatch(/timed out/);
    expect(out.infrastructure).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a 404 is reported as a possible setup race, not as infrastructure', async () => {
    // The operator reading the alert needs to tell "Twilio is unwell" from
    // "that call does not exist" — the second can be a benign race at setup.
    const err = Object.assign(new Error('not found'), { status: 404 });
    const twilio = clientWith(jest.fn().mockRejectedValue(err));
    const out = await resolveCallerIdentity(twilio, SID);
    expect(out.error).toMatch(/unknown call/);
    expect(out.infrastructure).toBe(false);
  });

  test('a 5xx is reported as infrastructure so its alerts can be collapsed', async () => {
    const err = Object.assign(new Error('bad gateway'), { status: 502 });
    const twilio = clientWith(jest.fn().mockRejectedValue(err));
    const out = await resolveCallerIdentity(twilio, SID);
    expect(out.infrastructure).toBe(true);
  });
});

describe('the production lookup budget, not just the mechanism (jsec-gsx0 P2)', () => {
  test('LOOKUP_TIMEOUT_MS sits well inside Twilio\'s ~15s TwiML deadline', () => {
    // The slow-lookup test passes an explicit timeoutMs, so it pins the
    // MECHANISM and never the shipped value — raising the constant to 30000
    // "to cut false refusals" would leave that test green while reinstating the
    // precise bug it was written to kill: twilio-node's 30s default outliving
    // Twilio's deadline, so the 403 and the Slack alert never render and the
    // caller just gets a dropped call. Pin the value itself.
    expect(LOOKUP_TIMEOUT_MS).toBeLessThan(15000);
    expect(LOOKUP_TIMEOUT_MS).toBeGreaterThan(500);   // not so tight it flaps
  });
});

describe('failure classification is by INCLUSION (jsec-gsx0 P3)', () => {
  const clientWith = (impl) => ({ calls: jest.fn(() => ({ fetch: impl })) });
  const SID = 'CA' + '0'.repeat(28) + 'abcd';
  const failWith = (status) => {
    const err = Object.assign(new Error(`HTTP ${status}`), { status });
    return resolveCallerIdentity(clientWith(jest.fn().mockRejectedValue(err)), SID);
  };

  test('SECURITY: a 429 is NOT infrastructure — an attacker must not be able to steer their own refusals onto the collapsed alert key', () => {
    // Every request to /api/voice now costs one Twilio REST call and the route
    // is unthrottled, so sustained probing can rate-limit the account itself.
    // Classifying by exclusion (`status !== 404`) made those 429s
    // "infrastructure", collapsing the attacker's refusals onto one alert that
    // states in words that it is not a probe. That is an alert-suppression
    // primitive handed to the exact adversary this change exists to stop.
    const out = await429();
    return out.then((r) => {
      expect(r.infrastructure).toBe(false);
      expect(r.error).toMatch(/lookup rejected \(HTTP 429\)/);
    });
  });

  test('a 5xx IS infrastructure', async () => {
    expect((await failWith(503)).infrastructure).toBe(true);
  });

  test('a transport error with no status IS infrastructure', async () => {
    const twilio = clientWith(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect((await resolveCallerIdentity(twilio, SID)).infrastructure).toBe(true);
  });

  test('a 404 stays its own case — a setup race, not infrastructure', async () => {
    const out = await failWith(404);
    expect(out.infrastructure).toBe(false);
    expect(out.error).toMatch(/unknown call/);
  });

  test('a 403 is not infrastructure either', async () => {
    expect((await failWith(403)).infrastructure).toBe(false);
  });

  function await429() { return failWith(429); }
});
