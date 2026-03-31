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

export function getCockpit(identifier, signal) {
  return apiFetch(`/cockpit/${encodeURIComponent(identifier)}`, { signal });
}

export function refreshCockpit(identifier, signal) {
  return apiFetch(`/cockpit/${encodeURIComponent(identifier)}?refresh=true`, { signal });
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
