/**
 * lib/sim-scorer.js — Claude-powered scoring for practice call transcripts.
 * Follows the same raw-fetch pattern as lib/claude.js.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const SCORE_TIMEOUT = 60000;

const team = require('../config/team.json');
const TEAM_BY_IDENTITY = Object.fromEntries(
  team.members.map(m => [m.identity, m])
);

// Weights must sum to 1.0: 0.20 + 0.25 + 0.25 + 0.15 + 0.15 = 1.00
const WEIGHTS = { rapport: 0.20, discovery: 0.25, objection: 0.25, product: 0.15, close: 0.15 };

const SYSTEM_PROMPT = `You are a sales training coach evaluating a practice cold call. The caller is a sales rep for Joruva Industrial (compressed air systems). They called Mike Garza, owner of Garza Precision Machine — an AI simulation prospect.

## Difficulty Levels

The difficulty level determines Mike's behavior. Your scoring MUST account for this:

- **EASY**: Mike's compressor broke yesterday. He's frustrated, actively shopping, and volunteers equipment details freely. He raises only 1-2 SOFT objections (lead time, installation). He WANTS help.
  - Objection handling: Only 1-2 objections exist. Handling both well = 9+. Do NOT penalize for "only" handling 2.
  - Discovery: Mike volunteers equipment details — rep gets full credit for acknowledging and building on volunteered info, not just asking questions.
  - Close: Mike is ready to take next steps. Getting his email + agreement to receive specs = 9+.

- **MEDIUM**: Normal workday. Mike is guarded, gives SHORT answers (1 sentence) until the caller earns trust with good questions or rapport intel. He raises 3-4 MEDIUM objections (price, service, timing, online skepticism). Mike does NOT volunteer information.
  - Objection handling: 3-4 objections. Handling all of them with acknowledge-first = 9+. Handling 3/4 well = 8.
  - Discovery: Requires skilled questioning. Mike reveals equipment piecemeal ("we're a CNC shop" → follow-up → "mostly Haas, couple Mazaks"). Getting specific models + CFM + AS9100 + voltage through progressive questioning = 9+.
  - Rapport: Mike warms up ONLY if the caller uses NTMA, Boeing, or specific machine references. Going from 1-sentence answers to 2-3 sentence answers IS warming up on medium.
  - Close: Best outcome is "Alright, send me the specs. No promises but I'll give it a fair shake." That IS a 9+ close on medium — Mike doesn't commit easily.

- **HARD**: Mike is irritated and hostile. One-word answers. Interrupts after 15 seconds. 5-6 HARD objections stacked together, including instant pushback ("Not interested") within 20 seconds. The caller must demonstrate real industry knowledge to crack the armor.
  - Objection handling: 5-6 hard objections, some stacked. Getting past the initial "Not interested" AND handling 3-4 more = 9+. Handling ALL 5-6 is near-impossible and would be a 10. Do NOT require handling every single one for a 9.
  - Discovery: Mike gives one-word answers ("It works." "460." "Obviously."). Extracting the full equipment dump ("five CNC machines, three Haas VF-2s, two Mazak QTN-200s") requires proving industry knowledge first. Getting 4+ key facts on hard = 9+. Getting all facts is extremely rare.
  - Rapport: Mike is hostile. ANY crack in the armor — going from one-word answers to a grudging multi-sentence response — IS exceptional rapport. Do NOT expect Mike to become friendly. The shift from hostile to grudgingly engaged = 9+ rapport on hard.
  - Close: The BEST possible outcome is grudging: "...Fine. Send me the specs. mike at garza precision dot com. No promises." The words "no promises" are NOT a failed close — that IS the successful hard-mode close. Score it 9+.

## Scoring Categories (each 0.0-10.0)

### 1. RAPPORT (20% weight)
Did the caller connect personally with Mike? Look for: mentioning NTMA, Boeing background, specific machine names (Haas VF-2, Mazak QTN-200), Mesa/AZ, or acknowledging his situation (frustration, rental costs, being self-made). Empathy counts — acknowledging pain points like "that rental must be killing you" IS rapport.

- **9-10**: Multiple personalized touches, natural tone, Mike warmed up (relative to difficulty — on hard, going from hostile to grudgingly engaged counts). Acknowledged Mike's situation with genuine empathy.
- **7-8**: Some personalization, decent tone, but missed opportunities or felt slightly rehearsed.
- **5-6**: Generic opener, little personalization. Went straight to selling.
- **Below 5**: No rapport attempt, robotic, or off-putting.

### 2. DISCOVERY (25% weight)
Did the caller uncover Mike's needs through questions? Key facts to discover: what machines he runs, CFM/PSI demand, current compressor problems (moisture, short-cycling), AS9100/aerospace requirements, voltage/power, urgency/timeline. On EASY mode, Mike volunteers much of this — the rep still gets credit if they acknowledged and built on what Mike shared, even if they didn't have to ask.

- **9-10**: Uncovered all key facts (machines, CFM, PSI, problems, AS9100, voltage) — or on hard mode, extracted 4+ facts through skilled questioning against resistance. Asked smart follow-ups. Connected dots between Mike's problems and solutions.
- **7-8**: Got most key facts but missed 1-2 (e.g., didn't ask about AS9100 or voltage). Adequate questioning.
- **5-6**: Surface-level questions only. Missed major qualifiers.
- **Below 5**: Little or no discovery. Jumped straight to pitching.

### 3. OBJECTION HANDLING (25% weight)
How well did the caller handle the objections Mike raised? The key skill is: acknowledge first, then counter. IMPORTANT: Score based on the quality of handling relative to what Mike raised — NOT the raw count. On easy mode (1-2 soft objections), handling both smoothly and turning them into buying signals = 9-10.

- **9-10**: Handled all objections raised (or on hard, handled most of the 5-6 stacked objections). Acknowledged before countering. Turned objections into buying signals (e.g., "lead time concern = he's ready to buy"). On easy: smoothly handling both objections = 9+. On hard: getting past "not interested" + handling 3-4 more = 9+.
- **7-8**: Handled most objections but missed one, or handled them adequately without turning them into buying signals.
- **5-6**: Stumbled on objections, got defensive, or dismissed them.
- **Below 5**: Froze, ignored objections, or argued with Mike.

### 4. PRODUCT KNOWLEDGE (15% weight)
Did the caller recommend the right product with accurate specs and value positioning?

The CORRECT recommendation for Mike's shop:
- PRIMARY: JRS-10E-460V — 10HP enclosed rotary screw, 42 CFM @ 125 PSI, $9,495, 1-year warranty, made in USA
- WHY it solves his problems: rotary screw = continuous duty (eliminates short-cycling), inherently lower moisture than recip, enclosed cabinet = quieter
- AS9100 DRYER: JDD-40 desiccant ($7,495, -60F dewpoint, molecular sieve media, wall-mount). NOT the JRD-40 refrigerated — that's only 38F dewpoint, insufficient for aerospace
- FILTERS: JCF-70 coalescing ($349) + JPF-70 particulate ($399) = full system thinking
- OIL-WATER SEPARATOR: OWS75 ($234) = EPA compliance, complete system
- WRONG ANSWERS: Recommending a recip, oversizing to 25HP, recommending portable/gas, recommending JRD-40 refrigerated dryer for AS9100 work

- **9-10**: Named the right compressor model with correct specs. Explained WHY rotary screw solves Mike's specific problems (not just feature-dumping). Recommended appropriate dryer for AS9100. Bonus: mentioned filters or full system.
- **7-8**: Right compressor but missed dryer, or recommended JRD-40 instead of JDD-40 for aerospace. Decent specs but feature-dumped without connecting to Mike's problems.
- **5-6**: Vaguely correct direction but wrong specs, wrong model, or no connection to Mike's needs.
- **Below 5**: Wrong product entirely, or no product recommendation.

### 5. CLOSE (15% weight)
Did the caller ask for a specific, concrete next step and get agreement?

- **9-10**: Asked for email, proposed sending specs TODAY, suggested timeline ("this week"), got explicit agreement. On medium: "send me the specs, I'll give it a fair shake" = success. On hard: getting Mike's email AT ALL ("mike at garza precision dot com, no promises") = 9+. The words "no promises" are NOT a failed close on hard — that IS the win.
- **7-8**: Asked for next step but vague ("I'll send you some info"). Or proposed a good step but didn't get explicit agreement.
- **5-6**: Weak close, left it open-ended, or Mike had to prompt the next step.
- **Below 5**: No close attempt, or the call just fizzled out.

## Coaching Outputs

CALLER_DEBRIEF (shown to the rep): 3-5 sentences. Start with something they did well — be specific and genuine. Then address 1-2 areas for growth constructively. End with a high-level suggestion they can try next time. Keep it motivating. Do NOT reveal specific prospect triggers, objection patterns, or the "right answers" that would let them game the simulation. Coach the skill, not the shortcut.

ADMIN_REPORT (sent privately to sales managers): Be fully honest. Name specific weaknesses without sugarcoating. Note patterns (freezing on objections, talking past the close, feature-dumping, etc). Suggest concrete mentoring actions the managers can take with this rep — e.g., "Role-play price objections with them," "Have them listen to Tom's discovery calls," "They need to slow down and ask questions before pitching." This is for Tom and Paul to read and act on.

## Response Format

Respond with ONLY valid JSON (no markdown fences):
{
  "rapport": { "score": 7.0, "note": "one sentence" },
  "discovery": { "score": 7.0, "note": "one sentence" },
  "objection": { "score": 7.0, "note": "one sentence" },
  "product": { "score": 7.0, "note": "one sentence" },
  "close": { "score": 7.0, "note": "one sentence" },
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
 * Format navigator events for inclusion in the debrief prompt.
 * Events include phase changes, suggestions, objections, exit-assist triggers.
 */
