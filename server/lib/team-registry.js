/**
 * team-registry.js — Canonical loader for the rep registry.
 *
 * Primary source:
 *   server/config/team.json         — committed, all per-rep config
 *                                     (identity, role, Slack ID, mobile, inbound DID, route type)
 *
 * Optional local-dev override:
 *   server/config/team-phones.json  — gitignored, identity → E.164 mobile
 *                                     If present, ITS entries OVERRIDE team.json's
 *                                     `mobile` field per-identity. Useful for sim-calling
 *                                     a test number on a dev machine without committing it.
 *                                     Not deployed to Render — production reads team.json only.
 *
 * All consumers that need per-rep config — escalation.js, sim.js, incoming.js,
 * sim-scorer.js, fireflies-sync.js, scoreboard.js — should load from here
 * rather than read the JSON files directly. This is the structural fix for the
 * 2026-05-19 Ryann/Tom drift incident: a single source of truth so the next
 * env-var-as-config drift can't happen at a different callsite.
 *
 * History: pre-2026-05-19 the inbound-routes-JSON-vs-env-var drift hid for
 * ~3 weeks because the env var was edited out-of-band on Render while 5
 * documented sources still described the old mapping. Linus's review on the
 * fix called out that escalation.js (PHONE_TOM, TOM_SLACK_USER_ID env vars)
 * had the SAME drift shape with no file backstop. This module is the fix.
 */

const fs = require('fs');
const path = require('path');

const TEAM_FILE = path.join(__dirname, '..', 'config', 'team.json');
const PHONES_FILE = path.join(__dirname, '..', 'config', 'team-phones.json');

// E.164: + followed by 7-15 digits (E.164 spec). Used by validators below.
const E164_RE = /^\+[1-9]\d{6,14}$/;

let cached = null;

/**
 * Load (and cache) the merged rep registry. Idempotent. Validates schema
 * at load time and throws if any rep has an invalid configuration —
 * boot-fail is preferable to a 500 on first request.
 */
