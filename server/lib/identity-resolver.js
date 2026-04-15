/**
 * lib/identity-resolver.js — Thin hub client + adapter + TTL cache + fallback.
 *
 * Phase 2c (hub-spoke, bd joruva-ucil-537): resolution chain moved to UCIL at
 * GET /hub/contacts/resolve. This module:
 *   1. Calls the hub (RBAC auth via HUB_ADMIN_EMAIL + HUB_ADMIN_KEY env)
 *   2. Maps the hub's domain-neutral response → legacy ResolvedIdentity shape
 *      (so cockpit.js and call-screen UI don't change)
 *   3. Caches resolved identities in-process by phone/email for CACHE_TTL_MS
 *      (live cockpit is the hot caller — repeat loads are free)
 *   4. Falls back to inline resolution (identity-resolver-inline.js) if the
 *      hub is unreachable, so a UCIL outage doesn't black out incoming calls
 *
 * STALENESS: the TTL cache is time-based only. A HubSpot update to a contact
 * will not be visible to the spoke for up to CACHE_TTL_MS. This is a known
 * limitation — the proper fix is event-driven invalidation via a hub
 * `contact.updated` subscription (filed under a follow-up bead). Until then,
 * CACHE_TTL_MS is kept short (60s) so cockpit loads still feel live and
 * rare HubSpot edits are never more than a minute stale.
 *
 * Disable with USE_HUB_RESOLVER=false (reverts to inline fallback).
 */

const { resolve: resolveInline, toE164 } = require('./identity-resolver-inline');
const { normalizePhone } = require('./phone');

const HUB_URL = process.env.UCIL_HUB_URL || process.env.HUB_URL || 'https://joruva-ucil.onrender.com';
const HUB_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 1000;
// Negative results (unresolved) get a much shorter TTL. A recent HubSpot edit
// that landed during the 60s hit window would otherwise make the cockpit lie
// for a full minute after the person is enriched. 10s is the compromise:
// enough to absorb the same-call retry storm, short enough to recover fast.
const NEGATIVE_TTL_MS = 10 * 1000;
const USE_HUB = process.env.USE_HUB_RESOLVER !== 'false';

// Simple LRU-ish in-process cache keyed by `${type}:${normalized}`.
// Bounded at 500 entries — identity lookups are cheap and this protects memory.
const cache = new Map();
const CACHE_MAX = 500;

// Fallback instrumentation — how often are we running on inline because the
// hub was unreachable? During a hub outage this counter climbs fast, and the
// caller surface (cockpit) is silently degraded (Apollo/Dropcontact disabled
// in fallback per design). Expose it for /health + /metrics so ops sees it.
const fallbackCounter = { total: 0, lastAt: null, lastError: null };
function fallbackMetrics() { return { ...fallbackCounter }; }

function cacheKey(identifier) {
  if (!identifier) return null;
  if (identifier.includes('@')) return `email:${identifier.toLowerCase()}`;
  const n = normalizePhone(identifier);
  if (n) return `phone:${n}`;
  if (/^\d+$/.test(identifier)) return `hsid:${identifier}`;
  return null;
}

function cacheGet(key) {
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  // refresh LRU order
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  if (!key) return;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  const ttl = value && value.resolved ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  cache.set(key, { value, expires: Date.now() + ttl });
}

function clearCache() { cache.clear(); }

// ── Hub client ─────────────────────────────────────────────

