/**
 * lib/company-vernacular.js — Aggregates company-level intelligence from all sources.
 *
 * Combines: customer_interactions (sizing, products, competitive intel),
 * nucleus_phone_calls (AI summaries, notes), HubSpot company properties
 * (10-K, vernacular, compliance), and signal metadata (cert, DoD).
 *
 * Every field has a guaranteed type: arrays default to [], scalars to null,
 * counts to 0. Consumers can trust the shape without null-checking.
 */

const PAIN_KEYWORDS = /\b(moisture|short[- ]?cycling|downtime|leak|pressure drop|overheating|vibration|oil carry[- ]?over|condensat\w*|noise|energy cost|maintenance cost|failing|broke|rental)\b/gi;

/**
 * @param {{ icpAndSignal, interactionHistory, priorCalls, companyData }} opts
 * @returns {object} Vernacular with guaranteed field types
 */
function buildVernacular({ icpAndSignal, interactionHistory, priorCalls, companyData }) {
  const result = {
    equipment: [],
    painPoints: [],
    productsDiscussed: [],
    competitorsMentioned: [],
    lastSizing: null,
    certContext: null,
    hubspotVernacular: null,
    tenKInsights: null,
    leadershipStrategy: null,
    complianceContext: null,
    capitalEquipment: null,
    sourceCount: 0,
  };

  let sources = 0;

  // --- customer_interactions (via lookupCustomer) ---
  const interactions = interactionHistory?.interactions || [];
  if (interactions.length) {
    sources++;

    // Equipment from sizing_data
    for (const ix of interactions) {
      if (ix.sizing_data && typeof ix.sizing_data === 'object') {
        const sd = ix.sizing_data;
        const parts = [sd.equipment_type, sd.brand, sd.hp && `${sd.hp}HP`, sd.age].filter(Boolean);
        if (parts.length) result.equipment.push(parts.join(', '));
        if (sd.cfm || sd.psi) {
          result.lastSizing = result.lastSizing || {
            cfm: sd.cfm ?? null, psi: sd.psi ?? null,
            hp: sd.hp ?? null, machines: sd.machines ?? null,
            tank_size: sd.tank_size ?? null,
          };
        }
      }
    }

    // Pain points from summaries and qualification
    for (const ix of interactions) {
      const text = [ix.summary, ix.qualification?.reason].filter(Boolean).join(' ');
      const matches = text.matchAll(PAIN_KEYWORDS);
      for (const m of matches) {
        const lower = m[0].toLowerCase();
        if (!result.painPoints.includes(lower)) result.painPoints.push(lower);
      }
    }

    // Products discussed
    if (interactionHistory.productsDiscussed?.length) {
      for (const p of interactionHistory.productsDiscussed) {
        if (p && !result.productsDiscussed.includes(p)) result.productsDiscussed.push(p);
      }
    }
  }

  // --- customer_interactions: competitive intel ---
  for (const ix of interactions) {
    // From dedicated competitive_intel column
    if (ix.competitive_intel?.mentions) {
      for (const c of ix.competitive_intel.mentions) {
        if (c && !result.competitorsMentioned.includes(c)) result.competitorsMentioned.push(c);
      }
    }
    // From source_metadata.competitiveMentions (legacy path)
    const sm = ix.source_metadata;
    if (sm?.competitiveMentions && Array.isArray(sm.competitiveMentions)) {
      for (const c of sm.competitiveMentions) {
        if (c && !result.competitorsMentioned.includes(c)) result.competitorsMentioned.push(c);
      }
    }
  }

  // --- nucleus_phone_calls ---
  if (priorCalls?.length) {
    sources++;
    for (const call of priorCalls) {
      // Products from calls
      if (Array.isArray(call.products_discussed)) {
        for (const p of call.products_discussed) {
          if (p && !result.productsDiscussed.includes(p)) result.productsDiscussed.push(p);
        }
      }
      // Pain points from call notes
      if (call.notes) {
        for (const m of call.notes.matchAll(PAIN_KEYWORDS)) {
          const lower = m[0].toLowerCase();
          if (!result.painPoints.includes(lower)) result.painPoints.push(lower);
        }
      }
    }
  }

  // --- Signal metadata (cert/contract context) ---
  const signal = icpAndSignal;
  if (signal?.cert_standard) {
    sources++;
    const expiry = signal.cert_expiry_date ? new Date(signal.cert_expiry_date) : null;
    const isExpired = expiry && expiry.getTime() < Date.now();
    const expiryStr = expiry
      ? expiry.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : null;

    result.certContext = signal.cert_standard
      + (signal.cert_body ? ` (${signal.cert_body})` : '')
      + (isExpired ? `, EXPIRED ${expiryStr}` : expiryStr ? `, expires ${expiryStr}` : '');
  }

  // --- HubSpot company properties (count as one source) ---
  const props = companyData?.properties || companyData || {};
  let hasHubspotIntel = false;
  if (props.company_vernacular) {
    hasHubspotIntel = true;
    result.hubspotVernacular = props.company_vernacular;
  }
  if (props.ten_k_insights) {
    hasHubspotIntel = true;
    result.tenKInsights = props.ten_k_insights;
  }
  if (props.leadership_ceo_strategy) {
    hasHubspotIntel = true;
    result.leadershipStrategy = props.leadership_ceo_strategy;
  }
  if (props.capital_equipment_insights) {
    hasHubspotIntel = true;
    result.capitalEquipment = props.capital_equipment_insights;
  }

  // Compliance context
  const violation = [
    props.compliance_violation_type && `Violation: ${props.compliance_violation_type}`,
    props.compliance_violation_date && `on ${props.compliance_violation_date}`,
    props.environmental_compliance_budget && `Env budget: ${String(props.environmental_compliance_budget).substring(0, 200)}`,
  ].filter(Boolean);
  if (violation.length) {
    hasHubspotIntel = true;
    result.complianceContext = violation.join(' ');
  }
  if (hasHubspotIntel) sources++;

  // Dedupe and cap arrays
  result.equipment = [...new Set(result.equipment)].slice(0, 5);
  result.painPoints = [...new Set(result.painPoints)].slice(0, 5);
  result.productsDiscussed = [...new Set(result.productsDiscussed)].slice(0, 10);
  result.competitorsMentioned = [...new Set(result.competitorsMentioned)].slice(0, 5);
  result.sourceCount = sources;

  return result;
}

module.exports = { buildVernacular };
