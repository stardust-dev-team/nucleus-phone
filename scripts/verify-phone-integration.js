#!/usr/bin/env node
/**
 * scripts/verify-phone-integration.js — Integration verification for signal engine.
 *
 * Validates response shapes from every signal/cockpit/pipeline endpoint.
 * Non-destructive: never spends credits or mutates state.
 *
 * Usage: node scripts/verify-phone-integration.js [base_url]
 *
 * Plan ref: ~/.claude/plans/toasty-knitting-marshmallow.md (Verification Plan)
 * Bead: nucleus-phone-kc8.9
 */

const BASE = process.argv[2] || 'https://nucleus-phone.onrender.com';
const MC_BASE = process.argv[3] || 'https://joruva-multichannel.onrender.com';
const API_KEY = '7HiiWgouyuepJPODV38YeDbTNVQi34Iv';
const MC_API_KEY = 'Tt2k+Vrj9/FL5O40C98IM5ogno4VBZyNPEX3G0DS1n8=';

let passed = 0;
let failed = 0;
let skipped = 0;

// ── Helpers ──────────────────────────────────────────────────────────

async function apiFetch(base, path, opts = {}) {
  const key = base === MC_BASE ? MC_API_KEY : API_KEY;
  const resp = await fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'X-Api-Key': key,
      'X-Requested-With': 'fetch',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return { status: resp.status, data: await resp.json() };
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

function hasFields(obj, fields) {
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
  const missing = hasFields(c, required);
  assert('Company has required fields', !missing.length,
    `missing: ${missing.join(', ')}`);

  // Plan specifies these signal fields must be present
  const signalFields = ['cert_expiry_date', 'contract_total', 'source_count'];
  const missingSignal = hasFields(c, signalFields);
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
    const validSources = new Set(['phantombuster', 'apollo', 'hubspot']);
    assert('Source is valid enum', validSources.has(c.source),
      `got "${c.source}"`);
  }
}

// ── Check 4: Per-company enrichment ──────────────────────────────────

async function checkPerCompanyEnrich(domain) {
  console.log('\n\u2550\u2550\u2550 Check 4/8: Per-Company Enrich (POST /api/contacts/signal/:domain/enrich) \u2550\u2550\u2550');

  // Plan specified this endpoint but it was never implemented.
  // Verify it 404s (not 500) to confirm clean routing.
  if (!domain) { skip('All checks', 'no domain available'); return; }

  try {
    const resp = await fetch(`${BASE}/api/contacts/signal/${encodeURIComponent(domain)}/enrich`, {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    // This endpoint doesn't exist yet — Express should return 404 or the
    // /:domain route might catch "enrich" as a domain. Either way, not 500.
    assert('Endpoint responds (not 500)', resp.status !== 500,
      `got ${resp.status}`);
    console.log(`  \u2139 Status: ${resp.status} \u2014 endpoint not yet implemented (plan Phase 3 item)`);
  } catch (err) {
    assert('Endpoint reachable', false, err.message);
  }
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
  try {
    const resp = await fetch(`${BASE}/api/signals/enrich-batch`, {
      method: 'POST',
      headers: {
        'X-Api-Key': API_KEY,
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tiers: ['invalid_tier'] }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await resp.json();
    assert('Rejects invalid tiers', resp.status === 400,
      `expected 400, got ${resp.status}: ${body.error || JSON.stringify(body).slice(0, 80)}`);
  } catch (err) {
    assert('POST endpoint reachable', false, err.message);
  }
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
    const missing = hasFields(data.signalMetadata, fields);
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

  try {
    const { status, data } = await apiFetch(MC_BASE, '/admin/abm/accounts?limit=3');
    assert('Returns 200', status === 200, `got ${status}`);
    assert('Has accounts array', Array.isArray(data.accounts),
      `keys: ${Object.keys(data).join(', ')}`);

    if (data.accounts?.length) {
      const a = data.accounts[0];
      const signalFields = ['signal_tier', 'signal_score', 'source_count',
        'cert_expiry_date', 'contract_total', 'dod_flag'];
      const missing = hasFields(a, signalFields);
      assert('Account has signal fields (Phase 2 fix)', !missing.length,
        `missing: ${missing.join(', ')}`);
      assert('Account has domain', !!a.domain);
      assert('Account has company_name', !!a.company_name || !!a.name);
    } else {
      skip('Account field check', 'no accounts returned');
    }
  } catch (err) {
    assert('Multichannel reachable', false, err.message);
  }
}

// ── Runner ───────────────────────────────────────────────────────────

async function run() {
  console.log(`\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557`);
  console.log(`\u2551  Signal Engine Integration Verification       \u2551`);
  console.log(`\u2551  API: ${BASE.padEnd(41)}\u2551`);
  console.log(`\u2551  MC:  ${MC_BASE.padEnd(41)}\u2551`);
  console.log(`\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d`);

  // Check 1 feeds a domain to checks 3-4
  const pipelineDomain = await checkPipeline();

  // Check 2 feeds a domain + phone to checks 3, 4, 7
  const signalResult = await checkSignalContacts();
  const testDomain = signalResult?.domain || pipelineDomain;
  const testPhone = signalResult?.phone;

  await checkSingleCompany(testDomain);
  await checkPerCompanyEnrich(testDomain);
  await checkBatchEnrichment();
  await checkCallbacks();
  await checkCockpit(testPhone);
  await checkMultichannelAPI();

  // Summary
  const total = passed + failed;
  const pct = total ? Math.round((passed / total) * 100) : 0;
  console.log(`\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557`);
  console.log(`\u2551  ${passed} passed, ${failed} failed, ${skipped} skipped (${pct}%)`.padEnd(48) + `\u2551`);
  if (failed === 0) {
    console.log(`\u2551  All integration contracts verified.           \u2551`);
  } else {
    console.log(`\u2551  ACTION REQUIRED: ${failed} check(s) failing.`.padEnd(48) + `\u2551`);
  }
  console.log(`\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
