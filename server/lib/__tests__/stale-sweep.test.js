/**
 * Tests for sweepStaleSims's two-tier predicate (B2b).
 *
 * Tier 1: status='in-progress' AND vapi_call_id IS NULL → 10min threshold
 * Tier 2: status='in-progress' AND vapi_call_id IS NOT NULL → 20min threshold
 * scoring:  status='scoring' → 10min threshold (unchanged from B2a)
 *
 * The sweep runs a single atomic UPDATE; these tests pin the SQL shape so the
 * predicate doesn't silently regress. Row-level outcomes are exercised by the
 * caller_debrief CASE expression in the SQL — pinned via shape assertions.
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../slack', () => ({ sendSystemAlert: jest.fn().mockResolvedValue(true) }));
jest.mock('../debug-log', () => ({ logEvent: jest.fn() }));

const { pool } = require('../../db');
const { runSweep } = require('../stale-sweep');
const { sendSystemAlert } = require('../slack');

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
});

function makeUpdateResponse(rows) {
  return Promise.resolve({ rows, rowCount: rows.length });
}

describe('sweepStaleSims — predicate shape', () => {
  test('UPDATE includes all three OR branches with parameterized intervals', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await runSweep();

    const simSweepCall = pool.query.mock.calls.find(c => /UPDATE sim_call_scores/.test(c[0]));
    expect(simSweepCall).toBeDefined();
    const [sql, params] = simSweepCall;

    // Tier 1: vapi_call_id IS NULL + make_interval($1)
    expect(sql).toMatch(/vapi_call_id IS NULL\s*\n?\s*AND created_at < NOW\(\) - make_interval\(mins => \$1\)/);
    // Tier 2: vapi_call_id IS NOT NULL + make_interval($2)
    expect(sql).toMatch(/vapi_call_id IS NOT NULL\s*\n?\s*AND created_at < NOW\(\) - make_interval\(mins => \$2\)/);
    // Scoring: make_interval($3)
    expect(sql).toMatch(/status = 'scoring'\s*\n?\s*AND created_at < NOW\(\) - make_interval\(mins => \$3\)/);
    // All three OR'd together
    expect(sql.match(/\sOR\s/g)).toHaveLength(2);
    // Params pin the thresholds: 10, 20, 10
    expect(params).toEqual([10, 20, 10]);
    // No template-literal interval strings (issue 6 — Linus review)
    expect(sql).not.toMatch(/INTERVAL '\$/);
    expect(sql).not.toMatch(/INTERVAL '\d/);
  });

  test('sweepStaleCalls is also parameterized (issue 6)', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await runSweep();

    const callsSweep = pool.query.mock.calls.find(c => /UPDATE nucleus_phone_calls/.test(c[0]));
    expect(callsSweep).toBeDefined();
    expect(callsSweep[0]).toMatch(/make_interval\(mins => \$1\)/);
    expect(callsSweep[1]).toEqual([15]);
    expect(callsSweep[0]).not.toMatch(/INTERVAL '\d/);
  });

  test('targets sim_call_scores with status = score-failed', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await runSweep();

    const simSweepCall = pool.query.mock.calls.find(c => /UPDATE sim_call_scores/.test(c[0]));
    expect(simSweepCall[0]).toMatch(/SET status = 'score-failed'/);
  });

  test('caller_debrief CASE distinguishes tier 1 vs tier 2 vs scoring', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await runSweep();

    const simSweepCall = pool.query.mock.calls.find(c => /UPDATE sim_call_scores/.test(c[0]));
    const sql = simSweepCall[0];
    expect(sql).toMatch(/iOS never connected/);
    expect(sql).toMatch(/end-of-call webhook never arrived/);
    expect(sql).toMatch(/scoring pipeline wedged/);
    expect(sql).toMatch(/COALESCE\(caller_debrief/);
  });

  test('CASE expression has no ELSE branch (issue 5 — unreachable code)', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await runSweep();

    const simSweepCall = pool.query.mock.calls.find(c => /UPDATE sim_call_scores/.test(c[0]));
    const sql = simSweepCall[0];
    // ELSE would mask a future predicate addition that forgets to add a
    // matching CASE branch. Without ELSE, the row gets NULL → COALESCE
    // preserves any existing caller_debrief, and ops can grep for swept
    // rows with no debrief tag.
    expect(sql).not.toMatch(/\bELSE\b/);
    expect(sql).not.toMatch(/stale row/);
  });
});

describe('sweepStaleSims — slack alert partitions by tier', () => {
  test('no alert when nothing swept', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await runSweep();
    expect(sendSystemAlert).not.toHaveBeenCalled();
  });

  test('mixed tier 1 + tier 2 rows: alert reports correct counts', async () => {
    // Default everything to empty so nucleus_phone_calls sweep + debug prune
    // don't trigger anything. Branch on SQL substring to inject sim results.
    pool.query.mockImplementation((sql) => {
      if (/UPDATE sim_call_scores/.test(sql)) {
        return makeUpdateResponse([
          { id: 1, caller_identity: 'kate', vapi_call_id: null, created_at: new Date() },     // tier 1
          { id: 2, caller_identity: 'paul', vapi_call_id: null, created_at: new Date() },     // tier 1
          { id: 3, caller_identity: 'tom',  vapi_call_id: 'vapi-x', created_at: new Date() }, // tier 2
        ]);
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await runSweep();

    expect(sendSystemAlert).toHaveBeenCalled();
    const [, blocks] = sendSystemAlert.mock.calls[0];
    const sectionText = blocks.find(b => b.type === 'section').text.text;
    expect(sectionText).toMatch(/Tier 1.*: 2/);
    expect(sectionText).toMatch(/Tier 2.*: 1/);
    expect(sectionText).toMatch(/kate.*paul.*tom/);
  });

  test('all-tier-1 sweep: alert reports tier1=N, tier2=0', async () => {
    pool.query.mockImplementation((sql) => {
      if (/UPDATE sim_call_scores/.test(sql)) {
        return makeUpdateResponse([
          { id: 1, caller_identity: 'kate', vapi_call_id: null, created_at: new Date() },
        ]);
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await runSweep();
    const [, blocks] = sendSystemAlert.mock.calls[0];
    const sectionText = blocks.find(b => b.type === 'section').text.text;
    expect(sectionText).toMatch(/Tier 1.*: 1/);
    expect(sectionText).toMatch(/Tier 2.*: 0/);
  });
});

describe('sweepStaleSims — error handling', () => {
  test('UPDATE failure is caught and logged, doesn\'t throw', async () => {
    pool.query.mockImplementation((sql) => {
      if (/UPDATE sim_call_scores/.test(sql)) {
        return Promise.reject(new Error('DB down'));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await expect(runSweep()).resolves.toBeUndefined();
    expect(sendSystemAlert).not.toHaveBeenCalled();
  });
});
