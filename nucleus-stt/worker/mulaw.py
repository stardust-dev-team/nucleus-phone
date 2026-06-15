"""G.711 μ-law decode + resample — the in-memory front half of the production path.

Twilio Media Streams deliver the counterparty track as raw 8 kHz, 8-bit μ-law frames
(base64 over a WebSocket — see plan §Architecture, P2 media-bridge). Whisper-family models
want 16 kHz float32 mono. This module does that conversion entirely in RAM: bytes → int16
PCM → float32 → 16 kHz. No file, no /tmp — which is the whole point of security invariant #1.

`audioop.ulaw2lin` would have done the decode, but audioop was removed from the stdlib in
Python 3.13, so we build the (tiny, exact) G.711 lookup table ourselves. The table is pinned
by `test_mulaw.py` against hardcoded canonical anchor values (no audioop dependency), so the
decode stays correct when this module is ported into the P2 stt-service.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import resample_poly

TELEPHONY_RATE = 8_000   # what Twilio sends
MODEL_RATE = 16_000      # what Whisper/Moonshine expect


def _build_ulaw_table() -> np.ndarray:
    """256-entry LUT: μ-law byte → signed int16 PCM (standard ITU-T G.711)."""
    table = np.empty(256, dtype=np.int16)
    for byte in range(256):
        u = ~byte & 0xFF
        t = ((u & 0x0F) << 3) + 0x84
        t <<= (u & 0x70) >> 4
        # Sign per ITU-T G.711 (matches audioop.ulaw2lin / Sun g711.c exactly):
        # the sign bit set → negative branch.
        sample = (0x84 - t) if (u & 0x80) else (t - 0x84)
        table[byte] = sample
    return table


_ULAW_TABLE = _build_ulaw_table()


def ulaw_bytes_to_pcm16(mulaw: bytes) -> np.ndarray:
    """Raw μ-law bytes → int16 PCM, vectorized through the LUT. Pure in-memory."""
    return _ULAW_TABLE[np.frombuffer(mulaw, dtype=np.uint8)]


def resample_8k_to_16k(pcm8k: np.ndarray) -> np.ndarray:
    """8 kHz Float32 → 16 kHz Float32, in RAM. The binding-side step that bridges the
    8 kHz `SttChunk` contract to whisper's 16 kHz input (ADR 0001 §Production-shape).

    up=2/down=1 is an exact integer ratio, so `resample_poly` is precise and cheap and
    preserves time (a segment's timestamp is unchanged by the rate change). Defined ONCE
    here so the validation harness (`stream_validate.transcribe_window`) and the production
    worker (`stt_worker.py`) resample the *identical* way — the ADR's "same signal the live
    system sees" guarantee depends on there being no second copy of this to drift from."""
    return np.ascontiguousarray(
        resample_poly(pcm8k, MODEL_RATE, TELEPHONY_RATE), dtype=np.float32
    )


def ulaw_to_model_input(mulaw: bytes) -> np.ndarray:
    """Twilio frame bytes → float32 mono @16 kHz, ~[-1, 1], ready for any engine.

    This is the exact transform the production stt-service adapter must perform on each
    Media Streams frame. Keeping it identical here means the bake-off measures WER on the
    *same* signal the live system will see, codec degradation included.

    Range is approximately [-1, 1] but is explicitly NOT a hard bound: polyphase resampling
    rings and overshoots on full-scale content. Typical speech stays near ±1.1, but pathological
    full-scale patterns (e.g. a period-3 ``[0x00, 0x80, 0x00]`` train) ring to ≈1.75 — a ~75%
    overshoot. Whisper-family models tolerate >1.0 floats, so we deliberately don't clamp
    (hard-clipping would add harmonic distortion). Any downstream consumer in P2 that needs a
    strict bound MUST clamp at its own boundary (and size buffers for ≥1.75, not 1.0) — do not
    assume a bound here.
    """
    pcm16 = ulaw_bytes_to_pcm16(mulaw)
    audio = pcm16.astype(np.float32) / 32768.0
    # 8k → 16k: integer ratio, so resample_poly(up=2, down=1) is exact and cheap.
    return resample_poly(audio, MODEL_RATE, TELEPHONY_RATE).astype(np.float32)
