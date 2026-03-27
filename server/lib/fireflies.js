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

    const data = await res.json();
    if (data.errors) {
      console.error('Fireflies upload errors:', data.errors);
      return { success: false, reason: 'api_error', errors: data.errors };
    }
    console.log('Fireflies upload success:', title);
    return { success: true, title };
  } catch (err) {
    console.error('Fireflies upload failed:', err.message);
    return { success: false, reason: 'network_error', error: err.message };
  }
}

module.exports = { uploadToFireflies };
