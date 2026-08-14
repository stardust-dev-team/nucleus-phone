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
//   What bounds the risk today is the TTL, and the fact that reading a ticket
//   requires either the authorized user's browser (in which case you have their
//   session anyway) or read access to the Twilio console. The latter is a real
//   if narrow replay window, and the clean fix is to bind the ticket to the
//   authorized identity and check it against the `From: client:<identity>` that
//   Twilio derives from the access token rather than from client params. That
//   is NOT done here because this session could not verify the shape of `From`
//   against a real call — the Twilio API probe was blocked, and shipping a
//   guard on an unverified parameter shape is the exact mistake that left the
//   jsec-vr1s guards dead for two months. Tracked as a follow-up bead.
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

/** ticket (string) -> { conferenceName, muted, expiresAt } */
const tickets = new Map();

/**
 * Authorize one join. Call ONLY after the caller has been checked against the
 * conference — this function asserts nothing about who is asking.
 *
 * @param {string} conferenceName the conference the bearer may enter
 * @param {boolean} muted whether the bearer enters muted
 * @returns {string} the opaque ticket to hand to the client
 */
function issueJoinTicket(conferenceName, muted) {
  if (typeof conferenceName !== 'string' || !conferenceName) {
    throw new Error('issueJoinTicket: conferenceName is required');
  }
  // 32 bytes from the CSPRNG: not guessable, and not derived from the
  // conference name, so a ticket leaks nothing about what it opens.
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    conferenceName,
    muted: !!muted,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return ticket;
}

/**
 * Resolve a ticket to the join it authorizes.
 *
 * Returns null for every failure — absent, wrong type, unknown, expired — so
 * the caller has exactly one branch to get right, and a bug in this function
 * fails CLOSED (no conference to join) rather than open.
 *
 * @param {unknown} ticket
 * @returns {{conferenceName: string, muted: boolean}|null}
 */
function redeemJoinTicket(ticket) {
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
  return { conferenceName: entry.conferenceName, muted: entry.muted };
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
