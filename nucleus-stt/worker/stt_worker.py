#!/usr/bin/env python
"""Production streaming-STT worker — engine-agnostic (beads aunshin-phone-9yh + qid.15).

The Node media-bridge (qid.8) spawns ONE long-lived instance of this per call and drives
it over stdio. It runs the sliding-window streamer validated in stream_validate.py (bead
1wk / ADR 0001 §Streaming-mode validation) as a real worker: 8 kHz Float32 frames in,
JSON transcript segments out.

═══ Two engines, ONE transport (`--engine`) ═══
The transport below (StreamingWorker + the framing/serve loop) is ENGINE-NEUTRAL: it only
needs `engine.transcribe_segments(audio16k) -> [obj with .text/.t0/.t1 in centiseconds]`.
  --engine whisper.cpp  (DEFAULT)  BATCH / post-call engine (qid.13). Best one-shot WER
                                   (5.9 %); latency irrelevant for the one-shot path.
  --engine moonshine               LIVE counterparty engine (qid.15). The ONLY engine that
                                   sustains the live cadence on GPU-less x86 Render
                                   (~0.7 s p90 at step 1250 ms; whisper.cpp is 3–9 s there).
The default is whisper.cpp so the existing 9yh batch binding — which spawns this worker with
no --engine — is unchanged. The live moonshine binding passes `--engine moonshine`.

WHY the Render-hardware gate (bead jch, ADR 0001 §Render-hardware confirmation) REVERSED the
ee2 Apple-Silicon pick: on GPU-less x86 whisper.cpp's full-window decode is 3–9 s p90 (never
keeps a live cadence) while moonshine — driven through this SAME re-decode loop — holds
~0.7 s. moonshine's compute scales with audio length (no whisper-style 30 s mel pad), so
re-decoding a short trailing window is cheap. moonshine has NO native streaming encoder in the
pinned `useful-moonshine-onnx==20251121` (qid.15 spike), so it ships the proven re-decode path
here — identical to whisper's strategy, different engine.

Why a subprocess (not an in-process Node addon): it reuses the ADR-validated
in-RAM-buffer decode path verbatim (whisper's `whisper_full()` / moonshine's `generate()` on a
numpy array — the no-tempfile audit only ever covered THOSE array paths), and the process
boundary is the natural place to enforce security invariant #1 at the OS level — a read-only
/tmp / seccomp / Landlock jail the Node process could never get (bead 9gt / deploy bead t9w).
The IPC adds ~zero latency; the model decode dominates.

═══ stdio protocol ═══
Requests (Node → worker, on stdin, binary, FIFO — the binding serializes so frames never
interleave):  [1 byte opcode][4 bytes BE uint32 seq][4 bytes BE uint32 payload length][payload]
  0x01 AUDIO  — payload = little-endian Float32 PCM, 8 kHz mono (one `SttChunk.pcm`).
                Appended to the rolling window. A decode fires only once `step_ms` of new
                audio has arrived; otherwise the buffering is acknowledged with no segments.
  0x02 FINISH — payload empty. Decode the trailing window once more as the end-of-turn
                FINAL hypothesis. This is the only request that yields final=true.
  0x03 CLOSE  — payload empty. Free the model and exit.
The `seq` is echoed back in the response so the binding can DETECT a desync (a stray/lost
line) instead of silently mis-attributing transcript offsets to the wrong request — which,
for counterparty health-related transcript, is a compliance problem, not just a glitch.

Responses (worker → Node, on stdout, one JSON line — `\n`-terminated — per request, in
order):
  {"type":"ready"}                                  once, after the model loads (no seq)
  {"type":"segments","seq":N,"final":bool,           one per AUDIO/FINISH request
      "segments":[{"text":str,"t0Ms":float,"t1Ms":float}]}   (segments may be [] when buffering)
  {"type":"error","seq":N,"message":str}            a per-request decode failure (segments
                                                    treated as empty; worker stays alive)

Offsets are CHUNK-RELATIVE, honoring src/media-bridge/stt-adapter.ts's WhisperCppBinding
contract: t0Ms/t1Ms are measured from the start of THE BUFFER THIS REQUEST CONTRIBUTED
(the AUDIO chunk; for FINISH, from the current end-of-stream cursor). The TS adapter — the
only side that knows each chunk's true stream position — adds that position back. Anchoring
per-request like this keeps the merge clock domain correct even if the worker's own
elapsed-audio count drifts from Twilio's stream timestamps (e.g. a dropped frame). See the
adapter's CONTRACT comment.

Invariant #1 (HARD): every decode runs on an in-RAM Float32 buffer — whisper's `whisper_full()`
or moonshine's `MoonshineOnnxModel.generate()` on a numpy array — never a CLI binary that needs
a WAV path (= temp spill). This module imports no temp or file-write API; the only disk read is
the model load at startup.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys

import numpy as np

from engines.base import STTEngine
from engines.moonshine_engine import MoonshineEngine
from engines.whisper_cpp_engine import WhisperCppEngine
from mulaw import TELEPHONY_RATE, resample_8k_to_16k

# Engine registry for --engine. whisper.cpp = batch (qid.13); moonshine = live (qid.15).
# The eval-only moonshine-v2 / faster-whisper engines are NOT shipped in
# nucleus-stt (nucleus-phone-rgja.4 copy-fork) — bake-off code stayed in
# aunshin-phone.
ENGINES = {
    "whisper.cpp": WhisperCppEngine,
    "moonshine": MoonshineEngine,
}

SAMPLES_PER_MS = TELEPHONY_RATE // 1000   # 8 samples per ms at 8 kHz
CS_TO_MS = 10.0                            # whisper t0/t1 are centiseconds

OP_AUDIO = 0x01
OP_FINISH = 0x02
OP_CLOSE = 0x03
HEADER = struct.Struct(">BII")             # opcode (1) + seq (4 BE) + payload length (4 BE)


class StreamingWorker:
    """Holds the model and the rolling 8 kHz window; turns AUDIO/FINISH requests into
    transcript segments with chunk-relative offsets. Single-threaded and driven strictly
    in request order, so no locking is needed."""

    def __init__(self, engine: STTEngine, step_ms: int, window_ms: int) -> None:
        self._engine = engine
        self._step_samples = TELEPHONY_RATE * step_ms // 1000
        self._window_samples = TELEPHONY_RATE * window_ms // 1000
        # `window` holds only the trailing `window_samples` (decode cost is bounded — see
        # ADR 0001 §"Why a sliding window"). `total_samples` is the UNTRIMMED cumulative
        # count, so offset math survives the trim.
        self._window = np.empty(0, dtype=np.float32)
        self._total_samples = 0
        self._samples_since_step = 0

    def accept_audio(self, pcm8k: np.ndarray) -> dict:
        """Append a chunk; decode + return a partial (final=false) only when a full step
        of new audio has accumulated, else acknowledge with no segments."""
        chunk_start_sample = self._total_samples
        self._append(pcm8k)
        self._samples_since_step += pcm8k.size
        if self._samples_since_step < self._step_samples:
            return {"type": "segments", "final": False, "segments": []}
        # Subtract (don't zero) so a frame carrying more than one step of audio — possible if
        # frames are ever coalesced or step_ms is tiny — doesn't drop the remainder and skew
        # the cadence.
        self._samples_since_step -= self._step_samples
        anchor_ms = chunk_start_sample / SAMPLES_PER_MS
        return {"type": "segments", "final": False, "segments": self._decode(anchor_ms)}

    def finish(self) -> dict:
        """End-of-turn FINAL decode of the trailing window. Anchored at the current
        end-of-stream cursor (no new chunk), matching the adapter's `flush()` which adds
        `streamCursorMs`; the tail's segments are therefore reported as negative offsets
        from that cursor, recovering true stream time when the adapter adds it back."""
        anchor_ms = self._total_samples / SAMPLES_PER_MS
        return {"type": "segments", "final": True, "segments": self._decode(anchor_ms)}

    def _append(self, pcm8k: np.ndarray) -> None:
        # Atomic: build the new window in a local and commit both fields together, so a
        # concatenate failure can't leave _total_samples ahead of the window content (which
        # would silently corrupt every later offset).
        joined = np.concatenate((self._window, pcm8k)) if self._window.size else pcm8k
        self._window = joined[-self._window_samples:] if joined.size > self._window_samples else joined
        self._total_samples += pcm8k.size

    def _decode(self, anchor_ms: float) -> list[dict]:
        """Decode the current trailing window and convert the engine's window-relative
        centisecond timestamps to chunk-relative ms (relative to `anchor_ms`).

        Engine-neutral: whisper.cpp returns several segments with real per-word timing;
        moonshine returns ONE window-level segment (t0=0, t1=window length — it has no word
        timing, see MoonshineEngine.transcribe_segments). The math below is identical for both.

        Worked example (8 samples/ms): a chunk lands so total_samples=24000 (3000ms) and the
        window is the trailing 16000 samples → window_start_ms = (24000-16000)/8 = 1000ms. A
        segment at t0=50 cs is abs 1000 + 500 = 1500ms. For an AUDIO request anchored at the
        chunk start (say 2980ms), it is reported as 1500 - 2980 = -1480ms; the adapter adds
        chunk.offsetMs (2980) back → 1500ms stream-relative. The negative is expected: the
        segment began before this chunk's audio."""
        if self._window.size == 0:
            return []
        window_start_ms = (self._total_samples - self._window.size) / SAMPLES_PER_MS
        segments = self._engine.transcribe_segments(resample_8k_to_16k(self._window))
        out: list[dict] = []
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            seg_abs0 = window_start_ms + seg.t0 * CS_TO_MS
            seg_abs1 = window_start_ms + seg.t1 * CS_TO_MS
            out.append({"text": text,
                        "t0Ms": seg_abs0 - anchor_ms,
                        "t1Ms": seg_abs1 - anchor_ms})
        return out


