/**
 * Integration replay harness (bead nucleus-phone-rgja.9, Stage C). Exercises the FULL
 * in-house wire that the unit tests stub out — a real `ws` socket, a real per-call worker
 * SUBPROCESS, the real HttpIngestClient, and a real stub `/api/stt-ingest` HTTP receiver —
 * end to end, with NO Python/moonshine install:
 *
 *   recorded Media Streams frames → ws://…/media-stream (real WebSocketServer)
 *     → two MediaStreamBridge per call → createLiveSttFactory spawning the DETERMINISTIC
 *       FAKE worker (`__fixtures__/fake-stt-worker.mjs` on this node, NOT moonshine)
 *     → HttpIngestClient → stub /api/stt-ingest receiver
 *
 * Asserts: per-speaker chunks (agent vs customer) arrive, every POST is tagged with the
 * call's conference_name, and a single finalize lands on stop. The REAL moonshine worker
 * acceptance is deferred to the Render deploy (Stage D / rgja.6) — this proves the
 * orchestration + transport + ingest plumbing with a stub engine.
 *
 * Frames are synthesized (there is no recorded JSON fixture in the repos — aunshin's
 * scripts/media-streams/test-media-streams.ts generates them live the same way), but they
 * are driven over a genuine socket so the WS framing + subprocess spawn + POST path are real.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';
import { Logger } from './log/index.js';
import { createLiveSttFactory } from './media-bridge/index.js';
import { HttpIngestClient } from './ingest-client.js';
import { createMediaStreamServer, type MediaStreamServer } from './media-stream-server.js';

const STUB_WORKER = join(dirname(fileURLToPath(import.meta.url)), 'media-bridge', '__fixtures__', 'fake-stt-worker.mjs');
const CONF = 'nucleus-call-replay0001';
const silent = new Logger({ sink: () => {} });

interface IngestPost {
  conferenceName?: string;
  text?: string;
  speaker?: string;
  event?: string;
}

/** Stub /api/stt-ingest receiver — records every POST body, always 200. */
function startStubIngest(): Promise<{ server: Server; url: string; posts: IngestPost[] }> {
  const posts: IngestPost[] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/stt-ingest')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        posts.push(JSON.parse(body));
      } catch {
        /* ignore a malformed body in the stub */
      }
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, posts });
    });
  });
}

function mulawPayload(): string {
  // 20ms of 8kHz μ-law = 160 bytes. Content is arbitrary (the stub worker replies regardless;
  // decoded floats are in [-1,1] so they never hit the worker's ±crash sentinels).
  return Buffer.alloc(160, 0x55).toString('base64');
}

function startFrame() {
  return JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ-replay',
    start: {
      streamSid: 'MZ-replay',
      accountSid: 'AC-replay',
      callSid: 'CA-replay',
      tracks: ['inbound', 'outbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: { conference_name: CONF },
    },
  });
}

function mediaFrame(track: string, ts: number) {
  return JSON.stringify({
    event: 'media',
    sequenceNumber: String(ts),
    streamSid: 'MZ-replay',
    media: { track, chunk: String(ts), timestamp: String(ts), payload: mulawPayload() },
  });
}

const STOP = JSON.stringify({ event: 'stop', sequenceNumber: '99', streamSid: 'MZ-replay', stop: { accountSid: 'AC-replay', callSid: 'CA-replay' } });

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

let stub: { server: Server; url: string; posts: IngestPost[] };
let server: MediaStreamServer;

after(async () => {
  if (server) await server.close();
  if (stub) await new Promise((r) => stub.server.close(() => r(undefined)));
});

test('replay: both-track frames → per-speaker chunks + conference-tagged POSTs + one finalize', async () => {
  stub = await startStubIngest();
  server = createMediaStreamServer({
    sttFactory: createLiveSttFactory({ pythonPath: process.execPath, workerScript: STUB_WORKER, logger: silent }),
    ingest: new HttpIngestClient({ baseUrl: stub.url, secret: 'replay-secret', logger: silent }),
    logger: silent,
  });
  const port = await server.listen(0, '127.0.0.1');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Replay a short both-tracks call: start, interleaved inbound/outbound media, stop.
  ws.send(startFrame());
  for (let i = 1; i <= 4; i++) {
    ws.send(mediaFrame('inbound', i * 20));
    ws.send(mediaFrame('outbound', i * 20));
  }
  ws.send(STOP);

  // The stub fake worker emits a final segment on FINISH (drain), so each bridge POSTs one
  // finalized chunk at stop; then the server POSTs the finalize. Wait for the finalize to land.
  await waitFor(() => stub.posts.some((p) => p.event === 'finalize'));
  ws.close();

  const chunks = stub.posts.filter((p) => p.event !== 'finalize');
  const finalizes = stub.posts.filter((p) => p.event === 'finalize');

  // Every POST is tagged with THIS call's conference_name (callId == conference_name).
  assert.ok(stub.posts.length >= 3, `expected >=3 posts, got ${stub.posts.length}`);
  assert.ok(stub.posts.every((p) => p.conferenceName === CONF), 'all posts tagged with conference_name');

  // Per-speaker chunks: the outbound-track bridge stamps 'agent', the inbound 'customer'.
  const speakers = new Set(chunks.map((c) => c.speaker));
  assert.ok(speakers.has('agent'), 'agent (outbound) chunk present');
  assert.ok(speakers.has('customer'), 'customer (inbound) chunk present');

  // Exactly one finalize on stop.
  assert.equal(finalizes.length, 1);
});
