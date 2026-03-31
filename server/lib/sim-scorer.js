/**
 * lib/sim-scorer.js — Claude-powered scoring for practice call transcripts.
 * Follows the same raw-fetch pattern as lib/claude.js.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const SCORE_TIMEOUT = 60000;

// Weights must sum to 1.0: 0.20 + 0.25 + 0.25 + 0.15 + 0.15 = 1.00
const WEIGHTS = { rapport: 0.20, discovery: 0.25, objection: 0.25, product: 0.15, close: 0.15 };

const SYSTEM_PROMPT = `You are a sales training coach evaluating a practice cold call. The caller is a sales rep for Joruva Industrial (compressed air systems). They called Mike Garza, owner of Garza Precision Machine — an AI simulation prospect.

Score the call transcript on these 5 categories (each 0.0-10.0):

1. RAPPORT (20% weight): Did they use personalized rapport (NTMA, Boeing background, shop knowledge)? Natural or forced?
2. DISCOVERY (25% weight): Did they qualify? Role, current system, pain points, CFM/PSI needs, timeline, budget?
3. OBJECTION_HANDLING (25% weight): How many objections were raised? How many handled? Did they acknowledge before countering?
4. PRODUCT_KNOWLEDGE (15% weight): Correct product match? Accurate specs? Value positioning vs just features? (Joruva sells JRS-series rotary screw compressors at joruva.com. For Mike's 30-40 CFM at 125 PSI with 460V 3-phase, the right match is the JRS-10E-460V — 10HP enclosed rotary screw, 42 CFM @ 125 PSI, $9,495, 1-year warranty, made in USA. Key value props: rotary screw eliminates moisture/short-cycling vs recip, enclosed cabinet reduces noise, touchscreen controls, continuous duty. Mentioning an air dryer for AS9100 compliance is a bonus. Wrong answers: recommending a recip when Mike already has moisture issues with one, oversizing to 25HP/$17,500 when 10HP covers his demand, or recommending a portable/gas unit for a fixed shop.)
5. CLOSE (15% weight): Asked for specific next step? Got agreement? Concrete not vague?

You must also produce two coaching outputs:

CALLER_DEBRIEF (shown to the rep): 3-5 sentences. Start with something they did well — be specific and genuine. Then address 1-2 areas for growth constructively. End with a high-level suggestion they can try next time. Keep it motivating. Do NOT reveal specific prospect triggers, objection patterns, or the "right answers" that would let them game the simulation. Coach the skill, not the shortcut.

ADMIN_REPORT (sent privately to sales managers): Be fully honest. Name specific weaknesses without sugarcoating. Note patterns (freezing on objections, talking past the close, feature-dumping, etc). Suggest concrete mentoring actions the managers can take with this rep — e.g., "Role-play price objections with them," "Have them listen to Tom's discovery calls," "They need to slow down and ask questions before pitching." This is for Tom and Paul to read and act on.

Respond with ONLY valid JSON:
{
  "rapport": { "score": 8.0, "note": "one sentence" },
  "discovery": { "score": 7.5, "note": "one sentence" },
  "objection": { "score": 6.0, "note": "one sentence" },
  "product": { "score": 7.0, "note": "one sentence" },
  "close": { "score": 5.5, "note": "one sentence" },
  "top_strength": "Best thing the rep did",
  "top_improvement": "Top area to work on",
  "caller_debrief": "3-5 sentence constructive debrief for the rep",
  "admin_report": "Fully honest assessment with specific mentoring suggestions for managers"
}`;

function clamp(val, min, max) {
  const n = Number(val);
  if (isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function computeGrade(overall) {
  if (overall >= 9.0) return 'A';
  if (overall >= 7.0) return 'B';
  if (overall >= 5.0) return 'C';
  if (overall >= 3.0) return 'D';
  return 'F';
}

/**
 * Score a practice call transcript via Claude.
 * Returns { scores, notes, overall, grade, topStrength, topImprovement } on success,
 * or { error: true, message } on failure.
 */
async function scoreTranscript(transcript, difficulty) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: true, message: 'ANTHROPIC_API_KEY not set' };
  if (!transcript || transcript.trim().length < 20) {
    return { error: true, message: 'Transcript too short to score' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCORE_TIMEOUT);

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
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Score this ${difficulty}-difficulty practice call transcript:\n\n${transcript}`,
        }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return { error: true, message: `Claude API ${resp.status}: ${body.substring(0, 200)}` };
    }

    const result = await resp.json();
    const raw = result.content?.[0]?.text;
    if (!raw) return { error: true, message: 'Empty Claude response' };

    // Strip markdown code fences if present
    const text = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const parsed = JSON.parse(text);

    const scores = {
      rapport: clamp(parsed.rapport?.score, 0, 10),
      discovery: clamp(parsed.discovery?.score, 0, 10),
      objection: clamp(parsed.objection?.score, 0, 10),
      product: clamp(parsed.product?.score, 0, 10),
      close: clamp(parsed.close?.score, 0, 10),
    };

    const notes = {
      rapport: String(parsed.rapport?.note || ''),
      discovery: String(parsed.discovery?.note || ''),
      objection: String(parsed.objection?.note || ''),
      product: String(parsed.product?.note || ''),
      close: String(parsed.close?.note || ''),
    };

    const overall = Math.round(
      (scores.rapport * WEIGHTS.rapport +
       scores.discovery * WEIGHTS.discovery +
       scores.objection * WEIGHTS.objection +
       scores.product * WEIGHTS.product +
       scores.close * WEIGHTS.close) * 10
    ) / 10;

    return {
      scores,
      notes,
      overall,
      grade: computeGrade(overall),
      topStrength: String(parsed.top_strength || ''),
      topImprovement: String(parsed.top_improvement || ''),
      callerDebrief: String(parsed.caller_debrief || ''),
      adminReport: String(parsed.admin_report || ''),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: true, message: `Claude API timed out after ${SCORE_TIMEOUT / 1000}s` };
    }
    if (err instanceof SyntaxError) {
      return { error: true, message: `Failed to parse Claude JSON: ${err.message}` };
    }
    return { error: true, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { scoreTranscript, computeGrade };
