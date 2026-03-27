const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const { pool } = require('../db');
const { client } = require('../lib/twilio');
const { apiKeyAuth } = require('../middleware/auth');
const {
  createConference, getConference, updateConference,
  removeConference, listActiveConferences,
} = require('../lib/conference');

const router = Router();
const twilioWebhook = twilio.webhook({ validate: false });

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
  } catch (err) {
    console.error('Call initiation failed:', err);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

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
router.post('/status', twilioWebhook, async (req, res) => {
  const {
    ConferenceSid, FriendlyName, StatusCallbackEvent,
    CallSid, Muted,
  } = req.body;

  const conf = getConference(FriendlyName);

  // On conference-start: save SID and dial the lead into the conference.
  // This replaces the old sleep-and-poll pattern in voice.js.
  if (StatusCallbackEvent === 'conference-start' && conf) {
    updateConference(FriendlyName, { conferenceSid: ConferenceSid });

    // Persist conference_sid to DB immediately so recording callbacks can find the row
    pool.query(
      'UPDATE nucleus_phone_calls SET conference_sid = $1 WHERE conference_name = $2',
      [ConferenceSid, FriendlyName]
    ).catch((err) => console.error('Failed to persist conference_sid:', err.message));

    if (conf.leadPhone) {
      try {
        await client.conferences(ConferenceSid).participants.create({
          from: process.env.NUCLEUS_PHONE_NUMBER,
          to: conf.leadPhone,
          earlyMedia: true,
          beep: false,
          endConferenceOnExit: true,
        });
        console.log(`Dialed ${conf.leadPhone} into conference ${FriendlyName}`);
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
