/**
 * lib/claude.js — Claude API rapport intelligence module.
 * Generates pre-call briefings from assembled contact data.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const FETCH_TIMEOUT = 6000; // 6 seconds

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

Given contact data (name, title, company, interaction history, pipeline data, PB profile), produce a JSON object with these fields:

- rapport_starters: Array of 2-3 conversation openers based on REAL data (career history, headline, company, location, tenure, past interactions). NEVER fabricate facts. If data is sparse, use what's available.
- intel_nuggets: Array of 2-4 buying signals, objection prep points, or compliance notes derived from interaction history and pipeline data.
- opening_line: A natural, warm opening line for the call. Use their first name.
- adapted_script: 2-3 sentences tailoring the standard pitch to this specific contact's industry/role/history.
- watch_outs: Array of 0-2 things to avoid (e.g., competitor mentions, past complaints, sensitive topics).
- product_reference: Relevant product lines based on their history/industry.

When signal metadata is present (signal_tier, cert_expiry, contract_total, dod_flag, cert_body, signal_sources), weave it into the opening_line and intel_nuggets:
- For cert expiry within 9 months: mention upcoming recertification as a conversation hook (e.g., "your AS9100 is up for renewal"). If cert_body is known (e.g., "NQA", "BSI"), mention it naturally — "I know NQA audits can be thorough..."
- For DoD/government contracts: reference compliance or mil-spec requirements naturally. Use contract_total to gauge scale.
- For SPEAR-tier contacts: the opener should be direct and high-value, referencing the specific signal that flagged them
- For TARGETED-tier: reference their industry fit
- When signal_sources is available, use the source context (e.g., "SAM.gov" → government procurement, "FPDS" → defense contracts) to inform your talking points
- Adapt talking points to the contact's TITLE: VP Ops → operational efficiency; QA Director → compliance and audit readiness; Purchasing → cost optimization; Maintenance → equipment reliability and downtime
- When pbContactData includes industry or location, use them to ground recommendations in the contact's geography and vertical
- NEVER mention tiers, scores, or signal data by name — use the underlying facts naturally.

Respond with ONLY valid JSON, no markdown fences.`;

function cacheKey(contactData) {
  return contactData.hubspotContactId
    || contactData.phone
    || contactData.email
    || 'unknown';
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

  return {
    fallback: true,
    rapport_starters: starters.slice(0, 3),
    intel_nuggets: nuggets.slice(0, 4),
    opening_line: opener,
    adapted_script: angle
      ? `Focus on ${angle.topic}. Frame Joruva's value around ${angle.hook}.`
      : '',
    watch_outs: signal?.dod_flag
      ? ['Avoid discussing specific contract details — let them bring it up']
      : [],
    product_reference: [],
  };
}

/**
 * Trim assembled data to only the fields Claude needs for rapport generation.
 * Prevents sending raw DB rows and interaction arrays into the prompt.
 */
function trimForClaude(contactData) {
  const history = contactData.interactionHistory;
  return {
    name: contactData.name,
    email: contactData.email,
    phone: contactData.phone,
    company: contactData.company,
    title: contactData.title,
    linkedinUrl: contactData.linkedinUrl,
    fitScore: contactData.fitScore,
    fitReason: contactData.fitReason,
    persona: contactData.persona,
    pbContactData: contactData.pbContactData,
    companyData: contactData.companyData,
    icpScore: contactData.icpScore ? {
      fit_score: contactData.icpScore.fit_score,
      fit_reason: contactData.icpScore.fit_reason,
      persona: contactData.icpScore.persona,
    } : null,
    interactionCount: history?.interactionCount || 0,
    lastInteractionSummary: history?.lastInteractionSummary || null,
    productsDiscussed: history?.productsDiscussed || [],
    recentInteractions: (history?.interactions || []).slice(0, 5).map(i => ({
      channel: i.channel, summary: i.summary, disposition: i.disposition,
    })),
    priorCallCount: contactData.priorCalls?.length || 0,
    recentCallNotes: (contactData.priorCalls || []).slice(0, 3).map(c => ({
      disposition: c.disposition, qualification: c.qualification, notes: c.notes,
    })),
    emailEngagement: (contactData.emailEngagement || []).slice(0, 5).map(e => ({
      event_type: e.event_type, campaign_name: e.campaign_name,
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
      const body = await resp.text();
      throw new Error(`Claude API ${resp.status}: ${body.substring(0, 200)}`);
    }

    const result = await resp.json();
    const text = result.content?.[0]?.text;
    if (!text) throw new Error('Empty Claude response');

    const intel = JSON.parse(text);
    intel.fallback = false;
    setCache(key, intel);
    return intel;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('Claude API timed out after 6s — returning fallback');
    } else {
      console.error('Claude rapport generation failed:', err.message);
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
