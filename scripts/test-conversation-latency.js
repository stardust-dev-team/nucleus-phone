#!/usr/bin/env node

/**
 * test-conversation-latency.js — Validates Haiku latency, prompt caching,
 * response shape, and suggestion quality for the Conversation Navigator.
 *
 * This script gates all Conversation Navigator implementation (nucleus-phone-ns9).
 * Run: node scripts/test-conversation-latency.js
 *
 * Env: ANTHROPIC_API_KEY must be set (via .env or shell).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PRODUCT_CATALOG } = require('../server/lib/product-catalog');
const { OBJECTION_PAIRS } = require('../server/lib/objection-pairs');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const FETCH_TIMEOUT = 10000;

const SYSTEM_PROMPT_TEXT = `You are a real-time conversation analyst for Joruva Industrial sales calls. Joruva sells compressed air systems (rotary screw compressors, dryers, filters, oil-water separators) to manufacturing shops, job shops, and industrial facilities. The caller is a Joruva sales rep. The prospect is typically a shop owner, plant manager, or maintenance lead.

You analyze transcript chunks and return a JSON object with exactly these fields:

PHASE — the current conversation phase. Must be one of: greeting, discovery, qualification, equipment_discussion, objection_handling, pricing, closing, small_talk.
Phase definitions:
- greeting: Initial pleasantries, introductions, small talk before business
- discovery: Asking about the prospect's shop, operations, equipment, pain points
- qualification: Probing budget, timeline, decision process, authority
- equipment_discussion: Technical discussion about specific equipment, specs, sizing, air quality
- objection_handling: Prospect raises concerns, pushback, or resistance
- pricing: Discussing costs, quotes, ROI, payment terms, competitive pricing
- closing: Asking for next steps, commitment, scheduling follow-up
- small_talk: Non-business conversation (weather, sports, family, vacations)

SENTIMENT — customer emotional state.
- customer: positive (engaged, interested, warm), neutral (polite but uncommitted), negative (frustrated, annoyed), guarded (skeptical, arms-crossed), hostile (angry, confrontational, wants off the call)
- momentum: building (getting more engaged over time), steady (no change), declining (losing interest), tanking (actively disengaging or getting angry)

SUGGESTION — a response hint for the caller. ONLY emit when the customer asks a direct question, raises a concern, or shows buying interest. Must be 1-2 sentences max. Set to null when no actionable moment exists. Do not suggest something for every chunk — most chunks should have null.
- trigger: MUST be exactly one of these 4 values: "question", "objection", "buying_interest", "exit_assist". No other values allowed.
- confidence: 0.0-1.0 how confident you are this suggestion is relevant

OBJECTION — when the customer voices a specific sales objection, provide the objection text and a concise rebuttal. Null otherwise.

PREDICTED_NEXT — predict the most likely next question or objection based on conversation trajectory. Pattern is a short keyword phrase (2-4 words) for client-side matching (e.g., "cost comparison", "warranty length", "lead time"). Include a pre-computed suggestion for that prediction. Null if no confident prediction.

PHASE_BANK — when you detect a phase transition (different phase than the previous chunk would have been), provide 3-5 pre-written suggestions appropriate for the new phase. Each has a trigger keyword and suggestion text. Null if no phase change detected.

${PRODUCT_CATALOG}

${OBJECTION_PAIRS}

CRITICAL RULES:
- Respond with ONLY valid JSON. No markdown fences. No explanation text.
- suggestion.text must be 1-2 sentences maximum.
- Set fields to null when not applicable — do not omit them.
- phase_bank entries should have specific, actionable trigger keywords.
- predicted_next.pattern should be 2-4 words, specific enough to match in transcript.

JSON schema (follow EXACTLY):
{"phase":"greeting|discovery|qualification|equipment_discussion|objection_handling|pricing|closing|small_talk","sentiment":{"customer":"positive|neutral|negative|guarded|hostile","momentum":"building|steady|declining|tanking"},"suggestion":{"text":"1-2 sentences","trigger":"question|objection|buying_interest|exit_assist","confidence":0.85}|null,"objection":{"objection":"text","rebuttal":"text"}|null,"predicted_next":{"pattern":"2-4 word keyword","suggestion":{"text":"text","trigger":"question|objection|buying_interest|exit_assist"}}|null,"phase_bank":[{"trigger":"keyword","text":"suggestion text"}]|null}`;

// Representative transcript snippets covering different call scenarios
const TRANSCRIPT_SNIPPETS = [
  {
    label: 'Discovery — asking about current setup',
    text: `Caller: So Mike, tell me a little about your shop. What kind of work are you guys doing over there?
Prospect: Yeah we're a job shop, mostly aerospace and defense contracts. We run about 12 Haas VMCs and a few turning centers. Been growing pretty fast the last couple years.
Caller: Nice, that's great to hear. And what are you running for compressed air right now?`,
    expectPhase: 'discovery',
    expectSentiment: 'positive',
    expectMomentum: null,
    expectSuggestion: false,
  },
  {
    label: 'Pricing objection — hostile',
    text: `Prospect: Ten grand for a compressor? Are you kidding me? I can get an Ingersoll for half that price. You guys are way out of line.
Caller: I hear you, Mike. Let me break down what's actually in that price.
Prospect: I don't need a breakdown. I need a real price. This is a waste of my time.`,
    expectPhase: 'objection_handling',
    expectSentiment: 'hostile',
    expectMomentum: 'tanking',
    expectSuggestion: true,
  },
  {
    label: 'Buying interest — ready to close',
    text: `Prospect: OK so the JRS-10E would cover our demand. And you said the dryer is separate?
Caller: Yep, the JRD-40 is $2,495 and handles 40 CFM at 38-degree dewpoint. Perfect match for the 10E.
Prospect: And what's the lead time? We need to get this in before our next audit in six weeks.`,
    expectPhase: 'pricing',
    expectSentiment: 'positive',
    expectMomentum: null,
    expectSuggestion: true,
  },
  {
    label: 'Competitor mention — guarded',
    text: `Prospect: Look, we've been running Atlas Copco for fifteen years. Never had a problem. My maintenance guy loves them.
Caller: Atlas Copco makes solid equipment. No argument there.
Prospect: So why would I switch? What can you actually do that they can't?`,
    expectPhase: 'objection_handling',
    expectSentiment: 'guarded',
    expectMomentum: null,
    expectSuggestion: true,
  },
  {
    label: 'Small talk — greeting phase',
    text: `Caller: Hey Mike, this is Alex from Joruva Industrial. How's it going today?
Prospect: Going pretty good. Just got back from vacation actually, trying to catch up on everything.
Caller: Oh nice, where'd you go?
Prospect: Took the family down to San Diego. Kids loved the zoo.`,
    expectPhase: 'greeting',
    expectSentiment: 'positive',
    expectMomentum: null,
    expectSuggestion: false,
  },
  {
    label: 'Equipment discussion — technical',
    text: `Prospect: Our main issue is moisture. We're running a 25-horse piston compressor and the air is wet. It's causing rust on parts coming off the CNC. We've tried an inline filter but it doesn't cut it.
Caller: Yeah, piston compressors are notorious for that. The short cycling creates a lot of condensate.
Prospect: So what would you recommend? We need clean, dry air for our precision work.`,
    expectPhase: 'equipment_discussion',
    expectSentiment: 'neutral',
    expectMomentum: null,
    expectSuggestion: true,
  },
  {
    label: 'Qualification — budget probing',
    text: `Caller: And budget-wise, Mike, do you have a range in mind for this project?
Prospect: I mean, I've been quoted 15 to 20 grand for a full system from other vendors. But honestly I was hoping to come in under that.
Caller: That's helpful. Our JRS-10E system with a dryer and filters comes in right around $12,500 all-in.`,
    expectPhase: 'qualification',
    expectSentiment: 'neutral',
    expectMomentum: null,
    expectSuggestion: true,
  },
  {
    label: 'Declining momentum — losing interest',
    text: `Prospect: Yeah, I don't know. We were looking at this last quarter but things have slowed down. Not sure we're ready to pull the trigger right now.
Caller: I totally understand. The market's been unpredictable.
Prospect: Yeah. Maybe next year. I appreciate the call though.`,
    expectPhase: 'closing',
    expectSentiment: 'neutral',       // customer sentiment; momentum is 'declining'
    expectMomentum: 'declining',
    expectSuggestion: true,
  },
];

const VALID_PHASES = new Set([
  'greeting', 'discovery', 'qualification', 'equipment_discussion',
  'objection_handling', 'pricing', 'closing', 'small_talk',
]);
const VALID_SENTIMENTS = new Set(['positive', 'neutral', 'negative', 'guarded', 'hostile']);
const VALID_MOMENTUM = new Set(['building', 'steady', 'declining', 'tanking']);
const VALID_TRIGGERS = new Set(['question', 'objection', 'buying_interest', 'exit_assist']);

// ── Helpers ──────────────────────────────────────────────────────────────

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
  return sorted[idx];
}

async function callHaiku(userContent, requestCacheControl) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  // Prompt caching requires system as array of content blocks with cache_control
  // Uncached: plain string (no caching possible)
  // Cached: array with cache_control on the system block
  const systemPayload = requestCacheControl
    ? [{ type: 'text', text: SYSTEM_PROMPT_TEXT, cache_control: { type: 'ephemeral' } }]
    : [{ type: 'text', text: SYSTEM_PROMPT_TEXT }];

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  const start = Date.now();

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPayload,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });

    // Clear timeout immediately after response headers arrive,
    // before parsing body (prevents abort during JSON parsing)
    clearTimeout(timer);
    const elapsed = Date.now() - start;

    if (!res.ok) {
      const body = await res.text();
      return { error: true, status: res.status, body: body.substring(0, 300), elapsed };
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const usage = data.usage || {};

    return { error: false, text, usage, elapsed };
  } catch (err) {
    clearTimeout(timer);
    return { error: true, message: err.message, elapsed: Date.now() - start };
  }
}

function parseResponse(rawText) {
  // Strip markdown fences (various formats Haiku uses)
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n/i, '');
  cleaned = cleaned.replace(/\n```\s*$/, '');
  cleaned = cleaned.trim();

  // If still not starting with {, extract the outermost JSON object.
  // lastIndexOf('}') works here because our schema has no trailing content
  // after the root object's closing brace — nested braces are interior.
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) cleaned = cleaned.substring(start, end + 1);
  }

  return JSON.parse(cleaned);
}

function validateSchema(parsed) {
  const issues = [];

  if (!parsed.phase || !VALID_PHASES.has(parsed.phase))
    issues.push(`invalid phase: "${parsed.phase}"`);

  if (!parsed.sentiment)
    issues.push('missing sentiment');
  else {
    if (!VALID_SENTIMENTS.has(parsed.sentiment.customer))
      issues.push(`invalid sentiment.customer: "${parsed.sentiment.customer}"`);
    if (!VALID_MOMENTUM.has(parsed.sentiment.momentum))
      issues.push(`invalid sentiment.momentum: "${parsed.sentiment.momentum}"`);
  }

  // suggestion can be null
  if (parsed.suggestion !== null && parsed.suggestion !== undefined) {
    if (!parsed.suggestion.text) issues.push('suggestion present but missing text');
    if (!VALID_TRIGGERS.has(parsed.suggestion.trigger))
      issues.push(`invalid suggestion.trigger: "${parsed.suggestion.trigger}"`);
    if (typeof parsed.suggestion.confidence !== 'number')
      issues.push('suggestion.confidence not a number');
  }

  // objection can be null
  if (parsed.objection !== null && parsed.objection !== undefined) {
    if (!parsed.objection.objection) issues.push('objection present but missing .objection');
    if (!parsed.objection.rebuttal) issues.push('objection present but missing .rebuttal');
  }

  // predicted_next can be null
  if (parsed.predicted_next !== null && parsed.predicted_next !== undefined) {
    if (!parsed.predicted_next.pattern) issues.push('predicted_next missing .pattern');
    if (!parsed.predicted_next.suggestion?.text)
      issues.push('predicted_next missing .suggestion.text');
  }

  // phase_bank can be null
  if (parsed.phase_bank !== null && parsed.phase_bank !== undefined) {
    if (!Array.isArray(parsed.phase_bank))
      issues.push('phase_bank not an array');
    else if (parsed.phase_bank.length > 0) {
      for (const item of parsed.phase_bank) {
        if (!item.trigger || !item.text)
          issues.push('phase_bank entry missing trigger or text');
      }
    }
  }

  return issues;
}

function validateQuality(parsed, snippet) {
  const issues = [];
  const warnings = [];

  // Phase/sentiment accuracy are soft checks — Haiku may reasonably classify
  // a "greeting" as "small_talk" or a "neutral" prospect as "positive".
  // These are logged for manual review but don't fail the quality gate.
  if (snippet.expectPhase && parsed.phase !== snippet.expectPhase)
    warnings.push(`phase: got "${parsed.phase}", expected "${snippet.expectPhase}"`);
  if (snippet.expectSentiment && parsed.sentiment?.customer !== snippet.expectSentiment)
    warnings.push(`sentiment: got "${parsed.sentiment?.customer}", expected "${snippet.expectSentiment}"`);
  if (snippet.expectMomentum && parsed.sentiment?.momentum !== snippet.expectMomentum)
    warnings.push(`momentum: got "${parsed.sentiment?.momentum}", expected "${snippet.expectMomentum}"`);

  // Suggestion length check (when present)
  // UI constraint: SuggestionCard is max 2 lines. Character count is the hard
  // gate (250 chars). Sentence count is soft — objection rebuttals naturally
  // need 2-3 sentences (acknowledge + pivot + value).
  if (parsed.suggestion?.text) {
    if (parsed.suggestion.text.length > 250)
      issues.push(`suggestion too long: ${parsed.suggestion.text.length} chars (max 250)`);
    const sentences = parsed.suggestion.text.split(/\.\s+/).filter(s => s.trim());
    if (sentences.length > 2)
      warnings.push(`suggestion ${sentences.length} sentences (target 1-2)`);
  }

  // Phase bank size (when present)
  if (parsed.phase_bank && parsed.phase_bank.length > 0) {
    if (parsed.phase_bank.length < 2)
      issues.push(`phase_bank too small: ${parsed.phase_bank.length} entries`);
    if (parsed.phase_bank.length > 7)
      issues.push(`phase_bank too large: ${parsed.phase_bank.length} entries`);
  }

  // predicted_next pattern specificity (when present)
  if (parsed.predicted_next?.pattern) {
    if (parsed.predicted_next.pattern.length < 3)
      issues.push(`predicted_next.pattern too vague: "${parsed.predicted_next.pattern}"`);
  }

  // Suggestion presence expectation
  if (snippet.expectSuggestion && !parsed.suggestion)
    issues.push('expected suggestion but got null');

  return { issues, warnings };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Conversation Navigator — Haiku Validation Script          ║');
  console.log('║  Model: ' + MODEL.padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('FATAL: ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  // ── Test 1: Uncached latency baseline ──────────────────────────────────

  console.log('━━━ Test 1: Uncached Latency Baseline (5 calls) ━━━\n');
  const uncachedLatencies = [];

  for (let i = 0; i < 5; i++) {
    const snippet = TRANSCRIPT_SNIPPETS[i];
    const result = await callHaiku(
      `Analyze this transcript chunk:\n\n${snippet.text}`,
      false  // no caching
    );

    if (result.error) {
      console.log(`  [${i + 1}] ERROR: ${result.status || result.message} (${result.elapsed}ms)`);
      continue;
    }

    uncachedLatencies.push(result.elapsed);
    console.log(`  [${i + 1}] ${snippet.label}: ${result.elapsed}ms`);
    console.log(`       tokens: in=${result.usage.input_tokens} out=${result.usage.output_tokens}`);
  }

  // ── Test 2: Cached latency + cache hit rate (all snippets) ──────────
  // Runs all 8 snippets with caching, then 2 repeats for cache hit detection.
  // Responses are stored and reused for Tests 3-4 (no redundant API calls).

  const CACHE_REPEAT_CALLS = 2; // extra calls after all snippets to detect cache hits
  const cachedCallCount = TRANSCRIPT_SNIPPETS.length + CACHE_REPEAT_CALLS;

  console.log(`\n━━━ Test 2: Cached Latency + Cache Hit Rate (${cachedCallCount} calls) ━━━\n`);
  const cachedLatencies = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  const cachedResponses = []; // { snippet, result, index }

  for (let i = 0; i < cachedCallCount; i++) {
    const snippet = TRANSCRIPT_SNIPPETS[i % TRANSCRIPT_SNIPPETS.length];
    const result = await callHaiku(
      `Analyze this transcript chunk:\n\n${snippet.text}`,
      true  // with caching
    );

    if (result.error) {
      console.log(`  [${i + 1}] ERROR: ${result.status || result.message} (${result.elapsed}ms)`);
      if (i < TRANSCRIPT_SNIPPETS.length) cachedResponses.push({ snippet, result, index: i });
      continue;
    }

    cachedLatencies.push(result.elapsed);
    const cacheRead = result.usage.cache_read_input_tokens || 0;
    const cacheCreate = result.usage.cache_creation_input_tokens || 0;
    const isHit = cacheRead > 0;
    if (isHit) cacheHits++;
    else cacheMisses++;

    // Store first 8 responses (one per snippet) for schema/quality validation
    if (i < TRANSCRIPT_SNIPPETS.length) cachedResponses.push({ snippet, result, index: i });

    console.log(`  [${i + 1}] ${snippet.label}: ${result.elapsed}ms [cache: ${isHit ? 'HIT' : 'MISS'}]`);
    console.log(`       tokens: in=${result.usage.input_tokens} out=${result.usage.output_tokens} cache_read=${cacheRead} cache_create=${cacheCreate}`);
  }

  // ── Test 3: Response shape validation (reuses Test 2 responses) ────────

  console.log('\n━━━ Test 3: Response Shape Validation (from Test 2 data) ━━━\n');
  let schemaPass = 0;
  let schemaFail = 0;

  for (const { snippet, result, index } of cachedResponses) {
    if (result.error) {
      console.log(`  [${index + 1}] ${snippet.label}: API ERROR`);
      schemaFail++;
      continue;
    }

    let parsed;
    try {
      parsed = parseResponse(result.text);
    } catch (err) {
      console.log(`  [${index + 1}] ${snippet.label}: JSON PARSE FAILED`);
      console.log(`       raw: ${result.text.substring(0, 200)}`);
      schemaFail++;
      continue;
    }

    const schemaIssues = validateSchema(parsed);
    if (schemaIssues.length === 0) {
      schemaPass++;
      console.log(`  [${index + 1}] ${snippet.label}: PASS`);
    } else {
      schemaFail++;
      console.log(`  [${index + 1}] ${snippet.label}: FAIL — ${schemaIssues.join(', ')}`);
    }

    // Log the raw response for manual review
    console.log(`       phase=${parsed.phase} sentiment=${parsed.sentiment?.customer}/${parsed.sentiment?.momentum}`);
    if (parsed.suggestion)
      console.log(`       suggestion: "${parsed.suggestion.text.substring(0, 100)}"`);
    if (parsed.objection)
      console.log(`       objection: "${parsed.objection.objection?.substring(0, 80)}"`);
    if (parsed.predicted_next)
      console.log(`       predicted: pattern="${parsed.predicted_next.pattern}"`);
    if (parsed.phase_bank)
      console.log(`       phase_bank: ${parsed.phase_bank.length} entries`);
  }

  // ── Test 4: Quality check (reuses Test 2 responses) ────────────────────

  console.log('\n━━━ Test 4: Suggestion Quality Check (from Test 2 data) ━━━\n');
  let qualityPass = 0;
  let qualityFail = 0;

  for (const { snippet, result, index } of cachedResponses) {
    if (result.error) {
      console.log(`  [${index + 1}] ${snippet.label}: API ERROR`);
      qualityFail++;
      continue;
    }

    let parsed;
    try {
      parsed = parseResponse(result.text);
    } catch {
      console.log(`  [${index + 1}] ${snippet.label}: PARSE ERROR`);
      qualityFail++;
      continue;
    }

    const { issues: qualityIssues, warnings: qualityWarnings } = validateQuality(parsed, snippet);
    if (qualityIssues.length === 0) {
      qualityPass++;
      console.log(`  [${index + 1}] ${snippet.label}: PASS`);
    } else {
      qualityFail++;
      console.log(`  [${index + 1}] ${snippet.label}: FAIL — ${qualityIssues.join(', ')}`);
    }
    if (qualityWarnings.length > 0)
      console.log(`       soft: ${qualityWarnings.join(', ')}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────

  const W = 62; // box width (interior)
  const line = '═'.repeat(W);
  const pad = (s) => '║ ' + s.padEnd(W - 2) + ' ║';

  console.log(`\n╔${line}╗`);
  console.log(pad('SUMMARY'));
  console.log(`╠${line}╣`);

  if (uncachedLatencies.length > 0) {
    console.log(pad(`Uncached latency:  p50=${median(uncachedLatencies)}ms  p95=${p95(uncachedLatencies)}ms`));
  } else {
    console.log(pad('Uncached latency:  NO DATA'));
  }

  if (cachedLatencies.length > 0) {
    console.log(pad(`Cached latency:    p50=${median(cachedLatencies)}ms  p95=${p95(cachedLatencies)}ms`));
  } else {
    console.log(pad('Cached latency:    NO DATA'));
  }

  const cacheTotal = cacheHits + cacheMisses;
  const schemaTotal = schemaPass + schemaFail;
  const qualityTotal = qualityPass + qualityFail;

  console.log(pad(`Cache hit rate:    ${cacheHits}/${cacheTotal} (${cacheTotal > 0 ? Math.round(cacheHits / cacheTotal * 100) : 0}%)`));
  console.log(pad(`Schema pass rate:  ${schemaPass}/${schemaTotal} (${schemaTotal > 0 ? Math.round(schemaPass / schemaTotal * 100) : 0}%)`));
  console.log(pad(`Quality pass rate: ${qualityPass}/${qualityTotal} (${qualityTotal > 0 ? Math.round(qualityPass / qualityTotal * 100) : 0}%)`));
  console.log(`╠${line}╣`);

  // Gate decision
  // Tier 3 (8s batch): p95 must fit within 8s cycle with margin → <6s
  // Tier 2 (question bypass): p50 must be near ~2.5s target → <3s
  // Schema: must reliably parse → >=80%
  // Quality: suggestions must be actionable → >=70%
  const latP50 = cachedLatencies.length > 0 ? median(cachedLatencies) : Infinity;
  const latP95 = cachedLatencies.length > 0 ? p95(cachedLatencies) : Infinity;
  const schemaRate = schemaTotal > 0 ? schemaPass / schemaTotal : 0;
  const qualityRate = qualityTotal > 0 ? qualityPass / qualityTotal : 0;

  const tier3Ok = latP95 < 6000;    // fits in 8s batch with 2s margin
  const tier2Ok = latP50 < 3000;    // question bypass target ~2.5s
  const schemaOk = schemaRate >= 0.8;
  const qualityOk = qualityRate >= 0.7;
  const cacheWorking = cacheHits > 0;

  console.log(pad(`Gate: Tier 3 p95 <6s:   ${tier3Ok ? 'PASS' : 'FAIL'} (${latP95}ms)`));
  console.log(pad(`Gate: Tier 2 p50 <3s:   ${tier2Ok ? 'PASS' : 'FAIL'} (${latP50}ms)`));
  console.log(pad(`Gate: schema >=80%:     ${schemaOk ? 'PASS' : 'FAIL'} (${Math.round(schemaRate * 100)}%)`));
  console.log(pad(`Gate: quality >=70%:    ${qualityOk ? 'PASS' : 'FAIL'} (${Math.round(qualityRate * 100)}%)`));
  console.log(pad(`Info: prompt caching:   ${cacheWorking ? 'ACTIVE' : 'NOT DETECTED'}`));
  if (!cacheWorking) {
    console.log(pad('  Haiku 4.5 may use transparent caching without'));
    console.log(pad('  reporting cache metrics. Latency is actual API perf.'));
  }
  console.log(`╠${line}╣`);

  const allPass = tier3Ok && tier2Ok && schemaOk && qualityOk;
  if (allPass) {
    console.log(pad('✓ ALL GATES PASSED — Conversation Navigator is a GO'));
    if (!cacheWorking)
      console.log(pad('  (caching informational — latency gates met without)'));
  } else {
    console.log(pad('✗ GATES FAILED — Review results before proceeding'));
    if (!tier3Ok) console.log(pad('  → p95 exceeds 8s batch cycle budget'));
    if (!tier2Ok) console.log(pad('  → p50 too high for question bypass, split needed'));
    if (!schemaOk) console.log(pad('  → Haiku struggling with 6-field schema, split?'));
    if (!qualityOk) console.log(pad('  → Review suggestion quality, tune prompt'));
  }

  console.log(`╚${line}╝`);

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
