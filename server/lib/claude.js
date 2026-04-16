/**
 * lib/claude.js — Claude API rapport intelligence module.
 * Generates pre-call briefings from assembled contact data.
 */

const { logEvent } = require('./debug-log');
const { touch } = require('./health-tracker');
const { throwHttpError } = require('./http-error');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const CACHE_VERSION = 2; // Bump when prompt or data shape changes
const FETCH_TIMEOUT = 6000; // 6 seconds

// Compact product catalog for Claude prompt — confirmed-pricing SKUs only.
// Source: compressor-catalog.js + sizing-engine.js (read-only, not imported to avoid coupling)
// Last synced: 2026-04-04. If prices change in source files, update this string.
const PRODUCT_CATALOG = `Joruva Industrial products (confirmed pricing):
Compressors: JRS-7.5E 7.5HP 28CFM $7,495 | JRS-10E 10HP 38CFM $9,495 | JRS-30 30HP 125CFM $19,500 (direct)
Dryers (refrigerated): JRD-30 $2,195 | JRD-40 $2,495 | JRD-60 $2,895 | JRD-80 $3,195 | JRD-100 $3,595
Dryers (desiccant, -60°F, molecular sieve, wall-mount): JDD-40 40CFM $7,495 | JDD-80 80CFM $11,895
Filters: JPF-70 particulate 1µm $399 | JPF-130 $499 | JCF-70 coalescing 0.01µm $349 | JCF-130 $449
OWS (oil-water separator): OWS75 $234 | OWS150 $1,092
Larger systems (30HP+): direct sale, custom quote required.
For AS9100/aerospace: recommend desiccant dryer + coalescing filter. General mfg: refrigerated dryer.`;

// In-memory cache: Map<string, { data, expiresAt }>
const cache = new Map();
const MAX_CACHE_SIZE = 200;

// Sweep expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

const SYSTEM_PROMPT = `You are a rapport-first intelligence analyst for Joruva Industrial, a compressed air systems distributor. Your job is to prepare a sales caller with a pre-call briefing.

Given contact data, produce a JSON object with these fields:

- rapport_starters: Array of 4-5 conversation openers based on REAL data. Use career history, tenure, past experience, company context, location, cert status, industry signals. NEVER fabricate facts.
- intel_nuggets: Array of 4-5 buying signals, equipment context, compliance notes, or competitive positioning points.
- opening_line: A natural, warm opening line referencing something specific about their company or role. Use their first name.
- adapted_script: A 3-5 sentence tactical paragraph: what to lead with, what angle works for this title/industry, which product to recommend first and why, what NOT to do. Be specific and tactical, not generic.
- watch_outs: Array of 1-3 things to avoid (competitor mentions, past complaints, sensitivity).
- product_reference: Array of 2-5 specific products from the catalog below, formatted as "MODEL — specs, $price. Use case." Match products to the contact's industry, company size, and compliance requirements.

${PRODUCT_CATALOG}

SIGNAL METADATA RULES:
- Cert expiry within 9 months: mention recertification as a hook. If cert_body known, reference it naturally.
- DoD/government contracts: reference compliance or mil-spec requirements. Use contract_total for scale.
- SPEAR-tier: direct, high-value opener referencing the specific signal.
- TARGETED-tier: reference industry fit.
- Adapt to TITLE: VP Ops → uptime; QA → compliance; Purchasing → cost; Maintenance → reliability.
- NEVER mention tiers, scores, or signal data by name.

COMPANY VERNACULAR RULES:
- When companyVernacular includes equipment, pain points, or competitors: reference them in intel_nuggets. Equipment context is gold — "I see you're running a 25HP piston" is 10x better than generic pitch.
- When tenKInsights or leadershipStrategy is present: weave business strategy into rapport_starters naturally. "I know Parker is focused on the Win Strategy 3.0 simplification initiative" shows research.
- When complianceContext has violations: reference compliance pressure without being accusatory.
- When capitalEquipment has procurement data: reference recent equipment purchases to gauge buying patterns.

EMAIL ENGAGEMENT RULES:
- When emailEngagement shows opens/clicks: reference interest indirectly ("I know you've been looking at our content on air quality") — never say "I see you opened our email."

CAREER CONTEXT RULES:
- When pastExperience is present: use career transitions for rapport ("Your background at Esterline must give you a strong perspective on...").
- When durationInRole is short (<12 months): note they may be evaluating vendors and establishing relationships.

Respond with ONLY valid JSON, no markdown fences.`;

