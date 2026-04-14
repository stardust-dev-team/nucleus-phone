/**
 * Shared mock for global.fetch.
 *
 * Usage:
 *   const { installFetchMock, mockFetchResponse } = require('../../__tests__/helpers/mock-fetch');
 *   beforeEach(() => installFetchMock());
 *   afterEach(() => { delete global.fetch; });
 *
 *   // In a test:
 *   mockFetchResponse({ data: 'ok' });           // 200 JSON
 *   mockFetchResponse('Not found', { status: 404 });
 */

let fetchMock;

function makeHeaders(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

function installFetchMock() {
  fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: makeHeaders(),
    json: async () => ({}),
    text: async () => '',
  });
  global.fetch = fetchMock;
  return fetchMock;
}

function mockFetchResponse(body, { status = 200, ok, headers = {} } = {}) {
  const isOk = ok !== undefined ? ok : status >= 200 && status < 300;
  fetchMock.mockResolvedValueOnce({
    ok: isOk,
    status,
    headers: makeHeaders(headers),
    json: async () => (typeof body === 'object' ? body : JSON.parse(body)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function mockFetchError(err) {
  fetchMock.mockRejectedValueOnce(err);
}

module.exports = { installFetchMock, mockFetchResponse, mockFetchError };
