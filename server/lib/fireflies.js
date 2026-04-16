// DEPRECATED for phone calls — replaced by Twilio RT Transcription + call-summarizer.js (2026-03).
// Still used by fireflies-sync.js for Teams/Zoom meeting transcripts.
//
// Fire-and-forget contract: returns { success: false, reason } on any failure,
// never throws. Callers (recording.js) do not branch on failure shape.

const { throwHttpError } = require('./http-error');

const FIREFLIES_UPLOAD_MUTATION = `
  mutation($input: AudioUploadInput) {
    uploadAudio(input: $input) {
      success
      title
      message
    }
  }
`;

async function uploadToFireflies(recordingUrl, metadata) {
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) {
    console.warn('FIREFLIES_API_KEY not set — skipping upload');
    return { success: false, reason: 'no_api_key' };
  }

  const attendees = [
    {
      displayName: metadata.callerDisplayName || metadata.callerIdentity,
      email: metadata.callerEmail || `${metadata.callerIdentity}@joruva.com`,
    },
    {
      displayName: metadata.leadName || 'Unknown',
      ...(metadata.leadEmail && { email: metadata.leadEmail }),
      ...(metadata.leadPhone && { phoneNumber: metadata.leadPhone }),
    },
  ];

  // If a coach joined, add them too
  if (metadata.coachIdentity) {
    attendees.push({
      displayName: metadata.coachIdentity === 'tom' ? 'Tom Russo' : metadata.coachIdentity,
      email: `${metadata.coachIdentity}@joruva.com`,
    });
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const title = `CNC Call — ${metadata.leadName || 'Unknown'} at ${metadata.leadCompany || 'Unknown'} — ${dateStr}`;

  try {
    const res = await fetch('https://api.fireflies.ai/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: FIREFLIES_UPLOAD_MUTATION,
        variables: {
          input: {
            url: recordingUrl.replace(
              'https://api.twilio.com',
              `https://${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}@api.twilio.com`
            ) + '.mp3',
            title,
            attendees,
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throwHttpError(res, text, 'POST', 'graphql', { service: 'Fireflies' });
    }
    const data = await res.json();
    if (data.errors) {
      console.error('Fireflies upload errors:', data.errors);
      return { success: false, reason: 'api_error', errors: data.errors };
    }
    console.log('Fireflies upload success:', title);
    return { success: true, title };
  } catch (err) {
    console.error('Fireflies upload failed:', err.message);
    let reason = 'network_error';
    if (err.status) reason = 'http_error';
    else if (err instanceof SyntaxError) reason = 'parse_error';
    return {
      success: false,
      reason,
      error: err.message,
      ...(err.status && { status: err.status }),
    };
  }
}

module.exports = { uploadToFireflies };
