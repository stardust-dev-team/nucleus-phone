/**
 * Resilience tests for {@link WhisperCppWorkerBinding} (bead: aunshin-phone-9yh).
 *
 * These DON'T need Python/whisper/the model — they drive the binding against a tiny
 * protocol-compatible stub worker that runs on `node` (`__fixtures__/fake-stt-worker.mjs`),
 * so they ALWAYS run (unlike the env-gated real-worker integration test). They lock down
 * the parts most likely to break a live call: ready-gating, FIFO response matching under
 * non-awaited concurrent calls, and crash → empty-resolve → transparent respawn (the bead's
 * "one bad frame / dead worker can't tear down the call" requirement).
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger } from '../log/index.js';
import { WhisperCppWorkerBinding } from './stt-worker-binding.js';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-stt-worker.mjs');

// Track every binding so a FAILED assertion can't leave a spawned worker alive — a lingering
// child keeps the event loop open and the whole file would time out, masking the real failure.
const live: WhisperCppWorkerBinding[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((b) => b.free()));
});

/** A binding wired to the node stub instead of the real Python worker. */
function makeBinding(
  maxRestarts = 5,
  extra: Partial<ConstructorParameters<typeof WhisperCppWorkerBinding>[0]> = {},
): WhisperCppWorkerBinding {
  const b = new WhisperCppWorkerBinding({
    pythonPath: process.execPath, // run the stub on this node
    workerScript: STUB,
    maxRestarts,
    logger: new Logger({ sink: () => {} }),
    ...extra,
  });
  live.push(b);
  return b;
}

const frame = (samples = 4) => new Float32Array(samples); // silent frame (no sentinel)
const crashFrame = () => Float32Array.from([666]); // stub exit(1)s on this
const desyncFrame = () => Float32Array.from([777]); // stub replies with a WRONG seq
const stallFrame = () => Float32Array.from([555]); // stub wedges: consumes AUDIO, never replies

/** A still-pending promise resolves to this sentinel when raced against a short timer. */
const PENDING = Symbol('pending');
function settledOrPending<T>(p: Promise<T>, ms = 50): Promise<T | typeof PENDING> {
  return Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);
}

test('happy path: spawns on first call, returns interim segments, finalizes on finish', async () => {
  const b = makeBinding();
  const r1 = await b.acceptAudio(frame());
  assert.deepEqual(r1, [{ text: 'frame', t0Ms: 0, t1Ms: 20, isFinal: false }]);

  const fin = await b.finish();
  assert.deepEqual(fin, [{ text: 'final', t0Ms: -10, t1Ms: 0, isFinal: true }]);
  await b.free();
});

test('serializes concurrent (non-awaited) calls in FIFO order', async () => {
  // The bridge fires handleMessage without awaiting, so acceptAudio calls overlap. The
  // binding must not interleave frames on the pipe nor mismatch responses.
  const b = makeBinding();
  const pending = [b.acceptAudio(frame()), b.acceptAudio(frame()), b.acceptAudio(frame())];
  const results = await Promise.all(pending);
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.deepEqual(r, [{ text: 'frame', t0Ms: 0, t1Ms: 20, isFinal: false }]);
  }
  await b.free();
});

test('worker crash resolves the in-flight frame empty, then respawns transparently', async () => {
  const b = makeBinding();
  await b.acceptAudio(frame()); // spawn + prove it works

  // This frame crashes the worker. It must resolve to [] (a lost frame), NOT reject/hang.
  const crashed = await b.acceptAudio(crashFrame());
  assert.deepEqual(crashed, [], 'crash frame yields no segments, no throw');

  // The very next frame must transparently respawn a fresh worker and succeed again.
  const recovered = await b.acceptAudio(frame());
  assert.deepEqual(recovered, [{ text: 'frame', t0Ms: 0, t1Ms: 20, isFinal: false }]);
  await b.free();
});

