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
    participants: [],
  });
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

// Sweep stale conferences every 10 minutes (e.g. if conference-end webhook never fires)
const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours
setInterval(() => {
  const now = Date.now();
  for (const [name, conf] of activeConferences) {
    if (now - conf.startedAt.getTime() > STALE_MS) {
      console.warn(`Removing stale conference: ${name} (started ${conf.startedAt.toISOString()})`);
      activeConferences.delete(name);
    }
  }
}, 10 * 60 * 1000);

module.exports = {
  createConference,
  getConference,
  updateConference,
  removeConference,
  listActiveConferences,
};
