const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

jest.mock('../debug-log', () => ({ logEvent: jest.fn() }));
jest.mock('../health-tracker', () => ({ touch: jest.fn() }));

let generateRapportIntel, clearCache;
let logEvent, touch;

beforeEach(() => {
  installFetchMock();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  // Fresh module per test to reset cache
  jest.isolateModules(() => {
    ({ generateRapportIntel, clearCache } = require('../claude'));
    ({ logEvent } = require('../debug-log'));
    ({ touch } = require('../health-tracker'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.ANTHROPIC_API_KEY;
  jest.restoreAllMocks();
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
  test('POSTs to Anthropic API with correct headers/body and returns parsed intel', async () => {
    mockFetchResponse(CLAUDE_RESPONSE);
    const result = await generateRapportIntel(CONTACT);
    expect(result.fallback).toBe(false);
    expect(result.rapport_starters).toHaveLength(1);
    expect(result.opening_line).toBe('Hi Jane');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith('anthropic');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('test-key');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(opts.body);
    expect(body.model).toMatch(/claude-sonnet/);
    expect(body.system).toMatch(/rapport/);
    expect(body.messages[0].content).toContain('Jane Doe');
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

  test('returns fallback on API error + logs structured error to telemetry', async () => {
    mockFetchResponse('{"error":"overloaded"}', { status: 529 });
    const result = await generateRapportIntel(CONTACT);
    expect(result.fallback).toBe(true);
    expect(touch).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'integration', 'anthropic',
      expect.stringMatching(/Claude POST v1\/messages \(529\)/),
      expect.objectContaining({
        level: 'error',
        detail: expect.objectContaining({
          status: 529,
          endpoint: 'v1/messages',
          body: expect.stringContaining('overloaded'),
        }),
      }),
    );
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
    clearCache('hs-1_v2');
    // Next call should hit API again
    mockFetchResponse(CLAUDE_RESPONSE);
    await generateRapportIntel(CONTACT);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('fallback uses signal metadata for SPEAR contact', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const spearContact = {
      hubspotContactId: 'hs-spear',
      name: 'Logan Torres',
      company: 'Precision Aero',
      title: 'VP Quality',
      signalMetadata: {
        signal_tier: 'SPEAR',
        signal_score: 92,
        cert_expiry_date: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        cert_standard: 'AS9100',
        cert_body: 'NQA',
        contract_total: 1500000,
        dod_flag: true,
        source_count: 3,
        signal_sources: ['SAM.gov', 'FPDS'],
      },
    };
    const result = await generateRapportIntel(spearContact);
    expect(result.fallback).toBe(true);
    // Should have cert-related talking points
    expect(result.rapport_starters.some(s => s.includes('AS9100'))).toBe(true);
    // Should have DoD intel nugget
    expect(result.intel_nuggets.some(n => n.includes('DoD'))).toBe(true);
    // Opening line should NOT be generic
    expect(result.opening_line).not.toContain('this is calling from Joruva Industrial.');
    expect(result.opening_line).toContain('Logan');
  });

  test('fallback handles expired cert correctly', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const expiredContact = {
      hubspotContactId: 'hs-expired',
      name: 'Dana Park',
      company: 'Legacy Machining',
      title: 'Quality Manager',
      signalMetadata: {
        signal_tier: 'TARGETED',
        cert_expiry_date: '2025-06-15T00:00:00Z', // well in the past
        cert_standard: 'ISO 9001',
        cert_body: 'BSI',
        dod_flag: false,
      },
    };
    const result = await generateRapportIntel(expiredContact);
    expect(result.fallback).toBe(true);
    expect(result.rapport_starters.some(s => s.includes('expired'))).toBe(true);
    expect(result.rapport_starters.some(s => s.includes('BSI'))).toBe(true);
    expect(result.intel_nuggets.some(n => n.includes('expired'))).toBe(true);
    // Must NOT say "expires" (future tense) for a past-date cert
    expect(result.rapport_starters.every(s => !s.includes('expires'))).toBe(true);
  });

  test('fallback with no signal data still works', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const bareContact = { name: 'Alex Smith' };
    const result = await generateRapportIntel(bareContact);
    expect(result.fallback).toBe(true);
    expect(result.opening_line).toContain('Alex');
    expect(result.rapport_starters.length).toBeGreaterThan(0);
  });

  test('fallback with full vernacular produces rich briefing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const richContact = {
      hubspotContactId: 'hs-rich',
      name: 'Daniel Franzese',
      company: 'HABCO Industries',
      title: 'Vice President and General Manager',
      pbContactData: {
        summary: 'Aerospace and aviation sector professional with contract negotiation expertise',
        industry: 'Aviation and Aerospace Component Manufacturing',
        location: 'North Dartmouth, Massachusetts',
        durationInRole: '9 months in role',
        pastExperience: { company: 'Esterline Advanced Sensors', title: 'Director, Sales and Operations', duration: '8 months' },
      },
      signalMetadata: {
        signal_tier: 'targeted',
        signal_score: 9,
        contract_total: 126480,
        dod_flag: true,
      },
      companyVernacular: {
        equipment: ['piston compressor, 25HP, 7 years old'],
        painPoints: ['moisture', 'short-cycling'],
        competitorsMentioned: ['Atlas Copco'],
        leadershipStrategy: 'Operational simplification and growth',
      },
      icpScore: { geo_city: 'GLASTONBURY', geo_state: 'CT', employee_range: '50-100' },
      emailEngagement: [
        { event_type: 'open', campaign_name: 'CNC Air Quality Series' },
        { event_type: 'click', campaign_name: 'CNC Air Quality Series' },
      ],
    };
    const result = await generateRapportIntel(richContact);
    expect(result.fallback).toBe(true);
    // Should have 4+ starters (signal + career + strategy)
    expect(result.rapport_starters.length).toBeGreaterThanOrEqual(4);
    // Should have 4+ nuggets (industry + location + equipment + pain + email)
    expect(result.intel_nuggets.length).toBeGreaterThanOrEqual(4);
    // Should have product recommendations
    expect(result.product_reference.length).toBeGreaterThanOrEqual(2);
    // Should have aerospace products since industry is aviation
    expect(result.product_reference.some(p => p.includes('JDD-40'))).toBe(true);
    // adapted_script should be a real paragraph, not empty
    expect(result.adapted_script.length).toBeGreaterThan(50);
    // watch_outs should include competitor
    expect(result.watch_outs.some(w => w.includes('Atlas Copco'))).toBe(true);
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
