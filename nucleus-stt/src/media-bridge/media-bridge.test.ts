/**
 * Media-bridge tests — copy-forked from aunshin-phone (bead nucleus-phone-rgja.4)
 * and adapted for the nucleus-phone TWO-bridges-per-call model: every Twilio WS
 * frame is fanned to both an `{counterpartyTrack:'outbound', speakerLabel:'agent'}`
 * bridge and an `{counterpartyTrack:'inbound', speakerLabel:'customer'}` bridge on
 * the same socket; each decodes only its own track and stamps its own speaker.
 *
 * Drives the pure message processor against a synthesized Media Streams fixture —
 * no socket, no native binding.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from '../log/index.js';
import { MediaStreamBridge, MockSttAdapter, SttWorkerAdapter } from './index.js';
import type { MediaBridgeOptions, SttBinding } from './index.js';
import type { TranscriptChunk } from '../merge/contract.js';

const CALL_ID = 'nucleus-call-0a0a0a0a';

function silentLogger(): Logger {
  return new Logger({ sink: () => {} });
}

/** Construct a bridge with the required nucleus-stt options defaulted (inbound/customer). */
function makeBridge(
  stt: MockSttAdapter,
  opts: Partial<MediaBridgeOptions> = {},
): MediaStreamBridge {
  return new MediaStreamBridge(stt, {
    callId: CALL_ID,
    speakerLabel: 'customer',
    logger: silentLogger(),
    ...opts,
  });
}

function mulawPayload(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString('base64');
}

function startFrame(tracks: string[], encoding = 'audio/x-mulaw', sampleRate = 8000): object {
  return {
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ-redacted',
    start: {
      streamSid: 'MZ-redacted',
      accountSid: 'AC-redacted',
      callSid: 'CA-redacted', // a SID — must NEVER be logged
      tracks,
      mediaFormat: { encoding, sampleRate, channels: 1 },
    },
  };
}

function mediaFrame(track: string, timestamp: number, bytes: number[]): object {
  return {
    event: 'media',
    sequenceNumber: '2',
    streamSid: 'MZ-redacted',
    media: { track, chunk: '1', timestamp: String(timestamp), payload: mulawPayload(bytes) },
  };
}

const stopFrame = { event: 'stop', sequenceNumber: '9', streamSid: 'MZ-redacted', stop: { accountSid: 'AC-redacted', callSid: 'CA-redacted' } };

test('two per-track bridges on one socket: outbound→agent, inbound→customer; each drops the other track', async () => {
  // This is the core nucleus-stt adaptation (review #11 / bead rgja.4): both
  // bridges receive EVERY frame (the B2 fan-out contract); the counterpartyTrack
  // filter keeps each bridge to its own track, and speakerLabel stamps the chunk.
  const agentStt = new MockSttAdapter();
  const custStt = new MockSttAdapter();
  const agentChunks: TranscriptChunk[] = [];
  const custChunks: TranscriptChunk[] = [];
  const agentBridge = makeBridge(agentStt, {
    counterpartyTrack: 'outbound',
    speakerLabel: 'agent',
    onChunk: (c) => agentChunks.push(c),
  });
  const custBridge = makeBridge(custStt, {
    counterpartyTrack: 'inbound',
    speakerLabel: 'customer',
    onChunk: (c) => custChunks.push(c),
  });

  const frames = [
    { event: 'connected', protocol: 'Call', version: '1.0.0' } as object,
    startFrame(['inbound', 'outbound']),
    mediaFrame('outbound', 0, [0x00, 0x80, 0xff]), // rep speaking
    mediaFrame('inbound', 20, [0x12, 0x34]),       // customer speaking
    mediaFrame('outbound', 40, [0x7f, 0x80]),      // rep again
    stopFrame,
  ];
  // Fan every frame to BOTH bridges (exactly what media-stream-server.ts will do).
  for (const f of frames) {
    await agentBridge.handleMessage(f);
    await custBridge.handleMessage(f);
  }

  // Agent bridge decoded the 2 outbound frames and dropped the 1 inbound frame.
  assert.equal(agentStt.received.length, 2);
  assert.equal(agentBridge.stats().droppedOtherTrack, 1);
  assert.ok(agentChunks.length > 0);
  for (const c of agentChunks) assert.equal(c.speaker, 'agent');

  // Customer bridge decoded the 1 inbound frame and dropped the 2 outbound frames.
  assert.equal(custStt.received.length, 1);
  assert.equal(custBridge.stats().droppedOtherTrack, 2);
  assert.ok(custChunks.length > 0);
  for (const c of custChunks) assert.equal(c.speaker, 'customer');
});

