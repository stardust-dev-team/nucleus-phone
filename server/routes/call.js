const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { client } = require('../lib/twilio');
const { bearerOrApiKeyOrSession } = require('../middleware/auth');
const { rbac, hasMinRole } = require('../middleware/rbac');
const {
  createConference, getConference, updateConference,
  removeConference, listActiveConferences, claimLeadDial,
} = require('../lib/conference');
const { cleanupCall } = require('../lib/live-analysis');
const { cleanupConversation } = require('../lib/conversation-pipeline');
const { cleanupPipelineState } = require('../lib/equipment-pipeline');
const { sendSlackAlert, sendSystemAlert } = require('../lib/slack');
const { createOutboundCall } = require('../lib/vapi');
const { resolveAssistantId } = require('../lib/personas');
const { pickGreeting } = require('../lib/sim-greetings');

const router = Router();

// Rep-facing endpoints need auth + at least external_caller. /status is a
// Twilio webhook validated by signature, so it explicitly bypasses this.
const callerGuard = [bearerOrApiKeyOrSession, rbac('external_caller')];

// Require session-auth callers (non-admin) to operate only on their own
// identity. Admin principals (API key or admin role) bypass this check so
// automation and debugging still work.
function enforceOwnIdentity(req, res, bodyIdentity) {
  if (!req.user) return false;
  if (hasMinRole(req.user.role, 'admin')) return true;
  if (!bodyIdentity || bodyIdentity === req.user.identity) return true;
  res.status(403).json({ error: 'callerIdentity must match your own identity' });
  return false;
}
const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const twilioWebhook = makeTwilioWebhook();

const E164_RE = /^\+[1-9]\d{6,14}$/;

// POST /api/call/initiate — start a new call
router.post('/initiate', ...callerGuard, async (req, res) => {
  const { to, contactName, companyName, contactId, callerIdentity } = req.body;

  if (!to || !callerIdentity) {
    return res.status(400).json({ error: 'to and callerIdentity required' });
  }

  if (!E164_RE.test(to)) {
    return res.status(400).json({ error: 'to must be E.164 format (e.g. +16025551234)' });
  }

  // Non-admin callers can only initiate as themselves.
  if (!enforceOwnIdentity(req, res, callerIdentity)) return;

  const conferenceName = `nucleus-call-${uuidv4()}`;

  try {
    const result = await pool.query(
      `INSERT INTO nucleus_phone_calls
        (conference_name, caller_identity, lead_phone, lead_name, lead_company, hubspot_contact_id, use_inhouse_stt)
       VALUES ($1, $2, $3, $4, $5, $6,
         COALESCE((SELECT use_inhouse_stt FROM nucleus_phone_users WHERE identity = $2), FALSE))
       RETURNING id`,
      [conferenceName, callerIdentity, to, contactName || null, companyName || null, contactId || null]
    );

    const dbRowId = result.rows[0].id;

    createConference(conferenceName, {
      callerIdentity, to, contactName, companyName, contactId, dbRowId,
    });

    res.json({ conferenceName, callId: dbRowId });

    // Poll for the conference SID and dial the lead in.
    // Status callbacks should handle this, but as a fallback we poll
    // in case the callback is delayed or lost behind the proxy.
    dialLeadWhenReady(conferenceName, to, dbRowId);
  } catch (err) {
    console.error('Call initiation failed:', err);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

// Poll Twilio for the conference SID, then dial the lead in.
// Retries every 1.5s for up to 15s. Exits early if the status
// callback already handled it (conferenceSid already set).
async function dialLeadWhenReady(conferenceName, leadPhone, dbRowId) {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));

    const conf = getConference(conferenceName);
    if (!conf) return; // call was cancelled or cleaned up
    if (conf.leadDialed) return; // status callback already dialed the lead

    try {
      const conferences = await client.conferences.list({
        friendlyName: conferenceName,
        status: 'in-progress',
        limit: 1,
      });

      if (conferences.length === 0) continue;

      const sid = conferences[0].sid;
      if (!claimLeadDial(conferenceName)) return; // callback beat us
      updateConference(conferenceName, { conferenceSid: sid });

      pool.query(
        'UPDATE nucleus_phone_calls SET conference_sid = $1 WHERE id = $2',
        [sid, dbRowId]
      ).catch((err) => console.error('Failed to persist conference_sid:', err.message));

      await client.conferences(sid).participants.create({
        from: process.env.NUCLEUS_PHONE_NUMBER,
        to: leadPhone,
        earlyMedia: true,
        beep: false,
        endConferenceOnExit: true,
      });

      console.log(`[poll-fallback] Dialed ${leadPhone} into ${conferenceName}`);
      return;
    } catch (err) {
      console.error(`[poll-fallback] Attempt ${i + 1} failed:`, err.message);
    }
  }
  console.error(`[poll-fallback] Gave up dialing lead for ${conferenceName}`);
  removeConference(conferenceName);
  pool.query(
    "UPDATE nucleus_phone_calls SET status = 'failed' WHERE id = $1 AND status != 'completed'",
    [dbRowId]
  ).catch((err) => console.error('Failed to mark call as failed:', err.message));
  sendSlackAlert({
    text: `:warning: Failed to connect lead ${leadPhone} — caller may be sitting in silence (${conferenceName})`,
  }).catch((err) => console.error('[poll-fallback] Slack alert failed:', err.message));
}

