// In-memory conference state — ephemeral, only matters while calls are live.
// If Render restarts mid-call, this is lost. Acceptable at current volume.
const activeConferences = new Map();

function createConference(conferenceName, data) {
  activeConferences.set(conferenceName, {
    conferenceSid: null,
    startedAt: new Date(),
    startedBy: data.callerIdentity,
    leadPhone: data.to,
    leadName: data.contactName,
    leadCompany: data.companyName,
    contactId: data.contactId,
    dbRowId: data.dbRowId,
    direction: data.direction || 'outbound',
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

function removeConference(conferenceName) {
  activeConferences.delete(conferenceName);
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
    }
  }
}, 2 * 60 * 1000);
sweepInterval.unref();

module.exports = {
  createConference,
  getConference,
  updateConference,
  removeConference,
  listActiveConferences,
  claimLeadDial,
};
