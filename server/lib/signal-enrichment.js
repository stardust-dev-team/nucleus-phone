/**
 * lib/signal-enrichment.js — Batch Apollo enrichment for signal-scored companies.
 *
 * Finds SPEAR + TARGETED companies that don't yet have Apollo contacts,
 * calls Apollo people search for each, and stores results in v35_pb_contacts.
 *
 * Credit tracking: Uses V3.5's v35_credit_daily_ledger table (shared Postgres).
 * Credits are incremented AFTER successful API calls to avoid over-counting on failures.
 *
 * Designed to run as a fire-and-forget background job triggered via API or CLI.
 * Supports resume after interruption via last_processed_domain cursor.
 */

const { pool } = require('../db');
const { searchPeopleByCompany } = require('./apollo');
const { normalizeCompanyName } = require('./company-normalizer');

const APOLLO_DAILY_BUDGET = 50; // Matches V3.5 CAPACITY.DAILY_BUDGET.apollo (Basic plan: 1K credits/mo)
const BUDGET_EXHAUSTED_PCT = 0.95; // Stop at 95% to leave headroom for V3.5 pipeline
const VALID_TIERS = new Set(['spear', 'targeted']);
const STALE_JOB_MINUTES = 10;
const ENRICHMENT_LOCK_KEY = 839271; // pg_advisory_lock key for signal enrichment exclusion

/**
 * Check remaining Apollo budget for today.
 * Reads directly from v35_credit_daily_ledger (same Postgres).
 */
async function checkApolloBudget() {
  const result = await pool.query(
    `SELECT consumed, remaining, pct_consumed
     FROM v35_credit_daily_ledger
     WHERE ledger_date = CURRENT_DATE AND service = 'apollo'`,
  );

  if (result.rows.length === 0) {
    return { allowed: true, remaining: APOLLO_DAILY_BUDGET, consumed: 0 };
  }

  const row = result.rows[0];
  const allowed = parseFloat(row.pct_consumed) < BUDGET_EXHAUSTED_PCT * 100;
  return {
    allowed,
    remaining: parseInt(row.remaining, 10),
    consumed: parseInt(row.consumed, 10),
  };
}

/**
 * Increment Apollo credit after a successful API call.
 * Uses the same ledger as V3.5's credit-tracker.js (UPSERT pattern).
 */
async function incrementApolloBudget(amount = 1) {
  const result = await pool.query(
    `INSERT INTO v35_credit_daily_ledger (ledger_date, service, budget_limit, consumed, last_increment_at)
     VALUES (CURRENT_DATE, 'apollo', $1, $2, NOW())
     ON CONFLICT (ledger_date, service) DO UPDATE SET
       consumed = v35_credit_daily_ledger.consumed + $2,
       last_increment_at = NOW()
     RETURNING consumed, remaining, pct_consumed`,
    [APOLLO_DAILY_BUDGET, amount],
  );

  const row = result.rows[0];
  const allowed = parseFloat(row.pct_consumed) < BUDGET_EXHAUSTED_PCT * 100;
  return { allowed, remaining: parseInt(row.remaining, 10), consumed: parseInt(row.consumed, 10) };
}

/**
 * Run batch enrichment for signal-scored companies.
 *
 * @param {Object} opts
 * @param {string[]} [opts.tiers] - Signal tiers to enrich (default: ['spear', 'targeted'])
 * @param {string} [opts.resumeFrom] - Domain to resume from (alphabetical cursor)
 * @param {string} [opts.jobId] - Existing job ID to resume, or null to create new
 * @returns {Promise<Object>} Job result summary
 */
