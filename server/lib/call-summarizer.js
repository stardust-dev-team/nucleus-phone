/**
 * call-summarizer.js — Claude post-call summary for real calls.
 *
 * Replaces Fireflies upload. Produces structured summary with action items,
 * disposition suggestion, and equipment mentions from the full transcript.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6-20250514';
const TIMEOUT = 45000;
const MIN_TRANSCRIPT_LENGTH = 50;
// ~100K chars ≈ ~25K tokens. Keeps Claude costs bounded on long calls.
const MAX_TRANSCRIPT_LENGTH = 100000;

const SYSTEM_PROMPT = `You summarize sales calls for a compressed air equipment company (Joruva Industrial / CAS — Compressed Air Systems).

The sales team sells JRS-series rotary screw compressors, air dryers, and filtration to shops that run CNC machines, packaging lines, paint booths, woodworking, and other pneumatic equipment.

Given a call transcript, produce a JSON summary:

{
  "summary": "2-3 sentence call summary — what happened, who was involved, outcome",
  "action_items": ["specific follow-up tasks for the sales rep"],
  "products_discussed": ["product names/models mentioned"],
  "objections_raised": ["objections the prospect raised"],
  "equipment_mentioned": ["prospect's equipment, e.g. Haas VF-2 x3"],
  "disposition_suggestion": "hot | warm | cold | callback",
  "next_step": "single most important next action"
}

Disposition guide:
- hot: ready to buy, asked for quote, wants to move forward
- warm: interested but needs follow-up (more info, internal approval, timing)
- cold: not interested, wrong fit, no budget, no authority
- callback: asked to call back at specific time, or needs to check something first

Be specific. "Send quote" is better than "follow up." Include dollar amounts and model numbers when mentioned. If the transcript is too short or garbled to summarize meaningfully, return the JSON with summary="Insufficient transcript data" and empty arrays.

Respond with ONLY valid JSON. No markdown fences, no explanation.`;

/**
 * Summarize a call transcript using Claude.
 * Returns { summary, action_items, products_discussed, objections_raised,
 *           equipment_mentioned, disposition_suggestion, next_step }
 * or { error: true, message } on failure.
 */
async function summarizeCall(transcript) {
  if (!transcript || transcript.length < MIN_TRANSCRIPT_LENGTH) {
    return { error: true, message: 'Transcript too short to summarize' };
  }

  // Truncate very long transcripts to bound cost/latency
  const input = transcript.length > MAX_TRANSCRIPT_LENGTH
    ? transcript.substring(0, MAX_TRANSCRIPT_LENGTH) + '\n\n[transcript truncated]'
    : transcript;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { error: true, message: 'ANTHROPIC_API_KEY not set' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: input }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      return { error: true, message: `Claude API ${res.status}: ${text.substring(0, 200)}` };
    }

    const data = await res.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock?.text) {
      return { error: true, message: 'No text in Claude response' };
    }

    const cleaned = textBlock.text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    return {
      summary: parsed.summary || '',
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      products_discussed: Array.isArray(parsed.products_discussed) ? parsed.products_discussed : [],
      objections_raised: Array.isArray(parsed.objections_raised) ? parsed.objections_raised : [],
      equipment_mentioned: Array.isArray(parsed.equipment_mentioned) ? parsed.equipment_mentioned : [],
      disposition_suggestion: parsed.disposition_suggestion || 'warm',
      next_step: parsed.next_step || '',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: true, message: 'Claude API timed out' };
    }
    if (err instanceof SyntaxError) {
      return { error: true, message: 'Failed to parse Claude response as JSON' };
    }
    return { error: true, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { summarizeCall, MIN_TRANSCRIPT_LENGTH };
