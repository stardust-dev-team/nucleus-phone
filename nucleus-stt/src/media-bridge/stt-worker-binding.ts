/**
 * {@link SttWorkerBinding}: a supervised Node↔Python STT worker (beads aunshin-phone-9yh +
 * aunshin-phone-qid.15). Spawns `scripts/stt-bakeoff/stt_worker.py`, drives it over stdio
 * (length-prefixed Float32 frames in, JSON segment lines out), and exposes the async
 * {@link SttBinding} the {@link SttWorkerAdapter} consumes. ENGINE-AGNOSTIC: the
 * transport (FIFO, respawn, desync handling) is identical across engines; the engine is one
 * spawn flag. Two named subclasses pin the two production engines:
 *   - {@link WhisperCppWorkerBinding}  BATCH / post-call (qid.13). whisper.cpp's best one-shot
 *     WER (5.9 %) wins; latency is irrelevant for the one-shot path.
 *   - {@link MoonshineWorkerBinding}   LIVE counterparty (qid.15). The ONLY engine that holds
 *     the live cadence on GPU-less x86 Render (~0.7 s p90 at step 1250 ms; whisper.cpp is 3–9 s
 *     there). qid.8 injects THIS as the live {@link SttAdapter}.
 *
 * WHY two engines: the ee2 spike picked whisper.cpp for live on Apple-Silicon, but the
 * Render-hardware gate (bead aunshin-phone-jch, 2026-06-09) REVERSED the LIVE-tier choice —
 * whisper.cpp's full-window decode is 3–9 s p90 on GPU-less x86 (never keeps up with a live
 * call) while moonshine holds ~0.7 s. The qid.15 spike confirmed the pinned
 * `useful-moonshine-onnx==20251121` has NO native streaming encoder (a real one lands only in
 * Moonshine v2, arXiv 2602.12241, which post-dates the pin), so the live worker ships the proven
 * re-decode fallback — same sliding-window strategy as whisper, different engine. See ADR 0001
 * §"Render-hardware confirmation".
 *
 * The subprocess — not an in-process Node addon — is deliberate: it reuses the ADR-validated
 * in-RAM decode path verbatim (whisper's `whisper_full()` / moonshine's `generate()` on a numpy
 * array), and the process boundary is the OS enforcement point for security invariant #1 (no
 * audio to disk — read-only /tmp / seccomp lands with the deploy, bead aunshin-phone-t9w /
 * aunshin-phone-9gt).
 *
 * Resilience (bead 9yh requirement: one bad frame / a dead worker must NOT tear down the
 * call): requests are serialized through an internal FIFO so concurrent `acceptAudio` calls
 * (the bridge fires `handleMessage` without awaiting) can't interleave on the pipe. If the
 * worker dies, in-flight requests resolve to `[]` (a lost frame, not a thrown call) and the
 * next request transparently respawns a fresh worker — bounded by {@link maxRestarts}, after
 * which the binding stays permanently empty (degraded mode; qid.12 surfaces audio-in/no-text).
 *
 * stdio protocol mirror — see stt_worker.py for the canonical spec:
 *   request : [1B opcode][4B BE seq][4B BE len][payload]  (AUDIO=0x01, FINISH=0x02, CLOSE=0x03)
 *   response: one JSON line per request, echoing `seq` — {"type":"ready"} |
 *             {"type":"segments",seq,...} | {"type":"error",seq,...}. A seq mismatch is a
 *             desync → the worker is torn down and respawned (never guess a mapping).
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface, type Interface } from 'node:readline';

import { Logger } from '../log/index.js';
import type { SttBinding, SttSegment } from './stt-adapter.js';

const OP_AUDIO = 0x01;
const OP_FINISH = 0x02;
const OP_CLOSE = 0x03;

/**
 * Twilio media frames arrive every 20 ms; the backpressure ceiling ({@link SttWorkerOptions.maxInFlight})
 * is sized in these. Mirrors the per-frame cadence the bridge feeds us (one `acceptAudio` per
 * 20 ms frame).
 */
