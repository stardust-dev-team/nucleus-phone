const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { sendSlackAlert } = require('../lib/slack');
const team = require('../config/team.json');

const router = Router();

const nameMap = Object.fromEntries(
  team.members.map(m => [m.identity, m.name])
);

// GET /api/scoreboard — rolling 7-day stats
router.get('/', apiKeyAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT caller_identity,
        COUNT(*) AS calls_made,
        COUNT(*) FILTER (WHERE qualification IN ('hot','warm')) AS leads_qualified,
        COUNT(*) FILTER (WHERE qualification = 'hot') AS hot_leads,
        COUNT(*) FILTER (WHERE disposition = 'callback_requested') AS callbacks,
        AVG(duration_seconds)::int AS avg_duration
      FROM nucleus_phone_calls
      WHERE created_at > NOW() - INTERVAL '7 days' AND status = 'completed'
      GROUP BY caller_identity
      ORDER BY leads_qualified DESC, calls_made DESC
    `);

    // Daily breakdown for sparklines
    const { rows: daily } = await pool.query(`
      SELECT caller_identity,
        created_at::date AS day,
        COUNT(*) AS calls
      FROM nucleus_phone_calls
      WHERE created_at > NOW() - INTERVAL '7 days' AND status = 'completed'
      GROUP BY caller_identity, created_at::date
      ORDER BY created_at::date
    `);

    const dailyByAgent = {};
    for (const row of daily) {
      const id = row.caller_identity;
      if (!dailyByAgent[id]) dailyByAgent[id] = [];
      dailyByAgent[id].push({ day: row.day, calls: parseInt(row.calls, 10) });
    }

    const leaderboard = rows.map(row => ({
      identity: row.caller_identity,
      displayName: nameMap[row.caller_identity] || row.caller_identity,
      callsMade: parseInt(row.calls_made, 10),
      leadsQualified: parseInt(row.leads_qualified, 10),
      hotLeads: parseInt(row.hot_leads, 10),
      callbacks: parseInt(row.callbacks, 10),
      avgDuration: row.avg_duration || 0,
      daily: dailyByAgent[row.caller_identity] || [],
    }));

    res.json({ leaderboard, period: '7d' });
  } catch (err) {
    console.error('Scoreboard fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch scoreboard' });
  }
});

// POST /api/scoreboard/aggregate — nightly materialization
router.post('/aggregate', apiKeyAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`
      INSERT INTO ucil_agent_stats (agent_name, stat_date, calls_made, callbacks_done, leads_qualified, hot_leads, avg_call_duration)
      SELECT
        caller_identity,
        created_at::date,
        COUNT(*),
        COUNT(*) FILTER (WHERE disposition = 'callback_requested'),
        COUNT(*) FILTER (WHERE qualification IN ('hot','warm')),
        COUNT(*) FILTER (WHERE qualification = 'hot'),
        AVG(duration_seconds)::int
      FROM nucleus_phone_calls
      WHERE status = 'completed'
        AND created_at::date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY caller_identity, created_at::date
      ON CONFLICT (agent_name, stat_date) DO UPDATE SET
        calls_made = EXCLUDED.calls_made,
        callbacks_done = EXCLUDED.callbacks_done,
        leads_qualified = EXCLUDED.leads_qualified,
        hot_leads = EXCLUDED.hot_leads,
        avg_call_duration = EXCLUDED.avg_call_duration
    `);

    // Check milestones after aggregation
    checkMilestones().catch(err =>
      console.error('Milestone check failed:', err.message)
    );

    res.json({ aggregated: rowCount });
  } catch (err) {
    console.error('Scoreboard aggregate failed:', err.message);
    res.status(500).json({ error: 'Failed to aggregate stats' });
  }
});

async function checkMilestones() {
  // Load already-sent milestones
  const { rows: sentRows } = await pool.query(
    `SELECT metadata FROM ucil_sync_state WHERE sync_key = 'milestones_sent'`
  );
  const sent = new Set(sentRows[0]?.metadata?.keys || []);

  const newMilestones = [];

  // First qualified lead ever
  const { rows: firstQual } = await pool.query(`
    SELECT agent_name, SUM(leads_qualified)::int AS total
    FROM ucil_agent_stats
    GROUP BY agent_name
    HAVING SUM(leads_qualified) = 1
  `);

  for (const row of firstQual) {
    const key = `first_qual_${row.agent_name}`;
    if (sent.has(key)) continue;
    const name = nameMap[row.agent_name] || row.agent_name;
    await sendSlackAlert(formatMilestoneAlert(name, 'First qualified lead! 🎯'));
    newMilestones.push(key);
  }

  // 3+ day streak (consecutive days with calls) — only alert for current active streaks
  const { rows: streaks } = await pool.query(`
    WITH daily AS (
      SELECT agent_name, stat_date,
        stat_date - (ROW_NUMBER() OVER (PARTITION BY agent_name ORDER BY stat_date))::int AS grp
      FROM ucil_agent_stats
      WHERE calls_made > 0 AND stat_date >= CURRENT_DATE - INTERVAL '14 days'
    )
    SELECT agent_name, COUNT(*)::int AS streak_days, MAX(stat_date) AS streak_end
    FROM daily
    GROUP BY agent_name, grp
    HAVING COUNT(*) >= 3
    ORDER BY streak_days DESC
  `);

  for (const row of streaks) {
    const key = `streak_${row.agent_name}_${row.streak_end}_${row.streak_days}`;
    if (sent.has(key)) continue;
    const name = nameMap[row.agent_name] || row.agent_name;
    await sendSlackAlert(formatMilestoneAlert(name, `${row.streak_days}-day calling streak! 🔥`));
    newMilestones.push(key);
  }

  // Persist newly sent milestones (cap at 200 most recent to prevent unbounded growth)
  if (newMilestones.length) {
    const allKeys = [...sent, ...newMilestones].slice(-200);
    await pool.query(`
      INSERT INTO ucil_sync_state (sync_key, last_sync_at, metadata)
      VALUES ('milestones_sent', NOW(), $1::jsonb)
      ON CONFLICT (sync_key) DO UPDATE SET metadata = $1::jsonb, updated_at = NOW()
    `, [JSON.stringify({ keys: allKeys })]);
  }
}

function formatMilestoneAlert(agentName, milestone) {
  return {
    text: `🏆 ${agentName}: ${milestone}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🏆 Milestone — ${agentName}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: milestone },
      },
    ],
  };
}

module.exports = router;
