/**
 * lib/vapi.js — Vapi API client for simulation calls.
 */

const VAPI_BASE = 'https://api.vapi.ai';

async function vapiRequest(method, endpoint, body, { usePublicKey } = {}) {
  const keyName = usePublicKey ? 'VAPI_PUBLIC_KEY' : 'VAPI_API_KEY';
  const apiKey = process.env[keyName];
  if (!apiKey) throw new Error(`${keyName} not set`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const opts = {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${VAPI_BASE}/${endpoint}`, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vapi ${method} ${endpoint} (${res.status}): ${text.substring(0, 300)}`);
    }
    // DELETE returns empty body
    if (res.status === 204 || res.headers.get('content-length') === '0') return {};
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Initiate an outbound practice call via Vapi.
 * Vapi calls the customer's phone and connects them to the assistant.
 */
async function createOutboundCall({ assistantId, customerNumber, phoneNumberId, assistantOverrides }) {
  const body = {
    assistantId,
    customer: { number: customerNumber },
    phoneNumberId: phoneNumberId || process.env.VAPI_PRACTICE_PHONE_ID,
  };
  if (assistantOverrides) body.assistantOverrides = assistantOverrides;
  return vapiRequest('POST', 'call/phone', body);
}

/**
 * Stop an in-progress Vapi call.
 */
async function stopCall(vapiCallId) {
  if (!vapiCallId || typeof vapiCallId !== 'string') {
    throw new Error('stopCall requires a valid call ID string');
  }
  return vapiRequest('POST', `call/${encodeURIComponent(vapiCallId)}/stop`);
}

/**
 * Fetch a completed call from the Vapi API (includes transcript + recording).
 */
async function getCall(vapiCallId) {
  return vapiRequest('GET', `call/${encodeURIComponent(vapiCallId)}`);
}

module.exports = { createOutboundCall, stopCall, getCall };