// POST /api/call/join — admin joins an active conference
router.post('/join', ...callerGuard, (req, res) => {
  const { conferenceName, callerIdentity, muted } = req.body;

  const conf = getConference(conferenceName);
  if (!conf) {
    return res.status(404).json({ error: 'Conference not found' });
  }

  res.json({ conferenceName, muted: !!muted });
});

// POST /api/call/mute — toggle participant mute via Twilio REST API
router.post('/mute', ...callerGuard, async (req, res) => {
  const { conferenceName, participantCallSid, muted } = req.body;

  const conf = getConference(conferenceName);
  if (!conf || !conf.conferenceSid) {
    return res.status(404).json({ error: 'Conference not found' });
  }

  if (req.user && !hasMinRole(req.user.role, 'admin')) {
    if (conf.callerIdentity && conf.callerIdentity !== req.user.identity) {
      return res.status(403).json({ error: 'Not your conference' });
    }
  }

  try {
    await client.conferences(conf.conferenceSid)
      .participants(participantCallSid)
      .update({ muted: !!muted });

    res.json({ success: true, muted: !!muted });
  } catch (err) {
    console.error('Mute toggle failed:', err.message);
    res.status(500).json({ error: 'Failed to toggle mute' });
  }
});

// GET /api/call/active — list active conferences with participants
// Admins also see in-progress practice calls.
//
// Optional ?identity=<me> filter narrows the response to conferences started
// by that identity. iOS dialer uses this as a precondition check before
// dialing — if the agent already has a live call on another device, the
// initiator surfaces a "you're already on a call" alert and returns. The
// filter applies uniformly to both 'live' and 'sim' entries.
//
// LIMITATION: filter matches startedBy only, not participants. Today every
// outbound conference is 1:1 with the initiating rep, so "calls I started"
// equals "calls I'm on." If a future flow adds rep-B-joins-rep-A patterns
// (warm transfer, shadow listen, supervisor monitor), this filter will fail
// open: rep B asking ?identity=B will not see A's conference and the iOS
// dialer's double-dial guard will allow a second call. Tracked: see
// nucleus-phone bead for participant-aware filter once such a flow lands.
router.get('/active', ...callerGuard, async (req, res) => {
  const filterIdentity = typeof req.query.identity === 'string' && req.query.identity.length
    ? req.query.identity
    : null;
  const conferences = listActiveConferences();

  const enriched = await Promise.all(
    conferences.map(async (conf) => {
      let participants = [];
      let duration = Math.floor((Date.now() - conf.startedAt.getTime()) / 1000);

      if (conf.conferenceSid) {
        try {
          const parts = await client.conferences(conf.conferenceSid)
            .participants.list();
          participants = parts.map((p) => ({
            callSid: p.callSid,
            muted: p.muted,
            hold: p.hold,
          }));
        } catch (_) { /* conference may have ended */ }
      }

      return {
        type: 'live',
        conferenceName: conf.conferenceName,
        conferenceSid: conf.conferenceSid,
        startedAt: conf.startedAt,
        startedBy: conf.startedBy,
        leadName: conf.leadName,
        leadCompany: conf.leadCompany,
        leadPhone: conf.leadPhone,
        direction: conf.direction || 'outbound',
        participants,
        duration,
      };
    })
  );

  // Practice-call visibility:
  //   • Admin (Tom, Paul): all in-progress + scoring sims (used by ops dashboards).
  //   • Non-admin reps: own in-progress sims only. This is what makes the
  //     iOS dialer's `shouldRejectDial` precondition work — a rep with an
  //     in-flight PWA sim must not be able to start another sim from iOS.
  //     "scoring" is intentionally excluded for non-admins; once a sim has
  //     ended on the rep's side, they should be free to start the next one.
  let simQuery = null;
  let simParams = [];
  if (req.user?.role === 'admin') {
    simQuery = `
      SELECT id, caller_identity, difficulty, created_at, status, monitor_listen_url
      FROM sim_call_scores
      WHERE status IN ('in-progress', 'scoring')
      ORDER BY created_at DESC
    `;
  } else if (req.user?.identity) {
    simQuery = `
      SELECT id, caller_identity, difficulty, created_at, status, monitor_listen_url
      FROM sim_call_scores
      WHERE status = 'in-progress' AND caller_identity = $1
      ORDER BY created_at DESC
    `;
    simParams = [req.user.identity];
  }
  if (simQuery) {
    try {
      const { rows } = await pool.query(simQuery, simParams);
      for (const row of rows) {
        enriched.push({
          type: 'sim',
          simCallId: row.id,
          conferenceName: `sim-${row.id}`,
          startedAt: row.created_at,
          startedBy: row.caller_identity,
          leadName: 'Mike Garza',
          leadCompany: `Practice — ${row.difficulty}`,
          participants: [],
          duration: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
          simStatus: row.status,
          hasListenUrl: !!row.monitor_listen_url,
        });
      }
    } catch (err) {
      console.error('Failed to fetch active sim calls:', err.message);
    }
  }

  const filtered = filterIdentity
    ? enriched.filter((c) => c.startedBy === filterIdentity)
    : enriched;
  res.json({ calls: filtered });
});

