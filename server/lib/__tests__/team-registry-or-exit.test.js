/**
 * team-registry-or-exit.test.js — drives the REAL loadRegistryOrExit
 * wrapper (not a mock) to verify the FATAL+process.exit contract.
 *
 * Closes Linus pass-3 #4: the boot-failure test in incoming.test.js mocks
 * team-registry's loadRegistryOrExit and inlines the FATAL log + exit
 * behavior, which makes that test a tautology — if the production wrapper
 * ever changes the log format or exit code, the mocked test still passes
 * against the wrong contract. This file exercises the real wrapper end
 * to end.
 *
 * Strategy: mock fs.readFileSync to throw when team.json is read. The
 * wrapper calls loadRegistry → fs.readFileSync → throws → wrapper catches
 * → logs FATAL → calls process.exit(1). Spy on process.exit + console.error
 * and assert the exact call signatures.
 */

jest.mock('fs', () => {
  const realFs = jest.requireActual('fs');
  return {
    ...realFs,
    readFileSync: jest.fn((p, opts) => {
      if (typeof p === 'string' && p.endsWith('team.json')) {
        throw new Error('ENOENT: simulated missing team.json');
      }
      return realFs.readFileSync(p, opts);
    }),
    existsSync: jest.fn((p) => {
      // Pretend team-phones.json doesn't exist either (loadRegistry's
      // existsSync check); we don't need the override for this test.
      if (typeof p === 'string' && p.endsWith('team-phones.json')) return false;
      const realFs2 = jest.requireActual('fs');
      return realFs2.existsSync(p);
    }),
  };
});

const { loadRegistryOrExit, _resetForTesting } = require('../team-registry');

describe('loadRegistryOrExit — real wrapper contract', () => {
  let exitSpy;
  let errSpy;

  beforeEach(() => {
    _resetForTesting();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit intercepted by spy');
    });
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('calls process.exit(1) with FATAL log when team.json read fails', () => {
    expect(() => loadRegistryOrExit('test-consumer')).toThrow('process.exit intercepted');
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Pin both the FATAL prefix shape AND the consumer-label inclusion
    // — these are the contract incoming.test.js's mock duplicated.
    // If the production wrapper changes the log format, this test fails
    // loudly instead of the mocked one silently passing.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^FATAL: team-registry load failed \(consumer=test-consumer\):$/),
      expect.stringContaining('ENOENT: simulated missing team.json'),
    );
  });

  test('consumer label appears verbatim in FATAL log on failure', () => {
    expect(() => loadRegistryOrExit('escalation')).toThrow();
    expect(errSpy.mock.calls[0][0]).toContain('consumer=escalation');
  });
});
