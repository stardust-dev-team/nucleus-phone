/**
 * CallMediaSession + server tests (bead nucleus-phone-rgja.5, Stage B2).
 *
 * Drives the per-call orchestration with a MockSttAdapter (one final chunk per media
 * write) and a recording IngestClient — no socket, no Python, no network. Covers the
 * plan's required cases: both bridges receive start/stop/media and each drops its
 * non-owned track; finalize fires exactly once (stop + socket-close); the drain-timeout
 * proceeds-and-finalizes when a worker wedges; an unroutable start (no conference_name)
 * is refused. Plus a /healthz smoke test on a bound port.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from './log/index.js';
import { MockSttAdapter } from './media-bridge/index.js';
import type { SttAdapter, SttChunk, SttResult } from './media-bridge/index.js';
import type { TranscriptChunk } from './merge/contract.js';
import { CallMediaSession, createMediaStreamServer, HEALTH_PATH } from './media-stream-server.js';
import type { IngestClient } from './ingest-client.js';

const CONF = 'nucleus-call-0a0a0a0a';

function silentLogger(): Logger {
  return new Logger({ sink: () => {} });
}

function mulawPayload(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString('base64');
}

function startFrame(opts: { conference?: string; tracks?: string[] } = {}): object {
  const start: Record<string, unknown> = {
    streamSid: 'MZ-redacted',
    accountSid: 'AC-redacted',
    callSid: 'CA-redacted',
    tracks: opts.tracks ?? ['inbound', 'outbound'],
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  };
  if (opts.conference !== undefined) start['customParameters'] = { conference_name: opts.conference };
  return { event: 'start', sequenceNumber: '1', streamSid: 'MZ-redacted', start };
}

function mediaFrame(track: string, timestamp: number): object {
  return {
    event: 'media',
    sequenceNumber: '2',
    streamSid: 'MZ-redacted',
    media: { track, chunk: '1', timestamp: String(timestamp), payload: mulawPayload([0xff, 0x7f, 0x00, 0x80]) },
  };
}

const STOP_FRAME = { event: 'stop', sequenceNumber: '9', streamSid: 'MZ-redacted', stop: { accountSid: 'AC-redacted', callSid: 'CA-redacted' } };

/** Records every POST so a test can assert chunk speakers + finalize count. */
class RecordingIngest implements IngestClient {
  readonly chunks: Array<{ conf: string; chunk: TranscriptChunk }> = [];
  finalizeCount = 0;
  async postChunk(conferenceName: string, chunk: TranscriptChunk): Promise<void> {
    this.chunks.push({ conf: conferenceName, chunk });
  }
  async postFinalize(conferenceName: string): Promise<void> {
    void conferenceName;
    this.finalizeCount++;
  }
}

/** An adapter whose flush() never resolves — simulates a wedged worker for the drain test. */
class HangingSttAdapter implements SttAdapter {
  write(_chunk: SttChunk): SttResult[] {
    return [];
  }
  flush(): Promise<SttResult[]> {
    return new Promise<SttResult[]>(() => {}); // never resolves
  }
  close(): Promise<void> {
    return new Promise<void>(() => {}); // never resolves
  }
}

/** A factory of fresh MockSttAdapters (one per bridge), labeled by track speaker via index. */
function mockFactory(): (callId: string) => SttAdapter {
  return () => new MockSttAdapter();
}

/** Drain race resolves on the real drain (never times out) for the happy-path tests. */
const drainWins = (): Promise<void> => new Promise<void>(() => {});

test('fan-out: both bridges see every frame; each drops its non-owned track; finalize once', async () => {
  const ingest = new RecordingIngest();
  const session = new CallMediaSession({
    sttFactory: mockFactory(),
    ingest,
    logger: silentLogger(),
    delay: drainWins,
  });

  await session.handleMessage(startFrame({ conference: CONF }));
  await session.handleMessage(mediaFrame('outbound', 20)); // only the agent bridge owns this
  await session.handleMessage(mediaFrame('inbound', 40)); // only the customer bridge owns this
  await session.handleMessage(STOP_FRAME);

  // Exactly two chunks — one per track — with the correct speaker stamped by each bridge.
  assert.equal(ingest.chunks.length, 2);
  const speakers = ingest.chunks.map((c) => c.chunk.speaker).sort();
  assert.deepEqual(speakers, ['agent', 'customer']);
  assert.ok(ingest.chunks.every((c) => c.conf === CONF));
  assert.equal(ingest.finalizeCount, 1);
});

