#!/usr/bin/env node
/**
 * Validate Fireflies GraphQL transcripts query schema.
 * Run: FIREFLIES_API_KEY=... node scripts/test-fireflies-query.js
 *
 * Answers: field names (date vs dateTime), attendees shape, sentence structure.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const QUERY = `
  query RecentTranscripts($fromDate: DateTime) {
    transcripts(
      limit: 3
      skip: 0
      fromDate: $fromDate
    ) {
      id
      title
      date
      duration
      organizer_email
      participants
      transcript_url
      sentences {
        index
        speaker_name
        text
        raw_text
        start_time
        end_time
      }
    }
  }
`;

async function main() {
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) {
    console.error('FIREFLIES_API_KEY not set');
    process.exit(1);
  }

  const fromDate = new Date(Date.now() - 7 * 86400000).toISOString();
  console.log('Querying transcripts from:', fromDate);

  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { fromDate },
    }),
  });

  const data = await res.json();

  if (data.errors) {
    console.error('GraphQL errors:', JSON.stringify(data.errors, null, 2));
    process.exit(1);
  }

  const transcripts = data.data?.transcripts || [];
  console.log(`\nFound ${transcripts.length} transcripts\n`);

  for (const t of transcripts) {
    console.log('---');
    console.log('ID:', t.id);
    console.log('Title:', t.title);
    console.log('Date:', t.date);
    console.log('Duration (s):', t.duration);
    console.log('Organizer:', t.organizer_email);
    console.log('Participants:', JSON.stringify(t.participants));
    console.log('Sentences count:', t.sentences?.length || 0);
    if (t.sentences?.length) {
      console.log('First sentence:', JSON.stringify(t.sentences[0]));
    }
  }

  // Log raw field names for schema validation
  if (transcripts.length) {
    console.log('\n=== SCHEMA VALIDATION ===');
    console.log('Top-level keys:', Object.keys(transcripts[0]).join(', '));
    if (transcripts[0].sentences?.length) {
      console.log('Sentence keys:', Object.keys(transcripts[0].sentences[0]).join(', '));
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
