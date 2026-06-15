"""whisper.cpp adapter (via pywhispercpp bindings).

In-memory path: `Model.transcribe(np.ndarray)` hands the float buffer to whisper.cpp's
`whisper_full()` C call — no file. IMPORTANT distinction for the ADR: the *whisper-cli
binary* (the other common way to use whisper.cpp) takes a WAV path and would force a temp
spill → disqualified. The Python binding does NOT; it's the integration choice that decides
compliance, not "whisper.cpp" as a brand. We use, and validate, the binding path only.
"""

from __future__ import annotations

import os

import numpy as np

from .base import STTEngine

# base.en is the validated default (ADR 0001). AUNSHIN_WHISPER_MODEL lets the Render-cadence
# gate (bead aunshin-phone-jch) sweep a smaller rung (tiny.en) WITHOUT a code edit if base.en
# can't hold the coaching cadence on GPU-less x86 CPU. Production code does NOT read this —
# it's a bake-off knob only; the shipped default lives in WhisperCppWorkerOptions / stt_worker.py.
MODEL = os.environ.get("AUNSHIN_WHISPER_MODEL", "base.en")


class WhisperCppEngine(STTEngine):
    name = "whisper.cpp"
    in_memory_api = "pywhispercpp Model.transcribe(np.ndarray) → whisper_full() on the buffer"
    model_id = f"whisper.cpp {MODEL}"

    def load(self) -> None:
        from pywhispercpp.model import Model

        # use_gpu=False forces CPU. CRITICAL for a fair bake-off: production is GPU-less Render
        # (Linux CPU). On a Mac, whisper.cpp would otherwise grab the Metal GPU and report a
        # latency we can't reproduce in prod, inflating its ranking. CPU keeps it apples-to-apples
        # with faster-whisper (CT2 int8 CPU) and moonshine (onnxruntime CPU). context_params is a
        # plain dict in pywhispercpp 1.5.
        self._model = Model(MODEL, context_params={"use_gpu": False},
                            print_progress=False, print_realtime=False, print_timestamps=False)

    def transcribe_segments(self, audio16k: np.ndarray):
        """Decode to whisper.cpp segments (each `.text`, `.t0`, `.t1` in CENTISECONDS
        relative to the buffer start). The production worker (stt_worker.py, bead 9yh)
        needs the per-segment timestamps for stream-relative offsets, so this is the
        primitive; `transcribe()` is the text-only convenience over it for the bake-off.
        Kept here so the validated model config (use_gpu=False etc.) lives in ONE place."""
        # whisper.cpp wants contiguous float32; the resample already gives float32 but
        # ensure contiguity for the C buffer hand-off.
        audio = np.ascontiguousarray(audio16k, dtype=np.float32)
        return self._model.transcribe(audio)

    def transcribe(self, audio16k: np.ndarray) -> str:
        return " ".join(seg.text.strip() for seg in self.transcribe_segments(audio16k)).strip()
