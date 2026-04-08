#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
/**
 * Resolve truncated last names via DataForSEO SERP API.
 * Two-pass approach:
 *   Pass 1: Search non-LinkedIn sources (news, press releases, company sites)
 *           where full names appear in titles and descriptions.
 *   Pass 2: Search LinkedIn profiles (sometimes non-truncated on Google).
 *
 * Cost: ~$0.014 per query (one query per contact). 155 contacts ≈ $2.17.
 *
 * Usage: node scripts/resolve-names-via-serp.js [--dry-run] [--limit N]
 */

const { pool } = require('../server/db');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--limit') || '200', 10);
const DELAY_MS = 800;

const DATAFORSEO_AUTH = process.env.DATAFORSEO_AUTH;
const SERP_URL = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';

async function serpSearch(keyword) {
  const resp = await fetch(SERP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${DATAFORSEO_AUTH}`,
    },
    body: JSON.stringify([{
      keyword,
      location_name: 'United States',
      language_code: 'en',
      depth: 10,
    }]),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SERP ${resp.status}: ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  const task = data.tasks?.[0];
  if (task?.status_code !== 20000) {
    throw new Error(`SERP task: ${task?.status_message || 'unknown'}`);
  }

  return task.result?.[0]?.items?.filter(i => i.type === 'organic') || [];
}

/**
 * Extract full name from SERP results by finding "FirstName LastName" where
 * LastName starts with the known initial, in titles, descriptions, or snippets.
 */
function extractName(results, firstName, lastInitial) {
  // Build regex: firstName followed by a capitalized word starting with lastInitial
  // e.g., for "Bobby" + "B." → /\bBobby\s+(B[a-zà-ž]{2,}(?:\s+[A-Z][a-zà-ž]+)?)/i
  const initial = lastInitial.replace('.', '');
  const firstWords = firstName.split(/[\s.]+/).filter(w => w.length >= 2);
  const firstPattern = firstWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s.]+');

  // Match firstName + lastName starting with initial (2+ chars after initial)
  // Single word only — multi-word last names are rare and cause false positives
  const nameRx = new RegExp(
    `\\b${firstPattern}\\s+(${initial}[a-zà-ž]{2,})\\b`,
    'i'
  );

  const seen = new Map(); // lastName → count (for confidence)

  for (const result of results) {
    // Search across all text fields
    const texts = [
      result.title || '',
      result.description || '',
      result.pre_snippet || '',
    ];

    for (const text of texts) {
      const match = text.match(nameRx);
      if (!match) continue;

      let lastName = match[1];
      // Capitalize properly
      lastName = lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase();

      // Skip common false positives (company fragments, generic words in SERP text)
      if (/^(Inc|Corp|Ltd|Company|Group|Brands|Energy|Industries|Email|Phone|Address|Contact|Manager|Director|President|Officer|Operations|Vice|Senior|Chief|About|Annual|Report|News|College|County|City|State|University|National|International|Service|Services|Solutions|Systems|Products|Received|Awarded|Appointed|Named|Joined|Based|County|Region|Division)$/i.test(lastName)) continue;
      // Skip fragments (≤3 chars after initial) — too short for a real last name
      if (lastName.length <= 3) continue;

      const key = lastName.toLowerCase();
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }

  if (seen.size === 0) return null;

  // Pick the most frequently seen last name (higher confidence)
  const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  const bestLast = sorted[0][0];
  const bestCount = sorted[0][1];

  // Capitalize it
  const lastName = bestLast.charAt(0).toUpperCase() + bestLast.slice(1);

  // Use the canonical first name (preserve original casing)
  const fn = firstWords[0].charAt(0).toUpperCase() + firstWords[0].slice(1);

  return { firstName: fn, lastName, confidence: bestCount };
}

async function main() {
  if (!DATAFORSEO_AUTH) {
    console.error('DATAFORSEO_AUTH not set.');
    process.exit(1);
  }

  console.log(`Resolving truncated names via SERP (dry_run=${DRY_RUN}, limit=${LIMIT})`);

  const { rows } = await pool.query(`
    SELECT id, full_name, first_name, last_name, title, company_name
    FROM v35_pb_contacts
    WHERE last_name ~ '^\\w\\.$'
      AND title IS NOT NULL
    ORDER BY phone IS NOT NULL DESC, id
    LIMIT $1
  `, [LIMIT]);

  console.log(`Found ${rows.length} contacts with truncated last names`);

  let resolved = 0, failed = 0, skipped = 0;

  for (const row of rows) {
    const { id, first_name, last_name, title, company_name } = row;

    // Simplify title (take first meaningful phrase, skip long compound titles)
    const shortTitle = title.split(/[,;/&]/).find(t => t.trim().length >= 5)?.trim() || title;

    // Simplify company name
    const company = company_name
      .replace(/\s*[-–]\s+.+$/, '')
      .replace(/,?\s*(LLC|Inc\.?|Corp\.?|Ltd\.?|Co\.?|LP|LLP)\s*$/i, '')
      .trim();

    const query = `"${first_name}" "${shortTitle}" "${company}" -site:linkedin.com`;

    try {
      if (DRY_RUN) {
        console.log(`  [DRY] ${row.full_name} → ${query.substring(0, 90)}`);
        skipped++;
        continue;
      }

      const results = await serpSearch(query);
      const match = extractName(results, first_name, last_name);

      if (match) {
        const fullName = `${match.firstName} ${match.lastName}`;
        await pool.query(`
          UPDATE v35_pb_contacts
          SET full_name = $1, first_name = $2, last_name = $3
          WHERE id = $4
        `, [fullName, match.firstName, match.lastName, id]);

        console.log(`  ✓ ${row.full_name} → ${fullName} (${company_name}) [${match.confidence}x]`);
        resolved++;
      } else {
        console.log(`  ✗ ${row.full_name} at ${company_name}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err) {
      console.error(`  ✗ ${row.full_name} at ${company_name} — ${err.message}`);
      failed++;
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone: ${resolved} resolved, ${failed} failed, ${skipped} skipped`);
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
