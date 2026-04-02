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

  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema, get FUZZY_AVAILABLE() { return FUZZY_AVAILABLE; } };
