/**
 * lib/slack.js — Slack notification sender.
 *
 * Fire-and-forget contract: every function returns a boolean (true=delivered,
 * false=failed). Failures NEVER throw. Slack is best-effort notification
 * plumbing — if an alert fails, the underlying business event (call made,
 * note written) still happened. Callers are not expected to branch on failure
 * shape; telemetry lives in logEvent for forensics.
 *
 * Contrast with apollo.js/hubspot.js which throw structured errors — those are
 * system-of-record writes where the caller needs to know what broke.
 */

const { formatDuration } = require('./format');
const { logEvent } = require('./debug-log');
const { touch } = require('./health-tracker');
const { throwHttpError } = require('./http-error');

const CHAT_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/**
 * POST to Slack's chat.postMessage (bot token). Shared by the three bot-mode
 * callers (sendAdminReport, sendSystemAlert, sendSlackDM). Fire-and-forget
 * contract: returns true on success, false on ANY failure (network, HTTP,
 * or data.ok:false). All failure paths log + emit telemetry; callers never
 * see exceptions.
 *
 * @param {Object} payload - Full Slack message payload (must include `channel`)
 * @param {string} context - Short tag for logs ('admin_report', 'system_alert', 'dm')
 */
async function postBotMessage(payload, context) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn(`SLACK_BOT_TOKEN not set — skipping ${context}`);
    return false;
  }
  try {
    const resp = await fetch(CHAT_POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throwHttpError(resp, text, 'POST', 'chat.postMessage', { service: 'Slack' });
    }
    const data = await resp.json();
    if (!data.ok) {
      // Slack returns HTTP 200 on logical failures (invalid_auth, channel_not_found,
      // not_in_channel). Treat these as structured errors so the catch block logs
      // with the same shape as HTTP failures. err.kind distinguishes this from
      // transport failures — the catch block logs kind so the telemetry doesn't
      // lie about "no status" when really it's "HTTP 200 but Slack rejected it."
      const err = new Error(`Slack chat.postMessage ok:false — ${data.error || 'unknown'}`);
      err.kind = 'slack_logical';
      err.slackError = data.error || null;
      err.endpoint = 'chat.postMessage';
      err.method = 'POST';
      throw err;
    }
    touch('slack');
    return true;
  } catch (err) {
    console.error(`Slack ${context} failed:`, err.message);
    logEvent('integration', 'slack', `${context} failed: ${err.message}`, {
      level: 'error',
      detail: {
        kind: err.kind,
        status: err.status,
        slackError: err.slackError,
        body: typeof err.body === 'string' ? err.body.substring(0, 200) : undefined,
      },
    });
    return false;
  }
}

async function sendSlackAlert(message) {
  const webhookUrl = process.env.SLACK_SALES_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('SLACK_SALES_WEBHOOK_URL not set — skipping alert');
    return false;
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throwHttpError(resp, text, 'POST', 'slack_webhook', { service: 'Slack' });
    }
    touch('slack');
    return true;
  } catch (err) {
    console.error('Slack alert error:', err.message);
    logEvent('integration', 'slack', `alert error: ${err.message}`, {
      level: 'error',
      detail: {
        status: err.status,
        body: typeof err.body === 'string' ? err.body.substring(0, 200) : undefined,
      },
    });
    return false;
  }
}

