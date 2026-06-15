// Migration-idempotency guard (nucleus-phone-rgja.7). initSchema runs on every boot,
// so the use_inhouse_stt columns MUST be added with ADD COLUMN IF NOT EXISTS — a
// re-run can't error. No DB needed: assert the guard is present in the db.js source so
// a future edit can't silently drop it (which would crash every boot after the first).
const fs = require('fs');
const path = require('path');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

describe('use_inhouse_stt schema migration is idempotent', () => {
  test('nucleus_phone_calls.use_inhouse_stt uses ADD COLUMN IF NOT EXISTS', () => {
    expect(dbSrc).toMatch(
      /ALTER TABLE nucleus_phone_calls ADD COLUMN IF NOT EXISTS use_inhouse_stt BOOLEAN/
    );
  });

  test('nucleus_phone_users.use_inhouse_stt uses ADD COLUMN IF NOT EXISTS', () => {
    expect(dbSrc).toMatch(
      /ALTER TABLE nucleus_phone_users ADD COLUMN IF NOT EXISTS use_inhouse_stt BOOLEAN/
    );
  });
});
