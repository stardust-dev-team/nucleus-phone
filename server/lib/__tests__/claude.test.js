const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

let generateRapportIntel, clearCache;

beforeEach(() => {
  installFetchMock();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  // Fresh module per test to reset cache
  jest.isolateModules(() => {
    ({ generateRapportIntel, clearCache } = require('../claude'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.ANTHROPIC_API_KEY;
});

const CONTACT = { hubspotContactId: 'hs-1', name: 'Jane Doe', company: 'Acme', title: 'VP Ops' };
const CLAUDE_RESPONSE = {
  content: [{ text: JSON.stringify({
    rapport_starters: ['Ask about Acme'],
    intel_nuggets: [{ insight: 'growth', category: 'signal' }],
    opening_line: 'Hi Jane',
    adapted_script: 'Custom pitch',
    watch_outs: [],
    product_reference: 'VSD compressors',
  }) }],
};

describe('generateRapportIntel', () => {
  test('calls Claude API and returns parsed intel', async () => {
    mockFetchResponse(CLAUDE_RESPONSE);
    const result = await generateRapportIntel(CONTACT);
    expect(result.fallback).toBe(false);
    expect(result.rapport_starters).toHaveLength(1);
    expect(result.opening_line).toBe('Hi Jane');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('cache hit skips API call', async () => {
    mockFetchResponse(CLAUDE_RESPONSE);
    await generateRapportIntel(CONTACT);
    // Second call — should use cache
    const result = await generateRapportIntel(CONTACT);
    expect(result.opening_line).toBe('Hi Jane');
    expect(global.fetch).toHaveBeenCalledTimes(1); // only one call
  });

  test('returns fallback when ANTHROPIC_API_KEY missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await generateRapportIntel(CONTACT);
    expect(result.fallback).toBe(true);
    expect(result.rapport_starters.length).toBeGreaterThan(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns fallback on API error', async () => {
    mockFetchResponse('Server error', { status: 500 });
    const result = await generateRapportIntel(CONTACT);
    expect(result.fallback).toBe(true);
  });

  test('returns fallback on network error', async () => {
    mockFetchError(new Error('Network failure'));
    const result = await generateRapportIntel(CONTACT);
    expect(result.fallback).toBe(true);
  });

  test('returns fallback on abort/timeout', async () => {
    const err = new DOMException('Aborted', 'AbortError');
    mockFetchError(err);
    const result = await generateRapportIntel(CONTACT);
    expect(result.fallback).toBe(true);
  });

  test('clearCache removes specific key', async () => {
    mockFetchResponse(CLAUDE_RESPONSE);
    await generateRapportIntel(CONTACT);
    clearCache('hs-1');
    // Next call should hit API again
    mockFetchResponse(CLAUDE_RESPONSE);
    await generateRapportIntel(CONTACT);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('clearCache without key clears all', async () => {
    mockFetchResponse(CLAUDE_RESPONSE);
    await generateRapportIntel(CONTACT);
    clearCache();
    mockFetchResponse(CLAUDE_RESPONSE);
    await generateRapportIntel(CONTACT);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
