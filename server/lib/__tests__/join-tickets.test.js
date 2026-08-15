// jsec-r0k6: unit coverage for the join-ticket store. The route-level tests
// prove the endpoints use it correctly; these pin the module's own promises,
// especially the ones that are load-bearing for security and easy to "simplify"
// away later.

const {
  issueJoinTicket, redeemJoinTicket, sweepExpiredTickets, _clearJoinTickets, TICKET_TTL_MS,
} = require('../join-tickets');

afterEach(() => {
  _clearJoinTickets();
  jest.restoreAllMocks();
});

describe('issueJoinTicket', () => {
  test('refuses to issue a ticket without a conference — a ticket to nowhere would resolve to undefined downstream', () => {
    expect(() => issueJoinTicket('', true, 'tom')).toThrow(/conferenceName is required/);
    expect(() => issueJoinTicket(undefined, true, 'tom')).toThrow(/conferenceName is required/);
  });

  test('every ticket is distinct, even for the same conference and flags', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(issueJoinTicket('conf-a', true, 'tom'));
    expect(seen.size).toBe(200);
  });

  test('the ticket does not embed the conference name it opens', () => {
    // A ticket that encoded its target would leak which call is live to anyone
    // who saw it, and would invite someone to "just decode it" downstream
    // instead of redeeming it.
    const ticket = issueJoinTicket('nucleus-call-very-distinctive-name', true, 'tom');
    expect(ticket).not.toContain('nucleus');
    expect(ticket).not.toContain('very-distinctive-name');
  });
});

describe('redeemJoinTicket', () => {
  test('resolves a live ticket to its conference and muted flag', () => {
    const ticket = issueJoinTicket('conf-a', true, 'tom');
    expect(redeemJoinTicket(ticket, 'tom')).toEqual({ conferenceName: 'conf-a', muted: true, identity: 'tom' });
  });

  test('muted is normalised to a boolean, so TwiML never receives a truthy string', () => {
    expect(redeemJoinTicket(issueJoinTicket('conf-a', 'false', 'tom'), 'tom').muted).toBe(true);
    expect(redeemJoinTicket(issueJoinTicket('conf-a', undefined, 'tom'), 'tom').muted).toBe(false);
  });

  test('returns null — never throws — for every junk input shape', () => {
    // The caller has exactly one branch to get right. Anything that could
    // throw here would land in voice.js's catch and emit generic error TwiML,
    // which is a worse failure than a clean refusal.
    //
    // HONEST NOTE: this test pins the CONTRACT, not the type guard that
    // appears to implement it. Map.get is total, so deleting that guard keeps
    // every case below green (verified by mutation, jsec-r0k6 M7). The guard's
    // justification is the documented future move to a shared store — see the
    // comment on it in join-tickets.js. Do not read this test as proof the
    // guard is load-bearing today.
    for (const junk of [undefined, null, '', 0, 42, {}, [], true, Symbol('x')]) {
      expect(redeemJoinTicket(junk, 'tom')).toBeNull();
    }
  });

  test('an unknown ticket is null', () => {
    issueJoinTicket('conf-a', true, 'tom');
    expect(redeemJoinTicket('some-other-ticket', 'tom')).toBeNull();
  });

  test('a ticket is dead the instant it reaches its TTL, and stays dead', () => {
    const ticket = issueJoinTicket('conf-a', true, 'tom');
    const start = Date.now();

    jest.spyOn(Date, 'now').mockReturnValue(start + TICKET_TTL_MS - 1);
    expect(redeemJoinTicket(ticket, 'tom')).not.toBeNull();

    // Boundary is >=, not >: a ticket must not survive its own expiry instant.
    jest.spyOn(Date, 'now').mockReturnValue(start + TICKET_TTL_MS);
    expect(redeemJoinTicket(ticket, 'tom')).toBeNull();

    // And redeeming past expiry must not resurrect it when the clock is
    // restored — expiry drops the entry.
    Date.now.mockRestore();
    expect(redeemJoinTicket(ticket, 'tom')).toBeNull();
  });

  test('DELIBERATE: a ticket is reusable inside its TTL — safe now that it is identity-bound', () => {
    // Reusability was the weak point pre-gsx0, because a ticket lifted from a
    // Twilio log worked for anyone. Now it only works for the identity it was
    // minted for, so replay by a different principal is impossible and reuse
    // costs nothing — the rightful owner's retry succeeds, nobody else's does.
    // If someone "hardens" this to single-use, this test is where they find out
    // why it isn't, and must justify the tradeoff rather than meet it in prod.
    const ticket = issueJoinTicket('conf-a', true, 'tom');
    expect(redeemJoinTicket(ticket, 'tom')).not.toBeNull();
    expect(redeemJoinTicket(ticket, 'tom')).not.toBeNull();
  });

  test('tickets are independent — redeeming one does not disturb another', () => {
    const a = issueJoinTicket('conf-a', true, 'tom');
    const b = issueJoinTicket('conf-b', false, 'tom');
    expect(redeemJoinTicket(a, 'tom').conferenceName).toBe('conf-a');
    expect(redeemJoinTicket(b, 'tom').conferenceName).toBe('conf-b');
  });
});

