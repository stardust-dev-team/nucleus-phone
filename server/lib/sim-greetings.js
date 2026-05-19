/**
 * lib/sim-greetings.js — Greeting pools for sim personas (Mike Garza).
 *
 * Randomized per-call to keep reps from memorizing the opener. Difficulty tiers
 * shape the warmth/curtness of the greeting. Used both by the PWA sim path
 * (routes/sim.js POST /call) and the iOS sim conference-start bridge (B2b in
 * routes/call.js) so both code paths share one source of truth.
 */

const GREETING_POOLS = {
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
};

function pickGreeting(difficulty) {
  const pool = GREETING_POOLS[difficulty];
  if (!pool) return "Hello?";
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { pickGreeting, GREETING_POOLS };
