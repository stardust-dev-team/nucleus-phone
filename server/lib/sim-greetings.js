/**
 * lib/sim-greetings.js — Greeting pools for sim personas.
 *
 * Randomized per-call to keep reps from memorizing the opener. Difficulty tiers
 * shape the warmth/curtness of the greeting. Used by the PWA sim path
 * (routes/sim.js POST /call) and the iOS sim conference-start bridge (B2b in
 * routes/call.js) so both code paths share one source of truth.
 *
 * Keyed by persona id, then difficulty. `pickGreeting(difficulty, personaId)`
 * defaults personaId to 'mike-garza' so existing callers that pass only a
 * difficulty behave exactly as before this file was parametrized.
 */

const DEFAULT_PERSONA_ID = 'mike-garza';

const GREETING_POOLS = {
  'mike-garza': {
    easy: [
      "Garza Precision, this is Mike. What can I do for you?",
      "Hey, Mike Garza.",
      "This is Mike at Garza Precision, how can I help you?",
      "Garza Precision, Mike speaking.",
    ],
    medium: [
      "Yeah, this is Mike.",
      "Mike speaking.",
      "Garza Precision.",
      "This is Mike.",
    ],
    hard: [
      "Garza Precision.",
      "Yeah.",
      "Mike.",
      "Hello???",
    ],
  },
  'ksi-dave': {
    easy: [
      "Midwest Air Power, this is Dave.",
      "Hey, Dave Kowalski.",
      "Midwest Air Power, Dave speaking. What can I do for you?",
      "This is Dave over at Midwest Air Power.",
    ],
    medium: [
      "Yeah, this is Dave.",
      "Midwest Air Power.",
      "Dave speaking.",
      "This is Dave.",
    ],
    hard: [
      "Midwest Air Power.",
      "Yeah.",
      "Dave.",
      "Yeah, who's this?",
    ],
  },
};

function pickGreeting(difficulty, personaId = DEFAULT_PERSONA_ID) {
  const personaPools = GREETING_POOLS[personaId] || GREETING_POOLS[DEFAULT_PERSONA_ID];
  const pool = personaPools[difficulty];
  if (!pool) return "Hello?";
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { pickGreeting, GREETING_POOLS };
