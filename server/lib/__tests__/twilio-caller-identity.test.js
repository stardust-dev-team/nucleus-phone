// jsec-gsx0: the parser that turns a Twilio `from` value into an identity we
// are willing to authorize on, plus the resolver that reads that value from the
// AUTHORITATIVE source (the REST Call resource) rather than the webhook body.
//
// The distinction is the whole point of this module: the body's `From` shares a
// namespace with client-supplied Device.connect params, so it looks right on
// every legitimate call and cannot be trusted. Everything downstream trusts
// this output, so its failure mode must be "return null", never "return
// something plausible".

const { parseClientIdentity, resolveCallerIdentity } = require('../twilio-caller-identity');

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
