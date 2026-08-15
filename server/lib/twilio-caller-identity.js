// jsec-gsx0: parse a Twilio `from` value into a caller identity we are willing
// to authorize on.
//
// READ THIS BEFORE CHANGING WHERE THE INPUT COMES FROM.
//
// This function only PARSES. Everything about whether the result can be trusted
// lives in the caller's choice of input, and that distinction cost a review
// round, so it is spelled out:
//
//   TRUSTWORTHY  — `from` off the REST Call resource
//                  (`client.calls(CallSid).fetch().from`). Twilio populates it
//                  from the ACCESS TOKEN the leg connected with, and no client
//                  can write it. routes/voice.js uses this.
//
//   NOT TRUSTWORTHY — `req.body.From` on the TwiML webhook. It LOOKS identical,
//                  and on every legitimate call it IS identical, which is
//                  exactly the trap. `Device.connect({params})` places
//                  client-supplied keys into the same flat POST body, and
//                  Twilio's own SDK documentation warns: "Your application
//                  should not assume that these parameters are safe since any
//                  user can call this function with whatever parameters they
//                  want." Whether a custom `From` overrides the standard one is
//                  undocumented — so we do not depend on the answer.
//
// The first version of this change read the body param and justified it with a
// survey of 300 production Calls showing `from=client:tom|paul`. That evidence
// was real but proved the wrong property: what `From` LOOKS LIKE on legitimate
// traffic, not whether a caller can SET it. Verifying the shape and assuming the
// provenance is the jsec-vr1s mistake one level up. The REST resource removes
// the question rather than answering it.
//
// ⚠ WHAT IS STILL NOT PROVEN — read before you lean on this for anything new.
// The VALUE now comes from an authoritative source, but the LOOKUP KEY
// (`req.body.CallSid`) still comes from the same body as the client's
// Device.connect params. Whether a custom `CallSid` param can SHADOW Twilio's
// standard one is undocumented and was not established here; the Voice SDK
// encodes custom params into one blob that Twilio expands server-side, so it
// cannot be answered from the client source either. Consequences, stated
// plainly rather than hedged:
//
//   * If Twilio sends BOTH, express/qs (`extended: true`) yields an ARRAY and
//     resolveCallerIdentity refuses it — so that case fails closed, and the
//     CALL_SID_RE check below is what makes that reliable rather than lucky.
//   * If Twilio lets a custom value SUPPRESS the standard one, an attacker who
//     already knows a victim's CallSid could present it and be resolved as the
//     victim. Note who that attacker is: the CallSid is printed at the top of
//     the same Twilio Call log page that would leak a JoinTicket, so it is the
//     SAME adversary the identity binding was written to stop. Against them the
//     binding may be decorative.
//
// This is shipped anyway because the check is MONOTONIC — it only ever adds a
// reason to refuse, never a reason to admit — so it cannot make any path weaker
// than it was before. What it must NOT be treated as is a proven guard. The
// checks that hold the line independently of this question are the join TICKET
// (unguessable, minted only after an authorization check) and the conferenceSid
// lifecycle invariant in routes/voice.js. Probing the shadowing behavior is
// tracked as its own bead; resolve it before anything NEW depends on caller
// identity here.
//
// What the 300-call survey DID establish, and what this parser encodes: Voice
// SDK legs carry `client:<identity>` (70 of 300; the other 230 were PSTN legs
// with an E.164 `from`), and the identities are lowercase — observed values were
// exactly ["client:tom", "client:paul"], on the production Twilio account,
// 2026-08-14. (The account SID is deliberately not quoted here — GitHub push
// protection classifies it as a secret and rejected the first push over it. It
// lives in the Render service env; Doppler holds the API key and auth token.)
//
// LOWERCASE: the identity registry is canonically lowercase ('paul', not 'Paul')
// and routes/call.js canonicalizes at the trust boundary for that reason (001z,
// commit 7774bac). The observed values already are lowercase; we lowercase again
// rather than depend on Twilio to keep doing so.

const CLIENT_PREFIX = 'client:';

// Twilio Call SIDs are 'CA' + 32 hex. Pinning the shape keeps a malformed or
// array-valued CallSid from ever reaching the REST client.
//
// Case-INSENSITIVE deliberately, though every SID Twilio has ever emitted is
// lowercase: this is a shape check guarding the REST client, not an identity
// check, and an uppercased SID simply 404s and fails closed one step later.
// Accepting it here costs nothing and avoids a refusal whose cause would be
// invisible if Twilio's casing ever drifted.
const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;

// Budget for the Call lookup. Deliberately far below Twilio's ~15s TwiML
// deadline so the refusal path still renders. See resolveCallerIdentity.
const LOOKUP_TIMEOUT_MS = 3000;