// POST /api/call/end — end a conference. Non-admin users can only end their
// own conferences (identified by conf.callerIdentity from createConference).
//
// bd-sgc: after Twilio confirms the conference end, synchronously remove
// the entry from the in-memory active map AND mark the DB row completed,
// instead of waiting for the conference-end webhook (which arrives 3-5s
// later — long enough that an iOS rep tapping "next call" immediately
// after hangup hits the precondition guard's "already on a call" reject).
//
// Webhook arm at the /status route (`StatusCallbackEvent === 'conference-end'`)
// is the cleanup safety net for paths where /api/call/end never fires
// (lead hung up first, network drop, etc). It's idempotent against the
// work done here: getConference returns undefined for the already-removed
// conf and the `if (conf)` guard short-circuits.
router.post('/end', ...callerGuard, async (req, res) => {
  const { conferenceName } = req.body;

  const conf = getConference(conferenceName);
  if (!conf || !conf.conferenceSid) {
    return res.status(404).json({ error: 'Conference not found' });
  }

  if (req.user && !hasMinRole(req.user.role, 'admin')) {
    if (conf.callerIdentity && conf.callerIdentity !== req.user.identity) {
      return res.status(403).json({ error: 'Not your conference' });
    }
  }

  try {
    await client.conferences(conf.conferenceSid).update({ status: 'completed' });
  } catch (err) {
    console.error('End conference failed:', err.message);
    return res.status(500).json({ error: 'Failed to end conference' });
  }

  // bd-sgc cleanup. Snapshot the fields we need BEFORE removeConference;
  // after removal, getConference() returns undefined. Duration is computed
  // from the same `conf.startedAt` the webhook arm uses so this race
  // converges to the same row value.
  const duration = Math.floor((Date.now() - conf.startedAt.getTime()) / 1000);
  const sid = conf.conferenceSid;
  removeConference(conferenceName);
  try {
    await pool.query(
      `UPDATE nucleus_phone_calls
       SET status = 'completed', duration_seconds = $1, conference_sid = $2
       WHERE conference_name = $3 AND status != 'completed'`,
      [duration, sid, conferenceName]
    );
  } catch (err) {
    console.error('bd-sgc DB cleanup failed:', err.message);
    // Don't fail the response — the row update is a follow-up, the
    // Twilio conference is already ended and the in-memory entry is
    // already gone. Stale-sweep / Twilio webhook will retry on the
    // next opportunity.
  }
  cleanupConversation(conferenceName);
  cleanupPipelineState(conferenceName);
  cleanupCall(conferenceName);

  res.json({ success: true });
});

