/**
 * Integration test for the real Node↔Python MOONSHINE worker (bead: aunshin-phone-qid.15).
 *
 * The live-tier sibling of whisper-cpp-worker-binding.test.ts: it spawns the actual
 * `stt_worker.py --engine moonshine`, feeds a recorded telephony μ-law fixture frame-by-frame
 * (the exact 20 ms Twilio cadence) through {@link MoonshineWorkerBinding} wrapped in the
 * engine-neutral {@link SttWorkerAdapter}, and asserts a plausible transcript with correct
 * STREAM-RELATIVE offsets falls out of `flush()`. This is the path qid.8 injects as the LIVE
 * counterparty STT adapter (ADR 0001 §Render-hardware confirmation).
 *
 * Unlike whisper, moonshine emits ONE window-level segment per decode (no word timing — see
 * the timestamp contract in MoonshineEngine / stt_worker.py), so the assertions check the
 * window-span offsets, not per-word timing.
 *
 * ENV-GATED, like the whisper integration test: auto-SKIPS unless the local prerequisites
 * exist — the stt-bakeoff venv, stt_worker.py, a μ-law fixture, and the moonshine ONNX weights
 * in the HF cache (skipping rather than triggering a ~190 MB download in CI). It runs under the
 * default `npm test` glob and no-ops when the engine isn't installed.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decodeMulawToFloat32 } from '../audio/mulaw.js';
import { Logger } from '../log/index.js';
import { SttWorkerAdapter } from './stt-adapter.js';
import { MoonshineWorkerBinding } from './stt-worker-binding.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAKEOFF = join(REPO_ROOT, 'scripts', 'stt-bakeoff');
const PYTHON = join(BAKEOFF, '.venv', 'bin', 'python');
const WORKER = join(BAKEOFF, 'stt_worker.py');
// 3.27 s clip — shorter than the 10 s window, so the final hypothesis covers the WHOLE
// utterance (no window-clipping) and offsets/text are cleanly assertable.
const FIXTURE = join(BAKEOFF, 'fixtures', 'telephony', '1089-134686-0001.ulaw');
const EXPECT_WORD = 'belly'; // from "STUFF IT INTO YOU HIS BELLY COUNSELLED HIM"

const FRAME_MS = 20;
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160 samples/frame
const STEP_MS = 1250; // the Render-confirmed live cadence (bead jch / ADR 0001)

/** True iff the moonshine base ONNX weights are in the HF cache (so the test won't download). */
function moonshineModelPresent(): boolean {
  const root = join(homedir(), '.cache', 'huggingface', 'hub', 'models--UsefulSensors--moonshine');
  if (!existsSync(root)) return false;
  // Bounded recursive search for encoder_model.onnx under the snapshot dir.
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (name === 'encoder_model.onnx') return true;
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        /* race / dangling symlink — skip */
      }
      if (isDir) stack.push(p);
    }
  }
  return false;
}

function skipReason(): string | false {
  if (!existsSync(PYTHON)) return `stt-bakeoff venv absent (${PYTHON})`;
  if (!existsSync(WORKER)) return `worker script absent (${WORKER})`;
  if (!existsSync(FIXTURE)) return `μ-law fixture absent (${FIXTURE})`;
  if (!moonshineModelPresent()) return 'moonshine base ONNX weights not downloaded';
  return false;
}

test(
  'real moonshine worker transcribes a μ-law fixture with stream-relative offsets',
  { skip: skipReason(), timeout: 60_000 },
  async () => {
    const mulaw = readFileSync(FIXTURE);
    const pcm = decodeMulawToFloat32(mulaw); // 8 kHz Float32, whole clip
    const audioDurationMs = (pcm.length / SAMPLE_RATE) * 1000;

    const binding = new MoonshineWorkerBinding({
      pythonPath: PYTHON,
      workerScript: WORKER,
      stepMs: STEP_MS,
      logger: new Logger({ sink: () => {} }),
    });
    const adapter = new SttWorkerAdapter(binding);

    const partials: string[] = [];
    try {
      // Feed 20 ms frames at their true stream-time offsets, exactly as the media-bridge would.
      for (let i = 0; i * FRAME_SAMPLES < pcm.length; i++) {
        const frame = pcm.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES);
        const results = await adapter.write({ pcm: frame, offsetMs: i * FRAME_MS });
        for (const r of results) {
          assert.equal(r.isFinal, false, 'write() yields only interim partials');
          if (r.text) partials.push(r.text);
        }
      }

      const finals = await adapter.flush();
      const finalText = finals.map((r) => r.text).join(' ').toLowerCase();

      assert.ok(finals.length > 0, 'flush() produces a final hypothesis');
      // Moonshine emits a single window-level segment for the end-of-turn finalize.
      assert.equal(finals.length, 1, 'moonshine finalize is one window-level segment');
      assert.ok(
        finalText.includes(EXPECT_WORD),
        `final transcript should contain "${EXPECT_WORD}"; got: ${finalText}`,
      );
      assert.ok(partials.length > 0, 'sliding-window partials were emitted during the call');

      for (const r of finals) {
        assert.equal(r.isFinal, true, 'flush() segments are final');
        assert.ok(r.startMs <= r.endMs, 'segment start precedes end');
        // Stream-relative: the window-level span sits inside [0, audioDuration] (+epsilon for
        // resample/centisecond rounding). A binding that forgot to re-anchor the chunk-relative
        // offsets would land these wildly outside the clip.
        assert.ok(r.startMs >= -FRAME_MS, `start in range: ${r.startMs}`);
        assert.ok(r.endMs <= audioDurationMs + FRAME_MS, `end in range: ${r.endMs} <= ${audioDurationMs}`);
      }
    } finally {
      await adapter.close();
    }
  },
);