describe('identity binding (jsec-gsx0)', () => {
  test('SECURITY: a stolen ticket is useless to anyone but the caller it was issued to', () => {
    // The threat this closes: the ticket transits Twilio and sits in Call and
    // Debugger logs for its whole TTL. Pre-gsx0 anyone who read it there — plus
    // any device token, which every authenticated principal can mint for
    // themselves — could redeem it. Now possession is not enough.
    const ticket = issueJoinTicket('conf-a', true, 'tom');

    expect(redeemJoinTicket(ticket, 'blake')).toBeNull();
    expect(redeemJoinTicket(ticket, 'paul')).toBeNull();
    // ...and the rightful owner is unaffected by the failed attempts.
    expect(redeemJoinTicket(ticket, 'tom')).not.toBeNull();
  });

  test('refuses to mint an unbound ticket rather than silently degrading to bearer semantics', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}]) {
      expect(() => issueJoinTicket('conf-a', true, bad)).toThrow(/identity is required/);
    }
  });

  test('a missing caller identity at redeem is a refusal, not a wildcard', () => {
    // If voice.js ever failed to recover an identity and passed nothing, the
    // ticket must NOT open. Fail closed.
    const ticket = issueJoinTicket('conf-a', true, 'tom');
    for (const missing of [undefined, null, '', 42, {}]) {
      expect(redeemJoinTicket(ticket, missing)).toBeNull();
    }
  });

  test('the identity comparison is case-insensitive on both sides', () => {
    // Mint from a session identity, redeem from Twilio's From. Both are
    // canonically lowercase today; normalising both ends means a display-cased
    // value on either side cannot turn into a permanent silent 403.
    const ticket = issueJoinTicket('conf-a', true, 'Tom');
    expect(redeemJoinTicket(ticket, 'tom')).not.toBeNull();
    expect(redeemJoinTicket(ticket, 'TOM')).not.toBeNull();
  });

  test('the identity is exposed on the grant so the caller can be audited', () => {
    const ticket = issueJoinTicket('conf-a', false, 'paul');
    expect(redeemJoinTicket(ticket, 'paul')).toEqual({
      conferenceName: 'conf-a', muted: false, identity: 'paul',
    });
  });

  test('two callers holding tickets for the SAME conference cannot use each other\'s', () => {
    const tomTicket = issueJoinTicket('conf-shared', true, 'tom');
    const paulTicket = issueJoinTicket('conf-shared', true, 'paul');

    expect(redeemJoinTicket(tomTicket, 'paul')).toBeNull();
    expect(redeemJoinTicket(paulTicket, 'tom')).toBeNull();
    expect(redeemJoinTicket(tomTicket, 'tom').conferenceName).toBe('conf-shared');
    expect(redeemJoinTicket(paulTicket, 'paul').conferenceName).toBe('conf-shared');
  });
});

describe('sweepExpiredTickets', () => {
  test('drops only expired entries, so the map cannot grow without bound', () => {
    const start = Date.now();
    const stale = issueJoinTicket('conf-old', true, 'tom');

    jest.spyOn(Date, 'now').mockReturnValue(start + TICKET_TTL_MS + 1);
    const fresh = issueJoinTicket('conf-new', true, 'tom');

    expect(sweepExpiredTickets()).toBe(1);
    expect(redeemJoinTicket(stale, 'tom')).toBeNull();
    expect(redeemJoinTicket(fresh, 'tom')).not.toBeNull();
  });
});
