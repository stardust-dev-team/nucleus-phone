/**
 * HttpIngestClient tests (bead nucleus-phone-rgja.5, Stage B2). Proves the
 * cross-service hop's retry + dead-letter contract with an injected fetch + an
 * immediate-resolve delay (no real backoff wait), and that neither method ever throws.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from './log/index.js';
import { HttpIngestClient, type FetchFn } from './ingest-client.js';
import type { TranscriptChunk } from './merge/contract.js';

const CONF = 'nucleus-call-0a0a0a0a';
const CHUNK: TranscriptChunk = { speaker: 'agent', text: 'hello there', utt_start_ms: 100, utt_end_ms: 900 };

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new Logger({ sink: (l) => lines.push(l) }), lines };
}

/** A fetch fake that returns the next queued response (or throws if queued an Error). */
function fakeFetch(responses: Array<{ ok: boolean; status: number } | Error>): {
  fetchFn: FetchFn;
  calls: Array<{ url: string; body: string; auth: string }>;
} {
  const calls: Array<{ url: string; body: string; auth: string }> = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers['authorization'] ?? '' });
    const r = responses[Math.min(i, responses.length - 1)] ?? { ok: true, status: 200 };
    i++;
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchFn, calls };
}

const noDelay = (): Promise<void> => Promise.resolve();

test('postChunk: 2xx success POSTs once with bearer + mapped body, no dead-letter', async () => {
  const { fetchFn, calls } = fakeFetch([{ ok: true, status: 200 }]);
  const { logger, lines } = capturingLogger();
  const client = new HttpIngestClient({ baseUrl: 'https://main.example.com/', secret: 'sek', fetchFn, delay: noDelay, logger });

  await client.postChunk(CONF, CHUNK);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://main.example.com/api/stt-ingest'); // trailing slash trimmed
  assert.equal(calls[0]?.auth, 'Bearer sek');
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), {
    conferenceName: CONF,
    text: 'hello there',
    speaker: 'agent',
    isFinal: true,
    uttStartMs: 100,
    uttEndMs: 900,
  });
  assert.equal(lines.length, 0); // nothing dead-lettered
});

test('postFinalize: posts the idempotent finalize body', async () => {
  const { fetchFn, calls } = fakeFetch([{ ok: true, status: 200 }]);
  const client = new HttpIngestClient({ baseUrl: 'https://main.example.com', secret: 'sek', fetchFn, delay: noDelay });

  await client.postFinalize(CONF);

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { conferenceName: CONF, event: 'finalize' });
});

test('5xx retries then succeeds — no dead-letter', async () => {
  const { fetchFn, calls } = fakeFetch([{ ok: false, status: 503 }, { ok: true, status: 200 }]);
  const { logger, lines } = capturingLogger();
  const client = new HttpIngestClient({ baseUrl: 'https://m', secret: 's', fetchFn, delay: noDelay, logger });

  await client.postChunk(CONF, CHUNK);

  assert.equal(calls.length, 2);
  assert.equal(lines.length, 0);
});

test('5xx exhausts attempts then dead-letters (no transcript text in the log)', async () => {
  const { fetchFn, calls } = fakeFetch([{ ok: false, status: 500 }]);
  const { logger, lines } = capturingLogger();
  const client = new HttpIngestClient({ baseUrl: 'https://m', secret: 's', fetchFn, delay: noDelay, maxAttempts: 3, logger });

  await client.postChunk(CONF, CHUNK); // must not throw

  assert.equal(calls.length, 3);
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0] ?? '{}');
  assert.equal(rec.event, 'ingest.deadletter.chunk');
  assert.equal(rec.callId, CONF);
  assert.equal(rec.code, '500');
  assert.equal(rec.count, 3);
  assert.ok(!JSON.stringify(rec).includes('hello there')); // transcript text never logged
});

test('4xx dead-letters immediately without retry', async () => {
  const { fetchFn, calls } = fakeFetch([{ ok: false, status: 401 }]);
  const { logger, lines } = capturingLogger();
  const client = new HttpIngestClient({ baseUrl: 'https://m', secret: 's', fetchFn, delay: noDelay, maxAttempts: 3, logger });

  await client.postChunk(CONF, CHUNK);

  assert.equal(calls.length, 1); // no retry on a 4xx
  assert.equal(JSON.parse(lines[0] ?? '{}').code, '401');
});

test('network throw retries then dead-letters as code "network"', async () => {
  const { fetchFn, calls } = fakeFetch([new Error('ECONNRESET')]);
  const { logger, lines } = capturingLogger();
  const client = new HttpIngestClient({ baseUrl: 'https://m', secret: 's', fetchFn, delay: noDelay, maxAttempts: 2, logger });

  await client.postFinalize(CONF); // must not throw

  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(lines[0] ?? '{}').event, 'ingest.deadletter.finalize');
  assert.equal(JSON.parse(lines[0] ?? '{}').code, 'network');
});