const FRAME_MS = 20;

/** STT engine the worker loads — selects `stt_worker.py --engine`. */
export type SttEngine = 'whisper.cpp' | 'moonshine';

export interface SttWorkerOptions {
  /** Absolute path to the Python interpreter (the stt-bakeoff venv in dev; the image's
   *  python on Render). */
  readonly pythonPath: string;
  /** Absolute path to stt_worker.py. */
  readonly workerScript: string;
  /**
   * STT engine the worker loads. Defaults to `'whisper.cpp'` so a bare {@link SttWorkerBinding}
   * (and the legacy {@link WhisperCppWorkerBinding} subclass) preserve the 9yh batch behavior.
   * The live path uses {@link MoonshineWorkerBinding} (`'moonshine'`). Passed through as
   * `stt_worker.py --engine <engine>`.
   */
  readonly engine?: SttEngine;
  /**
   * Partial-emit cadence (ms of arrived audio per decode). For whisper.cpp (BATCH, one-shot via
   * finish()) there is no live partial cadence to honour. For moonshine (LIVE) this IS the
   * partial-emit interval; the Render gate (bead aunshin-phone-jch; ADR 0001 §Render-hardware
   * confirmation) set it to 1250 ms (moonshine's +549 ms headroom there). Default 1250 — the
   * Render-confirmed-safe cadence — so neither engine is ever driven faster than it can hold.
   */
  readonly stepMs?: number;
  /** Trailing audio window decoded each step (ms). Default 10000 (keep <= 30000). */
  readonly windowMs?: number;
  /** Max worker respawns before giving up and staying in degraded (empty) mode. Default 5. */
  readonly maxRestarts?: number;
  /**
   * Backpressure ceiling for the LIVE frame storm (bead aunshin-phone-bgv). The bridge fires
   * `acceptAudio` fire-and-forget once per 20 ms Twilio frame while a GPU-less Render decode
   * runs ~1 s (ADR 0001 consequence #1), so ~step_ms/{@link FRAME_MS} frames (≈63 at the
   * jch-confirmed 1250 ms step) pile up behind each decode. That backlog normally drains the
   * instant the decode finishes — but a pathological stall (wedged worker / runaway decode)
   * would grow `inFlight` + the OS stdin pipe buffer without limit. This bounds it two ways:
   * at most `maxInFlight` frames sit DISPATCHED (awaiting a worker response), and at most
   * `maxInFlight` more sit UN-SENT in the overflow backlog; past that the OLDEST un-sent AUDIO
   * frame is dropped (resolved `[]`) — never the freshest (it matters most for live coaching),
   * never a FINISH. Only un-sent frames are droppable: a dispatched frame's seq is already
   * committed and the worker WILL echo it, so dropping it would desync the FIFO. Default
   * `ceil(windowMs / FRAME_MS)` — one full decode window of 20 ms frames (500 at the 10 s
   * default), comfortably above the healthy per-decode backlog so it never fires in normal
   * cadence. PII-safe drop count is logged (`stt.worker.backpressure_drop`) so degraded cadence
   * is observable (pairs with qid.12's audio-in/no-text-out signal).
   */
  readonly maxInFlight?: number;
  /** Injectable logger (PII-safe). Default a new {@link Logger}. */
  readonly logger?: Logger;
}

/** @deprecated Use {@link SttWorkerOptions}. Kept so existing call sites compile. */
export type WhisperCppWorkerOptions = SttWorkerOptions;

interface PendingRequest {
  /** Monotonic id echoed by the worker; lets us DETECT a response/request desync. */
  readonly seq: number;
  readonly frame: Buffer;
  /** All segments from one response carry the same finality (false for AUDIO, true for
   *  FINISH); set as each segment's `isFinal` when the response lands. */
  readonly isFinal: boolean;
  readonly resolve: (segments: SttSegment[]) => void;
}

interface WorkerSegment {
  readonly text: string;
  readonly t0Ms: number;
  readonly t1Ms: number;
}

