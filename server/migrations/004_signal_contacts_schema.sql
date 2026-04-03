-- 004_signal_contacts_schema.sql
-- Extends v35_pb_contacts to support Apollo-enriched contacts with phone numbers.
-- Also creates signal_enrichment_jobs for batch job state tracking.
--
-- Safe to run multiple times (all operations are idempotent).
-- Run against: V3.5 Postgres (instantly_analytics_db)

-- ── Step 1: Add new columns to v35_pb_contacts ─────────────────────
ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'phantombuster';
ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS domain TEXT;
ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS enrichment_batch_id TEXT;

-- ── Step 2: Handle linkedin_profile_url NOT NULL constraint ─────────
-- Existing PB contacts have linkedin_profile_url as UNIQUE NOT NULL.
-- Apollo contacts often lack LinkedIn URLs, so we need to relax this.
ALTER TABLE v35_pb_contacts ALTER COLUMN linkedin_profile_url DROP NOT NULL;

-- Find and drop the existing unique constraint on linkedin_profile_url.
-- The constraint name varies by installation, so we use a DO block to find it.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'v35_pb_contacts'::regclass
    AND contype = 'u'
    AND EXISTS (
      SELECT 1 FROM unnest(conkey) k
      JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k
      WHERE a.attname = 'linkedin_profile_url'
    );

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE v35_pb_contacts DROP CONSTRAINT %I', constraint_name);
    RAISE NOTICE 'Dropped constraint: %', constraint_name;
  END IF;
END $$;

-- Also drop any unique index (constraint may have been created as an index)
DO $$
DECLARE
  idx_name TEXT;
BEGIN
  SELECT i.relname INTO idx_name
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
  WHERE ix.indrelid = 'v35_pb_contacts'::regclass
    AND ix.indisunique
    AND a.attname = 'linkedin_profile_url'
    AND i.relname != 'idx_pbc_linkedin_unique';  -- don't drop the one we're about to create

  IF idx_name IS NOT NULL THEN
    EXECUTE format('DROP INDEX IF EXISTS %I', idx_name);
    RAISE NOTICE 'Dropped index: %', idx_name;
  END IF;
END $$;

-- ── Step 3: Create new partial unique indexes ───────────────────────
-- PB contacts: unique by LinkedIn URL (when present)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pbc_linkedin_unique
  ON v35_pb_contacts(linkedin_profile_url) WHERE linkedin_profile_url IS NOT NULL;

-- Apollo contacts: unique by domain + email (LinkedIn URL may be null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pbc_apollo_unique
  ON v35_pb_contacts(domain, email) WHERE source = 'apollo' AND email IS NOT NULL;

-- ── Step 4: Performance indexes ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pbc_domain ON v35_pb_contacts(domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pbc_phone ON v35_pb_contacts(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pbc_source ON v35_pb_contacts(source);

-- ── Step 5: Batch job state tracking ────────────────────────────────
CREATE TABLE IF NOT EXISTS signal_enrichment_jobs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'paused')),
  tiers TEXT[] NOT NULL,
  total_companies INT,
  processed_companies INT DEFAULT 0,
  credits_used INT DEFAULT 0,
  last_processed_domain TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error TEXT
);
