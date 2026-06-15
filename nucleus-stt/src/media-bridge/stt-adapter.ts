/**
 * Pluggable speech-to-text adapter for the counterparty audio track
 * (bead: aunshin-phone-qid.8). Plan §Security invariant #1.
 *
 * The media-bridge decodes counterparty μ-law frames to in-memory Float32 PCM and
 * hands them to an {@link SttAdapter}. The adapter is an interface so the engine
 * is swappable AND so the bridge is testable without a native binding:
 *   - {@link SttWorkerAdapter} — the production engine adapter. Streaming, IN-MEMORY
 *     ONLY (no temp-file buffering — an engine that buffers to /tmp is disqualified per
 *     invariant #1). The actual worker binding is INJECTED and ENGINE-NEUTRAL: the LIVE
 *     counterparty path injects {@link MoonshineWorkerBinding} (bead aunshin-phone-qid.15),
 *     the BATCH/post-call path injects {@link WhisperCppWorkerBinding} (bead
 *     aunshin-phone-9yh) — both Node↔Python workers over stdio; streaming decode validated
 *     in aunshin-phone-1wk, ADR 0001.
 *   - {@link MockSttAdapter} — deterministic, in-memory, for unit tests.
 *
 * No adapter may write audio to disk: it receives Float32 PCM and returns text.
 */

/** A chunk of decoded audio handed to the STT engine. In-memory only. */
export interface SttChunk {
  /** Float32 PCM, 8 kHz mono, normalized to [-1, 1]. Transient — never persisted. */
  readonly pcm: Float32Array;
  /** Stream-time offset (ms since stream start) of this chunk's first sample. */
  readonly offsetMs: number;
}

/** A (possibly partial) transcription result from the engine. */
export interface SttResult {
  readonly text: string;
  /** Stream-time ms offset of the utterance start. */
  readonly startMs: number;
  /** Stream-time ms offset of the utterance end (>= startMs). */
  readonly endMs: number;
  /** True for a finalized utterance; false for an interim hypothesis. */
  readonly isFinal: boolean;
}

/**
 * Streaming STT engine seam. `write` feeds one decoded chunk and returns any
 * results that finalized as a result; `flush` drains buffered audio at stream
 * end; `close` releases resources. All audio is in-memory Float32 — no disk.
 */
export interface SttAdapter {
  write(chunk: SttChunk): SttResult[] | Promise<SttResult[]>;
  flush(): SttResult[] | Promise<SttResult[]>;
  close(): void | Promise<void>;
}

/** Sample rate of Twilio Media Streams μ-law audio. 8 samples per millisecond. */
export const SAMPLE_RATE_HZ = 8000;
const SAMPLES_PER_MS = SAMPLE_RATE_HZ / 1000;

/**
 * The streaming STT worker binding the {@link SttWorkerAdapter} drives. ENGINE-NEUTRAL:
 * kept as an interface so the adapter holds NO hard dependency on a native module or a
 * specific engine — the LIVE path injects {@link MoonshineWorkerBinding}, the BATCH path
 * {@link WhisperCppWorkerBinding}, and tests inject a fake. A binding that requires a file
 * path instead of an in-memory buffer must NOT be adapted here — that would reintroduce the
 * temp-file path invariant #1 forbids.
 *
 * NOTE (9yh/qid.15): the real bindings accept 8 kHz PCM (per {@link SttChunk}) and resample
 * to the engine's native rate INTERNALLY — the bridge does not resample. They are ASYNC: each
 * call drives a Python worker over stdio, so the methods return Promises (the bridge already
 * awaits `SttAdapter.write`/`flush`).
 *
 * `isFinal` per segment: each sliding-window decode is a *replacement* hypothesis for the
 * current window, so `acceptAudio` segments are interim (`isFinal:false`) and only `finish`
 * (end-of-turn) yields `isFinal:true`. The adapter passes this through; the bridge's `emit()`
 * drops `isFinal:false` segments so interim hypotheses are never persisted as finalized
 * transcript (ADR 0001 §Production-shape findings).
 *
 * CONTRACT: segment offsets (`t0Ms`/`t1Ms`) are **relative to the buffer passed to
 * this call** (chunk-relative), NOT stream-cumulative. The adapter — which is the
 * only place that knows each chunk's stream position — adds the stream offset. We
 * make this explicit so the merge clock domain can't silently break on a binding
 * that resets its cursor per call (a common chunked-decoder shape).
 */
export interface SttSegment {
  readonly text: string;
  /** ms offset of the segment start, RELATIVE TO THIS CALL's buffer (see CONTRACT). */
  readonly t0Ms: number;
  /** ms offset of the segment end, relative to this call's buffer (>= t0Ms allowed to
   *  be negative for `finish`, whose anchor is the end-of-stream cursor). */
  readonly t1Ms: number;
  /** false for an interim sliding-window partial; true only for an end-of-turn finalize. */
  readonly isFinal: boolean;
}

