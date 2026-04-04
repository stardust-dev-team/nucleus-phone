#!/usr/bin/env node
/**
 * scripts/test-signal-phone-e2e.js — End-to-end test of the signal→phone integration.
 *
 * Tests the full flow: signal data → contacts API → cockpit resolution → display.
 * Runs against the live deployment (or localhost).
 *
 * Usage: node scripts/test-signal-phone-e2e.js [base_url]
 */

const BASE = process.argv[2] || 'https://nucleus-phone.onrender.com';
const API_KEY = '7HiiWgouyuepJPODV38YeDbTNVQi34Iv';

let passed = 0;
let failed = 0;

async function apiFetch(path) {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'X-Api-Key': API_KEY, 'X-Requested-With': 'fetch' },
    signal: AbortSignal.timeout(30000),
  });
  return { status: resp.status, data: await resp.json() };
}

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} — ${detail || 'FAILED'}`);
    failed++;
  }
}

async function testPipeline() {
  console.log('\n═══ 1. Pipeline API ═══');
  const { status, data } = await apiFetch('/api/signals/pipeline?limit=5');
  assert('Pipeline returns 200', status === 200, `got ${status}`);
  assert('Pipeline has companies array', Array.isArray(data.companies));
  assert('Pipeline returns companies', data.companies.length > 0, `got ${data.companies.length}`);

  if (data.companies.length > 0) {
    const c = data.companies[0];
    assert('Company has signal_tier', !!c.signal_tier, `got ${c.signal_tier}`);
    assert('Company has signal_score', c.signal_score !== undefined, `got ${c.signal_score}`);
    assert('Company has company_name', !!c.company_name, `got ${c.company_name}`);
    assert('Company has domain', !!c.domain, `got ${c.domain}`);
  }
}

async function testSignalContacts() {
  console.log('\n═══ 2. Signal Contacts API ═══');
  const { status, data } = await apiFetch('/api/contacts/signal?has_phone=false&limit=10');
  assert('Signal contacts returns 200', status === 200);
  assert('Has companies array', Array.isArray(data.companies));
  assert('Returns companies', data.companies.length > 0, `got ${data.companies.length}`);

  // Find a company with contacts
  const withContacts = data.companies.filter(c => c.contact_count > 0);
  assert('Some companies have contacts', withContacts.length > 0, `${withContacts.length} companies with contacts`);

  // Find a company with phone contacts
  const withPhone = data.companies.filter(c => c.phone_count > 0);
  assert('Some companies have phone contacts', withPhone.length > 0, `${withPhone.length} companies with phone contacts`);

  if (withPhone.length > 0) {
    const company = withPhone[0];
    const phoneContact = company.contacts.find(c => c.phone);
    assert('Phone contact has full_name', !!phoneContact?.full_name, phoneContact?.full_name);
    assert('Phone contact has phone', !!phoneContact?.phone, phoneContact?.phone);
    assert('Phone contact has title', !!phoneContact?.title, phoneContact?.title);
    return { company, phoneContact };
  }

  return null;
}

async function testSignalContactsByDomain(domain) {
  console.log('\n═══ 3. Single Domain Contacts API ═══');
  if (!domain) { console.log('  ⊘ Skipped — no domain to test'); return; }

  const { status, data } = await apiFetch(`/api/contacts/signal/${encodeURIComponent(domain)}`);
  assert('Domain contacts returns 200', status === 200);
  assert('Has company object', !!data.company);
  assert('Has contacts array', Array.isArray(data.contacts));
  assert('Company matches domain', data.company?.domain === domain, `expected ${domain}, got ${data.company?.domain}`);
}

async function testCockpitWithPhone(phone, expectedName) {
  console.log('\n═══ 4. Cockpit Resolution (phone → identity) ═══');
  if (!phone) { console.log('  ⊘ Skipped — no phone to test'); return; }

  console.log(`  Testing: /api/cockpit/${encodeURIComponent(phone)}`);
  const { status, data } = await apiFetch(`/api/cockpit/${encodeURIComponent(phone)}`);
  assert('Cockpit returns 200', status === 200);
  assert('Has identity object', !!data.identity);
  assert('Identity has name', !!data.identity?.name, `got "${data.identity?.name}"`);
  assert('Identity is NOT "Unknown"', data.identity?.name !== 'Unknown' && data.identity?.name !== 'Unknown Contact',
    `got "${data.identity?.name}" — identity resolver failed to find contact`);
  assert('Has rapport/briefing', !!data.rapport, data.rapport ? 'present' : 'missing');
  assert('Has signalMetadata', !!data.signalMetadata, data.signalMetadata ? `tier=${data.signalMetadata.signal_tier}` : 'MISSING — cockpit not returning signal data');

  if (data.identity) {
    console.log(`\n  Identity resolved:`);
    console.log(`    Name: ${data.identity.name || 'UNKNOWN'}`);
    console.log(`    Company: ${data.identity.company || 'UNKNOWN'}`);
    console.log(`    Phone: ${data.identity.phone || phone}`);
    console.log(`    Source: ${data.identity.source || 'UNKNOWN'}`);
  }
}

async function testCallbacks() {
  console.log('\n═══ 5. Callbacks Proxy ═══');
  const { status, data } = await apiFetch('/api/signals/callbacks');
  assert('Callbacks returns 200', status === 200);
  assert('Has callbacks array', Array.isArray(data.callbacks));
  // Callbacks may be empty — that's fine, just verify the shape
  console.log(`  Callbacks count: ${data.callbacks.length}`);
}

async function testEnrichmentStatus() {
  console.log('\n═══ 6. Enrichment Infrastructure ═══');
  // Check if the enrich-batch endpoint exists and responds
  try {
    const resp = await fetch(`${BASE}/api/signals/enrich-batch/nonexistent-job-id`, {
      headers: { 'X-Api-Key': API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    assert('Enrichment job endpoint exists', resp.status === 404 || resp.status === 200);
    assert('Returns proper error for missing job', data.error === 'Job not found' || !!data.id,
      `got status=${resp.status}`);
  } catch (err) {
    assert('Enrichment endpoint reachable', false, err.message);
  }
}

async function testWebhookEndpoint() {
  console.log('\n═══ 7. Apollo Phone Webhook ═══');
  // Send a test payload to verify the webhook accepts requests
  try {
    const resp = await fetch(`${BASE}/api/apollo/phone-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person: { id: 'test-123' } }), // empty payload, should return gracefully
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    assert('Webhook returns 200', resp.status === 200);
    assert('Webhook returns received=true', data.received === true);
    assert('Webhook handles empty payload gracefully', data.updated === 0);
  } catch (err) {
    assert('Webhook endpoint reachable', false, err.message);
  }
}

async function run() {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Signal → Phone E2E Test Suite               ║`);
  console.log(`║  Target: ${BASE.padEnd(36)}║`);
  console.log(`╚══════════════════════════════════════════════╝`);

  // Test 1: Pipeline API
  await testPipeline();

  // Test 2: Signal Contacts (find a company with phone contacts)
  const contactResult = await testSignalContacts();

  // Test 3: Single domain lookup
  const testDomain = contactResult?.company?.domain;
  await testSignalContactsByDomain(testDomain);

  // Test 4: Cockpit with phone number (the critical path)
  const testPhone = contactResult?.phoneContact?.phone;
  const testName = contactResult?.phoneContact?.full_name;
  await testCockpitWithPhone(testPhone, testName);

  // Test 5: Callbacks
  await testCallbacks();

  // Test 6: Enrichment
  await testEnrichmentStatus();

  // Test 7: Webhook
  await testWebhookEndpoint();

  // Summary
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Results: ${passed} passed, ${failed} failed`.padEnd(47) + '║');
  console.log(`╚══════════════════════════════════════════════╝\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