export class SttWorkerBinding implements SttBinding {
  private readonly pythonPath: string;
  private readonly workerScript: string;
  private readonly engine: SttEngine;
  private readonly stepMs: number;
  private readonly windowMs: number;
  private readonly maxRestarts: number;
  private readonly maxInFlight: number;
  private readonly log: Logger;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private ready = false;
  private restarts = 0;
  private closed = false;
  private nextSeq = 0;
  /** Last stderr lines (whisper logs / tracebacks) for diagnosing a nonzero exit. */
  private stderrTail: string[] = [];
  /** Cumulative AUDIO frames dropped by backpressure (bead bgv) — emitted as the log `count`. */
  private droppedFrames = 0;

  /** Requests handed to the LIVE worker, oldest first; responses map to them in order. */
  private readonly inFlight: PendingRequest[] = [];
  /** Requests waiting for the worker to (re)spawn + signal ready. */
  private readonly queued: PendingRequest[] = [];

  constructor(opts: SttWorkerOptions) {
    this.pythonPath = opts.pythonPath;
    this.workerScript = opts.workerScript;
    this.engine = opts.engine ?? 'whisper.cpp';
    this.stepMs = opts.stepMs ?? 1250; // Render-confirmed safe cadence (jch); see stepMs doc above.
    this.windowMs = opts.windowMs ?? 10_000;
    this.maxRestarts = opts.maxRestarts ?? 5;
    // One full decode window of 20ms frames (500 at the 10s default) — see maxInFlight doc.
    // Clamp to >= 1: a 0 ceiling would make EVERY frame overflow the backlog (and the
    // coalesce/eviction logic assumes at least one slot exists).
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? Math.ceil(this.windowMs / FRAME_MS));
    this.log = opts.logger ?? new Logger();
  }

  acceptAudio(pcm: Float32Array): Promise<SttSegment[]> {
    // View this array's bytes ONLY (honour byteOffset/byteLength so a shared/subarray
    // buffer can't ship neighbouring audio); buildFrame's concat copies them, so nothing
    // retains the caller's ArrayBuffer. Float32 is written native-endian and read '<f4' by
    // the worker — correct on x86/ARM (both little-endian; our only deploy targets).
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return this.send(OP_AUDIO, bytes, false);
  }

  finish(): Promise<SttSegment[]> {
    return this.send(OP_FINISH, Buffer.alloc(0), true);
  }

  async free(): Promise<void> {
    this.closed = true;
    // Resolve anything still outstanding so no caller hangs on a closing worker.
    this.drainPending();
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.reader?.close();
    this.reader = null;
    try {
      proc.stdin.write(frameHeader(OP_CLOSE, 0, 0)); // CLOSE gets no response; seq unused
      proc.stdin.end();
    } catch {
      /* pipe already gone — fall through to wait/kill */
    }
    const exited = once(proc, 'exit');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 1000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private send(opcode: number, payload: Buffer, isFinal: boolean): Promise<SttSegment[]> {
    if (this.closed) return Promise.resolve([]);
    return new Promise((resolve) => {
      // seq wraps at 2^32 (uint32 on the wire); the worker only ever compares for equality
      // against the head of the FIFO, so wrap is harmless.
      const seq = this.nextSeq++ >>> 0;
      const req: PendingRequest = { seq, frame: buildFrame(opcode, seq, payload), isFinal, resolve };
      // Dispatch immediately ONLY when the worker is live, nothing is already waiting (else we'd
      // jump the FIFO/seq queue), and the in-flight ceiling has room. Otherwise the frame goes to
      // the un-sent backlog, where the backpressure ceiling can drop it (bead bgv).
      if (this.ready && this.proc && this.queued.length === 0 && this.inFlight.length < this.maxInFlight) {
        this.dispatch(req);
      } else {
        this.enqueue(req);
        this.ensureWorker();
      }
    });
  }

  /** Write a request to the live worker and record it for FIFO response matching. */
  private dispatch(req: PendingRequest): void {
    const proc = this.proc;
    if (!proc) {
      this.enqueue(req);
      this.ensureWorker();
      return;
    }
    this.inFlight.push(req);
    proc.stdin.write(req.frame);
  }

  /**
   * Buffer an UN-SENT request, enforcing the backpressure ceiling (bead aunshin-phone-bgv).
   * Past `maxInFlight` un-sent frames we drop the OLDEST AUDIO frame — freshest audio matters
   * most for live coaching — resolving it `[]` so its caller never hangs. A FINISH is NEVER
   * dropped (losing it would truncate the final transcript). The dropped frame was never written
   * to the worker, so its seq never enters `inFlight` and the FIFO can't desync.
   *
   * All-FINISH backlog (bead aunshin-phone-sau): when there is NO AUDIO to evict, the backlog
   * is pure FINISH. The caller contract is one finish() per call (SttWorkerAdapter at
   * end-of-call), so in normal operation this holds at most a single FINISH. But a caller that
   * re-fires finish() against a wedged worker (a caller bug, or a future multi-utterance design)
   * would otherwise grow the queue unbounded — the one path that didn't honour bgv's "bound the
   * queue" intent. We COALESCE instead of dropping the finalize: the NEWEST FINISH re-decodes the
   * widest window, so we keep it and resolve the superseded earlier FINISH frames `[]`. The final
   * flush still happens (via the surviving FINISH) — bgv's "FINISH is never dropped / never
   * truncate the final transcript" rule holds, and the queue stays bounded by `maxInFlight`.
   */
  private enqueue(req: PendingRequest): void {
    this.queued.push(req);
    if (this.queued.length <= this.maxInFlight) return;
    // Over the ceiling: evict the oldest AUDIO frame (isFinal === false). Skip FINISH frames.
    const idx = this.queued.findIndex((r) => !r.isFinal);
    if (idx === -1) {
      this.coalesceFinish();
      return;
    }
    const dropped = this.queued.splice(idx, 1)[0] as PendingRequest; // idx >= 0 ⇒ exactly one
    this.droppedFrames += 1;
    // PII-safe: a short code + the cumulative drop count only (invariant #7).
    this.log.warn('stt.worker.backpressure_drop', { code: 'queue_full', count: this.droppedFrames });
    dropped.resolve([]);
  }

  /**
   * Collapse a pure-FINISH backlog to its single newest frame, resolving every superseded
   * FINISH `[]`. Bounds the all-FINISH queue without ever dropping the finalize: the surviving
   * (newest, widest-window) FINISH stays queued and pumps to the worker to do the real flush.
   */
  private coalesceFinish(): void {
    if (this.queued.length <= 1) return; // nothing to coalesce
    const newest = this.queued.pop() as PendingRequest; // the just-pushed frame is the newest
    const superseded = this.queued.splice(0, this.queued.length);
    this.queued.push(newest);
    for (const req of superseded) {
      this.droppedFrames += 1;
      // PII-safe: a short code + the cumulative coalesce/drop tally only (invariant #7).
      this.log.warn('stt.worker.backpressure_drop', { code: 'finish_coalesced', count: this.droppedFrames });
      req.resolve([]);
    }
  }

  /**
   * Drain the un-sent backlog to the live worker up to the in-flight ceiling, oldest-first
   * (preserving FIFO/seq order). Called after each response frees an in-flight slot and once a
   * (re)spawned worker signals ready.
   */
  private pump(): void {
    while (
      this.ready &&
      this.proc &&
      this.queued.length > 0 &&
      this.inFlight.length < this.maxInFlight
    ) {
      // Non-null: the while-guard proves queued is non-empty.
      this.dispatch(this.queued.shift() as PendingRequest);
    }
  }

  private ensureWorker(): void {
    if (this.closed || this.proc) return;
    if (this.restarts > this.maxRestarts) {
      // Give up: degraded mode. Resolve everything queued as empty so the call survives
      // without text rather than hanging.
      this.drainPending();
      return;
    }

    const proc = spawn(this.pythonPath, [
      this.workerScript,
      '--engine', this.engine,
      '--step-ms', String(this.stepMs),
      '--window-ms', String(this.windowMs),
    ]);
    this.proc = proc;
    this.ready = false;
    this.stderrTail = [];

    // Swallow stream errors (EPIPE when writing to a worker that just died): recovery
    // runs off the 'exit' event. An unhandled stream 'error' would crash the host process.
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      // Keep only a small tail — whisper.cpp is chatty on stderr and we log nothing per-frame.
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.stderrTail.push(line);
      }
      if (this.stderrTail.length > 20) this.stderrTail = this.stderrTail.slice(-20);
    });

    this.reader = createInterface({ input: proc.stdout });
    this.reader.on('line', (line) => this.onLine(line));

    proc.on('exit', (code, signal) => this.onExit(code, signal));
    proc.on('error', (err) => {
      // spawn failed (e.g. python missing): treat as an exit so restart/give-up logic runs.
      // Use a FIXED short code — never err.message: the PII-safe Logger throws if `code`
      // exceeds 64 chars (a spawn-ENOENT message with a long path does), and a throw inside
      // this 'error' listener would crash the host process — the exact failure this binding
      // exists to survive. The message goes to the operator console instead.
      process.stderr.write(`[stt.worker] spawn failed: ${err.message}\n`);
      this.log.error('stt.worker.spawn_error', { code: 'spawn_failed' });
      this.onExit(null, null);
    });
  }

  private onLine(line: string): void {
    let msg: { type?: string; seq?: number; final?: boolean; segments?: WorkerSegment[]; message?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn('stt.worker.bad_line', {});
      return;
    }

    if (msg.type === 'ready') {
      this.ready = true;
      // Flush the backlog that built while (re)spawning, in order, up to the in-flight ceiling
      // (the rest stay queued and pump in as responses land — bead bgv). NB: do NOT reset the
      // restart budget here — a worker that crashes right after 'ready' (before doing any
      // real work) would otherwise reset the counter every spawn and crash-loop forever.
      // The budget resets only on a successful RESPONSE (below), i.e. proof of real work.
      this.pump();
      return;
    }

    if (msg.type === 'error') {
      // A per-frame decode error: the worker stays alive and already consumed the request,
      // so settle the matching in-flight request as empty (no text this frame). It still
      // counts as the worker doing work → reset the crash budget.
      const req = this.dequeue(msg.seq);
      if (!req) return; // orphan / desync — dequeue handled it
      this.log.warn('stt.worker.decode_error', {});
      this.restarts = 0;
      req.resolve([]);
      this.pump(); // a slot freed — drain any backpressure backlog
      return;
    }

    if (msg.type === 'segments') {
      const req = this.dequeue(msg.seq);
      if (!req) return; // orphan / desync — dequeue handled it
      this.restarts = 0; // a delivered response proves the worker is healthy
      const isFinal = req.isFinal;
      const segments = (msg.segments ?? []).map((s) => ({
        text: s.text,
        t0Ms: s.t0Ms,
        t1Ms: s.t1Ms,
        isFinal,
      }));
      req.resolve(segments);
      this.pump(); // a slot freed — drain any backpressure backlog
    }
  }

  /**
   * Pop the in-flight request a response belongs to, verifying its echoed `seq` matches the
   * FIFO head. A mismatch (or a response with no in-flight request) means the stdout stream
   * desynced — a stray/duplicated/dropped line. We do NOT guess a mapping (that would
   * mis-attribute counterparty transcript offsets, a compliance problem); we tear the worker
   * down so onExit drains everything as empty and respawns from a clean slate.
   */
  private dequeue(seq: number | undefined): PendingRequest | undefined {
    const head = this.inFlight[0];
    if (!head) {
      this.log.warn('stt.worker.orphan_response', {});
      return undefined;
    }
    if (seq !== head.seq) {
      this.log.error('stt.worker.desync', { code: 'seq_mismatch' });
      this.resync();
      return undefined;
    }
    return this.inFlight.shift();
  }

  /** Force a clean restart after an unrecoverable protocol desync. */
  private resync(): void {
    const proc = this.proc;
    if (!proc) return;
    // Kill it; the 'exit' handler drains in-flight requests empty and respawns if work waits.
    proc.kill('SIGKILL');
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.reader?.close();
    this.reader = null;
    this.proc = null;
    this.ready = false;

    if (this.closed) return; // expected shutdown via free()

    this.restarts += 1;
    // Structured log stays PII-safe (invariant #7): a short code + the restart count only.
    this.log.error('stt.worker.exit', {
      code: `exit_${code ?? signal ?? 'unknown'}`,
      count: this.restarts,
    });
    // The worker's stderr is whisper/python diagnostics (model/system info, tracebacks —
    // never audio or transcript), so it goes to the OPERATOR CONSOLE, not the PII-safe log.
    // This is the only window into a deploy-time failure (missing python/model — bead t9w).
    if (this.stderrTail.length) {
      process.stderr.write(`[stt.worker] ${this.stderrTail.slice(-3).join(' | ')}\n`);
    }

    // In-flight requests can't be answered by a dead worker — settle them empty (frames
    // lost, call continues) and requeue nothing; their audio is gone with the worker.
    const lost = this.inFlight.splice(0, this.inFlight.length);
    for (const req of lost) req.resolve([]);

    // Respawn if anything is waiting; a crash with no pending work just leaves proc=null
    // and the next send() respawns lazily.
    if (this.queued.length > 0) this.ensureWorker();
  }

  /** Resolve every queued + in-flight request as empty (used on free / restart-exhaustion). */
  private drainPending(): void {
    const all = [...this.inFlight.splice(0, this.inFlight.length),
                 ...this.queued.splice(0, this.queued.length)];
    for (const req of all) req.resolve([]);
  }
}