export interface SttBinding {
  /** Feed Float32 PCM (8 kHz mono) already in memory; return any segments that decoded
   *  this step (interim, `isFinal:false`), with chunk-relative ms offsets. */
  acceptAudio(pcm: Float32Array): Promise<SttSegment[]>;
  /** Flush the decode buffer at stream end; return the final hypothesis (`isFinal:true`)
   *  with offsets relative to the flushed tail (end-of-stream cursor). */
  finish(): Promise<SttSegment[]>;
  /** Free the model/context (terminate the worker). */
  free(): void | Promise<void>;
}

/**
 * Production STT adapter over a streaming whisper.cpp binding. Holds only the
 * injected binding and a running stream-time cursor; never allocates a file.
 *
 * The binding reports CHUNK-relative offsets; this adapter converts them to
 * STREAM-relative by adding the offset of the chunk they belong to. `write` knows
 * that offset directly (`chunk.offsetMs`); `flush` uses the running cursor (the
 * end of the last fed chunk), since the flushed tail has no chunk of its own.
 */
export class SttWorkerAdapter implements SttAdapter {
  private streamCursorMs = 0;

  constructor(private readonly binding: SttBinding) {}

  async write(chunk: SttChunk): Promise<SttResult[]> {
    const base = chunk.offsetMs;
    this.streamCursorMs = base + chunk.pcm.length / SAMPLES_PER_MS;
    const segments = await this.binding.acceptAudio(chunk.pcm);
    return segments.map((s) => ({
      text: s.text,
      startMs: base + s.t0Ms,
      endMs: base + s.t1Ms,
      isFinal: s.isFinal,
    }));
  }

  async flush(): Promise<SttResult[]> {
    const base = this.streamCursorMs;
    const segments = await this.binding.finish();
    return segments.map((s) => ({
      text: s.text,
      startMs: base + s.t0Ms,
      endMs: base + s.t1Ms,
      isFinal: s.isFinal,
    }));
  }

  async close(): Promise<void> {
    await this.binding.free();
  }
}

export interface MockSttOptions {
  /**
   * Emit a final result for each `write` whose text is produced by `label`
   * (default `cp-<n>`). The result spans the chunk's audio extent (offsetMs →
   * offsetMs + chunkDurationMs), so offset assignment is deterministically
   * testable. Set false to only emit on `flush`.
   */
  readonly emitPerWrite?: boolean;
  /** Text generator, keyed by zero-based write index. */
  readonly label?: (index: number) => string;
}

/**
 * Deterministic in-memory STT adapter for tests. Records every chunk it received
 * (length + offset + whether any sample was out of [-1,1]) so a test can prove
 * the bridge fed valid decoded PCM and nothing else — and that no audio touched
 * disk (this class has, and needs, zero filesystem access).
 */
export class MockSttAdapter implements SttAdapter {
  readonly received: Array<{ samples: number; offsetMs: number }> = [];
  sawOutOfRangeSample = false;
  private writeIndex = 0;
  private totalSamples = 0;
  private readonly emitPerWrite: boolean;
  private readonly label: (index: number) => string;

  constructor(opts: MockSttOptions = {}) {
    this.emitPerWrite = opts.emitPerWrite ?? true;
    this.label = opts.label ?? ((n) => `cp-${n}`);
  }

  write(chunk: SttChunk): SttResult[] {
    for (const s of chunk.pcm) {
      if (s < -1 || s > 1 || !Number.isFinite(s)) this.sawOutOfRangeSample = true;
    }
    this.received.push({ samples: chunk.pcm.length, offsetMs: chunk.offsetMs });
    this.totalSamples += chunk.pcm.length;
    if (!this.emitPerWrite) return [];
    const durationMs = chunk.pcm.length / SAMPLES_PER_MS;
    const result: SttResult = {
      text: this.label(this.writeIndex++),
      startMs: chunk.offsetMs,
      endMs: chunk.offsetMs + durationMs,
      isFinal: true,
    };
    return [result];
  }

  flush(): SttResult[] {
    if (this.emitPerWrite || this.totalSamples === 0) return [];
    // Span = first chunk's stream offset → that offset + total audio duration, so
    // start and end are in the same (stream-time) frame even when the stream did
    // not open at 0 — the mock must not model inconsistent offsets.
    const startMs = this.received[0]?.offsetMs ?? 0;
    return [
      {
        text: this.label(this.writeIndex++),
        startMs,
        endMs: startMs + this.totalSamples / SAMPLES_PER_MS,
        isFinal: true,
      },
    ];
  }

  close(): void {
    /* nothing to release — in-memory only */
  }
}
