// In-memory conference state — ephemeral, only matters while calls are live.
// If Render restarts mid-call, this is lost. Acceptable at current volume.
const activeConferences = new Map();

function createConference(conferenceName, data) {
  // Every conference has an owner. Refuse to store one without: a silently
  // undefined owner is how the ownership guards were dead for months
  // (jsec-vr1s) — with fail-closed guards it would now mean an admin-only
  // conference nobody intended. All callsites already pass an identity.
  if (typeof data.callerIdentity !== 'string' || !data.callerIdentity) {
    throw new Error(`createConference(${conferenceName}): callerIdentity is required`);
  }
  activeConferences.set(conferenceName, {
    conferenceSid: null,
    startedAt: new Date(),
    // startedBy is the ONLY owner field a conference carries. Consumers must
    // read conf.startedBy — a `conf.callerIdentity` read is always undefined
    // and silently disabled every ownership guard for months (jsec-vr1s).
    startedBy: data.callerIdentity,
    leadPhone: data.to,
    leadName: data.contactName,
    leadCompany: data.companyName,
    contactId: data.contactId,
    dbRowId: data.dbRowId,
    direction: data.direction || 'outbound',
    repSlackDm: data.repSlackDm || '',
    repName: data.repName || '',
    participants: [],
    leadDialed: false,
  });
}

// Single-tick claim: safe in Node.js because check-and-set runs synchronously
// within one event loop tick. Returns true only for the first caller.
function claimLeadDial(conferenceName) {
  const conf = activeConferences.get(conferenceName);
  if (!conf || conf.leadDialed) return false;
  conf.leadDialed = true;
  return true;
}

function getConference(conferenceName) {
  return activeConferences.get(conferenceName);
}

function updateConference(conferenceName, updates) {
  const conf = activeConferences.get(conferenceName);
  if (conf) {
    Object.assign(conf, updates);
  }
}

// jsec-z4ff: observers notified whenever a conference leaves the store.
//
// The dependency points THIS way on purpose: live-analysis.js requires this
// module (to authorize subscriptions against conf.startedBy), so this module
// must not require live-analysis back. A listener list inverts it cleanly.
//
// Why it is needed: subscriptions used to survive a conference's removal
// harmlessly, because broadcast() never re-authorizes. Now that `subscribe`
// refuses an unknown conference, and useLiveAnalysis re-sends `subscribe` on
// every socket reconnect, any network blip after a removal would permanently
// blank a cockpit that is still on a live call. Three removal paths never
// cleaned up their listeners (the stale sweeper below, the poll-fallback
// give-up in routes/call.js, and the sim close-out) — routing every removal
// through one notification covers all of them at once, present and future.
const removalListeners = [];

/** Register a callback invoked with the conference name on every removal. */
function onConferenceRemoved(fn) {
  removalListeners.push(fn);
}

function notifyRemoved(conferenceName) {
  for (const fn of removalListeners) {
    try {
      fn(conferenceName);
    } catch (err) {
      // A misbehaving observer must never block teardown.
      console.error(`conference: removal listener failed for ${conferenceName}:`, err.message);
    }
  }
}

function removeConference(conferenceName) {
  if (activeConferences.delete(conferenceName)) notifyRemoved(conferenceName);
}

function listActiveConferences() {
  const result = [];
  for (const [name, conf] of activeConferences) {
    result.push({ conferenceName: name, ...conf });
  }
  return result;
}

// Sweep stale conferences every 2 minutes.
// A conference that never got a SID within 5 min is dead (webhook failed).
// A conference older than 2 hours with no participants is abandoned.
const STALE_NO_SID_MS = 5 * 60 * 1000;
const STALE_MAX_MS = 2 * 60 * 60 * 1000;
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [name, conf] of activeConferences) {
    const age = now - conf.startedAt.getTime();
    const noSid = !conf.conferenceSid && age > STALE_NO_SID_MS;
    const tooOld = age > STALE_MAX_MS;
    if (noSid || tooOld) {
      console.warn(`Removing stale conference: ${name} (age=${Math.round(age / 1000)}s, sid=${!!conf.conferenceSid})`);
      activeConferences.delete(name);
      notifyRemoved(name);
    }
  }
}, 2 * 60 * 1000);
sweepInterval.unref();

module.exports = {
  onConferenceRemoved,
  createConference,
  getConference,
  updateConference,
  removeConference,
  listActiveConferences,
  claimLeadDial,
};
