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
const { sendSlackAlert } = require('../lib/slack');

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
const twilioWebhook = makeTwilioWebhook('/api/call/status');

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
        (conference_name, caller_identity, lead_phone, lead_name, lead_company, hubspot_contact_id)
       VALUES ($1, $2, $3, $4, $5, $6)
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

  // Admins see in-progress practice calls too
  if (req.user?.role === 'admin') {
    try {
      const { rows } = await pool.query(`
        SELECT id, caller_identity, difficulty, created_at, status, monitor_listen_url
        FROM sim_call_scores
        WHERE status IN ('in-progress', 'scoring')
        ORDER BY created_at DESC
      `);
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
    res.json({ success: true });
  } catch (err) {
    console.error('End conference failed:', err.message);
    res.status(500).json({ error: 'Failed to end conference' });
  }
});

// POST /api/call/status — Twilio conference status callback
router.post('/status', twilioWebhook, async (req, res) => {
  const {
    ConferenceSid, FriendlyName, StatusCallbackEvent,
    CallSid, Muted,
  } = req.body;

  const conf = getConference(FriendlyName);

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

  if (StatusCallbackEvent === 'conference-end' && conf) {
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

module.exports = router;
