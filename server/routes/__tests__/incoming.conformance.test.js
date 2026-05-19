/**
 * incoming.conformance.test.js — Validates the canonical inbound routing
 * config at server/config/inbound-routes.json.
 *
 * This file exists because of the 2026-05-19 drift incident: the production
 * INBOUND_ROUTES env var had been silently re-pointed from Ryann to Tom on
 * +16026000188, while the code comment, unit tests, and runbook all still
 * said "Ryann". Nothing caught the drift. The fix promotes inbound-routes.json
 * to canonical source of truth, and this file pins the production mapping
 * so any future re-point requires a deliberate test update — which is
 * impossible to do accidentally.
 *
 * If a route's intended owner changes, update both the JSON file AND the
 * drift sentinel below in the same commit. Don't update just the file.
 */

const path = require('path');
const fs = require('fs');

const ROUTES_FILE = path.join(__dirname, '..', '..', 'config', 'inbound-routes.json');

describe('inbound-routes.json schema', () => {
  let config;
  let routes;

  beforeAll(() => {
    expect(fs.existsSync(ROUTES_FILE)).toBe(true);
    config = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
    routes = config.routes;
  });

  test('top-level object has a routes property containing the map', () => {
    expect(typeof routes).toBe('object');
    expect(routes).not.toBeNull();
    expect(Object.keys(routes).length).toBeGreaterThan(0);
  });

  test('every key is an E.164 US/Canada number', () => {
    for (const number of Object.keys(routes)) {
      expect(number).toMatch(/^\+1\d{10}$/);
    }
  });

  test('every entry has a string name', () => {
    for (const [number, route] of Object.entries(routes)) {
      expect(typeof route.name).toBe('string');
      expect(route.name.length).toBeGreaterThan(0);
    }
  });

  test('every entry has either forward or iosIdentity (validator condition)', () => {
    for (const [number, route] of Object.entries(routes)) {
      expect(Boolean(route.forward) || Boolean(route.iosIdentity)).toBe(true);
    }
  });

  test('forward numbers (when present) are E.164', () => {
    for (const [number, route] of Object.entries(routes)) {
      if (route.forward) {
        expect(route.forward).toMatch(/^\+1\d{10}$/);
      }
    }
  });

  test('slack field is a string (User ID, DM channel ID, or empty)', () => {
    for (const [number, route] of Object.entries(routes)) {
      expect(typeof route.slack).toBe('string');
    }
  });
});

describe('inbound-routes.json drift sentinels', () => {
  let routes;

  beforeAll(() => {
    routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')).routes;
  });

  // The 2026-05-19 drift incident pinned to a single assertion. If this
  // test fails because the route was deliberately changed, update the
  // expectation here AND update memory/runbooks/twilio-voice.md AND the
  // hub mirror — that's how we keep all three sources in sync.
  test('+16026000188 routes to Ryann (drift sentinel, 2026-05-19)', () => {
    const route = routes['+16026000188'];
    expect(route).toBeDefined();
    expect(route.name).toBe('Ryann');
    expect(route.forward).toBe('+14803630494');
    expect(route.slack).toBe('U0ANRJR25QB');
  });

  test('+16234620197 routes to Tom (paired sentinel)', () => {
    const route = routes['+16234620197'];
    expect(route).toBeDefined();
    expect(route.name).toBe('Tom');
    expect(route.forward).toBe('+16304416374');
  });
});
