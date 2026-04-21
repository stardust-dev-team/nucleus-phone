#!/usr/bin/env node
/**
 * scripts/resolve-signal-domains-v2.js
 *
 * Replaces resolve-signal-domains.js for the April 2026 SPEAR/TARGETED cohort.
 * Old script used Apollo /organizations/search as the free strategy — but
 * that endpoint now costs ~0.38 enrichment credits per call (confirmed
 * 2026-04-20 via test-rereveal.js ledger delta). Apollo's "free" tier
 * shrank; we need a new free pre-filter.
 *
 * Strategy chain (stops at first hit):
 *   1. Known-company map          — instant, free
 *   2. LinkedIn typeahead (free)  — confirms company exists on LinkedIn,
 *                                   returns canonical name + URN via our
 *                                   existing ads token quota (no credits)
 *   3. DataForSEO Google SERP     — only called for LinkedIn-hit companies,
 *                                   uses canonical LinkedIn name for better
 *                                   SERP accuracy than raw OASIS strings
 *
 * Companies with LinkedIn MISS are skipped entirely — if LinkedIn doesn't
 * know the company, Apollo won't have it for phone reveal either, so there's
 * no point spending DataForSEO credits (~$0.014 each) to find a domain
 * that has no downstream value.
 *
 * Updates both v35_signal_metadata and v35_lead_reservoir atomically.
 * Journal at ~/.joruva/signal-resolve-journal.jsonl for resumability.
 *
 * Usage:
 *   node scripts/resolve-signal-domains-v2.js --dry-run --limit 10
 *   node scripts/resolve-signal-domains-v2.js --limit 2669          # full burn
 *   node scripts/resolve-signal-domains-v2.js --resume              # skip journaled
 *   node scripts/resolve-signal-domains-v2.js --tiers spear         # narrow to spear
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── config ─────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const DATAFORSEO_AUTH = process.env.DATAFORSEO_AUTH;
const MC_URL = process.env.MULTICHANNEL_URL || 'https://joruva-multichannel.onrender.com';
const MC_API_KEY = process.env.MC_API_KEY; // header today is decorative (admin route unauth); set anyway

const DRY_RUN = process.argv.includes('--dry-run');
const RESUME = process.argv.includes('--resume');
const LIMIT = readIntArg('--limit', 2669);
const OFFSET = readIntArg('--offset', 0);
const TIERS = readStrArg('--tiers', 'spear,targeted').split(',').map(t => t.trim()).filter(Boolean);

const LINKEDIN_DELAY_MS = 500;  // ~2/sec — well under our ads quota
const DATAFORSEO_DELAY_MS = 1000; // ~1/sec — polite even though we pay per call
const JOURNAL_PATH = path.join(os.homedir(), '.joruva', 'signal-resolve-journal.jsonl');
const MAX_DFSEO_CALLS = 2500; // Hard cap on paid SERP calls. ~$35 ceiling at $0.014/call.
const LINKEDIN_MAX_RETRIES = 3;

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (!DATAFORSEO_AUTH) { console.error('DATAFORSEO_AUTH not set'); process.exit(1); }
if (!MC_API_KEY) { console.error('MC_API_KEY not set'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

// ── known-company map (instant, free) ──────────────────────────────────────
// Legal entity name != domain mapping. Copied from resolve-signal-domains.js
// so this script is self-contained.
const KNOWN_DOMAINS = {
  'lincoln electric': 'lincolnelectric.com',
  'xometry': 'xometry.com',
  'qorvo': 'qorvo.com',
  'hamilton sundstrand': 'collinsaerospace.com',
  'sidus space': 'sidus.space',
  'frequentis': 'frequentis.com',
  'marotta controls': 'marotta.com',
  'kamatics': 'kaman.com',
  'atrenne computing': 'atrenne.com',
  'curtiss-wright': 'curtisswright.com',
  'ducommun': 'ducommun.com',
  'l3harris': 'l3harris.com',
  'pcc airfoils': 'pccairfoils.com',
  'pcc structurals': 'pccstructurals.com',
  'mercury systems': 'mrcy.com',
  'mistras': 'mistrasgroup.com',
};

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// US state set for stripping from company names
const US_STATES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
  'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
  'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
  'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico',
  'new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania',
  'rhode island','south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
]);

function cleanCompanyName(name) {
  if (!name) return '';
  let n = name.trim()
    .replace(/\s*,?\s*(Inc|LLC|Corp|Corporation|Ltd|Limited|Co|Company|Group|LP|Holdings|PLC|GmbH|SA|AG)\.?\s*$/i, '')
    .replace(/\s+dba\s+/i, ' ').replace(/\s+d\/b\/a\s+/i, ' ')
    .replace(/[,.\s]+$/, '');
  const words = n.split(/\s+/);
  if (words.length >= 2) {
    const last = words[words.length - 1].toLowerCase();
    const lastTwo = words.length >= 3 ? words.slice(-2).join(' ').toLowerCase() : null;
    if (lastTwo && US_STATES.has(lastTwo)) n = words.slice(0, -2).join(' ');
    else if (US_STATES.has(last)) n = words.slice(0, -1).join(' ');
  }
  return n.replace(/[,.\s]+$/, '').trim();
}

// Jaccard name match — used to validate LinkedIn typeahead picks
const NAME_STOPWORDS = new Set([
  'the','a','and','&','of','for','inc','llc','ltd','corp','corporation',
  'company','co','dba','holdings','group','plc','lp','llp','pllc',
]);

function normalizeNameWords(name) {
  return new Set(
    (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w && !NAME_STOPWORDS.has(w) && w.length > 1),
  );
}

function nameJaccard(a, b) {
  const aw = normalizeNameWords(a);
  const bw = normalizeNameWords(b);
  if (aw.size === 0 || bw.size === 0) return 0;
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  return inter / (aw.size + bw.size - inter);
}

// ── journal ────────────────────────────────────────────────────────────────

// Every journal entry is tagged with mode ∈ {dry, live}. This prevents
// dry-run executions from poisoning subsequent --resume live runs: a
// dry-run "resolved" entry would otherwise look identical to a completed
// live update and cause the live run to silently skip the domain (Linus
// review MAJOR #2).
function appendJournal(entry) {
  fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
  const tagged = { ...entry, mode: DRY_RUN ? 'dry' : 'live' };
  const line = JSON.stringify(tagged) + '\n';
  const fd = fs.openSync(JOURNAL_PATH, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Returns Map<old_domain, latest_LIVE_entry>. Dry entries are ignored for
// resume purposes — only live state counts as "done."
function readJournalLatest() {
  if (!fs.existsSync(JOURNAL_PATH)) return new Map();
  const latest = new Map();
  for (const line of fs.readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e.old_domain && e.mode !== 'dry') latest.set(e.old_domain, e);
    } catch { /* torn line */ }
  }
  return latest;
}

