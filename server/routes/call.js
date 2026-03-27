const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const { pool } = require('../db');
const { client } = require('../lib/twilio');
const { apiKeyAuth } = require('../middleware/auth');
const {
  createConference, getConference, updateConference,
  removeConference, listActiveConferences, claimLeadDial,
} = require('../lib/conference');
const { webhookLogger } = require('../middleware/webhook-logger');

const router = Router();
const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/call/status`,
});

const E164_RE = /^\+[1-9]\d{6,14}$/;

// POST /api/call/initiate — start a new call
router.post('/initiate', apiKeyAuth, async (req, res) => {
  const { to, contactName, companyName, contactId, callerIdentity } = req.body;

  if (!to || !callerIdentity) {
    return res.status(400).json({ error: 'to and callerIdentity required' });
  }

  if (!E164_RE.test(to)) {
    return res.status(400).json({ error: 'to must be E.164 format (e.g. +16025551234)' });
  }

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
}

// POST /api/call/join — admin joins an active conference
router.post('/join', apiKeyAuth, (req, res) => {
  const { conferenceName, callerIdentity, muted } = req.body;

  const conf = getConference(conferenceName);
  if (!conf) {
    return res.status(404).json({ error: 'Conference not found' });
  }

  res.json({ conferenceName, muted: !!muted });
});

// POST /api/call/mute — toggle participant mute via Twilio REST API
router.post('/mute', apiKeyAuth, async (req, res) => {
  const { conferenceName, participantCallSid, muted } = req.body;

  const conf = getConference(conferenceName);
  if (!conf || !conf.conferenceSid) {
    return res.status(404).json({ error: 'Conference not found' });
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
router.get('/active', apiKeyAuth, async (req, res) => {
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
        conferenceName: conf.conferenceName,
        conferenceSid: conf.conferenceSid,
        startedAt: conf.startedAt,
        startedBy: conf.startedBy,
        leadName: conf.leadName,
        leadCompany: conf.leadCompany,
        leadPhone: conf.leadPhone,
        participants,
        duration,
      };
    })
  );

  res.json({ calls: enriched });
});

// POST /api/call/end — end a conference
router.post('/end', apiKeyAuth, async (req, res) => {
  const { conferenceName } = req.body;

  const conf = getConference(conferenceName);
  if (!conf || !conf.conferenceSid) {
    return res.status(404).json({ error: 'Conference not found' });
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
router.post('/status', webhookLogger, twilioWebhook, async (req, res) => {
  const {
    ConferenceSid, FriendlyName, StatusCallbackEvent,
    CallSid, Muted,
  } = req.body;

  const conf = getConference(FriendlyName);

  // On conference-start or first participant-join: save SID and dial the lead.
  // participant-join typically arrives ~800ms before conference-start, so we
  // trigger on whichever lands first. claimLeadDial() prevents double-dialing.
  if ((StatusCallbackEvent === 'conference-start' || StatusCallbackEvent === 'participant-join') && conf && ConferenceSid) {
    if (!conf.conferenceSid) {
      updateConference(FriendlyName, { conferenceSid: ConferenceSid });
      pool.query(
        'UPDATE nucleus_phone_calls SET conference_sid = $1 WHERE conference_name = $2',
        [ConferenceSid, FriendlyName]
      ).catch((err) => console.error('Failed to persist conference_sid:', err.message));
    }

    if (conf.leadPhone && claimLeadDial(FriendlyName)) {
      try {
        await client.conferences(ConferenceSid).participants.create({
          from: process.env.NUCLEUS_PHONE_NUMBER,
          to: conf.leadPhone,
          earlyMedia: true,
          beep: false,
          endConferenceOnExit: true,
        });
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
  }

  res.sendStatus(204);
});

module.exports = router;