async function callHub(identifier) {
  const email = process.env.HUB_ADMIN_EMAIL;
  const key = process.env.HUB_ADMIN_KEY;
  if (!email || !key) {
    throw new Error('HUB_ADMIN_EMAIL + HUB_ADMIN_KEY not configured');
  }

  const params = new URLSearchParams();
  if (identifier.includes('@')) params.set('email', identifier);
  else if (/^\d+$/.test(identifier)) params.set('hubspot_contact_id', identifier);
  else params.set('phone', identifier);

  const resp = await fetch(`${HUB_URL}/hub/contacts/resolve?${params}`, {
    headers: {
      'X-Hub-Admin-Email': email,
      'X-Hub-Admin-Key': key,
    },
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Hub resolver ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  }
  return resp.json();
}

// ── Adapter: hub shape → legacy ResolvedIdentity ───────────

// Extract a phone string for the unresolved path, branching on identifier type.
// Piping emails or HubSpot IDs through normalizePhone happened to yield null by
// accident; branch explicitly so the shape is obviously correct.
function identifierPhone(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  if (identifier.includes('@')) return null;          // email
  if (/^\d{11,}$/.test(identifier)) return null;      // HubSpot ID (opaque numeric)
  return toE164(normalizePhone(identifier));          // phone
}

function adapt(hubResult, identifier) {
  if (!hubResult || hubResult.found === false) {
    return {
      resolved: false,
      hubspotContactId: null,
      hubspotCompanyId: null,
      name: null,
      email: null,
      phone: hubResult?.contact?.phone || identifierPhone(identifier),
      company: null,
      title: null,
      linkedinUrl: null,
      profileImage: null,
      pbContactData: null,
      fitScore: null,
      fitReason: null,
      persona: null,
      source: 'unknown',
    };
  }

  const c = hubResult.contact || {};
  const co = hubResult.company || {};
  const e = hubResult.enrichments || {};
  const sources = hubResult.sources || [];

  // Legacy `source` is single-valued: first wins in priority order.
  // `hub_contacts` aliases to `hubspot` because cockpit.js doesn't know the
  // write-through cache exists — a warm hub_contacts hit originated in
  // HubSpot and we shouldn't surface a new string value.
  const priority = ['hubspot', 'v35_pb_contacts', 'apollo', 'dropcontact', 'hub_contacts'];
  const legacyAlias = { v35_pb_contacts: 'pb_contacts', hub_contacts: 'hubspot' };
  let source = 'unknown';
  for (const s of priority) {
    if (sources.includes(s)) { source = legacyAlias[s] || s; break; }
  }

  const pb = e.pb_contact;
  return {
    resolved: true,
    hubspotContactId: c.hubspot_contact_id || null,
    hubspotCompanyId: co.hubspot_company_id || null,
    name: c.name || null,
    email: c.email || e.dropcontact_email || null,
    phone: c.phone || identifierPhone(identifier),
    company: co.name || null,
    title: c.title || null,
    linkedinUrl: c.linkedin_url || null,
    profileImage: pb?.profile_image || null,
    pbContactData: pb ? {
      summary: pb.summary,
      industry: pb.industry,
      location: pb.location,
      companyLocation: pb.company_location,
      durationInRole: pb.duration_in_role,
      durationInCompany: pb.duration_in_company,
      pastExperience: pb.past_experience,
      connectionDegree: pb.connection_degree,
    } : null,
    fitScore: e.hubspot?.fit_score || null,
    fitReason: e.hubspot?.fit_reason || null,
    persona: e.hubspot?.persona || null,
    source,
  };
}

// ── Public API ─────────────────────────────────────────────

async function resolve(identifier) {
  if (!identifier) return adapt(null, identifier);

  const key = cacheKey(identifier);
  const cached = cacheGet(key);
  if (cached) return cached;

  if (USE_HUB) {
    try {
      const hubResult = await callHub(identifier);
      const identity = adapt(hubResult, identifier);
      cacheSet(key, identity);
      return identity;
    } catch (err) {
      // Structured fallback signal. The hub being unreachable silently
      // disables Apollo + Dropcontact (per design — avoid double-spending
      // against the hub's daily counter), so ops needs to see this clearly.
      // The counter feeds /health so the Joruva supervisor (CLAUDE.md
      // policy: caller must NEVER hear silence) can page on sustained
      // fallback activity.
      fallbackCounter.total += 1;
      fallbackCounter.lastAt = new Date().toISOString();
      fallbackCounter.lastError = err.message;
      console.warn(JSON.stringify({
        event: 'hub_resolver_fallback',
        error: err.message,
        fallback_total: fallbackCounter.total,
        ts: fallbackCounter.lastAt,
      }));
      // Inline fallback path — do NOT cache the result. Caching the degraded
      // identity for 60s (or even 10s) means the hub's recovery is invisible
      // to repeat callers until the TTL expires. Let every call through to
      // inline during the outage; inline has its own internal caches.
      return resolveInline(identifier);
    }
  }

  // USE_HUB=false (explicit rollback). Use inline and cache normally.
  const identity = await resolveInline(identifier);
  cacheSet(key, identity);
  return identity;
}

module.exports = { resolve, clearCache, fallbackMetrics, _adapt: adapt };
