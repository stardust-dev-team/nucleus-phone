/**
 * lib/fireflies-sync.js — Pull Fireflies transcripts, dedup, analyze, sync.
 */

const { pool } = require('../db');
const { resolve } = require('../lib/identity-resolver');
const { syncInteraction } = require('../lib/interaction-sync');
const team = require('../config/team.json');

const MAX_TRANSCRIPTS = 20;
const SEED_LOOKBACK_DAYS = 7;
const DEDUP_WINDOW_MINUTES = 15;

const TEAM_EMAILS = new Set(team.members.map(m => m.email));

const ANALYSIS_PROMPT = `Analyze this call transcript and return JSON with:
- summary: 2-3 sentence summary of the call
- intent: primary caller intent (e.g., "pricing inquiry", "technical support", "follow-up")
- products_discussed: array of product names mentioned
- sentiment: "positive" | "neutral" | "negative"
- competitive_mentions: array of competitor names mentioned (empty if none)
- disposition: "connected" | "voicemail" | "no_answer" | "callback_requested" based on conversation

Respond with ONLY valid JSON, no markdown fences.`;

// Title pattern from server/lib/fireflies.js line 39
const NPC_TITLE_PATTERN = /^CNC Call\s*[—–-]\s*.+\s*[—–-]\s*\d{4}-\d{2}-\d{2}$/;

const TRANSCRIPTS_QUERY = `
  query SyncTranscripts($fromDate: DateTime, $limit: Int) {
    transcripts(fromDate: $fromDate, limit: $limit) {
      id
      title
      date
      duration
      organizer_email
      participants
      sentences {
        speaker_name
        text
        start_time
        end_time
      }
    }
  }
`;

async function firefliesQuery(query, variables) {
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) throw new Error('FIREFLIES_API_KEY not set');

  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });

  const data = await res.json();
  if (data.errors) throw new Error(`Fireflies: ${data.errors[0].message}`);
  return data.data;
}

async function getLastSyncTime() {
  const { rows } = await pool.query(
    `SELECT last_sync_at FROM ucil_sync_state WHERE sync_key = 'fireflies'`
  );
  if (rows.length) return rows[0].last_sync_at;
  // Seed: 7 days ago
  return new Date(Date.now() - SEED_LOOKBACK_DAYS * 86400000);
}

async function updateSyncTime(timestamp) {
  await pool.query(`
    INSERT INTO ucil_sync_state (sync_key, last_sync_at)
    VALUES ('fireflies', $1)
    ON CONFLICT (sync_key) DO UPDATE SET last_sync_at = $1, updated_at = NOW()
  `, [timestamp]);
}

/**
 * 3-layer dedup check.
 * Returns true if this transcript is a duplicate.
 */
async function isDuplicate(transcript) {
  // Layer 1: Title matches nucleus-phone upload pattern
  if (NPC_TITLE_PATTERN.test(transcript.title)) return true;

  const tDate = new Date(transcript.date);

  // Layer 2: Existing customer_interactions with npc_ session within timeframe
  const { rows: npcRows } = await pool.query(`
    SELECT id FROM customer_interactions
    WHERE session_id LIKE 'npc_%'
      AND created_at BETWEEN $1 AND $2
    LIMIT 1
  `, [
    new Date(tDate.getTime() - DEDUP_WINDOW_MINUTES * 60000),
    new Date(tDate.getTime() + DEDUP_WINDOW_MINUTES * 60000),
  ]);
  if (npcRows.length) return true;

  // Layer 3: Already synced this exact Fireflies transcript
  const { rows: ffRows } = await pool.query(
    `SELECT id FROM customer_interactions WHERE session_id = $1`,
    [`ff_${transcript.id}`]
  );
  if (ffRows.length) return true;

  return false;
}

function extractPhoneFromParticipants(participants) {
  if (!participants || !Array.isArray(participants)) return null;
  for (const p of participants) {
    if (typeof p === 'string' && /\d{7,}/.test(p.replace(/\D/g, ''))) {
      return p;
    }
  }
  return null;
}

function extractTeamMember(transcript) {
  const orgEmail = transcript.organizer_email;
  if (orgEmail && TEAM_EMAILS.has(orgEmail)) {
    const member = team.members.find(m => m.email === orgEmail);
    return member?.identity || null;
  }
  if (transcript.participants) {
    for (const p of transcript.participants) {
      if (typeof p === 'string' && TEAM_EMAILS.has(p)) {
        return team.members.find(m => m.email === p)?.identity || null;
      }
    }
  }
  return null;
}

function buildTranscriptText(sentences) {
  if (!sentences?.length) return '';
  return sentences
    .map(s => `${s.speaker_name || 'Unknown'}: ${s.text}`)
    .join('\n')
    .substring(0, 8000); // Cap for Claude prompt
}

async function analyzeTranscript(transcriptText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: ANALYSIS_PROMPT,
        messages: [{ role: 'user', content: transcriptText }],
      }),
    });

    if (!res.ok) return null;
    const result = await res.json();
    const text = result.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function sync() {
  const fromDate = await getLastSyncTime();
  console.log('Fireflies sync from:', fromDate);

  const data = await firefliesQuery(TRANSCRIPTS_QUERY, {
    fromDate: new Date(fromDate).toISOString(),
    limit: MAX_TRANSCRIPTS,
  });

  const transcripts = data?.transcripts || [];
  if (!transcripts.length) {
    console.log('No new Fireflies transcripts');
    return { processed: 0, skipped: 0 };
  }

  // Filter: at least one team member involved
  const relevant = transcripts.filter(t => extractTeamMember(t));
  console.log(`${transcripts.length} transcripts, ${relevant.length} involve team members`);

  let processed = 0;
  let skipped = 0;
  let latestDate = fromDate;

  for (const transcript of relevant) {
    try {
      if (await isDuplicate(transcript)) {
        skipped++;
        continue;
      }

      const phone = extractPhoneFromParticipants(transcript.participants);
      const agentName = extractTeamMember(transcript);
      const transcriptText = buildTranscriptText(transcript.sentences);
      const analysis = transcriptText ? await analyzeTranscript(transcriptText) : null;

      // Identity resolution (best-effort)
      let identity = null;
      if (phone) {
        try { identity = await resolve(phone); } catch { /* noop */ }
      }

      await syncInteraction({
        channel: 'voice',
        direction: 'inbound',
        sessionId: `ff_${transcript.id}`,
        phone: phone || null,
        contactName: identity?.name || null,
        companyName: identity?.company || null,
        agentName,
        summary: analysis?.summary || transcript.title,
        productsDiscussed: analysis?.products_discussed || [],
        disposition: analysis?.disposition || 'connected',
        transcript: transcriptText || null,
        sentiment: analysis?.sentiment ? { overall: analysis.sentiment } : null,
        competitiveIntel: analysis?.competitive_mentions?.length
          ? { mentions: analysis.competitive_mentions } : null,
        sourceMetadata: {
          firefliesId: transcript.id,
          title: transcript.title,
          duration: transcript.duration,
        },
      });

      processed++;
      if (new Date(transcript.date) > new Date(latestDate)) {
        latestDate = transcript.date;
      }
    } catch (err) {
      console.error(`Fireflies sync error for ${transcript.id}:`, err.message);
    }
  }

  // Only update sync time if we actually processed or checked all transcripts
  if (processed > 0 || skipped > 0) {
    await updateSyncTime(latestDate);
  }

  console.log(`Fireflies sync complete: ${processed} processed, ${skipped} skipped`);
  return { processed, skipped };
}

module.exports = { sync };
