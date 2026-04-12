#!/usr/bin/env node
/**
 * scripts/verify-phone-integration.js — Integration verification for signal engine.
 *
 * Validates response shapes from every signal/cockpit/pipeline endpoint.
 * Non-destructive: never spends credits or mutates state.
 *
 * Usage:
 *   NUCLEUS_PHONE_API_KEY=... MC_API_KEY=... node scripts/verify-phone-integration.js [base_url] [mc_url]
 *
 *   Keys default to .env if present (dotenv loaded below).
 *
 * Plan ref: ~/.claude/plans/toasty-knitting-marshmallow.md (Verification Plan)
 * Bead: nucleus-phone-kc8.9
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'https://nucleus-phone.onrender.com';
const MC_BASE = process.argv[3] || 'https://joruva-multichannel.onrender.com';
const API_KEY = process.env.NUCLEUS_PHONE_API_KEY;
const MC_API_KEY = process.env.MC_API_KEY; // optional — Check 8 skipped if absent

if (!API_KEY) {
  console.error('Missing required env var: NUCLEUS_PHONE_API_KEY');
  console.error('Set it in .env or export before running.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
let skipped = 0;

// ── Helpers ──────────────────────────────────────────────────────────

async function apiFetch(base, path, opts = {}) {
  const key = base === MC_BASE ? MC_API_KEY : API_KEY;
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers = {
    'X-Api-Key': key,
    'X-Requested-With': 'fetch',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const resp = await fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _parseError: true, body: text.slice(0, 500) };
  }
  return { status: resp.status, data };
}

function assert(name, ok, detail) {
  if (ok) {
    console.log(`  \u2713 ${name}`);
    passed++;
  } else {
    console.log(`  \u2717 ${name} \u2014 ${detail || 'FAILED'}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  \u2298 ${name} \u2014 ${reason}`);
  skipped++;
}

function missingFields(obj, fields) {
  return fields.filter(f => obj[f] === undefined);
}

// ── Check 1: Pipeline ────────────────────────────────────────────────

async function checkPipeline() {
  console.log('\n\u2550\u2550\u2550 Check 1/8: Pipeline (GET /api/signals/pipeline) \u2550\u2550\u2550');

  const { status, data } = await apiFetch(BASE, '/api/signals/pipeline?limit=5');
  assert('Returns 200', status === 200, `got ${status}`);
  assert('Has companies array', Array.isArray(data.companies));

  if (!data.companies?.length) {
    skip('Field validation', 'no companies returned');
    return null;
  }

  const c = data.companies[0];
  const required = ['domain', 'company_name', 'signal_tier', 'signal_score'];
  const missing = missingFields(c, required);
  assert('Company has required fields', !missing.length,
    `missing: ${missing.join(', ')}`);

  // Plan specifies these signal fields must be present
  const signalFields = ['cert_expiry_date', 'contract_total', 'source_count'];
  const missingSignal = missingFields(c, signalFields);
  assert('Company has signal enrichment fields', !missingSignal.length,
    `missing: ${missingSignal.join(', ')}`);

  return c.domain;
}

// ── Check 2: Signal contacts ─────────────────────────────────────────

async function checkSignalContacts() {
  console.log('\n\u2550\u2550\u2550 Check 2/8: Signal Contacts (GET /api/contacts/signal) \u2550\u2550\u2550');

  const { status, data } = await apiFetch(BASE, '/api/contacts/signal?signal_tier=spear&has_phone=true&limit=10');
  assert('Returns 200', status === 200, `got ${status}`);
  assert('Has companies array', Array.isArray(data.companies));

  if (!data.companies?.length) {
    skip('Shape validation', 'no SPEAR companies with phone contacts');
    return null;
  }

  const co = data.companies[0];
  assert('Company has signal_score', co.signal_score !== undefined);
  assert('Company has signal_tier', co.signal_tier === 'spear',
    `expected spear, got ${co.signal_tier}`);
  assert('Company has contacts array', Array.isArray(co.contacts));

  if (co.contacts?.length) {
    const contact = co.contacts[0];
    assert('Contact has full_name', !!contact.full_name);
    assert('Contact has phone (has_phone=true filter)', !!contact.phone);
    assert('Contact has source discriminator', !!contact.source,
      `source: ${contact.source}`);
  } else {
    skip('Contact field check', 'company has 0 inline contacts');
  }

  return { domain: co.domain, phone: co.contacts?.[0]?.phone };
}

// ── Check 3: Single company contacts ─────────────────────────────────

async function checkSingleCompany(domain) {
  console.log('\n\u2550\u2550\u2550 Check 3/8: Single Company (GET /api/contacts/signal/:domain) \u2550\u2550\u2550');

  if (!domain) { skip('All checks', 'no domain from check 2'); return; }

  const { status, data } = await apiFetch(BASE, `/api/contacts/signal/${encodeURIComponent(domain)}`);
  assert('Returns 200', status === 200, `got ${status}`);
  assert('Has company object', !!data.company);
  assert('Company domain matches', data.company?.domain === domain,
    `expected ${domain}, got ${data.company?.domain}`);
  assert('Has contacts array', Array.isArray(data.contacts));

  if (data.contacts?.length) {
    const c = data.contacts[0];
    assert('Contact has source discriminator', !!c.source,
      `source field: ${c.source}`);
    const knownSources = new Set(['phantombuster', 'apollo', 'hubspot']);
    if (!knownSources.has(c.source)) {
      console.log(`  \u26a0 Unknown source "${c.source}" \u2014 new source type? Update knownSources if intentional.`);
    }
    assert('Source is non-empty string', typeof c.source === 'string' && c.source.length > 0,
      `got "${c.source}"`);
  }
}

// ── Check 4: Per-company enrichment ──────────────────────────────────

async function checkPerCompanyEnrich(domain) {
  console.log('\n\u2550\u2550\u2550 Check 4/8: Per-Company Enrich (POST /api/contacts/signal/:domain/enrich) \u2550\u2550\u2550');

  // Plan specified this endpoint but it was never implemented.
  // Verify it 404s (not 500) to confirm clean routing.
  // TODO: Convert to full shape validation once the endpoint ships.
  if (!domain) { skip('All checks', 'no domain available'); return; }

  const { status } = await apiFetch(BASE, `/api/contacts/signal/${encodeURIComponent(domain)}/enrich`, {
    method: 'POST',
  });
  assert('Endpoint responds (not 500)', status !== 500, `got ${status}`);
  console.log(`  \u2139 Status: ${status} \u2014 endpoint not yet implemented (plan Phase 3 item)`);
}

// ── Check 5: Batch enrichment (read-only) ────────────────────────────

async function checkBatchEnrichment() {
  console.log('\n\u2550\u2550\u2550 Check 5/8: Batch Enrichment (job status check) \u2550\u2550\u2550');

  // Verify job status endpoint works without starting a new job
  const { status, data } = await apiFetch(BASE, '/api/signals/enrich-batch/verify-test-nonexistent');
  assert('Job status endpoint exists', status === 404 || status === 200,
    `got ${status}`);
  assert('Returns proper shape for missing job', data.error === 'Job not found' || !!data.id,
    `got: ${JSON.stringify(data).slice(0, 100)}`);

  // Verify POST rejects bad input without spending credits
  const post = await apiFetch(BASE, '/api/signals/enrich-batch', {
    method: 'POST',
    body: { tiers: ['invalid_tier'] },
  });
  assert('Rejects invalid tiers', post.status === 400,
    `expected 400, got ${post.status}: ${post.data.error || JSON.stringify(post.data).slice(0, 80)}`);
}

// ── Check 6: Callbacks ───────────────────────────────────────────────

async function checkCallbacks() {
  console.log('\n\u2550\u2550\u2550 Check 6/8: Callbacks (GET /api/signals/callbacks) \u2550\u2550\u2550');

  const { status, data } = await apiFetch(BASE, '/api/signals/callbacks');
  assert('Returns 200', status === 200, `got ${status}`);
  assert('Has callbacks array', Array.isArray(data.callbacks));
  // Callbacks can be empty; verify graceful degradation shape
  assert('No error field on success', data.error === undefined);
  console.log(`  Callbacks: ${data.callbacks.length} pending`);
}

// ── Check 7: Cockpit signal context ──────────────────────────────────

async function checkCockpit(phone) {
  console.log('\n\u2550\u2550\u2550 Check 7/8: Cockpit Signal Context (GET /api/cockpit/:phone) \u2550\u2550\u2550');

  if (!phone) { skip('All checks', 'no phone from check 2'); return; }

  const { status, data } = await apiFetch(BASE, `/api/cockpit/${encodeURIComponent(phone)}`);
  assert('Returns 200', status === 200, `got ${status}`);
  assert('Has identity object', !!data.identity);
  assert('Has rapport object', !!data.rapport);

  // Signal metadata: present when company is in v35_signal_metadata
  assert('signalMetadata key exists', data.signalMetadata !== undefined,
    'key missing entirely');

  if (data.signalMetadata) {
    const fields = ['signal_tier', 'signal_score', 'cert_expiry_date',
      'cert_standard', 'contract_total', 'dod_flag'];
    const missing = missingFields(data.signalMetadata, fields);
    assert('Signal metadata has all plan-specified fields', !missing.length,
      `missing: ${missing.join(', ')}`);
    console.log(`  Signal: tier=${data.signalMetadata.signal_tier}, ` +
      `score=${data.signalMetadata.signal_score}, ` +
      `dod=${data.signalMetadata.dod_flag}`);
  } else {
    console.log(`  Signal: null (contact's company not scored \u2014 OK)`);
  }

  // ICP context should be present
  assert('Has icpScore', data.icpScore !== undefined, 'key missing');
}

// ── Check 8: Multichannel ABM API (direct) ───────────────────────────

async function checkMultichannelAPI() {
  console.log('\n\u2550\u2550\u2550 Check 8/8: Multichannel ABM API (GET /admin/abm/accounts) \u2550\u2550\u2550');

  if (!MC_API_KEY) { skip('All checks', 'MC_API_KEY not set'); return; }

  const { status, data } = await apiFetch(MC_BASE, '/admin/abm/accounts?limit=3');
  assert('Returns 200', status === 200, `got ${status}`);
  assert('Has accounts array', Array.isArray(data.accounts),
    `keys: ${Object.keys(data || {}).join(', ')}`);

  if (data.accounts?.length) {
    const a = data.accounts[0];
    const signalFields = ['signal_tier', 'signal_score', 'source_count',
      'cert_expiry_date', 'contract_total', 'dod_flag'];
    const missing = missingFields(a, signalFields);
    assert('Account has signal fields (Phase 2 fix)', !missing.length,
      `missing: ${missing.join(', ')}`);
    assert('Account has domain', !!a.domain);
    assert('Account has company_name', !!a.company_name || !!a.name);
  } else {
    skip('Account field check', 'no accounts returned');
  }
}

// ── Runner ───────────────────────────────────────────────────────────

function banner(lines) {
  const w = Math.max(...lines.map(l => l.length)) + 4;
  console.log('\n\u2554' + '\u2550'.repeat(w) + '\u2557');
  for (const l of lines) console.log(`\u2551  ${l.padEnd(w - 2)}\u2551`);
  console.log('\u255a' + '\u2550'.repeat(w) + '\u255d');
}

async function run() {
  banner([
    'Signal Engine Integration Verification',
    `API: ${BASE}`,
    `MC:  ${MC_BASE}`,
  ]);

  // Checks 1-2 feed data to downstream checks — must run first
  const pipelineDomain = await checkPipeline();
  const signalResult = await checkSignalContacts();
  const testDomain = signalResult?.domain || pipelineDomain;
  const testPhone = signalResult?.phone;

  // Checks 3-4 depend on domain from above — sequential
  await checkSingleCompany(testDomain);
  await checkPerCompanyEnrich(testDomain);

  // Checks 5-8 are independent of each other but we run sequentially
  // so console output stays ordered (parallel saves <2s on 4 HTTP calls).
  await checkBatchEnrichment();
  await checkCallbacks();
  await checkCockpit(testPhone);
  await checkMultichannelAPI();

  // Summary
  const total = passed + failed;
  const pct = total ? Math.round((passed / total) * 100) : 0;
  const summary = `${passed} passed, ${failed} failed, ${skipped} skipped (${pct}%)`;
  const verdict = failed === 0
    ? 'All integration contracts verified.'
    : `ACTION REQUIRED: ${failed} check(s) failing.`;
  banner([summary, verdict]);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
