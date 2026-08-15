// jsec-r0k6: server-minted tickets that authorize joins of ONE conference for a
// short window. Not one join — see the reusability note below; saying "one"
// here would overstate the guarantee to anyone who reads only the first line.
//
// WHY A TICKET AND NOT A GUARD ON THE JOIN BRANCH
//
// voice.js's `Action === 'join'` branch used to build conference TwiML from a
// client-supplied `ConferenceName`. That request arrives from Twilio, not from
// the browser, so it carries no session and no `req.user` — there is nothing on
// it to check an ownership guard against. Any authenticated principal could mint
// a device token for their OWN identity and then `Device.connect({Action:'join',
// ConferenceName:'<someone else's>'})`, landing silently in another rep's live
// customer call. The `POST /api/call/join` preflight was not a defense: it
// returns JSON, touches no Twilio, and an attacker simply skips it.
//
// The fix removes the untrusted input rather than guarding it. The preflight —
// which DOES have a session, and therefore a role and an identity — performs the
// authorization and mints an opaque ticket. voice.js resolves the ticket to a
// conference name it never accepted from the caller. A forged or absent ticket
// resolves to nothing, so the join branch has no conference to put the caller
// into. There is no name for an attacker to substitute.
//
// DELIBERATE DESIGN CHOICES (each one is a question a reviewer should ask):
//
// * NOT single-use — and the honest reason is weaker than it first looks. The
//   original justification here was "Twilio retries the webhook with the same
//   parameters". That is documented for STATUS CALLBACKS; for a TwiML URL the
//   documented recovery path is the Fallback URL, a different URL, so a retry
//   of this request with an identical ticket may never happen. Reusability is
//   therefore cheap insurance against a retry we have not proven exists, not a
//   requirement we have measured.
//
//   Reusability used to be the weak point, because a ticket lifted from a
//   Twilio log was usable by anyone. jsec-gsx0 closed that: the ticket is now
//   BOUND TO AN IDENTITY and redeemJoinTicket refuses unless the caller
//   recovered from Twilio's `From` matches. Replay by a different principal is
//   impossible, so reusability costs nothing — a retry by the rightful owner
//   works, and nobody else's does.
//
//   `From` is safe to authorize on because Twilio derives it from the ACCESS
//   TOKEN, not from client-supplied params, and routes/token.js mints tokens
//   bound to req.user.identity. Verified empirically before being relied on —
//   see lib/twilio-caller-identity.js for the evidence and why that mattered.
//
// * Short TTL. The only legitimate gap between mint and redeem is one client
//   round-trip plus Twilio's inbound webhook — sub-second in practice. Two
//   minutes is generous slack for a slow network, not a window worth attacking.
//
// * In-memory, like lib/conference.js. A restart that loses tickets has already
//   lost the conferences they point at, so the two fail together. They do NOT
//   expire together, though: a call that ends normally calls removeConference
//   while a ticket minted seconds earlier is still live, so a ticket CAN name a
//   conference that no longer exists. voice.js re-checks getConference at
//   redeem time for exactly that reason. Render runs this service at
//   numInstances=1 (verified
//   2026-08-14); if it is ever scaled out, THIS MODULE AND lib/conference.js
//   BOTH need a shared store — a preflight on instance A and a Twilio webhook on
//   instance B would not see each other.
//
// * `muted` rides the ticket. It decides whether the joiner enters with an open
//   mic, so it is an authorization output, not a client preference. This does
//   not stop a joiner from unmuting via the Voice SDK afterwards (nothing
//   server-side can) — it stops the TwiML itself from being shaped by an
//   unauthenticated request body.
const crypto = require('node:crypto');

const TICKET_TTL_MS = 2 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

/** ticket (string) -> { conferenceName, muted, identity, expiresAt } */
const tickets = new Map();

