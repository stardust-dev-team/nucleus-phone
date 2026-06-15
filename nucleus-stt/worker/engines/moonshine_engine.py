"""Moonshine adapter (UsefulSensors, ONNX Runtime backend).

In-memory path: `MoonshineOnnxModel.generate(array)` takes the float32 audio tensor straight.
We deliberately bypass the `transcribe()` convenience wrapper — when handed a *path* that
wrapper calls librosa.load (a file read), but when handed an array it's a passthrough. Calling
generate() directly makes the in-memory contract explicit and unconditional.

Moonshine is purpose-built for short, low-latency utterances (its pitch vs. Whisper), which
matches the coaching use case: we transcribe a counterparty turn, not an hour-long file. This
is the LIVE counterparty engine (ADR 0001 §Render-hardware confirmation — the GPU-less x86 gate
reversed whisper.cpp → moonshine for live: moonshine holds ~0.7 s p90 at step 1250 ms where
whisper.cpp is 3–9 s).

═══ No native streaming in the pinned package (bead aunshin-phone-qid.15 spike) ═══
The qid.15 spike confirmed `useful-moonshine-onnx==20251121` exposes NO incremental/streaming
encoder: `generate()` runs `encoder.run()` over the WHOLE audio array in one shot (model.py)
and the only cross-step cache (`past_key_values`) is the decoder's within-call autoregressive
cache, reset every call. A real streaming encoder exists only in Moonshine *v2* (arXiv
2602.12241, Feb 2026), which POST-DATES this pin and is a different model distribution. So the
live worker ships the PROVEN re-decode fallback (re-decode the trailing window each step;
ADR 0001 §Render-hardware confirmation — ~700 ms p90, +549 ms headroom at step 1250 / window
10 s). Moonshine v2's native encoder is the future optimization (see FOLLOWUPS.md / its bead).

═══ Timestamp contract (qid.15) ═══
Moonshine's decoder emits tokens with NO word/segment time alignment (unlike whisper.cpp's
`transcribe_segments()`, whose t0/t1 are real). So this engine uses the BASE
`STTEngine.transcribe_segments` default — ONE Segment spanning the ENTIRE decoded buffer
(t0 = 0, t1 = buffer length); it does NOT override it. The production worker (stt_worker.py)
anchors that span to stream time the same way it does for whisper — yielding WINDOW-LEVEL timing
(the partial covers "what was said in this ~10 s trailing window"), NOT word-level. That is
coarse but workable: qid.11 merges counterparty utterances within a ~1.5 s reorder window and
partials are emitted at the 1250 ms cadence, finer than that tolerance. Word-level timing would
require Moonshine v2's encoder or a VAD-gated finalize (ADR 0001 carry-forward #2) — both out of
scope for the fallback.

NOTE on the window length lever (moonshine-specific): unlike whisper (flat 30 s mel pad →
decode cost is constant in window length), Moonshine's compute SCALES with audio length. So a
SHORTER window is a real lever for moonshine — it both decodes faster (more cadence headroom)
AND tightens the window-level timestamp span. The decision-of-record default is window 10 s
(Tom's call, jch); shortening it is a documented future tuning knob, not done here.
"""

from __future__ import annotations

import numpy as np

from .base import STTEngine

MODEL = "moonshine/base"


class MoonshineEngine(STTEngine):
    name = "moonshine"
    in_memory_api = "MoonshineOnnxModel.generate(np.ndarray) — ONNX runs on the in-RAM tensor"
    model_id = "moonshine/base (onnx)"

    def load(self) -> None:
        from moonshine_onnx import MoonshineOnnxModel, load_tokenizer

        self._model = MoonshineOnnxModel(model_name=MODEL)
        self._tokenizer = load_tokenizer()

    def transcribe(self, audio16k: np.ndarray) -> str:
        # generate() wants a batch dim: (1, n_samples).
        tokens = self._model.generate(audio16k[None, ...])
        return self._tokenizer.decode_batch(tokens)[0].strip()

    # transcribe_segments() is intentionally NOT overridden — the base window-level default is
    # exactly Moonshine's contract (one segment spanning the buffer; no word timing). See the
    # module docstring's "Timestamp contract" section.
