#!/usr/bin/env node
/**
 * scripts/burn-spear-mobile.js — one-time Apollo mobile-credit burn for SPEAR cohort.
 *
 * Purpose: spend the 5,592 mobile-reveal credit refund (expires 2026-05-11) on
 * fresh reveals for SPEAR-tier domains that have no existing Apollo coverage.
 * Cost per reveal: 8 mobile + 1 enrichment = 9 credits. Budget: 5,592 / 9 = 621.
 *
 * Flow per SPEAR domain (rate-limited to stay under Apollo's 50/min):
 *   1. Apollo org resolve — by domain for resolved rows, by name for
 *      .signal-pending placeholders (Jaccard-validated against company_name)
 *   2. Apollo people search with tight title filters (free)
 *   3. Cache ALL previews in v35_apollo_contact_cache (future sessions skip search)
 *   4. Filter previews to has_direct_phone === 'Yes'
 *   5. Rank by function (purchasing/procurement/sourcing > ops > supply chain)
 *      then seniority (COO > VP > Director > Manager). Exclude non-COO C-suite.
 *      Deterministic tiebreak: has_email then apollo_person_id.
 *   6. Pick ONE top-ranked contact
 *   7. Upsert by apollo_person_id (SELECT-before-INSERT, not ON CONFLICT —
 *      partial unique index excludes NULL-email rows)
 *   8. POST /people/match with reveal_phone_number=true + webhook_url (9 credits)
 *   9. Journal each attempt/commit/fail with fsync for crash-safe resume
 *
 * Usage:
 *   node scripts/burn-spear-mobile.js --dry-run --limit 10
 *   node scripts/burn-spear-mobile.js --pilot                 # 10 real reveals
 *   node scripts/burn-spear-mobile.js --limit 621             # full burn
 *   node scripts/burn-spear-mobile.js --resume                # retry failed, skip committed
 *   node scripts/burn-spear-mobile.js --resume --no-retry-failed
 *   node scripts/burn-spear-mobile.js --tiers spear,targeted  # widen pool
 */

require('dotenv').config();

const { Pool } = require('pg');
const { Agent, setGlobalDispatcher } = require('undici');
const fs = require('fs');
const path = require('path');
const os = require('os');

// TCP socket reuse — prevents EADDRNOTAVAIL (local port exhaustion) on long runs.
// Default undici agent churns sockets on every fetch; at 5 req/sec × 1hr = 18k
// ephemeral ports in TIME_WAIT state. Bounded keep-alive agent with explicit
// connection pool keeps it under ~4 connections across the entire run.
//
// keepAliveTimeout is deliberately SHORTER than typical LB idle-timeouts
// (~30s on AWS ALB / common infra). Keep-alive only needs to span the
// intra-domain calls (org + people search within ~3s); don't try to span
// cross-domain gaps where we'd race the server-side half-close.
//
// Module-load side effect (setGlobalDispatcher): OK because this file is a
// CLI entry point, never imported from test harnesses.
const httpAgent = new Agent({
  keepAliveTimeout: 15_000,
  keepAliveMaxTimeout: 300_000,
  connections: 4,
  pipelining: 0,
});
setGlobalDispatcher(httpAgent);

// ── config ─────────────────────────────────────────────────────────────────

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_URL = process.env.APOLLO_PHONE_WEBHOOK_URL
  || 'https://nucleus-phone.onrender.com/api/apollo/phone-webhook';

const DRY_RUN = process.argv.includes('--dry-run');
const PILOT = process.argv.includes('--pilot');
const RESUME = process.argv.includes('--resume');
const NO_RETRY_FAILED = process.argv.includes('--no-retry-failed');
const LIMIT = PILOT ? 10 : readIntArg('--limit', 621);
const OFFSET = readIntArg('--offset', 0);
const TIERS = readStrArg('--tiers', 'spear').split(',').map(t => t.trim()).filter(Boolean);

const REQ_DELAY_MS = 1500; // ~40/min, under Apollo's 50/min documented limit
const SEARCH_PER_PAGE = 10;
const JOURNAL_PATH = path.join(os.homedir(), '.joruva', 'apollo-burn-journal.jsonl');
const MAX_RETRIES = 4;

if (!APOLLO_API_KEY) { console.error('APOLLO_API_KEY not set'); process.exit(1); }
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

// Keep pg pool tight: 2 connections is plenty for a sequential-per-domain loop
// (1 for the main query path, 1 for the transactional updateDomain).
// idleTimeoutMillis: close idle connections after 30s so we don't accumulate
// stale sockets on the Render-side during search-heavy (no-DB-work) stretches.
// connectionTimeoutMillis: surface hangs fast instead of blocking indefinitely
// on a bad socket (preceding root cause of the EADDRNOTAVAIL crash).
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// ── title filter sent to Apollo search ─────────────────────────────────────

const TITLE_FILTERS = [
  // Purchasing / procurement / sourcing (function priority 3)
  'Purchasing Manager', 'Purchasing Director', 'VP Purchasing',
  'Procurement Manager', 'Procurement Director', 'Director of Procurement',
  'VP Procurement', 'Head of Procurement', 'VP of Procurement',
  'Sourcing Manager', 'Sourcing Director', 'Senior Buyer',
  // Operations (function priority 2)
  'VP Operations', 'VP of Operations', 'Director of Operations',
  'COO', 'Chief Operating Officer',
  // Supply chain (function priority 1)
  'Supply Chain Manager', 'Supply Chain Director', 'VP Supply Chain',
];

// ── ranking ────────────────────────────────────────────────────────────────

// Excludes non-COO C-suite and owner/founder titles. Does NOT exclude
// "president" as a bare word — "Vice President" must score, and bare
// "President" harmlessly returns -1 via the function-check path because
// no ops/procurement keyword will be present.
const EXCLUDE_TITLE_PATTERNS = /\b(ceo|cfo|cto|cio|chro|cmo|cso|cro)\b|chief (executive|financial|technology|information|human|marketing|strategy|revenue)/i;

function scoreTitle(title) {
  const t = (title || '').toLowerCase();
  if (!t) return -1;
  if (EXCLUDE_TITLE_PATTERNS.test(t)) return -1;

  // Function score (must have one)
  let fn = 0;
  if (/\b(purchasing|procurement|sourcing|buyer)\b/.test(t)) fn = 3;
  else if (/\b(operations|operational)\b|\bcoo\b|chief operating/.test(t)) fn = 2;
  else if (/\bsupply chain\b/.test(t)) fn = 1;
  else return -1;

  // Seniority score
  let sen = 0;
  if (/\bcoo\b|chief operating/.test(t)) sen = 5;
  else if (/\bvp\b|vice president|v\.p\./.test(t)) sen = 3;
  else if (/\bdirector\b|head of/.test(t)) sen = 2;
  else if (/\bmanager\b|\bsenior\b|\bsr\.?\b/.test(t)) sen = 1;
  else return -1;

  return fn * 100 + sen;
}

function pickTopContact(previews) {
  const candidates = previews
    .filter(p => p.has_direct_phone === 'Yes')
    .map(p => ({ p, score: scoreTitle(p.title) }))
    .filter(x => x.score > 0)
    // Deterministic sort: score desc, has_email desc, id asc (stable lex)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ae = a.p.has_email ? 1 : 0;
      const be = b.p.has_email ? 1 : 0;
      if (be !== ae) return be - ae;
      return (a.p.id || '').localeCompare(b.p.id || '');
    });
  return candidates[0]?.p || null;
}

// ── name matching (Jaccard) ────────────────────────────────────────────────

const NAME_STOPWORDS = new Set([
  'the', 'a', 'and', '&', 'of', 'for', 'inc', 'llc', 'ltd',
  'corp', 'corporation', 'company', 'co', 'dba', 'holdings',
  'group', 'plc', 'lp', 'llp', 'pllc',
]);

function normalizeNameWords(name) {
  return new Set(
    (name || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !NAME_STOPWORDS.has(w) && w.length > 1),
  );
}