/**
 * BATCH / post-call binding (engine `whisper.cpp`, bead aunshin-phone-9yh → qid.13). Best
 * one-shot WER (5.9 %); latency irrelevant for the one-shot decode. This is the legacy name —
 * it now just pins the engine on the generic {@link SttWorkerBinding}; `engine` in `opts` is
 * forced to `'whisper.cpp'`.
 */
export class WhisperCppWorkerBinding extends SttWorkerBinding {
  constructor(opts: Omit<SttWorkerOptions, 'engine'>) {
    super({ ...opts, engine: 'whisper.cpp' });
  }
}

/**
 * LIVE counterparty binding (engine `moonshine`, bead aunshin-phone-qid.15). The only engine
 * that holds the live cadence on GPU-less x86 Render (~0.7 s p90 at step 1250 ms; ADR 0001
 * §Render-hardware confirmation). qid.8 injects this as the live {@link SttAdapter} (wrapping it
 * in {@link SttWorkerAdapter}, which is itself engine-neutral — it only re-anchors offsets).
 * Drives the proven re-decode-the-trailing-window fallback (the pinned `useful-moonshine-onnx`
 * has no native streaming encoder — qid.15 spike); the same protocol as whisper, different
 * engine + a window-level timestamp contract (see stt_worker.py / MoonshineEngine).
 */
export class MoonshineWorkerBinding extends SttWorkerBinding {
  constructor(opts: Omit<SttWorkerOptions, 'engine'>) {
    super({ ...opts, engine: 'moonshine' });
  }
}

/** Big-endian [opcode][uint32 seq][uint32 length] header (9 bytes). */
function frameHeader(opcode: number, seq: number, length: number): Buffer {
  const header = Buffer.allocUnsafe(9);
  header.writeUInt8(opcode, 0);
  header.writeUInt32BE(seq >>> 0, 1);
  header.writeUInt32BE(length, 5);
  return header;
}

function buildFrame(opcode: number, seq: number, payload: Buffer): Buffer {
  return payload.length === 0
    ? frameHeader(opcode, seq, 0)
    : Buffer.concat([frameHeader(opcode, seq, payload.length), payload]);
}