test('a seq-mismatch (protocol desync) tears the worker down and recovers, never mis-maps', async () => {
  const b = makeBinding();
  await b.acceptAudio(frame()); // spawn + prove healthy

  // The worker replies to this with the WRONG seq. The binding must NOT resolve it with the
  // mismatched response (that would mis-attribute offsets); it tears the worker down →
  // the request resolves empty.
  const desynced = await b.acceptAudio(desyncFrame());
  assert.deepEqual(desynced, [], 'desynced request yields no segments, no mis-mapped response');

  // A fresh worker is spawned for the next frame and the protocol is healthy again.
  const recovered = await b.acceptAudio(frame());
  assert.deepEqual(recovered, [{ text: 'frame', t0Ms: 0, t1Ms: 20, isFinal: false }]);
  await b.free();
});

test('gives up after maxRestarts, then stays in degraded (empty) mode without throwing', async () => {
  const b = makeBinding(1); // allow only 1 restart
  await b.acceptAudio(frame());
  // Crash repeatedly past the restart budget.
  for (let i = 0; i < 4; i++) {
    const r = await b.acceptAudio(crashFrame());
    assert.deepEqual(r, [], `crash ${i} stays empty, never throws`);
  }
  // Still callable; just permanently empty (qid.12 surfaces audio-in/no-text-out).
  const r = await b.acceptAudio(frame());
  assert.deepEqual(r, []);
  await b.free();
});

test('backpressure: past the ceiling, drops the OLDEST un-sent AUDIO frame (resolves []), keeps the newest', async () => {
  // maxInFlight=2: at most 2 frames dispatched + 2 more held un-sent before drop-oldest fires.
  const b = makeBinding(5, { maxInFlight: 2 });
  await b.acceptAudio(frame()); // spawn + prove healthy

  // Wedge the worker so nothing drains: these two fill the in-flight ceiling and never reply.
  const inflight1 = b.acceptAudio(stallFrame());
  const inflight2 = b.acceptAudio(frame());

  // Now the worker is stuck. Further frames land in the un-sent backlog (cap 2). The 3rd
  // backlog frame pushes past the ceiling and must evict the OLDEST backlog AUDIO frame.
  const oldest = b.acceptAudio(frame()); // queued[0] — the drop target
  const mid = b.acceptAudio(frame()); // queued[1]
  const newest = b.acceptAudio(frame()); // overflow → drops `oldest`

  assert.deepEqual(await oldest, [], 'oldest un-sent frame is dropped → resolves empty');

  // The newest frame is preserved (still pending behind the wedged worker), not dropped.
  assert.equal(await settledOrPending(newest), PENDING, 'freshest audio is kept, never dropped');
  assert.equal(await settledOrPending(mid), PENDING, 'mid frame still buffered, not dropped');
  // The dispatched (already-sent) frames are untouched — dropping them would desync the FIFO.
  assert.equal(await settledOrPending(inflight1), PENDING, 'dispatched frame is never dropped');
  assert.equal(await settledOrPending(inflight2), PENDING, 'dispatched frame is never dropped');

  await b.free(); // drains the wedged frames empty
});

test('backpressure: a FINISH frame is NEVER dropped, only AUDIO is evicted', async () => {
  const b = makeBinding(5, { maxInFlight: 2 });
  await b.acceptAudio(frame()); // spawn + prove healthy

  // Wedge the worker (fill the 2 in-flight slots).
  b.acceptAudio(stallFrame());
  b.acceptAudio(frame());

  // Backlog, oldest-first: [FINISH, audioA]. Both fit under the cap of 2.
  const finish = b.finish();
  const audioA = b.acceptAudio(frame());
  // Each further AUDIO frame overflows and must evict the oldest *AUDIO* (skipping FINISH).
  const audioB = b.acceptAudio(frame()); // evicts audioA (FINISH is skipped)
  const audioC = b.acceptAudio(frame()); // evicts audioB

  assert.deepEqual(await audioA, [], 'oldest AUDIO evicted, not the older FINISH');
  assert.deepEqual(await audioB, [], 'next-oldest AUDIO evicted');
  // FINISH survived every eviction even though it was the oldest backlog entry.
  assert.equal(await settledOrPending(finish), PENDING, 'FINISH is never dropped');
  assert.equal(await settledOrPending(audioC), PENDING, 'freshest AUDIO retained');

  await b.free();
});

