/**
 * Integration test for findActiveUserByEmail — confirms the SQL compiles
 * against real Postgres and returns the new `oid` column added in 006_users_oid.
 *
 * This test is gated on RUN_DB_TESTS=1 + DATABASE_URL because the rest of the
 * suite is fully mocked. Run locally with:
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://... \
 *     ./node_modules/.bin/jest auth-find-user.integration
 *
 * Skipped (suite passes vacuously) without those env vars — CI today doesn't
 * provision a test DB. Tracked as a follow-up to wire into the deploy pipeline.
 */

const RUN = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('findActiveUserByEmail (integration)', () => {
  let pool;
  let findActiveUserByEmail;
  const TEST_EMAIL = `t3x-test-${Date.now()}@joruva.com`;
  const TEST_OID  = '00000000-0000-0000-0000-DEADBEEF0001';

  beforeAll(async () => {
    // Load real db.js (pool) — requires a reachable DATABASE_URL.
    ({ pool } = require('../../db'));
    // Apply 006 migration in case the test DB hasn't seen it yet. Must match
    // the canonical migration's UUID type — `IF NOT EXISTS` is on the column,
    // not the type, so a stale VARCHAR column would silently survive.
    await pool.query(`
      ALTER TABLE nucleus_phone_users ADD COLUMN IF NOT EXISTS oid UUID UNIQUE;
      CREATE INDEX IF NOT EXISTS idx_npu_oid ON nucleus_phone_users(oid) WHERE oid IS NOT NULL;
    `);
    // Insert a fixture row scoped to this test.
    await pool.query(
      `INSERT INTO nucleus_phone_users (email, identity, role, display_name, oid, is_active)
       VALUES ($1, $2, 'caller', 'T3X Test User', $3, TRUE)
       ON CONFLICT (email) DO UPDATE SET oid = EXCLUDED.oid, is_active = TRUE`,
      [TEST_EMAIL, `t3x-test-${Date.now()}`, TEST_OID]
    );
    // Late require — auth.js pulls dotenv + msal at top, but here we just want
    // the helper. Node's module cache means it won't re-init.
    ({ findActiveUserByEmail } = require('../auth'));
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM nucleus_phone_users WHERE email = $1', [TEST_EMAIL]);
    await pool.end();
  });

  test('SELECT compiles and returns oid column', async () => {
    const user = await findActiveUserByEmail(TEST_EMAIL);
    expect(user).not.toBeNull();
    expect(user.email).toBe(TEST_EMAIL);
    expect(user.oid).toBe(TEST_OID);
    // Confirm the existing columns still come through unchanged
    expect(user.id).toEqual(expect.any(Number));
    expect(user.identity).toEqual(expect.any(String));
    expect(user.role).toEqual(expect.any(String));
    expect(user.display_name).toEqual(expect.any(String));
  });

  test('returns null for non-existent email', async () => {
    const user = await findActiveUserByEmail('does-not-exist-t3x@joruva.com');
    expect(user).toBeNull();
  });
});