function cacheKey(contactData) {
  const id = contactData.hubspotContactId
    || contactData.phone
    || contactData.email
    || 'unknown';
  return `${id}_v${CACHE_VERSION}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  // Evict oldest if at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

// Map contact titles to their likely priority when discussing compressed air systems
const TITLE_ANGLES = {
  'operations':  { topic: 'operational efficiency', hook: 'uptime and throughput' },
  'quality':     { topic: 'compliance and audit readiness', hook: 'certification requirements' },
  'maintenance': { topic: 'equipment reliability', hook: 'maintenance costs and downtime' },
  'purchasing':  { topic: 'cost optimization', hook: 'total cost of ownership' },
  'plant':       { topic: 'plant performance', hook: 'capacity and reliability' },
  'engineering': { topic: 'system design', hook: 'specs and performance requirements' },
  'facilities':  { topic: 'facility infrastructure', hook: 'system reliability and efficiency' },
  'supply':      { topic: 'supply chain continuity', hook: 'equipment lead times' },
};

function titleAngle(title) {
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const [key, angle] of Object.entries(TITLE_ANGLES)) {
    if (lower.includes(key)) return angle;
  }
  return null;
}

function buildFallback(contactData) {
  const name = contactData.name || 'there';
  const firstName = name.split(' ')[0];
  const signal = contactData.signalMetadata;
  const starters = [];
  const nuggets = [];
  let opener = '';

  // Signal-driven content
  if (signal) {
    // Cert expiry — strongest conversation hook
    if (signal.cert_expiry_date && signal.cert_standard) {
      const expiry = new Date(signal.cert_expiry_date);
      const monthsOut = Math.round((expiry - Date.now()) / (30 * 24 * 60 * 60 * 1000));
      const expiryStr = expiry.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const certName = signal.cert_standard;

      const bodyRef = signal.cert_body ? ` (${signal.cert_body})` : '';
      const isExpired = expiry < Date.now();

      if (isExpired) {
        starters.push(`Their ${certName} cert appears expired${bodyRef} — recertification is urgent`);
        nuggets.push(`${certName} expired — compliance gap is a strong opening for equipment audit conversations`);
      } else if (monthsOut <= 9) {
        starters.push(`Their ${certName} cert expires ${expiryStr}${bodyRef} — ask about recertification timeline`);
        nuggets.push(`${certName} renewal in ${monthsOut} months — compressed air system compliance is often part of recertification audits`);
      } else {
        starters.push(`They hold ${certName} certification${bodyRef} — reference quality/compliance standards`);
      }
    }

    // DoD / government contracts
    if (signal.dod_flag) {
      const contractStr = signal.contract_total
        ? ` (${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(signal.contract_total)} in contracts)`
        : '';
      nuggets.push(`Active DoD contractor${contractStr} — mil-spec and ITAR compliance likely matter`);
      starters.push('Reference their government/defense work — ask about compliance requirements for shop floor equipment');
    }

    // Signal source context
    const sources = signal.signal_sources;
    if (Array.isArray(sources) && sources.length) {
      nuggets.push(`Flagged via ${sources.join(', ')} — confirms active government/procurement presence`);
    }

    // Tier-based opener
    if (signal.signal_tier === 'SPEAR') {
      opener = `Hi ${firstName}, this is Tom from Joruva Industrial — we work with aerospace and defense manufacturers on their compressed air systems.`;
    } else if (signal.signal_tier === 'TARGETED') {
      opener = `Hi ${firstName}, this is Tom from Joruva Industrial — we specialize in compressed air systems for manufacturers in your space.`;
    }
  }

  // Title-specific talking point
  const angle = titleAngle(contactData.title);
  if (angle) {
    starters.push(`As ${contactData.title}, they likely care about ${angle.topic} — lead with ${angle.hook}`);
  }

  // Pad to at least 2 starters with generic fallbacks
  if (contactData.company && starters.length < 2) {
    starters.push(`Ask about their role at ${contactData.company}`);
  }
  if (contactData.title && !angle && starters.length < 2) {
    starters.push(`Reference their work as ${contactData.title}`);
  }
  if (!starters.length) starters.push('Start with a warm introduction about Joruva Industrial');

  // Default opener if signal didn't set one
  if (!opener) {
    opener = contactData.company
      ? `Hi ${firstName}, this is Tom from Joruva Industrial — do you have a moment to talk about your compressed air setup at ${contactData.company}?`
      : `Hi ${firstName}, this is Tom from Joruva Industrial.`;
  }

  // PB enrichment context
  const pb = contactData.pbContactData;
  if (pb?.industry) nuggets.push(`Industry: ${pb.industry}`);
  if (pb?.location) nuggets.push(`Location: ${pb.location}`);

  // Career context from PB data
  if (pb?.durationInRole) {
    const months = parseInt(pb.durationInRole, 10);
    const tenure = !isNaN(months) && months <= 12
      ? 'relatively new — may be evaluating vendors'
      : !isNaN(months)
        ? 'established — knows the operation well'
        : '';
    starters.push(`${pb.durationInRole} in current role${tenure ? ` — ${tenure}` : ''}`);
  }
  if (pb?.pastExperience) {
    const past = typeof pb.pastExperience === 'object'
      ? `Previously ${pb.pastExperience.title} at ${pb.pastExperience.company}${pb.pastExperience.duration ? ` (${pb.pastExperience.duration})` : ''}`
      : `Previous: ${pb.pastExperience}`;
    starters.push(past);
  }

  // Company vernacular context
  const vern = contactData.companyVernacular;
  if (vern?.equipment?.length) {
    nuggets.push(`Equipment: ${vern.equipment.slice(0, 2).join('; ')}`);
  }
  if (vern?.painPoints?.length) {
    nuggets.push(`Known pain: ${vern.painPoints.slice(0, 3).join(', ')}`);
  }
  if (vern?.competitorsMentioned?.length) {
    nuggets.push(`Competitors mentioned: ${vern.competitorsMentioned.slice(0, 3).join(', ')}`);
  }
  if (vern?.leadershipStrategy) {
    starters.push(`Company strategy: ${vern.leadershipStrategy}`);
  }

  // Lead reservoir enrichment
  const icp = contactData.icpScore;
  if (icp?.industry_description && !pb?.industry) nuggets.push(`Industry: ${icp.industry_description}`);
  if (icp?.employee_range) nuggets.push(`Company size: ${icp.employee_range} employees`);
  if (icp?.geo_city && icp?.geo_state && !pb?.location) {
    nuggets.push(`Location: ${icp.geo_city}, ${icp.geo_state}`);
  }

  // Email engagement
  const engagement = contactData.emailEngagement;
  if (engagement?.length) {
    const opens = engagement.filter(e => e.event_type === 'open').length;
    const clicks = engagement.filter(e => e.event_type === 'click').length;
    const campaign = engagement[0]?.campaign_name;
    let engStr = `Email activity: ${opens} opens, ${clicks} clicks`;
    if (campaign) engStr += ` (${campaign})`;
    nuggets.push(engStr);
  }

  // Product recommendations based on industry/cert
  const products = [];
  const isAerospace = signal?.cert_standard?.includes('AS9100')
    || pb?.industry?.toLowerCase().includes('aerospace')
    || pb?.industry?.toLowerCase().includes('aviation');

  if (isAerospace) {
    products.push('JRS-10E — 10HP, 38 CFM @ 150 PSI, $9,495. Enclosed rotary screw.');
    products.push('JDD-40 — Desiccant dryer, -60°F dewpoint, 40 CFM, $7,495. Molecular sieve, wall-mount. For AS9100.');
    products.push('JCF-70 — Coalescing filter, 0.01 micron, $349. Oil-free air for aerospace.');
  } else {
    products.push('JRS-10E — 10HP, 38 CFM @ 150 PSI, $9,495. Enclosed rotary screw.');
    products.push('JRD-40 — Refrigerated dryer, 40 CFM, $2,495. General manufacturing.');
    products.push('JPF-70 — Particulate pre-filter, 1 micron, $399. Upstream of dryer.');
  }

  // Adapted script — tactical paragraph
  let script = '';
  if (angle && vern?.painPoints?.length) {
    script = `Lead with ${angle.topic} — they have known pain (${vern.painPoints[0]}). Frame Joruva's value around ${angle.hook}. `;
    script += isAerospace
      ? 'Recommend desiccant dryer + coalescing filter for AS9100 air quality compliance.'
      : 'Start with the JRS-10E rotary screw and JRD-40 refrigerated dryer for general manufacturing.';
  } else if (angle) {
    script = `Focus on ${angle.topic}. Frame Joruva's value around ${angle.hook}.`;
    if (pb?.summary) script += ` Context: ${pb.summary.substring(0, 120)}`;
  } else if (pb?.summary) {
    script = `This contact's background: ${pb.summary.substring(0, 150)}. Tailor your approach accordingly.`;
  }

  return {
    fallback: true,
    rapport_starters: starters.slice(0, 5),
    intel_nuggets: nuggets.slice(0, 5),
    opening_line: opener,
    adapted_script: script,
    watch_outs: [
      ...(signal?.dod_flag ? ['Avoid discussing specific contract details — let them bring it up'] : []),
      ...(vern?.competitorsMentioned?.length ? [`They know ${vern.competitorsMentioned[0]} — be ready with differentiators`] : []),
    ].slice(0, 3),
    product_reference: products,
  };
}

