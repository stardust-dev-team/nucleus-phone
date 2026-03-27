const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

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

    // Verify shared tables from UCIL exist (same Postgres, different service creates them)
    const { rows } = await client.query("SELECT to_regclass('public.customer_interactions')");
    if (!rows[0].to_regclass) {
      console.error('FATAL: customer_interactions table missing — UCIL must create it first');
      process.exit(1);
    }
    console.log('customer_interactions table verified');

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
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema };
