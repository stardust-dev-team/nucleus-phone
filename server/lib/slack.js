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

const GRADE_EMOJI = { A: '🏆', B: '👍', C: '📝', D: '⚠️', F: '❌' };

function scoreBar(score) {
  const filled = Math.min(10, Math.max(0, Math.round(Number(score) || 0)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function formatSimScorecard(data) {
  const grade = data.call_grade || data.grade;
  const emoji = GRADE_EMOJI[grade] || '🎯';
  const dur = formatDuration(data.duration_seconds);
  const diff = data.difficulty.charAt(0).toUpperCase() + data.difficulty.slice(1);

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
          text: [
            `Rapport:          ${scoreBar(data.score_rapport)}  ${data.score_rapport}/10`,
            `Discovery:        ${scoreBar(data.score_discovery)}  ${data.score_discovery}/10`,
            `Objection:        ${scoreBar(data.score_objection)}  ${data.score_objection}/10`,
            `Product:          ${scoreBar(data.score_product)}  ${data.score_product}/10`,
            `Close:            ${scoreBar(data.score_close)}  ${data.score_close}/10`,
          ].join('\n'),
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

module.exports = { sendSlackAlert, formatCallAlert, formatSimScorecard };