function formatCallAlert(callData) {
  const emoji = callData.qualification === 'hot' ? ':fire:' : ':thermometer:';
  return {
    text: `${emoji} *${callData.disposition}* — ${callData.leadName} at ${callData.leadCompany}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji === ':fire:' ? '🔥' : '🌡️'} ${callData.qualification?.toUpperCase() || 'QUALIFIED'} Lead — Phone Call` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Contact:*\n${callData.leadName}` },
          { type: 'mrkdwn', text: `*Company:*\n${callData.leadCompany}` },
          { type: 'mrkdwn', text: `*Called by:*\n${callData.callerIdentity}` },
          { type: 'mrkdwn', text: `*Duration:*\n${formatDuration(callData.durationSeconds)}` },
        ],
      },
      ...(callData.notes ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Notes:*\n${callData.notes}` },
      }] : []),
      ...(callData.productsDiscussed?.length ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Products:*\n${callData.productsDiscussed.join(', ')}` },
      }] : []),
    ],
  };
}

// Keep in sync with client/src/lib/constants.js GRADE_EMOJI
const GRADE_EMOJI = { A: '🏆', B: '👍', C: '📝', D: '⚠️', F: '❌' };

function scoreBar(score) {
  const n = Math.min(10, Math.max(0, Number(score) || 0));
  const full = Math.floor(n);
  const half = (n - full >= 0.5) ? 1 : 0;
  const empty = 10 - full - half;
  return '█'.repeat(full) + (half ? '▓' : '') + '░'.repeat(empty);
}

function formatSimScorecard(data) {
  const grade = data.call_grade || data.grade;
  const emoji = GRADE_EMOJI[grade] || '🎯';
  const dur = formatDuration(data.duration_seconds);
  const diff = data.difficulty ? data.difficulty.charAt(0).toUpperCase() + data.difficulty.slice(1) : 'Unknown';

  return {
    text: `${emoji} Practice Scorecard — ${data.caller_identity} | ${diff} | Grade: ${grade}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} Practice Call Scorecard` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Rep:*\n${data.caller_identity}` },
          { type: 'mrkdwn', text: `*Difficulty:*\n${diff}` },
          { type: 'mrkdwn', text: `*Duration:*\n${dur}` },
          { type: 'mrkdwn', text: `*Grade:*\n${grade} (${data.score_overall}/10)` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '```\n' + [
            `Rapport:   ${scoreBar(data.score_rapport)}  ${data.score_rapport}/10`,
            `Discovery: ${scoreBar(data.score_discovery)}  ${data.score_discovery}/10`,
            `Objection: ${scoreBar(data.score_objection)}  ${data.score_objection}/10`,
            `Product:   ${scoreBar(data.score_product)}  ${data.score_product}/10`,
            `Close:     ${scoreBar(data.score_close)}  ${data.score_close}/10`,
          ].join('\n') + '\n```',
        },
      },
      ...(data.top_strength ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Strength:* ${data.top_strength}` },
      }] : []),
      ...(data.top_improvement ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Work on:* ${data.top_improvement}` },
      }] : []),
    ],
  };
}

function formatAdminReport(data) {
  const grade = data.call_grade || data.grade;
  const diff = data.difficulty ? data.difficulty.charAt(0).toUpperCase() + data.difficulty.slice(1) : 'Unknown';
  return {
    text: `:lock: Mentoring Notes — ${data.caller_identity} | ${diff} | Grade: ${grade}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🔒 Mentoring Notes — ${data.caller_identity}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Rep:*\n${data.caller_identity}` },
          { type: 'mrkdwn', text: `*Difficulty:*\n${diff}` },
          { type: 'mrkdwn', text: `*Grade:*\n${grade} (${data.score_overall}/10)` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: data.admin_report },
      },
    ],
  };
}

async function sendAdminReport(message) {
  const channel = process.env.SLACK_ADMIN_CHANNEL_ID;
  if (!channel) {
    console.warn('SLACK_ADMIN_CHANNEL_ID not set — skipping admin report');
    return false;
  }
  return postBotMessage({ channel, ...message }, 'admin_report');
}

/**
 * Send a system alert to the admin channel (SLACK_ADMIN_CHANNEL_ID).
 * Used for stale-call sweeps, Vapi failures, scoring errors — anything
 * Tom needs to see as a sales manager, not just in server logs.
 */
async function sendSystemAlert(text, blocks) {
  const channel = process.env.SLACK_ADMIN_CHANNEL_ID;
  if (!channel) {
    console.warn('SLACK_ADMIN_CHANNEL_ID not set — skipping system alert');
    return false;
  }
  const payload = { channel, text };
  if (blocks) payload.blocks = blocks;
  return postBotMessage(payload, 'system_alert');
}

/**
 * Send a DM to a specific Slack user by their user or DM channel ID.
 * Uses the bot token (chat:write scope).
 */
async function sendSlackDM(channelOrUserId, text, blocks) {
  const payload = { channel: channelOrUserId, text };
  if (blocks) payload.blocks = blocks;
  return postBotMessage(payload, 'dm');
}

module.exports = { sendSlackAlert, sendAdminReport, sendSystemAlert, sendSlackDM, formatCallAlert, formatSimScorecard, formatAdminReport };