test('utt offsets land in the merge clock domain (streamStartOffsetMs + stream-time)', async () => {
  const stt = new MockSttAdapter();
  const captured: TranscriptChunk[] = [];
  const bridge = makeBridge(stt, {
    streamStartOffsetMs: 5000, // stream opened 5s into the call
    onChunk: (c) => captured.push(c),
  });

  await bridge.handleMessage(startFrame(['inbound']));
  await bridge.handleMessage(mediaFrame('inbound', 0, [0x00, 0x80])); // stream-time 0
  await bridge.handleMessage(mediaFrame('inbound', 120, [0x00, 0x80])); // stream-time 120ms
  await bridge.handleMessage(stopFrame);

  assert.equal(captured[0]?.utt_start_ms, 5000);
  assert.equal(captured[1]?.utt_start_ms, 5120);
  assert.equal(captured[0]?.utt_end_ms, 5000);
});

test('auto-captures streamStartOffsetMs from callStartWallMs so the track shares the call clock', async () => {
  const stt = new MockSttAdapter();
  const captured: TranscriptChunk[] = [];
  const bridge = makeBridge(stt, {
    callStartWallMs: 1000,
    now: () => 4000, // wall clock at the start frame ≈ stream open (3s into the call)
    onChunk: (c) => captured.push(c),
  });

  await bridge.handleMessage(startFrame(['inbound']));
  await bridge.handleMessage(mediaFrame('inbound', 0, [0x00, 0x80]));
  await bridge.handleMessage(mediaFrame('inbound', 200, [0x00, 0x80]));
  await bridge.handleMessage(stopFrame);

  assert.equal(captured[0]?.utt_start_ms, 3000);
  assert.equal(captured[1]?.utt_start_ms, 3200);
});

test('a media frame with a garbage timestamp is logged, not silently zeroed', async () => {
  const lines: string[] = [];
  const bridge = makeBridge(new MockSttAdapter(), { logger: new Logger({ sink: (l) => lines.push(l) }) });
  await bridge.handleMessage(startFrame(['inbound']));
  await bridge.handleMessage(mediaFrame('inbound', 0, [0x00])); // legit first frame, no warn
  await bridge.handleMessage({
    event: 'media',
    sequenceNumber: '3',
    streamSid: 'MZ',
    media: { track: 'inbound', chunk: '2', timestamp: 'NaN', payload: mulawPayload([0x80]) },
  });
  await bridge.handleMessage(stopFrame);
  assert.ok(lines.some((l) => l.includes('media.timestamp.bad')), 'bad timestamp logged');
});

test('media on an unsupported encoding decodes nothing', async () => {
  const stt = new MockSttAdapter();
  const bridge = makeBridge(stt);

  await bridge.handleMessage(startFrame(['inbound'], 'audio/l16', 16000));
  await bridge.handleMessage(mediaFrame('inbound', 0, [0x00, 0x80]));
  await bridge.handleMessage(stopFrame);

  assert.equal(stt.received.length, 0, 'no audio decoded under an unsupported format');
  assert.equal(bridge.stats().chunks, 0);
});

test('malformed frames are skipped without throwing', async () => {
  const stt = new MockSttAdapter();
  const bridge = makeBridge(stt);

  await bridge.handleMessage('not json{');
  await bridge.handleMessage({ event: 'media' }); // missing media body
  await bridge.handleMessage({ event: 'bogus' });
  await bridge.handleMessage(startFrame(['inbound']));
  await bridge.handleMessage(mediaFrame('inbound', 0, [0xff]));
  await bridge.handleMessage(stopFrame);

  assert.equal(bridge.stats().chunks, 1, 'the one valid frame still produced a chunk');
});

