/**
 * escalation.js — Dual SMS + Slack escalation to Tom.
 *
 * Rate-limited: 1 escalation per rep per 5 minutes (in-memory).
 * Resets on deploy — acceptable for 7-person team.
 */

const { client: twilioClient } = require('./twilio');
const { sendSlackDM } = require('./slack');
const { loadRegistryOrExit } = require('./team-registry');

// Load registry at module-init via the shared fail-loud wrapper. Catches
// team.json corruption at boot rather than at first escalation request
// (which would 500 the rep's ask-flow). Identical behavior across
// incoming.js / escalation.js / sim.js (Linus pass-3 #4).
const registry = loadRegistryOrExit('escalation');

const RATE_LIMIT_MS = 5 * 60 * 1000;
const rateMap = new Map();

function checkRateLimit(repIdentity) {
  const last = rateMap.get(repIdentity);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    const retryAfter = Math.ceil((RATE_LIMIT_MS - (Date.now() - last)) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }
  return { allowed: true };
}

async function escalateToTom({ repName, question, context, company, contact }) {
  const rate = checkRateLimit(repName);
  if (!rate.allowed) return { sent: false, rateLimited: true, retryAfterSeconds: rate.retryAfterSeconds };

  rateMap.set(repName, Date.now());

  // Escalations always go to Tom (CEO triage). Pulled from the canonical
  // team-registry (loaded + validated at module init above). Drops the
  // earlier PHONE_TOM/TOM_SLACK_USER_ID env vars — Linus #6 reduction
  // of drift surface.
  const tom = registry.getRepByIdentity('tom');
  const phoneTo = tom && tom.mobile;
  const phoneFrom = process.env.TWILIO_PHONE_NUMBER;
  const slackUserId = tom && tom.slackUserId;

  const companyStr = company ? ` re: ${company}` : '';
  const smsBody = `${repName}${companyStr}: ${question}`.substring(0, 160);

  const slackBlocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Escalation from ${repName}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Question:*\n${question}` },
        ...(company ? [{ type: 'mrkdwn', text: `*Company:*\n${company}` }] : []),
        ...(contact ? [{ type: 'mrkdwn', text: `*Contact:*\n${contact}` }] : []),
      ],
    },
    ...(context ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: `*Context:*\n${context.substring(0, 500)}` },
    }] : []),
  ];

  const results = { sms: false, slack: false };

  const promises = [];

  if (phoneTo && phoneFrom) {
    promises.push(
      twilioClient.messages.create({ to: phoneTo, from: phoneFrom, body: smsBody })
        .then(() => { results.sms = true; })
        .catch(err => console.error('Escalation SMS failed:', err.message))
    );
  } else {
    console.warn('escalation: Tom mobile (team-phones.json) or TWILIO_PHONE_NUMBER not set — skipping SMS');
  }

  if (slackUserId) {
    promises.push(
      sendSlackDM(slackUserId, `Escalation from ${repName}: ${question}`, slackBlocks)
        .then(ok => { results.slack = ok; })
        .catch(err => console.error('Escalation Slack DM failed:', err.message))
    );
  } else {
    console.warn('escalation: Tom slackUserId not in team.json — skipping Slack DM');
  }

  await Promise.all(promises);

  const channels = [];
  if (results.sms) channels.push('sms');
  if (results.slack) channels.push('slack');

  return { sent: channels.length > 0, channels, sms: results.sms, slack: results.slack };
}

module.exports = { escalateToTom, checkRateLimit };
