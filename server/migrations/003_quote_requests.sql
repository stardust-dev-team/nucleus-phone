-- Quote requests from LiveAssistant DirectSaleCTA component.
-- Stores custom quote requests for direct-sale products (30HP+).
-- Serves as the queue for programmatic email follow-up once CAS pricing is confirmed.

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

-- Auto-update updated_at on row changes (needed for status transitions)
CREATE OR REPLACE FUNCTION update_quote_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quote_requests_updated_at ON quote_requests;
CREATE TRIGGER trg_quote_requests_updated_at
  BEFORE UPDATE ON quote_requests
  FOR EACH ROW EXECUTE FUNCTION update_quote_requests_updated_at();