// ── strategy 1: known map ──────────────────────────────────────────────────

function lookupKnown(cleanedName) {
  const lower = cleanedName.toLowerCase();
  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    if (lower.includes(key)) return { domain, source: 'known-map' };
  }
  return null;
}

// ── strategy 2: LinkedIn typeahead (free via our ads token) ────────────────
//
// Hits /admin/targeting-search on our multichannel Render service, which
// wraps LinkedIn's /rest/adTargetingEntities TYPEAHEAD endpoint. Returns
// the canonical LinkedIn name + URN for the best-match company. Used as
// a pre-filter: if LinkedIn has no match, we skip DataForSEO entirely.
//
// Returns null if LinkedIn has no confident match (Jaccard < 0.5 against
// cleaned OASIS name).
async function searchLinkedInTypeahead(cleanedName) {
  const url = `${MC_URL}/admin/targeting-search?facet=employers&query=${encodeURIComponent(cleanedName)}`;
  // Retry transient network / 429 / 5xx. Persistent failures bubble up so
  // caller journals as linkedin_error (retriable on future --resume runs).
  let resp;
  let lastErr;
  for (let attempt = 0; attempt <= LINKEDIN_MAX_RETRIES; attempt++) {
    try {
      resp = await fetch(url, {
        headers: { 'X-Api-Key': MC_API_KEY },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) break;
      if (resp.status === 429) {
        // Don't count 429s against the retry budget — sleep longer and try again.
        await sleep(30000);
        attempt--;
        continue;
      }
      if (resp.status >= 500 && attempt < LINKEDIN_MAX_RETRIES) {
        await sleep(1000 * Math.pow(3, attempt)); // 1s → 3s → 9s
        continue;
      }
      throw new Error(`linkedin ${resp.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt >= LINKEDIN_MAX_RETRIES) throw new Error(`linkedin after ${LINKEDIN_MAX_RETRIES} retries: ${err.message}`);
      await sleep(1000 * Math.pow(3, attempt));
    }
  }
  if (!resp || !resp.ok) throw lastErr || new Error('linkedin unknown error');

  const data = await resp.json();
  const results = data.results || [];
  if (results.length === 0) return null;

  // Rank all candidates by Jaccard vs cleanedName.
  // Short-name edge case (#4 from Linus review): when cleaned name has only
  // 1 significant word (e.g. "Wagner", "Apex", "Lee"), Jaccard alone is too
  // permissive — any candidate sharing that one word gets high score.
  // For those cases, require exact single-token equality AND raise threshold.
  const cleanedTokens = normalizeNameWords(cleanedName);
  const singleToken = cleanedTokens.size === 1;
  const threshold = singleToken ? 0.75 : 0.5;

  const scored = results
    .map(r => {
      const candTokens = normalizeNameWords(r.name);
      if (singleToken) {
        // Single-word case: the one token MUST appear exactly in the candidate.
        const only = [...cleanedTokens][0];
        if (!candTokens.has(only)) return { r, jac: 0 };
      }
      return { r, jac: nameJaccard(cleanedName, r.name) };
    })
    .sort((a, b) => b.jac - a.jac);
  const best = scored[0];
  if (!best || best.jac < threshold) return null;
  return { name: best.r.name, urn: best.r.urn };
}

// ── strategy 3: DataForSEO Google SERP ─────────────────────────────────────
// Copied verbatim from resolve-signal-domains.js (battle-tested).
const SKIP_DOMAINS = new Set([
  // Social / general
  'linkedin.com','facebook.com','twitter.com','x.com','wikipedia.org',
  'yelp.com','bbb.org','bloomberg.com','dnb.com','zoominfo.com',
  'crunchbase.com','glassdoor.com','indeed.com','mapquest.com',
  'yellowpages.com','manta.com','opencorporates.com','sec.gov','sam.gov',
  'usaspending.gov','google.com','youtube.com','amazon.com','govtribe.com',
  'govwin.com','fpds.gov','usajobs.gov','macroaxis.com',
  'buzzfile.com','chamberofcommerce.com','northdata.com','pitchbook.com',
  'cbinsights.com','owler.com','craft.co','rocketreach.co','leadiq.com',
  'apollo.io','datanyze.com','lusha.com','clearbit.com','builtwith.com',
  'iowabids.com','bidnet.com','govplanet.com','surplus.com','kompass.com',
  'hoovers.com','spoke.com','rev.com','trustpilot.com','g2.com',
  'capterra.com','yahoo.com','gao.gov','highergov.com',
  'napaonline.com','amd.com','motorcarparts.com',
  // Manufacturing / aerospace directories + trade publications that
  // outrank small-company sites on CNC-aerospace queries (Linus #7)
  'thomasnet.com','industrynet.com','mfg.com','machinedesign.com',
  'designworldonline.com','americanmachinist.com','modernmachineshop.com',
  'qualitymag.com','industryweek.com','aviationweek.com','flightglobal.com',
  'defensenews.com','aviationpros.com','aerospacemanufacturinganddesign.com',
  'mmsonline.com','ctemag.com','productionmachining.com',
]);

async function searchGoogle(name) {
  const resp = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${DATAFORSEO_AUTH}` },
    body: JSON.stringify([{ keyword: `${name} company website`, location_code: 2840, language_code: 'en', depth: 10 }]),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`dataforseo ${resp.status}`);
  const data = await resp.json();
  const items = data?.tasks?.[0]?.result?.[0]?.items;
  if (!items?.length) return null;

  for (const item of items) {
    if (item.type !== 'organic' || !item.url) continue;
    let domain;
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (SKIP_DOMAINS.has(domain)) continue;
    if ([...SKIP_DOMAINS].some(d => domain.endsWith('.' + d))) continue;
    if (/\.(za|uk|au|de|fr|jp|cn|ru|br|in|kr|es|it|nl|se|no|dk|fi|pl|cz)\b/.test(domain)) continue;
    return { domain, source: 'google', title: item.title };
  }
  return null;
}

// Validate that a SERP-returned domain plausibly matches the company we searched.
// Tightened per Linus review #5: strip legal-suffix stopwords before token
// compare (so "Company"/"Inc" don't count as overlap), and require EITHER
// ≥2 token overlap OR both a domain-slug hit AND a title-token hit. A single
// shared token (e.g. "Wagner" in both "Wagner Machine" and "wagner-tools.com")
// no longer passes.
function validateMatch(searchName, result) {
  const searchWords = [...normalizeNameWords(searchName)].filter(w => w.length >= 3);
  if (!searchWords.length) return false;

  const domainLower = result.domain.toLowerCase().replace(/\.[a-z]+$/, '');
  const titleStr = (result.title || '').toLowerCase();
  const titleWords = [...normalizeNameWords(titleStr)];

  const domainHits = searchWords.filter(w => domainLower.includes(w)).length;
  const titleHits = searchWords.filter(w => titleWords.includes(w)).length;

  // Primary: ≥2 tokens shared with domain OR title
  if (domainHits >= 2 || titleHits >= 2) return true;
  // Secondary: 1 domain hit + 1 title hit (evidence from two surfaces)
  if (domainHits >= 1 && titleHits >= 1) return true;
  // Otherwise reject — single-surface single-token match is too permissive
  return false;
}

// ── resolve chain ──────────────────────────────────────────────────────────

async function resolveCompany(companyName) {
  const cleaned = cleanCompanyName(companyName);
  if (!cleaned) return { skipReason: 'empty_name_after_clean' };

  // Strategy 1: known map
  const known = lookupKnown(cleaned);
  if (known) return { match: known };

  // Strategy 2: LinkedIn typeahead (pre-filter; skips DataForSEO if miss)
  let linkedin;
  try {
    linkedin = await searchLinkedInTypeahead(cleaned);
  } catch (err) {
    // Treat network errors on typeahead as retriable skip — do NOT fall
    // through to DataForSEO (which would cost money on bad-data input).
    return { skipReason: 'linkedin_error', error: err.message };
  }
  await sleep(LINKEDIN_DELAY_MS);

  if (!linkedin) return { skipReason: 'no_linkedin_match' };

  // Strategy 3: DataForSEO using LinkedIn canonical name (cleaner input)
  let google;
  try {
    google = await searchGoogle(linkedin.name);
  } catch (err) {
    return { skipReason: 'dataforseo_error', error: err.message, linkedin };
  }
  await sleep(DATAFORSEO_DELAY_MS);

  if (!google) return { skipReason: 'no_serp_match', linkedin };
  if (!validateMatch(linkedin.name, google)) return { skipReason: 'serp_validation_fail', linkedin, googleDomain: google.domain };
  return { match: { ...google, linkedinUrn: linkedin.urn, linkedinName: linkedin.name } };
}

// ── DB update (atomic across both tables) ──────────────────────────────────

async function updateDomain(oldDomain, newDomain) {
  const [smCheck, lrCheck] = await Promise.all([
    pool.query(`SELECT domain FROM v35_signal_metadata WHERE domain = $1`, [newDomain]),
    pool.query(`SELECT domain FROM v35_lead_reservoir WHERE domain = $1`, [newDomain]),
  ]);
  if (smCheck.rows.length > 0 || lrCheck.rows.length > 0) {
    return { skipped: true, reason: 'domain-collision' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE v35_signal_metadata SET domain = $1 WHERE domain = $2`, [newDomain, oldDomain]);
    await client.query(`UPDATE v35_lead_reservoir SET domain = $1 WHERE domain = $2`, [newDomain, oldDomain]);
    await client.query('COMMIT');
    return { skipped: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== resolve-signal-domains-v2 ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Tiers: ${TIERS.join(', ')}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Resume: ${RESUME}`);
  console.log(`Journal: ${JOURNAL_PATH}`);
  console.log(`LinkedIn via: ${MC_URL}`);
  console.log(`DataForSEO: ${DATAFORSEO_AUTH ? 'available' : 'MISSING'}\n`);

  const result = await pool.query(
    `SELECT sm.domain AS old_domain, lr.company_name, sm.signal_tier, sm.signal_score
     FROM v35_signal_metadata sm
     JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
     WHERE sm.domain LIKE '%.signal-pending'
       AND sm.signal_tier = ANY($1::text[])
     ORDER BY
       CASE sm.signal_tier WHEN 'spear' THEN 1 WHEN 'targeted' THEN 2 ELSE 3 END,
       sm.signal_score DESC NULLS LAST,
       sm.domain
     OFFSET $2 LIMIT $3`,
    [TIERS, OFFSET, LIMIT],
  );
  let companies = result.rows;

  const latestJournal = RESUME ? readJournalLatest() : new Map();
  let resumeSkipped = 0;
  if (RESUME) {
    companies = companies.filter(c => {
      const j = latestJournal.get(c.old_domain);
      if (j && (j.state === 'resolved' || j.state === 'skipped')) {
        resumeSkipped++;
        return false;
      }
      return true;
    });
    console.log(`Resume: skipping ${resumeSkipped} already-processed domains`);
  }
  console.log(`Processing ${companies.length} signal-pending domains\n`);

  const stats = {
    'known-map': 0, google: 0, noLinkedin: 0, noSerp: 0, serpValidationFail: 0,
    collision: 0, linkedinError: 0, dfseoError: 0, errors: 0,
  };

  // Hard cap on paid DataForSEO calls. Guards against a LinkedIn schema
  // change or data-poisoning incident that would otherwise pass the
  // Jaccard gate and let every domain hit SERP.
  let dfseoCallCount = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    const label = `[${String(i + 1).padStart(4)}/${companies.length}]`;
    if (dfseoCallCount >= MAX_DFSEO_CALLS) {
      console.log(`\n[BUDGET GUARD] Reached MAX_DFSEO_CALLS=${MAX_DFSEO_CALLS}. Stopping.`);
      break;
    }
    try {
      const outcome = await resolveCompany(c.company_name);
      // Count every SERP call that ran (whether matched or not). searchGoogle
      // bills DataForSEO on attempt, not success.
      if (outcome.match?.source === 'google') dfseoCallCount++;
      else if (outcome.skipReason === 'no_serp_match' || outcome.skipReason === 'serp_validation_fail') dfseoCallCount++;

      if (outcome.match) {
        let dbResult = { skipped: false };
        if (!DRY_RUN) {
          dbResult = await updateDomain(c.old_domain, outcome.match.domain);
        }
        if (dbResult.skipped) {
          stats.collision++;
          appendJournal({ ts: new Date().toISOString(), old_domain: c.old_domain, state: 'skipped', reason: 'domain_collision', new_domain: outcome.match.domain });
          console.log(`${label} ⚠ COLLISION  ${(c.company_name||'').slice(0,42).padEnd(42)} → ${outcome.match.domain} (already in use)`);
        } else {
          stats[outcome.match.source] = (stats[outcome.match.source] || 0) + 1;
          appendJournal({
            ts: new Date().toISOString(),
            old_domain: c.old_domain,
            state: 'resolved',
            source: outcome.match.source,
            new_domain: outcome.match.domain,
            tier: c.signal_tier,
            linkedin_urn: outcome.match.linkedinUrn,
            linkedin_name: outcome.match.linkedinName,
          });
          console.log(`${label} ✓ ${outcome.match.source.padEnd(10)} ${(c.company_name||'').slice(0,42).padEnd(42)} → ${outcome.match.domain}`);
        }
      } else {
        // Structured skip reasons make it easy to run a targeted retry later
        const reason = outcome.skipReason;
        if (reason === 'no_linkedin_match') stats.noLinkedin++;
        else if (reason === 'no_serp_match') stats.noSerp++;
        else if (reason === 'serp_validation_fail') stats.serpValidationFail++;
        else if (reason === 'linkedin_error') stats.linkedinError++;
        else if (reason === 'dataforseo_error') stats.dfseoError++;
        appendJournal({ ts: new Date().toISOString(), old_domain: c.old_domain, state: 'skipped', reason, error: outcome.error });
        if (reason === 'no_linkedin_match') {
          console.log(`${label} ✗ no-linkedin ${(c.company_name||'').slice(0,50)}`);
        } else {
          console.log(`${label} ✗ ${reason.padEnd(18)} ${(c.company_name||'').slice(0,40)}`);
        }
      }

      // Progress checkpoint
      if ((i + 1) % 100 === 0) {
        const resolved = (stats['known-map'] || 0) + stats.google;
        console.log(`\n[checkpoint ${i + 1}/${companies.length}] resolved=${resolved} no-linkedin=${stats.noLinkedin} no-serp=${stats.noSerp} errors=${stats.errors + stats.linkedinError + stats.dfseoError}\n`);
      }
    } catch (err) {
      stats.errors++;
      appendJournal({ ts: new Date().toISOString(), old_domain: c.old_domain, state: 'error', error: err.message });
      console.error(`${label} ! ${c.company_name} — ${err.message}`);
    }
  }

  const resolved = (stats['known-map'] || 0) + stats.google;
  console.log('\n=== RESULT ===');
  console.log(`Resolved:            ${resolved}`);
  console.log(`  Known map:         ${stats['known-map'] || 0}`);
  console.log(`  LinkedIn+Google:   ${stats.google}`);
  console.log(`Skipped:`);
  console.log(`  No LinkedIn match: ${stats.noLinkedin}  (would waste DataForSEO — correctly skipped)`);
  console.log(`  LinkedIn ok, no SERP: ${stats.noSerp}`);
  console.log(`  SERP validation fail: ${stats.serpValidationFail}`);
  console.log(`  Domain collision:  ${stats.collision}`);
  console.log(`  LinkedIn error:    ${stats.linkedinError}`);
  console.log(`  DataForSEO error:  ${stats.dfseoError}`);
  console.log(`Errors:              ${stats.errors}`);
  console.log(`Total processed:     ${companies.length}`);

  if (DRY_RUN) console.log(`\nDry run — no DB updates applied.`);
  else console.log(`\nDataForSEO SERP calls: ${dfseoCallCount} (~$${(dfseoCallCount * 0.014).toFixed(2)})`);

  await pool.end();
}

main().catch(err => { console.error('FATAL:', err.message, err.stack); process.exit(1); });
