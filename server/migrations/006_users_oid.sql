-- 006_users_oid.sql
-- joruva-dialer-mac M1 (nucleus-phone-t3x): add Entra object-ID column to nucleus_phone_users.
--
-- Captured by /api/auth/exchange on first authenticated native-iOS request and
-- becomes the canonical join key for users (email is fragile across mailbox renames).
-- M1 still keys lookups off email; oid is set for follow-up backfill bead.
--
-- The canonical schema source remains server/db.js initSchema() — the matching
-- ALTER lives there too so a fresh deploy is self-applying.

ALTER TABLE nucleus_phone_users ADD COLUMN IF NOT EXISTS oid UUID UNIQUE;
CREATE INDEX IF NOT EXISTS idx_npu_oid ON nucleus_phone_users(oid) WHERE oid IS NOT NULL;
