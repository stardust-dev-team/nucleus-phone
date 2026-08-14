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
    expect(() => issueJoinTicket('', true)).toThrow(/conferenceName is required/);
    expect(() => issueJoinTicket(undefined, true)).toThrow(/conferenceName is required/);
  });

  test('every ticket is distinct, even for the same conference and flags', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(issueJoinTicket('conf-a', true));
    expect(seen.size).toBe(200);
  });

  test('the ticket does not embed the conference name it opens', () => {
    // A ticket that encoded its target would leak which call is live to anyone
    // who saw it, and would invite someone to "just decode it" downstream
    // instead of redeeming it.
    const ticket = issueJoinTicket('nucleus-call-very-distinctive-name', true);
    expect(ticket).not.toContain('nucleus');
    expect(ticket).not.toContain('very-distinctive-name');
  });
});

describe('redeemJoinTicket', () => {
  test('resolves a live ticket to its conference and muted flag', () => {
    const ticket = issueJoinTicket('conf-a', true);
    expect(redeemJoinTicket(ticket)).toEqual({ conferenceName: 'conf-a', muted: true });
  });

  test('muted is normalised to a boolean, so TwiML never receives a truthy string', () => {
    expect(redeemJoinTicket(issueJoinTicket('conf-a', 'false')).muted).toBe(true);
    expect(redeemJoinTicket(issueJoinTicket('conf-a', undefined)).muted).toBe(false);
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
      expect(redeemJoinTicket(junk)).toBeNull();
    }
  });

  test('an unknown ticket is null', () => {
    issueJoinTicket('conf-a', true);
    expect(redeemJoinTicket('some-other-ticket')).toBeNull();
  });

  test('a ticket is dead the instant it reaches its TTL, and stays dead', () => {
    const ticket = issueJoinTicket('conf-a', true);
    const start = Date.now();

    jest.spyOn(Date, 'now').mockReturnValue(start + TICKET_TTL_MS - 1);
    expect(redeemJoinTicket(ticket)).not.toBeNull();

    // Boundary is >=, not >: a ticket must not survive its own expiry instant.
    jest.spyOn(Date, 'now').mockReturnValue(start + TICKET_TTL_MS);
    expect(redeemJoinTicket(ticket)).toBeNull();

    // And redeeming past expiry must not resurrect it when the clock is
    // restored — expiry drops the entry.
    Date.now.mockRestore();
    expect(redeemJoinTicket(ticket)).toBeNull();
  });

  test('DELIBERATE: a ticket is reusable inside its TTL, because Twilio retries webhooks', () => {
    // Twilio re-sends a webhook that 5xx'd or timed out with identical
    // parameters. A single-use ticket would reject the retry and drop a
    // legitimate join. If someone "hardens" this to single-use, this test is
    // where they find out why it isn't — and must justify the tradeoff rather
    // than discover it in production.
    const ticket = issueJoinTicket('conf-a', true);
    expect(redeemJoinTicket(ticket)).not.toBeNull();
    expect(redeemJoinTicket(ticket)).not.toBeNull();
  });

  test('tickets are independent — redeeming one does not disturb another', () => {
    const a = issueJoinTicket('conf-a', true);
    const b = issueJoinTicket('conf-b', false);
    expect(redeemJoinTicket(a).conferenceName).toBe('conf-a');
    expect(redeemJoinTicket(b).conferenceName).toBe('conf-b');
  });
});

describe('sweepExpiredTickets', () => {
  test('drops only expired entries, so the map cannot grow without bound', () => {
    const start = Date.now();
    const stale = issueJoinTicket('conf-old', true);

    jest.spyOn(Date, 'now').mockReturnValue(start + TICKET_TTL_MS + 1);
    const fresh = issueJoinTicket('conf-new', true);

    expect(sweepExpiredTickets()).toBe(1);
    expect(redeemJoinTicket(stale)).toBeNull();
    expect(redeemJoinTicket(fresh)).not.toBeNull();
  });
});