// POST /api/call/status — Twilio conference status callback
router.post('/status', twilioWebhook, async (req, res) => {
  const {
    ConferenceSid, FriendlyName, StatusCallbackEvent,
    CallSid, Muted,
  } = req.body;

  const conf = getConference(FriendlyName);

  // ── SIM bridge (B2b, Architecture B) ─────────────────────────────────────
  // For sim conferences (FriendlyName === `sim-{id}`), the second participant
  // is Vapi-as-Mike-Garza, not a PSTN lead. On conference-start we dial Vapi
  // outbound to NUCLEUS_SIM_CONFERENCE_NUMBER. Vapi's inbound TwiML
  // (provisioned separately — see follow-up bead) connects that leg into
  // this same conference. Idempotency via SELECT FOR UPDATE on the
  // sim_call_scores row keyed by conference_name; vapi_call_id IS NOT NULL
  // is the sentinel check (sentinel column, not the locked column).
  //
  // This branch returns 204 inside handleSimConferenceStart and short-
  // circuits the rest of the handler so the real-call lead-dial path
  // doesn't run for sims (sim conf.leadPhone is null anyway, so it would
  // no-op — but explicit is better than relying on that invariant).
  // Trigger on EITHER conference-start OR participant-join — for PSTN-bridge
  // REST-created calls, Twilio sometimes fires only participant-join (q0z
  // smoke 2026-05-22). handleSimConferenceStart's SELECT FOR UPDATE on
  // vapi_call_id makes the second event a no-op short-circuit.
  const isSimBridgeTrigger = (StatusCallbackEvent === 'conference-start' || StatusCallbackEvent === 'participant-join')
    && ConferenceSid
    && typeof FriendlyName === 'string'
    && FriendlyName.startsWith('sim-');
  if (isSimBridgeTrigger) {
    await handleSimConferenceStart({ FriendlyName, ConferenceSid, conf });
    return res.sendStatus(204);
  }

  // On conference-start or first participant-join: save SID and dial the lead.
  // participant-join typically arrives ~800ms before conference-start, so we
  // trigger on whichever lands first. claimLeadDial() prevents double-dialing.
  //
  // claimLeadDial is a synchronous compare-and-set on an in-memory Map.
  // Because there is no await between reading conf.conferenceSid and
  // calling claimLeadDial, no other request can interleave here.
  // DO NOT add any async operation between these two checks.
  const shouldDialLead = StatusCallbackEvent === 'conference-start'
    || StatusCallbackEvent === 'participant-join';
  if (shouldDialLead && conf && ConferenceSid) {
    if (!conf.conferenceSid) {
      updateConference(FriendlyName, { conferenceSid: ConferenceSid });
      pool.query(
        'UPDATE nucleus_phone_calls SET conference_sid = $1 WHERE conference_name = $2',
        [ConferenceSid, FriendlyName]
      ).catch((err) => console.error('Failed to persist conference_sid:', err.message));
    }

    if (conf.leadPhone && claimLeadDial(FriendlyName)) {
      const isInbound = FriendlyName.startsWith('nucleus-inbound-');
      try {
        const participantOpts = {
          from: process.env.NUCLEUS_PHONE_NUMBER,
          to: conf.leadPhone,
          earlyMedia: true,
          beep: false,
          endConferenceOnExit: !isInbound,
        };

        // For inbound calls: monitor the rep's leg so we can redirect
        // the caller to voicemail if the rep doesn't answer.
        if (isInbound) {
          participantOpts.statusCallback = `${baseUrl}/api/voice/incoming/rep-status?conf=${encodeURIComponent(FriendlyName)}&rep_slack=${encodeURIComponent(conf.repSlackDm || '')}`;
          participantOpts.statusCallbackEvent = 'initiated ringing answered completed';
          participantOpts.statusCallbackMethod = 'POST';
          participantOpts.timeout = 25;
        }

        await client.conferences(ConferenceSid).participants.create(participantOpts);
        console.log(`[callback] Dialed ${conf.leadPhone} via ${StatusCallbackEvent} for ${FriendlyName}`);
      } catch (err) {
        console.error('Failed to dial lead into conference:', err.message);
      }
    }
  }

  if (StatusCallbackEvent === 'participant-join' && conf) {
    conf.participants.push({ callSid: CallSid, muted: Muted === 'true', joinedAt: new Date() });
  }

  if (StatusCallbackEvent === 'participant-leave' && conf) {
    conf.participants = conf.participants.filter((p) => p.callSid !== CallSid);
  }

  // bd-sgc: the `&& conf` guard is LOAD-BEARING for idempotency.
  // POST /api/call/end now synchronously calls removeConference +
  // the same DB UPDATE + the same three cleanup functions. When the
  // Twilio webhook arrives 3-5s later, getConference returns undefined
  // for the already-removed conf and the `&& conf` short-circuit
  // prevents double-cleanup. If a future refactor removes that
  // cleanup from /api/call/end, this arm must regain the SQL guard
  // (`AND status != 'completed'`) and/or absorb the cleanup work.
  //
  // Sim conferences have their own end-of-call lifecycle (sim.js's Vapi
  // webhook handler ends the Twilio conference and clears the map). They
  // don't have rows in nucleus_phone_calls — the UPDATE below would be a
  // harmless no-op for them today, but matching on FriendlyName across the
  // wrong table is a landmine. Explicitly skip sim conferences here.
  if (StatusCallbackEvent === 'conference-end' && conf
      && !(typeof FriendlyName === 'string' && FriendlyName.startsWith('sim-'))) {
    const duration = Math.floor((Date.now() - conf.startedAt.getTime()) / 1000);

    try {
      await pool.query(
        `UPDATE nucleus_phone_calls
         SET status = 'completed', duration_seconds = $1, conference_sid = $2
         WHERE conference_name = $3`,
        [duration, ConferenceSid, FriendlyName]
      );
    } catch (err) {
      console.error('Failed to update call record:', err.message);
    }

    removeConference(FriendlyName);
    // TODO: capture getCallEventLog(FriendlyName) before cleanup when real-call debrief is added
    cleanupConversation(FriendlyName);
    cleanupPipelineState(FriendlyName);
    cleanupCall(FriendlyName);
  }

  res.sendStatus(204);
});

