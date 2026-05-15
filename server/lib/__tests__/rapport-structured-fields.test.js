/**
 * rapport-structured-fields.test.js — Phase D contract tests.
 *
 * Pins the shape of the two new structured fields the rapport generator
 * emits: `brand_voice` (do/don't pairs) and `competitive_watch`
 * (competitors + reframe). The Anthropic API is mocked; an optional
 * `INTEGRATION=1` test exercises the real Haiku call.
 */

const { installFetchMock, mockFetchResponse } = require('../../__tests__/helpers/mock-fetch');

jest.mock('../debug-log', () => ({ logEvent: jest.fn() }));
jest.mock('../health-tracker', () => ({ touch: jest.fn() }));

let generateRapportIntel;

beforeEach(() => {
  installFetchMock();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.isolateModules(() => {
    ({ generateRapportIntel } = require('../claude'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.ANTHROPIC_API_KEY;
  jest.restoreAllMocks();
});

const CONTACT = {
  hubspotContactId: 'hs-phase-d-1',
  name: 'Jane Doe',
  company: 'Acme',
  title: 'VP Ops',
};

describe('generateRapportIntel — Phase D structured fields', () => {
  test('emits brand_voice with avoid + use arrays when Claude returns them', async () => {
    mockFetchResponse({
      content: [{
        text: JSON.stringify({
          rapport_starters: ['ask about Acme'],
          intel_nuggets: ['plant in Phoenix'],
          opening_line: 'Hi Jane',
          adapted_script: 'Lead with uptime',
          watch_outs: [],
          product_reference: ['JRS-30'],
          brand_voice: {
            avoid: ['leverage', 'best-in-class'],
            use: ['we run it ourselves', 'plain English'],
          },
          competitive_watch: {
            competitors: ['Atlas Copco', 'Ingersoll Rand'],
            reframe: 'Reframe to assembled-in-Texas reliability.',
          },
        }),
      }],
    });

    const result = await generateRapportIntel(CONTACT);

    expect(result.fallback).toBe(false);
    expect(result.brand_voice).toBeDefined();
    expect(Array.isArray(result.brand_voice.avoid)).toBe(true);
    expect(Array.isArray(result.brand_voice.use)).toBe(true);
    expect(result.brand_voice.avoid.length).toBeGreaterThan(0);
    expect(result.brand_voice.use.length).toBeGreaterThan(0);

    expect(result.competitive_watch).toBeDefined();
    expect(Array.isArray(result.competitive_watch.competitors)).toBe(true);
    expect(typeof result.competitive_watch.reframe).toBe('string');
    expect(result.competitive_watch.competitors).toContain('Atlas Copco');
  });

  test('fallback path also emits structured brand_voice + competitive_watch', async () => {
    // No ANTHROPIC_API_KEY -> goes straight to buildFallback. Reset env
    // var inside this test so the module-init capture sees it absent.
    delete process.env.ANTHROPIC_API_KEY;
    jest.isolateModules(() => {
      ({ generateRapportIntel } = require('../claude'));
    });

    const result = await generateRapportIntel({
      ...CONTACT,
      companyVernacular: { competitorsMentioned: ['Sullair'] },
    });

    expect(result.fallback).toBe(true);
    expect(result.brand_voice).toBeDefined();
    expect(result.brand_voice.avoid.length).toBeGreaterThan(0);
    expect(result.brand_voice.use.length).toBeGreaterThan(0);

    expect(result.competitive_watch).toBeDefined();
    expect(result.competitive_watch.competitors).toContain('Sullair');
    expect(result.competitive_watch.reframe).toMatch(/Sullair/);
    // Pin the fallback reframe's "assembled-in-Texas" anchor. This
    // string is hardcoded in buildFallback; if CAS facility messaging
    // shifts (or the location changes), this test fails and forces an
    // intentional update. Filed by Linus review #12.
    expect(result.competitive_watch.reframe).toMatch(/assembled-in-Texas/);
  });

  test('structured fields survive the setCache/getCached roundtrip', async () => {
    // Calls generateRapportIntel TWICE for the same contact. First
    // call goes to fetch (Claude), result is cached. Second call must
    // hit cache (no fetch) and return the exact same structured
    // payload. This catches:
    //   - accidental shallow-merge or strip in setCache/getCached
    //   - cache-key mismatches that cause unnecessary refetches
    // Mock returns the same response for both potential fetches; the
    // assertion that fetch was called only once is the load-bearing
    // check.
    mockFetchResponse({
      content: [{
        text: JSON.stringify({
          rapport_starters: [], intel_nuggets: [],
          opening_line: 'x', adapted_script: 'y', watch_outs: [],
          product_reference: [],
          brand_voice: { avoid: ['a'], use: ['b'] },
          competitive_watch: { competitors: ['c'], reframe: 'd' },
        }),
      }],
    });

    const first = await generateRapportIntel(CONTACT);
    const second = await generateRapportIntel(CONTACT);

    expect(global.fetch).toHaveBeenCalledTimes(1); // second call hit cache
    expect(second.brand_voice).toEqual({ avoid: ['a'], use: ['b'] });
    expect(second.competitive_watch).toEqual({ competitors: ['c'], reframe: 'd' });
    expect(second).toEqual(first); // exact roundtrip — no shallow strip
  });
});

// Real Haiku call — gated to avoid burning API credits on every test run.
// Run with `INTEGRATION=1 npm test -- --testPathPattern=rapport-structured-fields`.
const integrationOrSkip = process.env.INTEGRATION ? describe : describe.skip;
integrationOrSkip('generateRapportIntel — integration (real Claude)', () => {
  test('real call emits brand_voice + competitive_watch shape', async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('INTEGRATION=1 requires ANTHROPIC_API_KEY in env');
    }
    delete global.fetch; // use the real one
    jest.isolateModules(() => {
      ({ generateRapportIntel } = require('../claude'));
    });

    const result = await generateRapportIntel({
      ...CONTACT,
      pbContactData: { industry: 'Aerospace', location: 'Phoenix, AZ' },
    });

    expect(result.brand_voice?.avoid).toEqual(expect.any(Array));
    expect(result.brand_voice?.use).toEqual(expect.any(Array));
    expect(result.competitive_watch?.competitors).toEqual(expect.any(Array));
    expect(typeof result.competitive_watch?.reframe).toBe('string');
  }, 15000);
});