test('finalize is at-most-once across a stop frame AND a later socket close', async () => {
  const ingest = new RecordingIngest();
  const session = new CallMediaSession({ sttFactory: mockFactory(), ingest, logger: silentLogger(), delay: drainWins });

  await session.handleMessage(startFrame({ conference: CONF }));
  await session.handleMessage(mediaFrame('inbound', 20));
  await session.handleMessage(STOP_FRAME);
  await session.close(); // socket-drop after a clean stop — must NOT double-finalize

  assert.equal(ingest.finalizeCount, 1);
});

test('drain timeout: a wedged worker still proceeds + finalizes', async () => {
  const ingest = new RecordingIngest();
  const lines: string[] = [];
  const session = new CallMediaSession({
    sttFactory: () => new HangingSttAdapter(),
    ingest,
    logger: new Logger({ sink: (l) => lines.push(l) }),
    drainTimeoutMs: 10,
    delay: () => Promise.resolve(), // timeout wins immediately
  });

  await session.handleMessage(startFrame({ conference: CONF }));
  await session.handleMessage(mediaFrame('inbound', 20));
  // close() drives bridge.close() → stt.flush() which never resolves; the bounded race
  // must still let finalize through. If the bound were missing, this await would hang.
  await session.close();

  assert.equal(ingest.finalizeCount, 1);
  assert.ok(lines.some((l) => JSON.parse(l).event === 'media.drain.timeout'));
});

test('start without conference_name is refused (onUnroutable, no bridges, no finalize)', async () => {
  const ingest = new RecordingIngest();
  let unroutable = 0;
  const session = new CallMediaSession({
    sttFactory: mockFactory(),
    ingest,
    logger: silentLogger(),
    onUnroutable: () => unroutable++,
  });

  await session.handleMessage(startFrame({})); // no conference_name
  await session.handleMessage(mediaFrame('inbound', 20)); // ignored — never started
  await session.close();

  assert.equal(unroutable, 1);
  assert.equal(session.isStarted, false);
  assert.equal(ingest.chunks.length, 0);
  assert.equal(ingest.finalizeCount, 0);
});

test('a conference_name that is not the nucleus-* shape is refused as unroutable (PII guard)', async () => {
  const ingest = new RecordingIngest();
  let unroutable = 0;
  const session = new CallMediaSession({
    sttFactory: mockFactory(),
    ingest,
    logger: silentLogger(),
    onUnroutable: () => unroutable++,
  });

  // A misconfigured <Parameter> carrying a phone number must NOT become a callId.
  await session.handleMessage(startFrame({ conference: '+16025551234' }));

  assert.equal(unroutable, 1);
  assert.equal(session.isStarted, false);
});

test('frames before start are ignored; an unparseable frame is dropped without throwing', async () => {
  const ingest = new RecordingIngest();
  const session = new CallMediaSession({ sttFactory: mockFactory(), ingest, logger: silentLogger(), delay: drainWins });

  await session.handleMessage({ event: 'connected', protocol: 'Call', version: '1.0' }); // pre-start
  await session.handleMessage(mediaFrame('inbound', 20)); // pre-start media — ignored
  await session.handleMessage('}{ not json'); // unparseable
  assert.equal(ingest.chunks.length, 0);
  assert.equal(session.isStarted, false);
});

test('GET /healthz returns 200 with activeCalls', async () => {
  const server = createMediaStreamServer({ sttFactory: mockFactory(), ingest: new RecordingIngest(), logger: silentLogger() });
  const port = await server.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; activeCalls: number };
    assert.equal(body.status, 'ok');
    assert.equal(body.activeCalls, 0);
  } finally {
    await server.close();
  }
});
