"""Engine contract for the bake-off.

Every adapter exposes the same two-phase shape so the harness can measure fairly:

  load()                    — pull/init the model. Runs ONCE, OUTSIDE the temp-file audit,
                              because first-use weight downloads legitimately write to
                              ~/.cache and we don't want them confused with audio spill.
  transcribe(audio16k)      — decode an in-memory float32 @16 kHz mono array to text. This
                              is the ONLY method the audit wraps. It must touch no disk.

`in_memory_api` documents *which* native entry point keeps audio in RAM — this string lands
in the ADR as the per-engine justification for security invariant #1.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np


#: 16 kHz feature frontend → 160 samples per centisecond (the unit `Segment.t0/t1` use).
SAMPLES_PER_CS_16K = 160


@dataclass(frozen=True)
class Segment:
    """One transcript segment with timing RELATIVE TO THE DECODED BUFFER START.

    `t0`/`t1` are in CENTISECONDS — whisper.cpp's native unit — so the production worker
    (stt_worker.py) can read `.text`/`.t0`/`.t1` off either a pywhispercpp segment or this
    dataclass with the same `* CS_TO_MS` math (it never converts twice). Engines whose model
    emits no word-level timing (Moonshine) return a SINGLE window-level Segment spanning the
    whole decoded buffer — see the default `STTEngine.transcribe_segments` below and ADR 0001
    §"moonshine native-streaming spike" for that timestamp contract.
    """
    text: str
    t0: float  # centiseconds from buffer start
    t1: float  # centiseconds from buffer start


class STTEngine(ABC):
    name: str
    #: Human-readable note on the in-memory decode path (goes into the ADR).
    in_memory_api: str
    #: Model identifier actually loaded (for the results table — keeps the comparison honest).
    model_id: str

    @abstractmethod
    def load(self) -> None:
        """Initialise / warm up the model. Called once before any audited transcribe()."""

    @abstractmethod
    def transcribe(self, audio16k: np.ndarray) -> str:
        """Decode a 16 kHz float32 mono array to text, in memory only."""

    def transcribe_segments(self, audio16k: np.ndarray) -> list[Segment]:
        """Streaming primitive the production worker (stt_worker.py) drives — the ONE method the
        engine-agnostic transport needs. Default: a single WINDOW-LEVEL segment spanning the whole
        decoded buffer (t0=0, t1=buffer length), because most engines (Moonshine, faster-whisper as
        wired here) expose no per-word timing. whisper.cpp OVERRIDES this with real per-segment
        timestamps. Empty text → no segment (a silent window emits nothing, not a 0-length blob).

        t1 is the buffer duration in centiseconds: `n_samples / SAMPLES_PER_CS_16K`. This is
        rate-independent of the 8 kHz→16 kHz resample upstream — `resample_poly(_, 2, 1)` yields
        exactly 2× the samples, so the centisecond value is the same whichever domain you count in.
        See ADR 0001 §"moonshine native-streaming spike" for why window-level timing is workable."""
        text = self.transcribe(audio16k)
        if not text:
            return []
        return [Segment(text=text, t0=0.0, t1=audio16k.shape[-1] / SAMPLES_PER_CS_16K)]