function describeShape(value) {
  if (Array.isArray(value)) return 'an array — duplicate CallSid params';
  if (value === undefined || value === null) return 'nothing';
  return typeof value === 'string' ? 'a malformed string' : typeof value;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {unknown} from a Twilio `from` value. Pass the one off the REST Call
 *   resource, NOT req.body.From — see the header.
 * @returns {string|null} the lowercased client identity, or null if this leg is
 *   not an identified Voice SDK client (PSTN leg, absent, or malformed).
 *
 * Returns null rather than throwing, and callers MUST treat null as "refuse".
 * Every failure shape collapses to one value so a caller has a single branch to
 * get right, and so a bug here fails closed.
 */
function parseClientIdentity(from) {
  if (typeof from !== 'string') return null;
  // Lowercase ONCE and slice the lowercased copy. toLowerCase() is not
  // length-preserving in Unicode ('İ' lowercases to two code units), so testing
  // the prefix on one string and slicing the other is a latent index bug.
  const normalised = from.trim().toLowerCase();
  if (!normalised.startsWith(CLIENT_PREFIX)) return null;
  const identity = normalised.slice(CLIENT_PREFIX.length).trim();
  return identity || null;
}

/**
 * Resolve the caller identity for a leg from its AUTHORITATIVE source: the REST
 * Call resource. Twilio sets `from` there from the access token, and nothing a
 * client sends can change it.
 *
 * Fails CLOSED — returns null on a missing CallSid, an API error, or a `from`
 * that is not a client identity. That means a Twilio API outage refuses
 * conference entry rather than admitting an unverified caller. This adds no NEW
 * outage class: routes/call.js already needs the Twilio REST API to dial the
 * lead into the conference, so a call cannot succeed without it either way.
 *
 * @param {object} twilioClient the twilio SDK client (injected for testability)
 * @param {unknown} callSid
 * @returns {Promise<{identity: string|null, error: string|null}>}
 */
async function resolveCallerIdentity(twilioClient, callSid, { timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  // Shape-check the SID before spending a round-trip on it. This ALSO fails
  // closed on the express/qs array shape: `?CallSid=a&CallSid=b` parses to an
  // ARRAY under `extended: true` (server/index.js), and an array is not a
  // string. See the header's note on what is and is not verified about the
  // CallSid's provenance — this check is why a duplicate cannot slip through.
  if (typeof callSid !== 'string' || !CALL_SID_RE.test(callSid)) {
    return { identity: null, error: `no usable CallSid on the request (got ${describeShape(callSid)})` };
  }
  try {
    // BOUND THE WAIT. twilio-node defaults to a 30s request timeout
    // (lib/base/RequestClient.js DEFAULT_TIMEOUT) and lib/twilio.js passes
    // none, but Twilio abandons a TwiML request at ~15s. Unbounded, a SLOW
    // Twilio API — the common degradation, and the one correlated with
    // everything else being on fire — means this handler is still blocked when
    // Twilio gives up: the caller gets a silently dropped call with a generic
    // 11200, our 403 never renders, and the Slack alert never fires. In other
    // words the fail-closed path would be unreachable in precisely the failure
    // it exists for. A short budget makes the refusal actually happen.
    const call = await withTimeout(twilioClient.calls(callSid).fetch(), timeoutMs);
    const identity = parseClientIdentity(call && call.from);
    return identity
      ? { identity, error: null }
      : { identity: null, error: `leg is not an identified Voice SDK client (from=${call && call.from ? String(call.from).slice(0, 24) : 'absent'})` };
  } catch (err) {
    // Distinguish "we could not ask" from "Twilio says no such call". The first
    // is an infrastructure problem and the second can be a genuine race at call
    // setup; an operator reading the alert needs to tell them apart rather than
    // see every one labelled as probing.
    const status = err && err.status;
    // Classify by INCLUSION, not by exclusion. The first cut said
    // `infrastructure: status !== 404`, which quietly made every non-404 an
    // "infrastructure failure" — including 4xx. That is an alert-suppression
    // primitive, and a reachable one: every request to this route now costs one
    // Twilio REST call, the route is unthrottled, so an attacker's own probing
    // volume can rate-limit the account into 429s. Their continued probing
    // would then collapse onto the single global alert key under a banner
    // stating, in words, that it is not a probe.
    //
    // Only "we could not reach Twilio" is infrastructure: a transport error
    // with no status, or a 5xx. A 4xx means Twilio answered and rejected us,
    // which stays on the per-conference key where a burst remains visible.
    const isInfrastructure = !status || status >= 500;
    const kind = status === 404
      ? 'unknown call (possible setup race)'
      : (isInfrastructure ? 'lookup unavailable' : `lookup rejected (HTTP ${status})`);
    return { identity: null, error: `${kind}: ${err.message}`, infrastructure: isInfrastructure };
  }
}

module.exports = { parseClientIdentity, resolveCallerIdentity, LOOKUP_TIMEOUT_MS, CALL_SID_RE };
