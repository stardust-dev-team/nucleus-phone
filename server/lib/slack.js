const { formatDuration } = require('./format');

async function sendSlackAlert(message) {
  const webhookUrl = process.env.SLACK_SALES_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('SLACK_SALES_WEBHOOK_URL not set — skipping alert');
    return false;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      console.error('Slack alert failed:', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Slack alert error:', err.message);
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
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_ADMIN_CHANNEL_ID;
  if (!token || !channel) {
    console.warn('SLACK_BOT_TOKEN or SLACK_ADMIN_CHANNEL_ID not set — skipping admin report');
    return false;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, ...message }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Slack admin report failed:', data.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Slack admin report error:', err.message);
    return false;
  }
}

/**
 * Send a system alert to the admin channel (SLACK_ADMIN_CHANNEL_ID).
 * Used for stale-call sweeps, Vapi failures, scoring errors — anything
 * Tom needs to see as a sales manager, not just in server logs.
 */
async function sendSystemAlert(text, blocks) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_ADMIN_CHANNEL_ID;
  if (!token || !channel) {
    console.warn('SLACK_BOT_TOKEN or SLACK_ADMIN_CHANNEL_ID not set — skipping system alert');
    return false;
  }
  try {
    const payload = { channel, text };
    if (blocks) payload.blocks = blocks;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Slack system alert failed:', data.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Slack system alert error:', err.message);
    return false;
  }
}

/**
 * Send a DM to a specific Slack user by their user or DM channel ID.
 * Uses the bot token (chat:write scope).
 */
async function sendSlackDM(channelOrUserId, text, blocks) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn('SLACK_BOT_TOKEN not set — skipping DM');
    return false;
  }
  try {
    const payload = { channel: channelOrUserId, text };
    if (blocks) payload.blocks = blocks;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Slack DM failed:', data.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Slack DM error:', err.message);
    return false;
  }
}

module.exports = { sendSlackAlert, sendAdminReport, sendSystemAlert, sendSlackDM, formatCallAlert, formatSimScorecard, formatAdminReport };