test('backpressure: emits a PII-safe drop metric (event + cumulative count, no transcript)', async () => {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new Logger({ sink: (line) => lines.push(JSON.parse(line)) });
  const b = makeBinding(5, { maxInFlight: 2, logger });
  await b.acceptAudio(frame()); // spawn + prove healthy

  // Wedge (fills the 2 in-flight slots), then push 5 backlog frames against the cap of 2. The
  // backlog holds the 2 newest; the 3 oldest are evicted oldest-first → exactly 3 drops.
  b.acceptAudio(stallFrame());
  b.acceptAudio(frame());
  const drops = [b.acceptAudio(frame()), b.acceptAudio(frame()), b.acceptAudio(frame())];
  b.acceptAudio(frame()); // backlog overflows → evicts drops[1] (drops[0] already gone above)
  b.acceptAudio(frame()); // evicts drops[2]
  await Promise.all(drops); // all three oldest frames resolve []

  const dropLines = lines.filter((l) => l.event === 'stt.worker.backpressure_drop');
  assert.equal(dropLines.length, 3, 'one log line per dropped frame');
  // Cumulative count climbs 1→2→3 (mirrors the existing restart-count convention).
  assert.deepEqual(
    dropLines.map((l) => l.count),
    [1, 2, 3],
    'count is the cumulative drop tally',
  );
  for (const l of dropLines) {
    assert.equal(l.code, 'queue_full');
    // PII-safe: only the allowlisted operational fields, never any text/transcript payload.
    assert.deepEqual(Object.keys(l).sort(), ['code', 'count', 'event', 'level', 'ts']);
  }

  await b.free();
});

test('backpressure: an all-FINISH backlog coalesces to one, and that one FINISH still flushes', async () => {
  // bead aunshin-phone-sau: a caller that re-fires finish() against a busy worker must not grow
  // the queue without bound. maxInFlight=1 so a single in-flight AUDIO frame forces the FINISH
  // frames into the un-sent backlog, where coalesce keeps only the newest.
  const lines: Array<Record<string, unknown>> = [];
  const logger = new Logger({ sink: (line) => lines.push(JSON.parse(line)) });
  const b = makeBinding(5, { maxInFlight: 1, logger });
  await b.acceptAudio(frame()); // spawn + prove healthy; in-flight drained

  // SYNCHRONOUS burst — no awaits between calls, so the worker's stdout replies aren't processed
  // mid-burst: the AUDIO frame holds the only in-flight slot while the FINISH frames pile up.
  const audio = b.acceptAudio(frame()); // dispatched → fills the single in-flight slot
  const finish1 = b.finish(); // queued[0]
  const finish2 = b.finish(); // queued len 2 > 1, all-FINISH → coalesce: supersedes finish1
  const finish3 = b.finish(); // coalesce again → supersedes finish2; finish3 is the survivor

  assert.deepEqual(await finish1, [], 'an older FINISH is superseded → resolves empty');
  assert.deepEqual(await finish2, [], 'the next FINISH is superseded too');
  // The AUDIO reply frees the in-flight slot → the surviving FINISH dispatches and FLUSHES.
  assert.deepEqual(await audio, [{ text: 'frame', t0Ms: 0, t1Ms: 20, isFinal: false }]);
  assert.deepEqual(
    await finish3,
    [{ text: 'final', t0Ms: -10, t1Ms: 0, isFinal: true }],
    'the surviving FINISH still produces the final flush — the finalize is never lost',
  );

  // The coalesced frames are logged PII-safe with a distinct code (not a transcript byte in sight).
  const coalesced = lines.filter((l) => l.code === 'finish_coalesced');
  assert.equal(coalesced.length, 2, 'two superseded FINISH frames, two coalesce log lines');
  for (const l of coalesced) {
    assert.equal(l.event, 'stt.worker.backpressure_drop');
    assert.deepEqual(Object.keys(l).sort(), ['code', 'count', 'event', 'level', 'ts']);
  }

  await b.free();
});

test('free() is safe before any frame and idempotent', async () => {
  const b = makeBinding();
  await b.free(); // never spawned
  await b.free(); // idempotent
  // After free, calls resolve empty (closed).
  assert.deepEqual(await b.acceptAudio(frame()), []);
});
