/**
 * Unit test for the live counterparty STT factory (bead: aunshin-phone-qid.8).
 *
 * The factory is thin composition glue, so this asserts the two properties that actually
 * matter and would silently regress otherwise:
 *   1. PER-CALL ISOLATION — each call gets a distinct adapter over a distinct binding (its
 *      own worker subprocess), so one call's audio can never reach another's worker
 *      (HARD compliance rule #1).
 *   2. LIVE ENGINE IS MOONSHINE — the wrapped binding is a {@link MoonshineWorkerBinding}, not
 *      the whisper.cpp batch binding. A regression here passes typecheck but blows the live
 *      cadence on Render (whisper is 3–9 s p90 there; ADR 0001 §Render-hardware confirmation).
 *
 * The end-to-end decode path (real Python worker → transcript) is covered by
 * moonshine-worker-binding.test.ts; this test needs no Python — every constructor is lazy
 * (the worker spawns only on the first acceptAudio), so bogus paths never spawn anything.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Logger } from '../log/index.js';
import { createLiveSttFactory, liveSttConfigFromEnv } from './live-stt-factory.js';
import { SttWorkerAdapter, type SttAdapter } from './stt-adapter.js';
import { MoonshineWorkerBinding } from './stt-worker-binding.js';

const CONFIG = {
  pythonPath: '/nonexistent/python',
  workerScript: '/nonexistent/stt_worker.py',
  logger: new Logger({ sink: () => {} }),
};

/** Reach the adapter's injected binding for a white-box engine assertion. */
function bindingOf(adapter: SttAdapter): unknown {
  return (adapter as unknown as { binding: unknown }).binding;
}

test('createLiveSttFactory returns a per-call adapter factory', () => {
  const factory = createLiveSttFactory(CONFIG);
  assert.equal(typeof factory, 'function');
  const adapter = factory('call-a');
  assert.ok(adapter instanceof SttWorkerAdapter, 'produces the engine-neutral worker adapter');
});

test('each call gets a distinct adapter + binding (per-user worker isolation)', () => {
  const factory = createLiveSttFactory(CONFIG);
  const a = factory('call-a');
  const b = factory('call-b');
  assert.notEqual(a, b, 'distinct adapters per call');
  assert.notEqual(bindingOf(a), bindingOf(b), 'distinct bindings → distinct worker subprocesses');
});

test('the live binding is moonshine, not the whisper.cpp batch engine', () => {
  const adapter = createLiveSttFactory(CONFIG)('call-a');
  assert.ok(
    bindingOf(adapter) instanceof MoonshineWorkerBinding,
    'LIVE tier must inject MoonshineWorkerBinding (Render cadence; ADR 0001)',
  );
});

test('constructing an adapter spawns no worker (paths are never touched until audio)', () => {
  // Bogus python/worker paths + no acceptAudio call ⇒ nothing spawns, nothing throws.
  assert.doesNotThrow(() => createLiveSttFactory(CONFIG)('call-a'));
});

// ── liveSttConfigFromEnv: the Render deploy seam (bead aunshin-phone-t9w) ──────

test('liveSttConfigFromEnv reads the required paths and optional numeric tuning', () => {
  const cfg = liveSttConfigFromEnv({
    NUCLEUS_STT_PYTHON: '/app/worker/.venv/bin/python',
    NUCLEUS_STT_WORKER: '/app/worker/stt_worker.py',
    NUCLEUS_STT_STEP_MS: '1250',
    NUCLEUS_STT_WINDOW_MS: '10000',
  });
  assert.equal(cfg.pythonPath, '/app/worker/.venv/bin/python');
  assert.equal(cfg.workerScript, '/app/worker/stt_worker.py');
  assert.equal(cfg.stepMs, 1250);
  assert.equal(cfg.windowMs, 10000);
});

test('liveSttConfigFromEnv throws (fail-fast) when a required path var is missing', () => {
  assert.throws(
    () => liveSttConfigFromEnv({ NUCLEUS_STT_PYTHON: '/x' }),
    /NUCLEUS_STT_WORKER/,
  );
});

test('liveSttConfigFromEnv ignores unset/garbage numeric vars (binding defaults win, not 0)', () => {
  const cfg = liveSttConfigFromEnv({
    NUCLEUS_STT_PYTHON: '/x',
    NUCLEUS_STT_WORKER: '/y',
    NUCLEUS_STT_STEP_MS: 'fast',
    NUCLEUS_STT_WINDOW_MS: '0',
  });
  assert.equal(cfg.stepMs, undefined, 'non-numeric step falls through to the binding default');
  assert.equal(cfg.windowMs, undefined, 'non-positive window falls through to the binding default');
});
