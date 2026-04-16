/**
 * lib/dropcontact.js — Simplified Dropcontact reverse lookup for identity resolution.
 * Async batch model: submit → poll → retrieve. 1 credit on success.
 *
 * Stripped from joruva-v35-scripts/src/lib/dropcontact.js.
 * No circuit breaker, no rate limiter — overkill at <10 calls/day.
 */

const { throwHttpError } = require('./http-error');

const BASE_URL = 'https://api.dropcontact.io/batch';
const TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 60000;

/**
 * Reverse-lookup a phone + name to find email.
 * Submits a batch of 1, polls until complete, returns email if found.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} [params.firstName]
 * @param {string} [params.lastName]
 * @param {string} [params.company]
 * @returns {Promise<{email: string|null, qualification: string|null}>}
 */
async function reverseSearch({ phone, firstName, lastName, company }) {
  const apiKey = process.env.DROPCONTACT_API_KEY;
  if (!apiKey) return { email: null, qualification: null };

  // Submit batch
  const submitResp = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'X-Access-Token': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: [{
        phone,
        ...(firstName && { first_name: firstName }),
        ...(lastName && { last_name: lastName }),
        ...(company && { company }),
      }],
      siren: false,
      language: 'en',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!submitResp.ok) {
    const text = await submitResp.text().catch(() => '');
    throwHttpError(submitResp, text, 'POST', 'batch', { service: 'Dropcontact' });
  }

  const { request_id } = await submitResp.json();
  if (!request_id) throw new Error('Dropcontact: no request_id returned');

  // Poll until done
  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const pollResp = await fetch(`${BASE_URL}/${request_id}`, {
      headers: { 'X-Access-Token': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!pollResp.ok) {
      // Fatal errors: fail fast instead of polling until timeout
      if (pollResp.status === 401 || pollResp.status === 403 || pollResp.status === 404) {
        const text = await pollResp.text().catch(() => '');
        throwHttpError(pollResp, text, 'GET', `batch/${request_id}`, { service: 'Dropcontact' });
      }
      console.warn(`Dropcontact poll transient ${pollResp.status} for ${request_id} — retrying`);
      continue; // 429, 500, 503 etc — retriable
    }

    const result = await pollResp.json();
    if (!result.success) continue;

    const contact = result.data?.[0];
    if (!contact) return { email: null, qualification: null };

    return {
      email: contact.email?.[0]?.email || null,
      qualification: contact.email?.[0]?.qualification || null,
    };
  }

  return { email: null, qualification: null };
}

module.exports = { reverseSearch };