/**
 * Handle Twilio's conference-start callback for a sim conference (B2b).
 *
 * Architecture B: Vapi-initiated. After the rep's Voice SDK leg lands in the
 * conference, we dial Vapi outbound to NUCLEUS_SIM_CONFERENCE_NUMBER. Vapi's
 * inbound TwiML (separate follow-up bead) connects that leg into this
 * conference, so Vapi-as-Mike-Garza ends up as the second participant.
 *
 * Idempotency: Twilio retries non-2xx and slow webhook responses. We wrap the
 * dial path in an explicit BEGIN/SELECT-FOR-UPDATE/COMMIT transaction on
 * sim_call_scores so a retry seeing vapi_call_id IS NOT NULL short-circuits.
 *
 * On failure: row marked 'score-failed', system alert fired, conference is
 * ended (rep's iOS leg gets remoteHangup and surfaces the scoring sheet's
 * failure path).
 *
 * Errors are swallowed and never re-thrown — caller (the /status route)
 * always wants to return 204. If we threw, Twilio would retry the webhook,
 * and the SELECT FOR UPDATE would correctly short-circuit, but the row
 * UPDATE on the failure path would never run.
 */
async function handleSimConferenceStart({ FriendlyName, ConferenceSid, conf }) {
  const simConferenceNumber = process.env.NUCLEUS_SIM_CONFERENCE_NUMBER;
  if (!simConferenceNumber) {
    console.error(`sim-bridge: NUCLEUS_SIM_CONFERENCE_NUMBER not set — cannot dial Vapi for ${FriendlyName}`);
    sendSystemAlert(
      `🔴 Sim Bridge Misconfigured — NUCLEUS_SIM_CONFERENCE_NUMBER unset`,
      [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*${FriendlyName}* could not bridge to Vapi: NUCLEUS_SIM_CONFERENCE_NUMBER env var is not set on this deploy.\n\n*Action:* set the env var to the Twilio inbound number whose TwiML conferences into \`sim-{id}\`.` },
      }]
    ).catch(() => {});
    await markSimFailed(FriendlyName, 'NUCLEUS_SIM_CONFERENCE_NUMBER unset').catch(() => {});
    return;
  }

  // pool.connect() is inside the try so a pool-exhausted / DB-down exception
  // is caught by the same handler that flips the row to score-failed via the
  // no-transaction markSimFailed fallback (the connection never opened, so
  // no lock to release here — markSimFailed gets its own connection).
  let dbClient = null;
  let simRow = null;
  try {
    dbClient = await pool.connect();
    await dbClient.query('BEGIN');

    // Look up sim row by conference_name (B2a's column). FOR UPDATE locks
    // the row so a concurrent Twilio retry blocks here until COMMIT, then
    // sees vapi_call_id populated (or status='score-failed' on the failure
    // paths) and short-circuits.
    const { rows } = await dbClient.query(
      `SELECT id, persona_id, difficulty, vapi_call_id, status
       FROM sim_call_scores WHERE conference_name = $1 FOR UPDATE`,
      [FriendlyName]
    );

    if (!rows.length) {
      console.warn(`sim-bridge: no sim_call_scores row for conference_name=${FriendlyName}`);
      await dbClient.query('COMMIT');
      return;
    }
    simRow = rows[0];

    // Idempotency sentinel.
    if (simRow.vapi_call_id) {
      console.log(`sim-bridge: ${FriendlyName} already has vapi_call_id=${simRow.vapi_call_id}, short-circuit`);
      await dbClient.query('COMMIT');
      return;
    }

    // If the user cancelled, sweep marked the row, or a prior bridge attempt
    // committed score-failed in the narrow window between sim-call-ios POST
    // and Twilio's conference-start arriving, don't dial Vapi.
    if (simRow.status !== 'in-progress') {
      console.warn(`sim-bridge: ${FriendlyName} status is ${simRow.status}, refusing to dial Vapi`);
      await dbClient.query('COMMIT');
      return;
    }

    // Recover persona+difficulty. Primary path uses the in-memory map (set
    // by sim-call-ios). Fallback uses the DB row's persona_id/difficulty
    // columns when the map was wiped (process restart).
    const personaId = (conf && conf.type === 'sim' && conf.personaId) || simRow.persona_id;
    const difficulty = (conf && conf.type === 'sim' && conf.difficulty) || simRow.difficulty;
    const assistantId = (conf && conf.type === 'sim' && conf.assistantId)
      || (personaId && difficulty ? resolveAssistantId({ personaId, difficulty }) : undefined);

    if (!assistantId) {
      console.error(`sim-bridge: cannot resolve assistantId for ${FriendlyName} (persona=${personaId}, difficulty=${difficulty})`);
      // Flip status on the locked row, then COMMIT — a blocked Twilio retry
      // unblocks, sees status='score-failed', and short-circuits via the
      // in-progress guard above. ROLLBACK would release the lock with the
      // row still 'in-progress' and the retry would re-dial Vapi (issue 1).
      await failOnLockedRow(dbClient, simRow.id, 'assistantId unresolved');
      await dbClient.query('COMMIT');
      return;
    }

    let vapiCall;
    try {
      vapiCall = await createOutboundCall({
        assistantId,
        customerNumber: simConferenceNumber,
        assistantOverrides: {
          firstMessage: pickGreeting(difficulty),
          variableValues: { simCallId: String(simRow.id), conferenceName: FriendlyName },
        },
      });
    } catch (err) {
      console.error(`sim-bridge: Vapi createOutboundCall failed for ${FriendlyName}:`, err.message);
      // Same race-closure pattern as the assistantId path: flip status under
      // the lock + COMMIT, so the blocked retry can't double-dial Vapi.
      // The SELECT we did earlier doesn't need to be rolled back — it
      // didn't write anything; the UPDATE here is the only write and it's
      // the state we want persisted.
      try {
        await failOnLockedRow(dbClient, simRow.id, `Vapi dial failed: ${err.message}`);
        await dbClient.query('COMMIT');
      } catch (commitErr) {
        // If the COMMIT itself failed, the lock is already gone via implicit
        // rollback and we can't atomically guard the retry. Fall back to a
        // separate-connection markSimFailed — race window opens here, but
        // we've already failed once on Vapi so a double-dial is the lesser
        // evil than a stuck in-progress row.
        console.error(`sim-bridge: COMMIT after Vapi failure also failed for ${FriendlyName}:`, commitErr.message);
        await markSimFailed(FriendlyName, `Vapi dial failed: ${err.message}`).catch(() => {});
      }
      // End the conference so the rep's leg drops cleanly into the scoring
      // sheet's failure-path instead of hanging in silence.
      client.conferences(ConferenceSid).update({ status: 'completed' })
        .catch((endErr) => console.error(`sim-bridge: failed to end conference ${ConferenceSid} after Vapi error:`, endErr.message));
      sendSystemAlert(
        `🔴 Sim Bridge Failed — Vapi dial error`,
        [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*${FriendlyName}* could not connect to Vapi.\n*assistantId:* \`${assistantId}\`\n*Error:* ${err.message}` },
        }]
      ).catch(() => {});
      return;
    }

    await dbClient.query(
      `UPDATE sim_call_scores
       SET vapi_call_id = $1,
           monitor_listen_url = $2,
           monitor_control_url = $3,
           conference_sid = $4,
           conference_sid_set_at = NOW()
       WHERE id = $5`,
      [
        vapiCall.id,
        vapiCall.monitor?.listenUrl || null,
        vapiCall.monitor?.controlUrl || null,
        ConferenceSid,
        simRow.id,
      ]
    );

    await dbClient.query('COMMIT');

    // Cache the SID in the in-memory map so downstream conference-end /
    // participant-leave events on the same FriendlyName have the SID handy.
    updateConference(FriendlyName, { conferenceSid: ConferenceSid });

    console.log(`sim-bridge: ${FriendlyName} → vapi=${vapiCall.id} (conf=${ConferenceSid})`);
  } catch (err) {
    console.error(`sim-bridge: transaction failed for ${FriendlyName}:`, err.message);
    if (dbClient) {
      try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    }
    // No dbClient → pool.connect() itself failed (DB unreachable / pool
    // exhausted). markSimFailed uses pool.query which will also fail in that
    // case, but we still try — the catch keeps the route from blowing up.
    await markSimFailed(FriendlyName, `bridge error: ${err.message}`).catch(() => {});
  } finally {
    if (dbClient) dbClient.release();
  }
}