async function runBatchEnrichment({ tiers = ['spear', 'targeted'], resumeFrom = null, jobId } = {}) {
  if (!jobId) throw new Error('jobId required — call claimEnrichmentSlot() first');

  const validTiers = tiers.filter(t => VALID_TIERS.has(t));
  if (validTiers.length === 0) throw new Error('No valid tiers provided');

  await pool.query(
    `UPDATE signal_enrichment_jobs SET status = 'running', heartbeat_at = NOW() WHERE id = $1`,
    [jobId],
  );

  try {
    // Find companies that need enrichment (no Apollo contacts yet)
    const cursorCondition = resumeFrom ? `AND sm.domain > $2` : '';
    const queryValues = resumeFrom ? [validTiers, resumeFrom] : [validTiers];

    const companiesResult = await pool.query(
      `SELECT sm.domain, lr.company_name
       FROM v35_signal_metadata sm
       JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
       WHERE sm.signal_tier = ANY($1)
         AND sm.domain NOT LIKE '%.signal-pending'
         AND NOT EXISTS (
           SELECT 1 FROM v35_pb_contacts pb
           WHERE pb.domain = sm.domain AND pb.source = 'apollo'
         )
         ${cursorCondition}
       ORDER BY sm.domain ASC
       LIMIT 500`,
      queryValues,
    );

    const companies = companiesResult.rows;

    await pool.query(
      `UPDATE signal_enrichment_jobs SET total_companies = $2 WHERE id = $1`,
      [jobId, companies.length],
    );

    if (companies.length === 0) {
      await pool.query(
        `UPDATE signal_enrichment_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [jobId],
      );
      return { jobId, status: 'completed', processed: 0, creditsUsed: 0, message: 'No companies need enrichment' };
    }

    let processed = 0;
    let creditsUsed = 0;
    let lastDomain = resumeFrom;

    for (const company of companies) {
      // Check budget before each call
      const budget = await checkApolloBudget();
      if (!budget.allowed) {
        await updateJobProgress(jobId, 'paused', processed, creditsUsed, lastDomain);
        return {
          jobId, status: 'paused', processed, creditsUsed,
          message: `Budget exhausted (${budget.consumed}/${APOLLO_DAILY_BUDGET}). Resume tomorrow.`,
          resumeFrom: lastDomain,
        };
      }

      try {
        const result = await searchPeopleByCompany(company.domain);
        const contacts = result.contacts;

        // Increment credits AFTER successful reveals (search is free)
        if (result.creditsUsed > 0) {
          await incrementApolloBudget(result.creditsUsed);
          creditsUsed += result.creditsUsed;
        }

        // Upsert contacts into v35_pb_contacts
        const norm = normalizeCompanyName(company.company_name);
        for (const c of contacts) {
          if (!c.email && !c.linkedin_url) continue;

          await pool.query(
            `INSERT INTO v35_pb_contacts
               (full_name, first_name, last_name, title, company_name, company_name_norm,
                linkedin_profile_url, email, phone, phone_type, domain, source, enrichment_batch_id, apollo_person_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9 IS NOT NULL THEN 'mobile' END, $10, 'apollo', $11, $12)
             ON CONFLICT (domain, email)
               WHERE source = 'apollo' AND email IS NOT NULL
             DO UPDATE SET
               phone = COALESCE(EXCLUDED.phone, v35_pb_contacts.phone),
               phone_type = COALESCE(EXCLUDED.phone_type, v35_pb_contacts.phone_type),
               title = COALESCE(EXCLUDED.title, v35_pb_contacts.title),
               linkedin_profile_url = COALESCE(EXCLUDED.linkedin_profile_url, v35_pb_contacts.linkedin_profile_url),
               apollo_person_id = COALESCE(EXCLUDED.apollo_person_id, v35_pb_contacts.apollo_person_id)`,
            [
              c.name, c.first_name, c.last_name, c.title,
              company.company_name, norm,
              c.linkedin_url, c.email, c.phone, company.domain, jobId,
              c.apollo_person_id,
            ],
          );
        }

        processed++;
        lastDomain = company.domain;

        // Flush progress every 10 companies
        if (processed % 10 === 0) {
          await updateJobProgress(jobId, 'running', processed, creditsUsed, lastDomain);
        }
      } catch (err) {
        console.error(`Enrichment failed for ${company.domain}:`, err.message);
        // Continue to next company — don't stop the whole batch for one failure
        lastDomain = company.domain;
      }
    }

    // Final progress flush
    await updateJobProgress(jobId, 'running', processed, creditsUsed, lastDomain);

    // Check if more companies remain
    const moreResult = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM v35_signal_metadata sm
         WHERE sm.signal_tier = ANY($1)
           AND sm.domain > $2
           AND sm.domain NOT LIKE '%.signal-pending'
           AND NOT EXISTS (
             SELECT 1 FROM v35_pb_contacts pb
             WHERE pb.domain = sm.domain AND pb.source = 'apollo'
           )
       ) AS has_more`,
      [validTiers, lastDomain],
    );

    const hasMore = moreResult.rows[0]?.has_more;
    const finalStatus = hasMore ? 'running' : 'completed';

    await pool.query(
      `UPDATE signal_enrichment_jobs
       SET status = $2, last_processed_domain = $3
           ${finalStatus === 'completed' ? ', completed_at = NOW()' : ''}
       WHERE id = $1`,
      [jobId, finalStatus, lastDomain],
    );

    return {
      jobId, status: finalStatus, processed, creditsUsed,
      message: hasMore ? `Processed ${processed} companies, more remain. Run again to continue.` : 'All companies enriched.',
      resumeFrom: hasMore ? lastDomain : null,
    };
  } catch (err) {
    await pool.query(
      `UPDATE signal_enrichment_jobs SET status = 'failed', error = $2 WHERE id = $1`,
      [jobId, err.message],
    );
    throw err;
  }
}

/**
 * Update job progress with absolute values (not relative increments).
 */
async function updateJobProgress(jobId, status, processed, creditsUsed, lastDomain) {
  await pool.query(
    `UPDATE signal_enrichment_jobs
     SET status = $2, processed_companies = $3, credits_used = $4, last_processed_domain = $5, heartbeat_at = NOW()
     WHERE id = $1`,
    [jobId, status, processed, creditsUsed, lastDomain],
  );
}

/**
 * Get job status.
 */
async function getJobStatus(jobId) {
  const result = await pool.query(
    `SELECT * FROM signal_enrichment_jobs WHERE id = $1`,
    [jobId],
  );
  return result.rows[0] || null;
}

/**
 * Claim a job slot. Uses pg_try_advisory_xact_lock to serialize the check-then-insert
 * (prevents TOCTOU race on concurrent POSTs). The lock releases at COMMIT — ongoing
 * enrichment is guarded by the heartbeat_at check, not the advisory lock.
 * Returns jobId or throws {code: 'CONCURRENT_JOB'}.
 */
async function claimEnrichmentSlot(tiers) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [ENRICHMENT_LOCK_KEY],
    );
    if (!lockResult.rows[0].acquired) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('Enrichment job already running (lock contention)'),
        { code: 'CONCURRENT_JOB', activeJobId: 'unknown' },
      );
    }

    // Check for a live running job (heartbeat within stale threshold)
    const active = await client.query(
      `SELECT id FROM signal_enrichment_jobs
       WHERE status = 'running'
         AND heartbeat_at > NOW() - make_interval(mins => $1)
       LIMIT 1`,
      [STALE_JOB_MINUTES],
    );
    if (active.rows.length > 0) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`Enrichment job already running (${active.rows[0].id})`),
        { code: 'CONCURRENT_JOB', activeJobId: active.rows[0].id },
      );
    }

    const result = await client.query(
      `INSERT INTO signal_enrichment_jobs (tiers, status, heartbeat_at)
       VALUES ($1, 'running', NOW())
       RETURNING id`,
      [tiers],
    );
    await client.query('COMMIT');
    return result.rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runBatchEnrichment, getJobStatus, checkApolloBudget, claimEnrichmentSlot, APOLLO_DAILY_BUDGET };
