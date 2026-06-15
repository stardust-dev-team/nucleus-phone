/**
 * Integration test for the real Node↔Python whisper.cpp worker (bead: aunshin-phone-9yh).
 *
 * This is the ONE test that exercises the true TS ↔ stdio ↔ Python ↔ whisper.cpp path:
 * it spawns the actual worker, feeds a recorded telephony μ-law fixture frame-by-frame
 * (the exact 20 ms Twilio cadence) through {@link WhisperCppWorkerBinding} wrapped in the
 * production {@link SttWorkerAdapter}, and asserts a plausible transcript with correct
 * STREAM-RELATIVE offsets falls out of `flush()`.
 *
 * ENV-GATED, like `test:pg`: it auto-SKIPS unless the local prerequisites exist — the
 * stt-bakeoff venv interpreter, stt_worker.py, a μ-law fixture, and the base.en model
 * (skipping rather than triggering a ~147 MB model download in CI). It still runs under
 * the default `npm test` glob; it just no-ops when the engine isn't installed. To run it,
 * set up scripts/stt-bakeoff (see that dir's README) so the venv + model are present.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decodeMulawToFloat32 } from '../audio/mulaw.js';
import { Logger } from '../log/index.js';
import { SttWorkerAdapter } from './stt-adapter.js';
import { WhisperCppWorkerBinding } from './stt-worker-binding.js';

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

/** base.en GGML model location across pywhispercpp's platform dirs (mac / XDG). */
function modelPresent(): boolean {
  const name = 'ggml-base.en.bin';
  return [
    join(homedir(), 'Library', 'Application Support', 'pywhispercpp', 'models', name),
    join(homedir(), '.local', 'share', 'pywhispercpp', 'models', name),
  ].some(existsSync);
}

function skipReason(): string | false {
  if (!existsSync(PYTHON)) return `stt-bakeoff venv absent (${PYTHON})`;
  if (!existsSync(WORKER)) return `worker script absent (${WORKER})`;
  if (!existsSync(FIXTURE)) return `μ-law fixture absent (${FIXTURE})`;
  if (!modelPresent()) return 'whisper base.en model not downloaded';
  return false;
}

test(
  'real worker transcribes a μ-law fixture with stream-relative offsets',
  { skip: skipReason(), timeout: 60_000 },
  async () => {
    const mulaw = readFileSync(FIXTURE);
    const pcm = decodeMulawToFloat32(mulaw); // 8 kHz Float32, whole clip
    const audioDurationMs = (pcm.length / SAMPLE_RATE) * 1000;

    const binding = new WhisperCppWorkerBinding({
      pythonPath: PYTHON,
      workerScript: WORKER,
      stepMs: 500,
      logger: new Logger({ sink: () => {} }),
    });
    const adapter = new SttWorkerAdapter(binding);

    const partials: string[] = [];
    try {
      // Feed 20 ms frames at their true stream-time offsets, exactly as the media-bridge
      // would from Twilio media frames.
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
      assert.ok(
        finalText.includes(EXPECT_WORD),
        `final transcript should contain "${EXPECT_WORD}"; got: ${finalText}`,
      );
      assert.ok(partials.length > 0, 'sliding-window partials were emitted during the call');

      for (const r of finals) {
        assert.equal(r.isFinal, true, 'flush() segments are final');
        assert.ok(r.startMs <= r.endMs, 'segment start precedes end');
        // Stream-relative: the whole utterance sits inside [0, audioDuration] (+epsilon for
        // whisper's centisecond rounding). A binding that forgot to re-anchor chunk-relative
        // offsets would land these wildly outside the clip.
        assert.ok(r.startMs >= -FRAME_MS, `start in range: ${r.startMs}`);
        assert.ok(r.endMs <= audioDurationMs + FRAME_MS, `end in range: ${r.endMs} <= ${audioDurationMs}`);
      }
    } finally {
      await adapter.close();
    }
  },
);