// Jaccard: |intersection| / |union|. Treats short-set false positives
// correctly — {lee} vs {bruce, lee, family} = 1/3 = 0.33, rejected.
function nameJaccard(a, b) {
  const aw = normalizeNameWords(a);
  const bw = normalizeNameWords(b);
  if (aw.size === 0 || bw.size === 0) return 0;
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  const union = aw.size + bw.size - inter;
  return inter / union;
}

// ── v35-compatible company_name_norm (matches lib/company-normalizer.js) ───

const COMPANY_SUFFIXES = /\b(inc\.?|incorporated|llc|l\.l\.c\.?|corp\.?|corporation|ltd\.?|limited|co\.?|company|group|lp|l\.p\.?|holdings|plc|gmbh|s\.a\.?|sa|ag)\s*$/i;

function normalizeCompanyName(name) {
  if (!name) return '';
  let n = name.trim().toLowerCase();
  n = n.replace(/[,.\s]+$/, '');
  n = n.replace(COMPANY_SUFFIXES, '').trim();
  n = n.replace(/[,.\s]+$/, '');
  return n;
}

// ── Apollo calls with typed errors + retry ─────────────────────────────────

class ApolloError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApolloError';
    this.status = status;
    this.body = body;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRetriable(err) {
  // HTTP-level retry: 429 rate-limit and 5xx from Apollo
  if (err instanceof ApolloError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // Transport-level retry: socket reset / abort / DNS blip / timeout.
  // undici surfaces these via err.cause.code or err.code; fetch's
  // AbortSignal.timeout throws AbortError. All are recoverable given that
  // we have keep-alive sockets that can go stale between server half-close
  // and client reuse.
  const code = err?.code || err?.cause?.code;
  const name = err?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CLOSED_CLIENT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  // Generic fetch TypeError (Node fetch wraps transport errors in TypeError)
  if (name === 'TypeError' && /fetch|network|socket/i.test(err.message || '')) return true;
  return false;
}

async function withRetry(label, fn) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES || !isRetriable(err)) throw err;
      const status = err instanceof ApolloError ? err.status : (err?.code || err?.name || 'transport');
      const retryAfter = err.retryAfter ? err.retryAfter * 1000 : Math.min(30000, 1000 * 2 ** attempt);
      console.error(`[retry ${attempt + 1}/${MAX_RETRIES}] ${label}: ${status} — waiting ${retryAfter}ms`);
      await sleep(retryAfter);
    }
  }
  throw new Error('unreachable'); // satisfy linter
}