/** Flip a locked sim row to score-failed on the same dbClient that holds the
 *  SELECT FOR UPDATE lock. Caller is responsible for COMMIT/ROLLBACK. Used by
 *  the bridge's in-transaction failure paths (issue 1: closes the race where
 *  a blocked Twilio retry would re-dial Vapi after a separate-connection
 *  markSimFailed).
 */
async function failOnLockedRow(dbClient, simRowId, errorMessage) {
  await dbClient.query(
    `UPDATE sim_call_scores
     SET status = 'score-failed',
         caller_debrief = COALESCE(caller_debrief, $1)
     WHERE id = $2`,
    [`Practice call could not start: ${errorMessage}`, simRowId]
  );
}

/** Mark a sim row 'score-failed' with an error message. Used by the bridge
 *  failure paths so iOS poll sees status='failed' on /api/sim/call/:id/score.
 */
async function markSimFailed(conferenceName, errorMessage) {
  await pool.query(
    `UPDATE sim_call_scores
     SET status = 'score-failed',
         caller_debrief = COALESCE(caller_debrief, $1)
     WHERE conference_name = $2 AND status IN ('in-progress', 'scoring')`,
    [`Practice call could not start: ${errorMessage}`, conferenceName]
  );
}

module.exports = Object.assign(router, { __testing: { handleSimConferenceStart, markSimFailed, failOnLockedRow } });
