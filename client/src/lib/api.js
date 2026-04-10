const API_BASE = '/api';

async function apiFetch(path, options = {}) {
  const { signal, ...rest } = options;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    credentials: 'include',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
      ...rest.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res.json();
}

export function getToken(identity) {
  return apiFetch(`/token?identity=${encodeURIComponent(identity)}`);
}

export function initiateCall({ to, contactName, companyName, contactId, callerIdentity }) {
  return apiFetch('/call/initiate', {
    method: 'POST',
    body: JSON.stringify({ to, contactName, companyName, contactId, callerIdentity }),
  });
}

export function joinCall({ conferenceName, callerIdentity, muted }) {
  return apiFetch('/call/join', {
    method: 'POST',
    body: JSON.stringify({ conferenceName, callerIdentity, muted }),
  });
}

export function muteParticipant({ conferenceName, participantCallSid, muted }) {
  return apiFetch('/call/mute', {
    method: 'POST',
    body: JSON.stringify({ conferenceName, participantCallSid, muted }),
  });
}

export function getActiveCalls() {
  return apiFetch('/call/active');
}

export function endCall(conferenceName) {
  return apiFetch('/call/end', {
    method: 'POST',
    body: JSON.stringify({ conferenceName }),
  });
}

export function searchContacts(q, limit = 50) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', limit);
  return apiFetch(`/contacts?${params}`);
}

export function getSignalContacts({ signal_tier, geo_state, timezone, has_phone = true, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (signal_tier) params.set('signal_tier', signal_tier);
  if (timezone) params.set('timezone', timezone);
  else if (geo_state) params.set('geo_state', geo_state);
  if (!has_phone) params.set('has_phone', 'false');
  params.set('limit', limit);
  params.set('offset', offset);
  return apiFetch(`/contacts/signal?${params}`);
}

export function getSignalCallbacks() {
  return apiFetch('/signals/callbacks');
}

export function getContact(id) {
  return apiFetch(`/contacts/${id}`);
}

export function getCallHistory({ caller, disposition, limit = 25, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (caller) params.set('caller', caller);
  if (disposition) params.set('disposition', disposition);
  params.set('limit', limit);
  params.set('offset', offset);
  return apiFetch(`/history?${params}`);
}

export function getCallDetail(id) {
  return apiFetch(`/history/${id}`);
}

export function saveDisposition(callId, data) {
  return apiFetch(`/history/${callId}/disposition`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getCockpit(identifier, signal, { difficulty } = {}) {
  const params = difficulty ? `?difficulty=${difficulty}` : '';
  return apiFetch(`/cockpit/${encodeURIComponent(identifier)}${params}`, { signal });
}

export function refreshCockpit(identifier, signal, { difficulty } = {}) {
  const params = difficulty ? `?refresh=true&difficulty=${difficulty}` : '?refresh=true';
  return apiFetch(`/cockpit/${encodeURIComponent(identifier)}${params}`, { signal });
}

export function getScoreboard(signal) {
  return apiFetch('/scoreboard', { signal });
}

export function startPracticeCall(difficulty, mode = 'phone') {
  return apiFetch('/sim/call', {
    method: 'POST',
    body: JSON.stringify({ difficulty, mode }),
  });
}

export function getPracticeCallStatus(id, signal) {
  return apiFetch(`/sim/call/${id}/status`, { signal });
}

export function cancelPracticeCall(id) {
  return apiFetch(`/sim/call/${id}/cancel`, { method: 'POST' });
}

export function linkVapiCall(simCallId, vapiCallId) {
  return apiFetch(`/sim/call/${simCallId}/link-vapi`, {
    method: 'POST',
    body: JSON.stringify({ vapiCallId }),
  });
}

export function getSimListenUrl(simCallId) {
  return apiFetch(`/sim/call/${simCallId}/listen`);
}

export function getPracticeScores(identity) {
  return apiFetch(`/sim/scores/${encodeURIComponent(identity)}`);
}

export function getPracticeScoreboard(signal) {
  return apiFetch('/sim/scoreboard', { signal });
}

export function runTestScenario(chunks, delayMs = 800) {
  return apiFetch('/equipment/test-scenario', {
    method: 'POST',
    body: JSON.stringify({ chunks, delayMs }),
  });
}

// ── Call Summaries ───────────────────────────────────────────
export function getCallSummaries({ caller, q, limit = 20, offset = 0, signal } = {}) {
  const params = new URLSearchParams();
  if (caller) params.set('caller', caller);
  if (q) params.set('q', q);
  params.set('limit', limit);
  params.set('offset', offset);
  return apiFetch(`/summaries?${params}`, { signal });
}

export function getCallSummaryDetail(id, { signal } = {}) {
  return apiFetch(`/summaries/${id}`, { signal });
}

// ── Ask Nucleus ──────────────────────────────────────────────
// askNucleus uses raw fetch (NOT apiFetch) because the response is an SSE
// stream and apiFetch calls res.json() unconditionally. The caller reads
// the stream via response.body.getReader().
export function askNucleus({ message, conversationId, signal }) {
  return fetch(`${API_BASE}/ask`, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'X-Requested-With': 'fetch',
    },
    body: JSON.stringify({ message, conversationId: conversationId || null }),
  });
}

export function askNucleusEscalate({ question, context, company, contact, conversationId }) {
  return apiFetch('/ask/escalate', {
    method: 'POST',
    body: JSON.stringify({ question, context, company, contact, conversationId }),
  });
}

export function askNucleusGetConversation(id, { signal } = {}) {
  return apiFetch(`/ask/conversations/${id}`, { signal });
}

export function askNucleusListConversations({ signal } = {}) {
  return apiFetch('/ask/conversations', { signal });
}

export function askNucleusDeleteConversation(id) {
  return apiFetch(`/ask/conversations/${id}`, { method: 'DELETE' });
}