/**
 * Trim assembled data to only the fields Claude needs for rapport generation.
 * Prevents sending raw DB rows and interaction arrays into the prompt.
 */
function trimForClaude(contactData) {
  const history = contactData.interactionHistory;
  const vern = contactData.companyVernacular;

  // Truncate long HubSpot text fields to stay within ~1,600 token user message budget
  const truncate = (s, max) => s ? String(s).substring(0, max) : null;

  return {
    name: contactData.name,
    company: contactData.company,
    title: contactData.title,
    pbContactData: contactData.pbContactData ? {
      summary: truncate(contactData.pbContactData.summary, 200),
      industry: contactData.pbContactData.industry ?? null,
      location: contactData.pbContactData.location ?? null,
      durationInRole: contactData.pbContactData.durationInRole ?? null,
      pastExperience: contactData.pbContactData.pastExperience ?? null,
      connectionDegree: contactData.pbContactData.connectionDegree ?? null,
    } : null,
    icpScore: contactData.icpScore ? {
      icp_score: contactData.icpScore.icp_score ?? null,
      prequalify_class: contactData.icpScore.prequalify_class ?? null,
      industry_description: contactData.icpScore.industry_description ?? null,
      employee_range: contactData.icpScore.employee_range ?? null,
      geo_city: contactData.icpScore.geo_city ?? null,
      geo_state: contactData.icpScore.geo_state ?? null,
    } : null,
    interactionCount: history?.interactionCount || 0,
    lastInteractionSummary: history?.lastInteractionSummary ?? null,
    productsDiscussed: history?.productsDiscussed || [],
    recentInteractions: (history?.interactions || []).slice(0, 5).map(i => ({
      channel: i.channel, summary: i.summary, disposition: i.disposition,
    })),
    priorCallCount: contactData.priorCalls?.length || 0,
    recentCallNotes: (contactData.priorCalls || []).slice(0, 3).map(c => ({
      disposition: c.disposition, qualification: c.qualification, notes: c.notes,
    })),
    emailEngagement: (contactData.emailEngagement || []).slice(0, 5).map(e => ({
      event_type: e.event_type, campaign_name: e.campaign_name ?? null,
    })),
    signalMetadata: contactData.signalMetadata ? {
      signal_tier: contactData.signalMetadata.signal_tier,
      signal_score: contactData.signalMetadata.signal_score,
      cert_expiry_date: contactData.signalMetadata.cert_expiry_date,
      cert_standard: contactData.signalMetadata.cert_standard,
      cert_body: contactData.signalMetadata.cert_body,
      contract_total: contactData.signalMetadata.contract_total,
      dod_flag: contactData.signalMetadata.dod_flag,
      source_count: contactData.signalMetadata.source_count,
      signal_sources: Array.isArray(contactData.signalMetadata.signal_sources)
        ? contactData.signalMetadata.signal_sources : null,
    } : null,
    // Company vernacular (truncated for prompt budget)
    companyVernacular: vern ? {
      equipment: (vern.equipment || []).slice(0, 5),
      painPoints: (vern.painPoints || []).slice(0, 5),
      productsDiscussed: (vern.productsDiscussed || []).slice(0, 5),
      competitorsMentioned: (vern.competitorsMentioned || []).slice(0, 3),
      certContext: vern.certContext ?? null,
      hubspotVernacular: truncate(vern.hubspotVernacular, 500),
      tenKInsights: truncate(vern.tenKInsights, 500),
      leadershipStrategy: vern.leadershipStrategy ?? null,
      complianceContext: truncate(vern.complianceContext, 300),
      capitalEquipment: truncate(vern.capitalEquipment, 300),
    } : null,
    // Pipeline context
    pipelineSegment: contactData.pipelineData?.[0]?.segment ?? null,
    discoverySource: contactData.pipelineData?.[0]?.discovery_source ?? null,
  };
}