async function apolloFetch(endpoint, body, label) {
  const resp = await fetch(`https://api.apollo.io/api/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new ApolloError(`${label} -> ${resp.status}`, resp.status, text.slice(0, 300));
    const ra = parseInt(resp.headers.get('retry-after') || '', 10);
    if (!isNaN(ra)) err.retryAfter = ra;
    throw err;
  }
  return resp.json();
}

async function apolloOrgSearch(domain, companyName) {
  const isPlaceholder = domain.endsWith('.signal-pending');
  const body = isPlaceholder
    ? { q_organization_name: companyName, per_page: 5 }
    : { q_organization_domains: domain, per_page: 1 };

  const data = await withRetry(`org_search ${domain}`, () =>
    apolloFetch('mixed_companies/search', body, `org_search ${domain}`),
  );
  const orgs = data.organizations || [];
  if (orgs.length === 0) return null;

  if (isPlaceholder) {
    const scored = orgs
      .map(o => ({ o, jac: nameJaccard(companyName, o.name) }))
      .sort((a, b) => b.jac - a.jac);
    const best = scored[0];
    if (!best || best.jac < 0.5) return null;
    return best.o;
  } else {
    const org = orgs[0];
    const orgDomain = (org.primary_domain || '').toLowerCase();
    if (orgDomain && orgDomain !== domain.toLowerCase()) return null;
    return org;
  }
}

async function apolloPeopleSearch(orgId) {
  const data = await withRetry(`people_search ${orgId}`, () =>
    apolloFetch('mixed_people/api_search', {
      organization_ids: [orgId],
      person_titles: TITLE_FILTERS,
      page: 1,
      per_page: SEARCH_PER_PAGE,
    }, `people_search ${orgId}`),
  );
  return data.people || [];
}

async function apolloReveal(apolloId) {
  const data = await withRetry(`reveal ${apolloId}`, () =>
    apolloFetch('people/match', {
      id: apolloId,
      reveal_phone_number: true,
      webhook_url: WEBHOOK_URL,
    }, `reveal ${apolloId}`),
  );
  return data.person || null;
}

// ── journal (crash-safe, fsync'd) ──────────────────────────────────────────

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

function appendJournal(entry) {
  ensureDir(JOURNAL_PATH);
  const line = JSON.stringify(entry) + '\n';
  const fd = fs.openSync(JOURNAL_PATH, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Returns Map<domain, latest_state>. Latest state wins: the last-journaled
// terminal state for a domain is what we honor on resume.
function readJournalLatest() {
  if (!fs.existsSync(JOURNAL_PATH)) return new Map();
  const latest = new Map();
  const lines = fs.readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.domain) latest.set(e.domain, e);
    } catch { /* ignore torn line */ }
  }
  return latest;
}

// Decide whether to skip a domain on resume based on its latest journaled state.
// - committed / skipped: always skip (final)
// - failed: retry unless --no-retry-failed
// - attempt (orphaned, no terminal): WARN and re-attempt — unclear if credits
//   were burned; user can --no-retry-failed to force skip
function shouldSkipOnResume(entry) {
  if (!entry) return false;
  if (entry.state === 'committed' || entry.state === 'skipped') return true;
  if (entry.state === 'failed') return NO_RETRY_FAILED;
  if (entry.state === 'attempt') {
    console.warn(`[resume-warn] ${entry.domain}: orphaned attempt (no terminal state) — re-attempting. Credits may have been burned previously.`);
    return NO_RETRY_FAILED;
  }
  return false;
}

// ── DB writes ──────────────────────────────────────────────────────────────

async function cachePreviewsForDomain(domain, previews) {
  if (!previews.length) return;
  const contacts = previews.map(p => ({
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    title: p.title || null,
    seniority: p.seniority || null,
    has_direct_phone: p.has_direct_phone,
    has_email: !!p.has_email,
    apollo_person_id: p.id,
    source: 'apollo_search',
    match_method: 'burn-spear-mobile',
  }));
  await pool.query(
    `INSERT INTO v35_apollo_contact_cache (domain, filters_hash, contacts, created_at, expires_at)
     VALUES ($1, 'burnspear2604', $2::jsonb, NOW(), NOW() + INTERVAL '30 days')
     ON CONFLICT (domain, filters_hash) DO UPDATE SET
       contacts = EXCLUDED.contacts,
       created_at = NOW(),
       expires_at = NOW() + INTERVAL '30 days'`,
    [domain, JSON.stringify(contacts)],
  );
}

// SELECT-before-INSERT dedup: the existing partial unique index
// idx_pbc_apollo_unique(domain, email) is conditional on email IS NOT NULL,
// so ON CONFLICT silently no-ops on our email=NULL rows and duplicates pile
// up on rerun. Sequential per-domain, no races to worry about.
async function upsertContactRow(domain, companyName, preview) {
  const existing = await pool.query(
    `SELECT id FROM v35_pb_contacts
     WHERE apollo_person_id = $1 AND source = 'apollo'
     LIMIT 1`,
    [preview.id],
  );
  if (existing.rowCount > 0) return existing.rows[0].id;

  const fullName = [preview.first_name, preview.last_name].filter(Boolean).join(' ') || preview.name || null;
  const result = await pool.query(
    `INSERT INTO v35_pb_contacts
       (full_name, first_name, last_name, title, company_name, company_name_norm,
        linkedin_profile_url, email, phone, phone_type, domain, source,
        enrichment_batch_id, apollo_person_id)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, $7, 'apollo', 'burn-spear-mobile', $8)
     RETURNING id`,
    [
      fullName, preview.first_name || null, preview.last_name || null, preview.title || null,
      companyName, normalizeCompanyName(companyName),
      domain, preview.id,
    ],
  );
  return result.rows[0].id;
}

// ── domain list ────────────────────────────────────────────────────────────

async function getTargetDomains() {
  const r = await pool.query(`
    SELECT sm.domain, lr.company_name, sm.signal_score, sm.signal_tier, sm.cert_expiry_date
    FROM v35_signal_metadata sm
    LEFT JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
    WHERE sm.signal_tier = ANY($1::text[])
    ORDER BY
      CASE sm.signal_tier WHEN 'spear' THEN 1 WHEN 'targeted' THEN 2 ELSE 3 END,
      sm.signal_score DESC NULLS LAST,
      sm.cert_expiry_date ASC NULLS LAST,
      sm.domain
  `, [TIERS]);
  return r.rows;
}

// ── helpers ────────────────────────────────────────────────────────────────

function readIntArg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = parseInt(process.argv[i + 1], 10);
  return isNaN(v) ? def : v;
}

function readStrArg(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : def;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== burn-spear-mobile ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no reveals)' : PILOT ? 'PILOT (10 reveals)' : 'LIVE'}`);
  console.log(`Tiers: ${TIERS.join(', ')}`);
  console.log(`Limit: ${LIMIT} ${DRY_RUN ? 'domains to inspect' : 'reveals max'}`);
  console.log(`Offset: ${OFFSET}`);
  console.log(`Resume: ${RESUME}${RESUME && NO_RETRY_FAILED ? ' (no-retry-failed)' : ''}`);
  console.log(`Webhook: ${WEBHOOK_URL}`);
  console.log(`Journal: ${JOURNAL_PATH}`);
  console.log(`Cost model: 9 credits/reveal (8 mobile + 1 enrichment)`);

  const allDomains = await getTargetDomains();
  console.log(`\nTarget domains in DB: ${allDomains.length}`);

  const latestJournal = RESUME ? readJournalLatest() : new Map();
  let resumeSkipped = 0;
  const domains = allDomains.slice(OFFSET).filter(d => {
    if (!RESUME) return true;
    const skip = shouldSkipOnResume(latestJournal.get(d.domain));
    if (skip) resumeSkipped++;
    return !skip;
  });
  if (RESUME) console.log(`Resume: skipping ${resumeSkipped} already-resolved domains`);
  console.log(`Domains to process: ${domains.length}\n`);

  let revealed = 0;
  let processed = 0;
  let noOrgMatch = 0;
  let noCandidates = 0;
  let errors = 0;
  let domainIdx = 0;

  // SIGTERM handler — allows `kill -TERM <pid>` to cleanly pause mid-run.
  // Flag is checked between iterations so we always finish the current
  // domain (including any in-flight reveal POST + journal commit) before
  // exiting. Prevents orphaned `attempt` journal entries that would cause
  // double-billing on --resume. Matches the behavior Linus review called
  // out as MAJOR #4.
  let shuttingDown = false;
  process.on('SIGTERM', () => {
    if (!shuttingDown) {
      console.log('\n[SIGTERM] graceful shutdown requested — will exit after current domain');
      shuttingDown = true;
    }
  });
  process.on('SIGINT', () => {
    if (!shuttingDown) {
      console.log('\n[SIGINT] graceful shutdown requested — will exit after current domain');
      shuttingDown = true;
    }
  });

  for (const { domain, company_name: companyName, signal_tier: tier } of domains) {
    domainIdx++;
    if (shuttingDown) {
      console.log(`\n[SHUTDOWN] stopping between domains at ${domainIdx - 1}/${domains.length} (reveals=${revealed})`);
      break;
    }
    if (DRY_RUN && processed >= LIMIT) {
      console.log(`\n[LIMIT] dry-run domain limit reached: ${processed}/${LIMIT}`);
      break;
    }
    if (!DRY_RUN && revealed >= LIMIT) {
      console.log(`\n[LIMIT] reveal budget reached: ${revealed}/${LIMIT}`);
      break;
    }
    processed++;

    try {
      const org = await apolloOrgSearch(domain, companyName);
      await sleep(REQ_DELAY_MS);
      if (!org) {
        noOrgMatch++;
        appendJournal({ ts: new Date().toISOString(), domain, tier, state: 'skipped', reason: 'no_org_match' });
        continue;
      }

      const previews = await apolloPeopleSearch(org.id);
      await sleep(REQ_DELAY_MS);

      if (!DRY_RUN) await cachePreviewsForDomain(domain, previews);

      const top = pickTopContact(previews);
      if (!top) {
        noCandidates++;
        appendJournal({ ts: new Date().toISOString(), domain, tier, state: 'skipped', reason: 'no_ranked_candidate', preview_count: previews.length });
        console.log(`[${domainIdx}/${domains.length}] ${domain}: no qualifying contact (previews=${previews.length})`);
        continue;
      }

      const scoreVal = scoreTitle(top.title);
      console.log(`[${domainIdx}/${domains.length}] ${domain.padEnd(45)} → ${(top.title || '?').padEnd(42)} (score=${scoreVal}, tier=${tier})`);

      if (DRY_RUN) continue;

      await upsertContactRow(domain, companyName || org.name, top);
      appendJournal({ ts: new Date().toISOString(), domain, tier, state: 'attempt', apollo_person_id: top.id, title: top.title });

      try {
        await apolloReveal(top.id);
        appendJournal({ ts: new Date().toISOString(), domain, tier, state: 'committed', apollo_person_id: top.id, title: top.title, score: scoreVal });
        revealed++;
      } catch (revealErr) {
        const status = revealErr instanceof ApolloError ? revealErr.status : 0;
        const msg = revealErr.message || String(revealErr);
        appendJournal({ ts: new Date().toISOString(), domain, tier, state: 'failed', apollo_person_id: top.id, error: msg, status });
        errors++;
        console.error(`[reveal-fail ${domainIdx}/${domains.length}] ${domain}: ${msg}`);
      }
      await sleep(REQ_DELAY_MS);

      if (revealed > 0 && revealed % 25 === 0) {
        console.log(`\n[progress] ${revealed} reveals fired, ${noOrgMatch} no-org, ${noCandidates} no-candidate, ${errors} errors\n`);
      }
    } catch (err) {
      errors++;
      const status = err instanceof ApolloError ? err.status : 0;
      const msg = err.message || String(err);
      console.error(`[error ${domainIdx}/${domains.length}] ${domain}: ${msg}`);
      appendJournal({ ts: new Date().toISOString(), domain, tier, state: 'failed', error: msg, status });
      await sleep(REQ_DELAY_MS * 2);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Domains processed: ${processed}`);
  console.log(`Reveals fired:     ${revealed}`);
  console.log(`No org match:      ${noOrgMatch}`);
  console.log(`No candidate:      ${noCandidates}`);
  console.log(`Errors:            ${errors}`);
  console.log(`Mobile credits spent: ~${revealed * 8}`);
  console.log(`General credits spent: ~${revealed * 1}`);
  console.log(`Total credits spent: ~${revealed * 9}`);

  await pool.end();
  await httpAgent.close();
}

main().catch(async (err) => {
  console.error('FATAL:', err.message);
  // Best-effort cleanup with a 5s overall ceiling. pool.end() can hang
  // indefinitely if a pg client is stuck on a broken connection; we'd rather
  // exit dirty than leave the process alive. Journal is fsync'd per entry,
  // so we're not losing any data by exiting abruptly.
  const cleanup = Promise.allSettled([
    pool.end().catch(() => {}),
    // destroy() not close() — we're on a crash path. close() waits for
    // in-flight responses which may never come. destroy() aborts immediately.
    httpAgent.destroy().catch(() => {}),
  ]);
  await Promise.race([cleanup, sleep(5000)]);
  process.exit(1);
});