def _read_exactly(stream, n: int) -> bytes | None:
    """Read exactly n bytes from a pipe (which may return short reads), or None on EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _emit(obj: dict) -> None:
    """Write one JSON response line and flush (the binding reads line-delimited)."""
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def serve(worker: StreamingWorker, stdin, stdout_ready: bool = True) -> int:
    if stdout_ready:
        _emit({"type": "ready"})
    while True:
        header = _read_exactly(stdin, HEADER.size)
        if header is None:
            return 0  # clean EOF: Node closed the pipe
        opcode, seq, length = HEADER.unpack(header)
        payload = _read_exactly(stdin, length) if length else b""
        if length and payload is None:
            return 1  # truncated frame mid-payload
        if opcode == OP_CLOSE:
            return 0
        try:
            if opcode == OP_AUDIO:
                pcm = np.frombuffer(payload, dtype="<f4").astype(np.float32, copy=False)
                resp = worker.accept_audio(pcm)
            elif opcode == OP_FINISH:
                resp = worker.finish()
            else:
                resp = {"type": "error", "message": f"unknown opcode {opcode}"}
            resp["seq"] = seq
            _emit(resp)
        except Exception as exc:  # one bad frame must not kill the worker
            _emit({"type": "error", "seq": seq, "message": f"{type(exc).__name__}: {exc}"})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    # Engine: default whisper.cpp keeps the existing 9yh BATCH binding (spawns with no --engine)
    # unchanged. The LIVE path (qid.15) passes --engine moonshine — the only engine that holds
    # the live cadence on GPU-less x86 Render (bead jch, ADR 0001 §Render-hardware confirmation).
    ap.add_argument("--engine", choices=sorted(ENGINES), default="whisper.cpp",
                    help="STT engine: whisper.cpp (batch/qid.13, default) | moonshine (live/qid.15)")
    # step-ms is moot for batch one-shot decode; for the LIVE moonshine path it is the
    # partial-emit cadence. Default = the Render-confirmed-safe 1250 ms (moonshine's +549 ms
    # headroom there; was the never-shipped 500). window 10 s bounds the re-decode cost.
    ap.add_argument("--step-ms", type=int, default=int(os.environ.get("NUCLEUS_STT_STEP_MS", "1250")))
    ap.add_argument("--window-ms", type=int, default=int(os.environ.get("NUCLEUS_STT_WINDOW_MS", "10000")))
    ap.add_argument("--model-info", action="store_true",
                    help="print the engine/model id and exit (no model load) — lets the "
                         "binding/integration test probe availability cheaply")
    args = ap.parse_args()

    engine = ENGINES[args.engine]()
    if args.model_info:
        print(engine.model_id)
        return 0

    # The wire format is little-endian Float32 (the binding writes native-endian on its
    # x86/ARM hosts, both LE; we read '<f4'). Fail loud on a big-endian host rather than
    # decode every frame as garbage audio.
    if sys.byteorder != "little":
        sys.exit("stt_worker requires a little-endian host (audio wire format is '<f4')")

    engine.load()
    worker = StreamingWorker(engine, step_ms=args.step_ms, window_ms=args.window_ms)
    # Binary stdin (audio frames); stdout stays text for JSON lines.
    return serve(worker, sys.stdin.buffer)


if __name__ == "__main__":
    sys.exit(main())
