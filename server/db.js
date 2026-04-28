const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

// Set after initSchema() — default false so the JS fallback is always safe.
let FUZZY_AVAILABLE = false;

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS nucleus_phone_calls (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        conference_name VARCHAR(100) UNIQUE,
        conference_sid VARCHAR(50),
        caller_identity VARCHAR(50),
        lead_phone VARCHAR(20),
        lead_name VARCHAR(255),
        lead_company VARCHAR(255),
        hubspot_contact_id VARCHAR(50),
        direction VARCHAR(10) DEFAULT 'outbound',
        status VARCHAR(20) DEFAULT 'connecting',
        duration_seconds INTEGER,
        disposition VARCHAR(30),
        qualification VARCHAR(20),
        products_discussed JSONB DEFAULT '[]',
        notes TEXT,
        recording_url TEXT,
        recording_duration INTEGER,
        fireflies_uploaded BOOLEAN DEFAULT FALSE,
        participants JSONB DEFAULT '[]',
        slack_notified BOOLEAN DEFAULT FALSE,
        hubspot_synced BOOLEAN DEFAULT FALSE
      );

      CREATE INDEX IF NOT EXISTS idx_npc_caller ON nucleus_phone_calls(caller_identity);
      CREATE INDEX IF NOT EXISTS idx_npc_lead_phone ON nucleus_phone_calls(lead_phone);
      CREATE INDEX IF NOT EXISTS idx_npc_status ON nucleus_phone_calls(status);
      CREATE INDEX IF NOT EXISTS idx_npc_created ON nucleus_phone_calls(created_at DESC);
    `);
    console.log('nucleus_phone_calls table ready');

    // Check if UCIL's customer_interactions table exists (same Postgres, different service creates it)
    const { rows } = await client.query("SELECT to_regclass('public.customer_interactions')");
    if (!rows[0].to_regclass) {
      console.warn('WARNING: customer_interactions table missing — cockpit/sync features will fail until UCIL deploys');
    } else {
      console.log('customer_interactions table verified');
    }

    // Cockpit tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ucil_agent_stats (
        agent_name VARCHAR(50) NOT NULL,
        stat_date DATE NOT NULL,
        calls_made INTEGER DEFAULT 0,
        callbacks_done INTEGER DEFAULT 0,
        leads_qualified INTEGER DEFAULT 0,
        hot_leads INTEGER DEFAULT 0,
        avg_call_duration INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (agent_name, stat_date)
      );

      CREATE TABLE IF NOT EXISTS ucil_sync_state (
        sync_key VARCHAR(100) PRIMARY KEY,
        last_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_record_id TEXT,
        metadata JSONB DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- updated_at trigger for ucil_sync_state
      CREATE OR REPLACE FUNCTION update_ucil_sync_state_ts()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ucil_sync_state_ts ON ucil_sync_state;
      CREATE TRIGGER trg_ucil_sync_state_ts
        BEFORE UPDATE ON ucil_sync_state
        FOR EACH ROW EXECUTE FUNCTION update_ucil_sync_state_ts();
    `);
    console.log('cockpit tables ready');

    // Simulation scoring table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sim_call_scores (
        id SERIAL PRIMARY KEY,
        vapi_call_id TEXT UNIQUE,
        caller_identity VARCHAR(50) NOT NULL,
        difficulty VARCHAR(10) NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
        duration_seconds INTEGER,
        transcript TEXT,
        recording_url TEXT,
        cost_cents INTEGER,
        score_rapport NUMERIC(3,1) CHECK (score_rapport BETWEEN 0 AND 10),
        note_rapport TEXT,
        score_discovery NUMERIC(3,1) CHECK (score_discovery BETWEEN 0 AND 10),
        note_discovery TEXT,
        score_objection NUMERIC(3,1) CHECK (score_objection BETWEEN 0 AND 10),
        note_objection TEXT,
        score_product NUMERIC(3,1) CHECK (score_product BETWEEN 0 AND 10),
        note_product TEXT,
        score_close NUMERIC(3,1) CHECK (score_close BETWEEN 0 AND 10),
        note_close TEXT,
        score_overall NUMERIC(3,1) CHECK (score_overall BETWEEN 0 AND 10),
        call_grade VARCHAR(2),
        top_strength TEXT,
        top_improvement TEXT,
        caller_debrief TEXT,
        admin_report TEXT,
        prompt_version VARCHAR(16),
        status VARCHAR(20) DEFAULT 'in-progress',
        slack_notified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        scored_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_sim_caller ON sim_call_scores(caller_identity);
      CREATE INDEX IF NOT EXISTS idx_sim_created ON sim_call_scores(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sim_vapi ON sim_call_scores(vapi_call_id);
    `);

    // Add columns introduced after initial schema (safe for existing deployments)
    await client.query(`
      ALTER TABLE sim_call_scores ADD COLUMN IF NOT EXISTS monitor_listen_url TEXT;
      ALTER TABLE sim_call_scores ADD COLUMN IF NOT EXISTS monitor_control_url TEXT;
    `);

    // Stale sweep is handled by lib/stale-sweep.js (runs on interval + startup)
    console.log('sim_call_scores table ready');

    // Equipment Knowledge Base tables
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch');
      FUZZY_AVAILABLE = true;
    } catch (err) {
      console.warn('fuzzystrmatch extension unavailable — fuzzy matching will use JS fallback:', err.message);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS equipment_catalog (
        id SERIAL PRIMARY KEY,
        manufacturer VARCHAR(100) NOT NULL,
        model VARCHAR(100) NOT NULL,
        model_variants TEXT[],
        category VARCHAR(50) NOT NULL,
        subcategory VARCHAR(50),
        cfm_min NUMERIC(8,2),
        cfm_max NUMERIC(8,2),
        cfm_typical NUMERIC(8,2),
        psi_required INTEGER,
        duty_cycle_pct INTEGER,
        air_quality_class VARCHAR(20),
        axis_count INTEGER,
        power_hp NUMERIC(8,2),
        voltage VARCHAR(20),
        source VARCHAR(20) NOT NULL
          CHECK (source IN ('manufacturer','field_verified','web_search','expert_input','call_intelligence')),
        source_url TEXT,
        confidence VARCHAR(10) DEFAULT 'medium'
          CHECK (confidence IN ('high','medium','low','unverified')),
        verified_by VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_verified_at TIMESTAMPTZ,
        UNIQUE(manufacturer, model)
      );
      -- idx on (manufacturer, model) is implicit from UNIQUE constraint
      CREATE INDEX IF NOT EXISTS idx_equip_category ON equipment_catalog(category);
      CREATE INDEX IF NOT EXISTS idx_equip_variants ON equipment_catalog USING GIN(model_variants);

      CREATE TABLE IF NOT EXISTS equipment_details (
        id SERIAL PRIMARY KEY,
        equipment_id INTEGER NOT NULL REFERENCES equipment_catalog(id) ON DELETE CASCADE,
        description TEXT,
        typical_applications TEXT[],
        industries TEXT[],
        air_usage_notes TEXT,
        common_air_problems TEXT[],
        recommended_air_quality TEXT,
        recommended_compressor VARCHAR(50),
        recommended_dryer VARCHAR(50),
        recommended_filters TEXT[],
        system_notes TEXT,
        key_selling_points TEXT[],
        common_objections TEXT[],
        seo_keywords TEXT[],
        search_volume_monthly INTEGER,
        content_generated BOOLEAN DEFAULT FALSE,
        manufacturer_url TEXT,
        spec_sheet_url TEXT,
        image_url TEXT,
        UNIQUE(equipment_id)
      );
      -- idx on (equipment_id) is implicit from UNIQUE constraint
      CREATE INDEX IF NOT EXISTS idx_equip_details_industries ON equipment_details USING GIN(industries);

      CREATE TABLE IF NOT EXISTS equipment_sightings (
        id SERIAL PRIMARY KEY,
        manufacturer VARCHAR(100),
        model VARCHAR(100),
        raw_mention TEXT NOT NULL,
        count INTEGER DEFAULT 1,
        usage_pattern VARCHAR(20),
        call_type VARCHAR(10) NOT NULL CHECK (call_type IN ('real','practice')),
        call_id TEXT,
        caller_identity VARCHAR(50),
        contact_name VARCHAR(100),
        company_name VARCHAR(100),
        catalog_match_id INTEGER REFERENCES equipment_catalog(id),
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sighting_mfg_model ON equipment_sightings(manufacturer, model);
      CREATE INDEX IF NOT EXISTS idx_sighting_unresolved ON equipment_sightings(resolved) WHERE resolved = FALSE;
    `);
    console.log('equipment tables ready');

    // Columns added after initial nucleus_phone_calls schema
    await client.query(`
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS transcript TEXT;
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS ai_summary TEXT;
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS ai_action_items JSONB;
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS ai_disposition_suggestion VARCHAR(30);
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS ai_summarized BOOLEAN DEFAULT FALSE;
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS caller_call_sid VARCHAR(50);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_calls_caller_call_sid ON nucleus_phone_calls(caller_call_sid);
    `);
    console.log('nucleus_phone_calls columns updated');

    // Quote requests from LiveAssistant DirectSaleCTA (direct-sale products)
    await client.query(`
      CREATE TABLE IF NOT EXISTS quote_requests (
        id SERIAL PRIMARY KEY,
        call_id TEXT,
        lead_email TEXT NOT NULL,
        lead_name TEXT,
        lead_company TEXT,
        lead_phone TEXT,
        recommendation_snapshot JSONB NOT NULL,
        equipment_snapshot JSONB,
        status TEXT DEFAULT 'pending',
        slack_notified BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_quote_requests_status ON quote_requests(status);

      CREATE OR REPLACE FUNCTION update_quote_requests_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_quote_requests_updated_at ON quote_requests;
      CREATE TRIGGER trg_quote_requests_updated_at
        BEFORE UPDATE ON quote_requests
        FOR EACH ROW EXECUTE FUNCTION update_quote_requests_updated_at();
    `);
    console.log('quote_requests table ready');

    // ── Curation log ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS equipment_curation_log (
        id SERIAL PRIMARY KEY,
        run_summary JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('equipment_curation_log table ready');

    // ── MSAL token cache for per-rep email sending ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS msal_token_cache (
        partition_key VARCHAR(255) PRIMARY KEY,
        cache_data TEXT NOT NULL,
        home_account_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE msal_token_cache ADD COLUMN IF NOT EXISTS home_account_id TEXT`);

    // Follow-up email columns on nucleus_phone_calls
    await client.query(`
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS lead_email TEXT;
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS follow_up_email_sent BOOLEAN DEFAULT FALSE;
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS follow_up_email_error TEXT;
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS voicemail_url TEXT;
    `);
    console.log('msal_token_cache + email columns ready');

    // ── Signal enrichment (Phase 4b) ─────────────────────────────
    // Extend v35_pb_contacts for Apollo-enriched contacts.
    // Full migration with constraint surgery is in migrations/004_signal_contacts_schema.sql
    // — these are the safe idempotent parts that can run on every startup.
    await client.query(`
      ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'phantombuster';
      ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS domain TEXT;
      ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS enrichment_batch_id TEXT;
      ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS apollo_person_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_pbc_domain ON v35_pb_contacts(domain) WHERE domain IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pbc_phone ON v35_pb_contacts(phone) WHERE phone IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pbc_source ON v35_pb_contacts(source);
      CREATE INDEX IF NOT EXISTS idx_pbc_apollo_id ON v35_pb_contacts(apollo_person_id) WHERE apollo_person_id IS NOT NULL;
    `);

    await client.query(`
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
    `);
    await client.query(`
      ALTER TABLE signal_enrichment_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
    `);
    console.log('signal enrichment schema ready');

    // ── Full-text search index for call summaries ────────────────
    // IMPORTANT: This expression must match the to_tsvector in:
    //   - server/routes/history.js (GET /api/history FTS_EXPR constant)
    //   - server/lib/ask-nucleus.js (search_my_calls tool)
    // If changed here, update both or the GIN index silently stops being used.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_npc_fts ON nucleus_phone_calls
        USING GIN (to_tsvector('english',
          COALESCE(ai_summary,'') || ' ' || COALESCE(notes,'') || ' ' ||
          COALESCE(lead_name,'') || ' ' || COALESCE(lead_company,'')));
    `);
    console.log('nucleus_phone_calls FTS index ready');

    // ── Ask Nucleus conversations ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ask_nucleus_conversations (
        id SERIAL PRIMARY KEY,
        caller_identity VARCHAR(50) NOT NULL,
        messages JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ask_conv_caller ON ask_nucleus_conversations(caller_identity);
      CREATE INDEX IF NOT EXISTS idx_ask_conv_updated ON ask_nucleus_conversations(updated_at DESC);

      CREATE OR REPLACE FUNCTION update_ask_conv_ts()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ask_conv_ts ON ask_nucleus_conversations;
      CREATE TRIGGER trg_ask_conv_ts
        BEFORE UPDATE ON ask_nucleus_conversations
        FOR EACH ROW EXECUTE FUNCTION update_ask_conv_ts();
    `);
    console.log('ask_nucleus_conversations table ready');

    // ── RBAC users ───────────────────────────────────────────────
    // nucleus-phone-e5p: DB-backed users replace the hardcoded USER_MAP so we
    // can instantly revoke access by flipping is_active=false. The sessionAuth
    // middleware re-reads this row (with a 5s cache) on every request.
    await client.query(`
      CREATE TABLE IF NOT EXISTS nucleus_phone_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        identity VARCHAR(50) UNIQUE NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'caller'
          CHECK (role IN ('external_caller', 'caller', 'admin')),
        display_name VARCHAR(255) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_npu_email_active ON nucleus_phone_users(email) WHERE is_active = TRUE;

      CREATE OR REPLACE FUNCTION update_npu_ts()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_npu_ts ON nucleus_phone_users;
      CREATE TRIGGER trg_npu_ts
        BEFORE UPDATE ON nucleus_phone_users
        FOR EACH ROW EXECUTE FUNCTION update_npu_ts();
    `);

    // 006_users_oid: Entra object-ID column for native-iOS dialer auth exchange.
    // Captured on first /api/auth/exchange call. Email lookup remains canonical
    // for M1; oid becomes the join key in a follow-up backfill bead.
    await client.query(`
      ALTER TABLE nucleus_phone_users ADD COLUMN IF NOT EXISTS oid UUID UNIQUE;
      CREATE INDEX IF NOT EXISTS idx_npu_oid ON nucleus_phone_users(oid) WHERE oid IS NOT NULL;
    `);

    // Seed internal @joruva.com users — idempotent, preserves is_active if
    // a user has been manually deactivated in a prior run.
    const SEED_USERS = [
      ['tom@joruva.com',   'tom',   'admin',  'Tom Russo'],
      ['paul@joruva.com',  'paul',  'admin',  'Paul Johnson'],
      ['kate@joruva.com',  'kate',  'caller', 'Kate Russo'],
      ['britt@joruva.com', 'britt', 'caller', 'Britt'],
      ['ryann@joruva.com', 'ryann', 'caller', 'Ryann Johnson'],
      ['alex@joruva.com',  'alex',  'caller', 'Alex'],
      ['lily@joruva.com',  'lily',  'caller', 'Lily'],
    ];
    for (const [email, identity, role, displayName] of SEED_USERS) {
      await client.query(
        `INSERT INTO nucleus_phone_users (email, identity, role, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [email, identity, role, displayName]
      );
    }
    console.log('nucleus_phone_users table ready');

    // ── phone_suffix7: indexed last-7-digit column for fast call matching ──
    // Replaces runtime REGEXP_REPLACE + RIGHT in cockpit queries with a
    // pre-computed column. Triggers keep it in sync on INSERT/UPDATE.
    await client.query(`
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS phone_suffix7 VARCHAR(7);
      ALTER TABLE v35_pb_contacts ADD COLUMN IF NOT EXISTS phone_suffix7 VARCHAR(7);
    `);

    // Parameterized trigger: TG_ARGV[0] is the source phone column name.
    // Used by both nucleus_phone_calls (lead_phone) and v35_pb_contacts (phone).
    // NOTE: Triggers don't fire on COPY. If bulk-loading data, either use INSERT
    // or run the backfill UPDATE below manually. The startup backfill catches
    // any stray NULLs on next boot.
    await client.query(`
      CREATE OR REPLACE FUNCTION compute_phone_suffix7()
      RETURNS TRIGGER AS $$
      DECLARE
        digits TEXT;
        src    TEXT;
      BEGIN
        EXECUTE 'SELECT ($1).' || quote_ident(TG_ARGV[0]) INTO src USING NEW;
        digits := REGEXP_REPLACE(COALESCE(src, ''), '\\D', '', 'g');
        IF LENGTH(digits) >= 7 THEN
          NEW.phone_suffix7 := RIGHT(digits, 7);
        ELSE
          NEW.phone_suffix7 := NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Clean up old per-table function if it exists from prior deploy
    await client.query(`DROP FUNCTION IF EXISTS compute_pb_phone_suffix7() CASCADE`);

    // Attach triggers (idempotent via DROP IF EXISTS)
    await client.query(`
      DROP TRIGGER IF EXISTS trg_npc_phone_suffix7 ON nucleus_phone_calls;
      CREATE TRIGGER trg_npc_phone_suffix7
        BEFORE INSERT OR UPDATE OF lead_phone ON nucleus_phone_calls
        FOR EACH ROW EXECUTE FUNCTION compute_phone_suffix7('lead_phone');

      DROP TRIGGER IF EXISTS trg_pbc_phone_suffix7 ON v35_pb_contacts;
      CREATE TRIGGER trg_pbc_phone_suffix7
        BEFORE INSERT OR UPDATE OF phone ON v35_pb_contacts
        FOR EACH ROW EXECUTE FUNCTION compute_phone_suffix7('phone');
    `);

    // Backfill existing rows (skip if already fully populated)
    const { rows: npcGap } = await client.query(
      `SELECT 1 FROM nucleus_phone_calls WHERE lead_phone IS NOT NULL AND phone_suffix7 IS NULL LIMIT 1`
    );
    if (npcGap.length) {
      await client.query(`
        UPDATE nucleus_phone_calls
        SET phone_suffix7 = RIGHT(REGEXP_REPLACE(lead_phone, '\\D', '', 'g'), 7)
        WHERE lead_phone IS NOT NULL
          AND phone_suffix7 IS NULL
          AND LENGTH(REGEXP_REPLACE(lead_phone, '\\D', '', 'g')) >= 7
      `);
    }
    const { rows: pbcGap } = await client.query(
      `SELECT 1 FROM v35_pb_contacts WHERE phone IS NOT NULL AND phone_suffix7 IS NULL LIMIT 1`
    );
    if (pbcGap.length) {
      await client.query(`
        UPDATE v35_pb_contacts
        SET phone_suffix7 = RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 7)
        WHERE phone IS NOT NULL
          AND phone_suffix7 IS NULL
          AND LENGTH(REGEXP_REPLACE(phone, '\\D', '', 'g')) >= 7
      `);
    }

    // Indexes for the new column
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_npc_phone_suffix7 ON nucleus_phone_calls(phone_suffix7) WHERE phone_suffix7 IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pbc_phone_suffix7 ON v35_pb_contacts(phone_suffix7) WHERE phone_suffix7 IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_npc_completed_suffix7 ON nucleus_phone_calls(phone_suffix7) WHERE status = 'completed' AND phone_suffix7 IS NOT NULL;
    `);
    console.log('phone_suffix7 columns + triggers + indexes ready');

    // Phone numbers spoken during calls, captured from RT transcription
    await client.query(`
      ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS captured_phones JSONB DEFAULT '[]'::jsonb;
    `);
    console.log('captured_phones column ready');

    // ── Debug events (production debug mode) ────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS debug_events (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMPTZ DEFAULT NOW(),
        category VARCHAR(30) NOT NULL,
        source VARCHAR(80) NOT NULL,
        level VARCHAR(10) DEFAULT 'info',
        summary TEXT NOT NULL,
        detail JSONB,
        call_id TEXT,
        caller_identity VARCHAR(50)
      );
      CREATE INDEX IF NOT EXISTS idx_debug_events_ts ON debug_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_debug_events_category ON debug_events(category, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_debug_events_call_id ON debug_events(call_id) WHERE call_id IS NOT NULL;
    `);
    console.log('debug_events table ready');

  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema, get FUZZY_AVAILABLE() { return FUZZY_AVAILABLE; } };