function loadRegistry() {
  if (cached) return cached;

  const team = JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8'));
  if (!Array.isArray(team.members) || team.members.length === 0) {
    throw new Error('team-registry: team.json has no members');
  }

  // Optional local-dev override file. NOT deployed to Render — production
  // reads team.json's mobile field directly. When present, its entries
  // take precedence so a dev machine can swap in a test number without
  // editing the committed team.json.
  let phoneOverrides = {};
  if (fs.existsSync(PHONES_FILE)) {
    try {
      phoneOverrides = JSON.parse(fs.readFileSync(PHONES_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`team-registry: failed to parse team-phones.json: ${err.message}`);
    }
  }

  const byIdentity = new Map();
  const byDID = new Map();
  const inboundRoutes = {};

  for (const m of team.members) {
    if (!m.identity || typeof m.identity !== 'string') {
      throw new Error(`team-registry: member missing identity: ${JSON.stringify(m)}`);
    }
    if (byIdentity.has(m.identity)) {
      throw new Error(`team-registry: duplicate identity "${m.identity}"`);
    }

    // Mobile resolution: team-phones.json override beats team.json default.
    // Either source must produce a valid E.164; absent is allowed only for
    // reps without inbound.type=forward (validator below catches conflicts).
    const mobile = phoneOverrides[m.identity] || m.mobile || null;
    if (mobile && !E164_RE.test(mobile)) {
      throw new Error(`team-registry: rep "${m.identity}" mobile is not E.164: ${mobile}`);
    }

    const rep = {
      identity: m.identity,
      name: m.name,
      email: m.email,
      role: m.role,
      pronouns: m.pronouns,
      slackUserId: m.slackUserId || null,
      mobile,
      inbound: m.inbound || null,
    };
    byIdentity.set(m.identity, rep);

    // Inbound DID indexing + route derivation. A rep without inbound
    // (e.g., Britt — outbound-only) doesn't get indexed by DID and won't
    // appear in inboundRoutes. That's intentional: registry.getInboundRoute()
    // returns null for unmapped DIDs so the caller can render an
    // "unknown number" voicemail rather than crashing.
    if (m.inbound) {
      const { did, type } = m.inbound;
      if (!did || !E164_RE.test(did)) {
        throw new Error(`team-registry: rep "${m.identity}" inbound.did is not E.164: ${did}`);
      }
      if (byDID.has(did)) {
        throw new Error(`team-registry: duplicate inbound DID "${did}"`);
      }

      // `identity` is the rep's canonical, UNIQUE nucleus_phone_users key — carried on
      // the route so consumers can join to the users table without a second registry
      // lookup. Used by incoming.js to stamp the use_inhouse_stt gate (nucleus-phone-rgja.7);
      // do NOT join on `name`/display_name, which are cosmetic and drift.
      const route = { identity: m.identity, name: m.name, slack: m.slackUserId || '' };
      if (type === 'iosIdentity') {
        route.iosIdentity = m.inbound.iosIdentity || m.identity;
      } else if (type === 'forward') {
        if (!mobile) {
          throw new Error(
            `team-registry: rep "${m.identity}" has inbound.type=forward but no mobile in team-phones.json — ` +
            `either populate team-phones.json or change inbound.type to iosIdentity`
          );
        }
        route.forward = mobile;
      } else {
        throw new Error(`team-registry: rep "${m.identity}" has unknown inbound.type "${type}"`);
      }

      byDID.set(did, rep);
      inboundRoutes[did] = route;
    }
  }

  cached = {
    /** All reps, in declaration order. */
    reps: team.members.map(m => byIdentity.get(m.identity)),
    /** Lookup by string identity ("tom", "ryann", etc). Null if unknown. */
    getRepByIdentity: (id) => byIdentity.get(id) || null,
    /** Lookup by inbound DID E.164. Null if DID not in registry. */
    getRepByDID: (did) => byDID.get(did) || null,
    /** Inbound TwiML route for a DID. Returns { name, slack, forward? | iosIdentity? } or null. */
    getInboundRoute: (did) => inboundRoutes[did] || null,
    /** Full inbound route map — for code that wants to iterate all DIDs (validators, conformance tests). */
    getAllInboundRoutes: () => ({ ...inboundRoutes }),
  };
  return cached;
}

/**
 * Module-init wrapper: load the registry, log success ONCE, or process.exit(1)
 * with a FATAL log on validation failure. All three call sites (incoming.js,
 * escalation.js, sim.js) should use THIS function at their module-init
 * rather than inlining try/catch — Linus pass-3 review pointed out that
 * three independent try/catch blocks meant three inconsistent failure modes
 * (one process.exit, one runtime throw, one silent env-var fallback). One
 * place to fail loudly.
 *
 * Returns the registry on success. Never returns on failure (process.exit).
 *
 * Cached at the wrapper level (Linus pass-3 #5): the first successful call
 * caches the result so subsequent calls return immediately. This means:
 *   (a) only ONE "loaded N reps, M routes" log line at boot, not three
 *       (was: one per consumer — noisy);
 *   (b) a dynamic require() after startup (test setup, hot-reload, script)
 *       won't re-exit the process if team.json is corrupted between
 *       boot and that dynamic require — because the cached success
 *       short-circuits before re-reading the file.
 *
 * The consumer label is preserved in the FATAL log on first-call failure
 * so the operator knows which require triggered the boot crash, but on
 * the success path it appears only once (from the first consumer to
 * call this — typically incoming.js since server/index.js requires it
 * before escalation.js or sim.js).
 */
let cachedRegistry = null;

function loadRegistryOrExit(consumerLabel) {
  if (cachedRegistry) return cachedRegistry;
  try {
    const registry = loadRegistry();
    const routeCount = Object.keys(registry.getAllInboundRoutes()).length;
    console.log(`team-registry loaded (${registry.reps.length} reps, ${routeCount} inbound routes; first consumer=${consumerLabel})`);
    cachedRegistry = registry;
    return cachedRegistry;
  } catch (err) {
    console.error(`FATAL: team-registry load failed (consumer=${consumerLabel}):`, err.message);
    process.exit(1);
  }
}

/** Test-only: forget the cached registry so the next loadRegistry() re-reads files. */
function _resetForTesting() {
  cached = null;
  cachedRegistry = null;
}

module.exports = { loadRegistry, loadRegistryOrExit, _resetForTesting };