/**
 * Authorize one join. Call ONLY after the caller has been checked against the
 * conference — this function asserts nothing about whether they SHOULD be
 * allowed, only about who the resulting ticket will work for.
 *
 * @param {string} conferenceName the conference the bearer may enter
 * @param {boolean} muted whether the bearer enters muted
 * @param {string} identity the caller the ticket is issued to. Required
 *   (jsec-gsx0): a ticket that works for anyone who holds it is a bearer token,
 *   and this one transits Twilio and lands in Call/Debugger logs for its whole
 *   TTL. Binding it means possession is not enough — you must also be the person
 *   it was minted for, which is checked against Twilio's `From`.
 * @returns {string} the opaque ticket to hand to the client
 */
function issueJoinTicket(conferenceName, muted, identity) {
  if (typeof conferenceName !== 'string' || !conferenceName) {
    throw new Error('issueJoinTicket: conferenceName is required');
  }
  if (typeof identity !== 'string' || !identity.trim()) {
    // Throw rather than mint an unbound ticket. An identity-less ticket would
    // silently degrade to the pre-gsx0 bearer semantics, and a silently weaker
    // guard is exactly the jsec-vr1s failure mode.
    throw new Error('issueJoinTicket: identity is required');
  }
  // 32 bytes from the CSPRNG: not guessable, and not derived from the
  // conference name, so a ticket leaks nothing about what it opens.
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    conferenceName,
    muted: !!muted,
    // Lowercase at the boundary, the way routes/call.js does (001z) — the
    // registry is canonically lowercase and both sides of the later comparison
    // must be normalised the same way or the check silently never matches.
    identity: identity.trim().toLowerCase(),
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return ticket;
}

/**
 * Resolve a ticket to the join it authorizes, FOR A SPECIFIC CALLER.
 *
 * The caller identity is a required argument rather than a field on the return
 * value on purpose: if the comparison lived at the call site, forgetting it
 * would compile, pass every "valid ticket works" test, and quietly restore
 * bearer semantics. Making it impossible to redeem without naming who is
 * redeeming is the point.
 *
 * Returns null for every failure — absent, wrong type, unknown, expired, or
 * issued to somebody else — so the caller has exactly one branch to get right
 * and a bug in this function fails CLOSED.
 *
 * @param {unknown} ticket
 * @param {unknown} callerIdentity identity recovered from Twilio's `From`
 * @returns {{conferenceName: string, muted: boolean, identity: string}|null}
 */
function redeemJoinTicket(ticket, callerIdentity) {
  // Redundant while the store is a Map (Map.get is total) — kept as an explicit
  // boundary check so a future shared store, which may not be, cannot silently
  // change what a junk ticket does.
  if (typeof ticket !== 'string' || !ticket) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    tickets.delete(ticket);
    return null;
  }
  // jsec-gsx0: possession is not authorization. The ticket names the caller it
  // was minted for, and `callerIdentity` comes from Twilio's `From`, which is
  // derived from the access token rather than from anything the client sent
  // (see lib/twilio-caller-identity.js). A ticket lifted from a Twilio log is
  // therefore useless to anyone but its owner.
  if (typeof callerIdentity !== 'string' || !callerIdentity) return null;
  if (callerIdentity.trim().toLowerCase() !== entry.identity) return null;

  return { conferenceName: entry.conferenceName, muted: entry.muted, identity: entry.identity };
}

/** Drop expired tickets so the map cannot grow without bound. */
function sweepExpiredTickets() {
  const now = Date.now();
  let removed = 0;
  for (const [ticket, entry] of tickets) {
    if (now >= entry.expiresAt) {
      tickets.delete(ticket);
      removed += 1;
    }
  }
  return removed;
}

const sweepInterval = setInterval(sweepExpiredTickets, SWEEP_INTERVAL_MS);
// Same as lib/conference.js: never hold the event loop open for this.
sweepInterval.unref();

/** Test seam — drop all tickets. Not used by production code. */
function _clearJoinTickets() {
  tickets.clear();
}

module.exports = {
  issueJoinTicket,
  redeemJoinTicket,
  sweepExpiredTickets,
  _clearJoinTickets,
  TICKET_TTL_MS,
};