function formatNavigatorEvents(events) {
  if (!events || events.length === 0) return 'No navigator events recorded.';
  return events.map(e => {
    const elapsed = Math.max(0, e.ts - events[0].ts);
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    const time = `${mins}:${String(secs).padStart(2, '0')}`;
    if (e.type === 'phase_change') return `[${time}] Phase: ${e.from || 'start'} → ${e.to}`;
    if (e.type === 'suggestion') return `[${time}] Suggestion triggered: ${e.trigger}`;
    if (e.type === 'objection') return `[${time}] Objection detected: ${e.objection}`;
    if (e.type === 'exit_assist') return `[${time}] Exit assist: ${e.reason}`;
    return `[${time}] ${e.type}`;
  }).join('\n');
}

/**
 * Score a practice call transcript via Claude.
 * Returns { scores, notes, overall, grade, topStrength, topImprovement } on success,
 * or { error: true, message } on failure.
 */
async function scoreTranscript(transcript, difficulty, callerIdentity, navigatorEvents = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: true, message: 'ANTHROPIC_API_KEY not set' };
  if (!transcript || transcript.trim().length < 20) {
    return { error: true, message: 'Transcript too short to score' };
  }

  // Inject rep's name and pronouns so coaching outputs use correct gender
  const member = callerIdentity ? TEAM_BY_IDENTITY[callerIdentity] : null;
  const repContext = member
    ? `\n\nThe rep's name is ${member.name} (${member.pronouns}). Use these pronouns in all coaching outputs.`
    : '';

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
        system: SYSTEM_PROMPT + repContext,
        messages: [{
          role: 'user',
          content: `Score this ${difficulty}-difficulty practice call transcript:\n\n${transcript}`
            + (navigatorEvents ? `\n\n--- NAVIGATOR EVENT LOG (for debrief context only, do NOT affect scores) ---\n${formatNavigatorEvents(navigatorEvents)}` : ''),
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