async function generateRapportIntel(contactData) {
  const key = cacheKey(contactData);
  const cached = getCached(key);
  if (cached) return cached;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — returning fallback');
    return buildFallback(contactData);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const trimmed = trimForClaude(contactData);

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Generate a pre-call briefing for this contact:\n\n${JSON.stringify(trimmed, null, 2)}`,
        }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throwHttpError(resp, body, 'POST', 'v1/messages', { service: 'Claude' });
    }

    const result = await resp.json();
    const text = result.content?.[0]?.text;
    if (!text) throw new Error('Empty Claude response');

    const intel = JSON.parse(text);
    intel.fallback = false;
    touch('anthropic');
    setCache(key, intel);
    return intel;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('Claude API timed out after 6s — returning fallback');
      logEvent('integration', 'anthropic', 'timeout after 6s', { level: 'warn' });
    } else {
      console.error('Claude rapport generation failed:', err.message);
      logEvent('integration', 'anthropic', `failed: ${err.message}`, {
        level: 'error',
        detail: {
          status: err.status,
          endpoint: err.endpoint,
          body: typeof err.body === 'string' ? err.body.substring(0, 200) : undefined,
        },
      });
    }
    return buildFallback(contactData);
  } finally {
    clearTimeout(timer);
  }
}

function clearCache(key) {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

module.exports = { generateRapportIntel, clearCache };