test('the bridge logs the internal callId and never the Twilio CallSid', async () => {
  const lines: string[] = [];
  const bridge = makeBridge(new MockSttAdapter(), { logger: new Logger({ sink: (l) => lines.push(l) }) });
  await bridge.handleMessage(startFrame(['inbound']));
  await bridge.handleMessage(mediaFrame('inbound', 0, [0x00]));
  await bridge.handleMessage(stopFrame);

  const joined = lines.join('\n');
  assert.ok(joined.includes(CALL_ID), 'logs carry the internal call id');
  assert.ok(!joined.includes('CA-redacted'), 'logs never carry the Twilio CallSid');
});

test('SttWorkerAdapter converts chunk-relative binding offsets to stream-relative', async () => {
  const fake: SttBinding = {
    acceptAudio: () =>
      Promise.resolve([{ text: 'seg', t0Ms: 10, t1Ms: 40, isFinal: false }]),
    finish: () => Promise.resolve([{ text: 'tail', t0Ms: 5, t1Ms: 15, isFinal: true }]),
    free: () => {},
  };
  const adapter = new SttWorkerAdapter(fake);

  const r1 = await adapter.write({ pcm: new Float32Array(800), offsetMs: 1000 });
  assert.deepEqual(r1, [{ text: 'seg', startMs: 1010, endMs: 1040, isFinal: false }]);

  const r2 = await adapter.write({ pcm: new Float32Array(800), offsetMs: 2000 });
  assert.equal(r2[0]?.startMs, 2010);

  const rf = await adapter.flush();
  assert.deepEqual(rf, [{ text: 'tail', startMs: 2105, endMs: 2115, isFinal: true }]);
});

test('flush-mode adapter aggregates and emits one chunk at stop', async () => {
  const stt = new MockSttAdapter({ emitPerWrite: false, label: () => 'final-cp' });
  const captured: TranscriptChunk[] = [];
  const bridge = makeBridge(stt, { onChunk: (c) => captured.push(c) });

  await bridge.handleMessage(startFrame(['inbound']));
  await bridge.handleMessage(mediaFrame('inbound', 0, [0x00, 0x80]));
  await bridge.handleMessage(mediaFrame('inbound', 40, [0x00, 0x80]));
  assert.equal(bridge.stats().chunks, 0, 'nothing emitted mid-stream in flush mode');
  await bridge.handleMessage(stopFrame);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.text, 'final-cp');
  assert.equal(captured[0]?.speaker, 'customer');
});

// ── worker teardown: close() lifecycle ───────────────────────────────────────

class CountingStt extends MockSttAdapter {
  flushes = 0;
  closes = 0;
  override flush(): ReturnType<MockSttAdapter['flush']> {
    this.flushes++;
    return super.flush();
  }
  override close(): void {
    this.closes++;
    super.close();
  }
}

test('close() before any start frame frees the worker WITHOUT flushing (no idle spawn)', async () => {
  const stt = new CountingStt();
  const bridge = makeBridge(stt);

  await bridge.close();
  assert.equal(stt.flushes, 0, 'no flush on a never-started bridge');
  assert.equal(stt.closes, 1, 'worker released exactly once');
});

test('close() is idempotent across a stop frame — the worker is freed exactly once', async () => {
  const stt = new CountingStt();
  const bridge = makeBridge(stt);

  await bridge.handleMessage(startFrame(['inbound']));
  await bridge.handleMessage(stopFrame); // close() via the stop frame
  await bridge.close(); // explicit close() races a clean stop — must be a no-op
  await bridge.close(); // doubly idempotent
  assert.equal(stt.flushes, 1, 'flushed exactly once');
  assert.equal(stt.closes, 1, 'worker freed exactly once (no double free)');
});
