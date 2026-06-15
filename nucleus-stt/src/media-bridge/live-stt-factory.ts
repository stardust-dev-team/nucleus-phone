/**
 * Live counterparty STT factory (bead: aunshin-phone-qid.8). The composition root for
 * the LIVE tier — the missing seam between "the bridge exists" and "the server can run it":
 * it produces the per-call {@link SttAdapter} the {@link CallSupervisor} injects via its
 * `sttFactory`, wiring the engine-neutral {@link SttWorkerAdapter} over a
 * {@link MoonshineWorkerBinding} (the only engine that holds the live cadence on GPU-less x86
 * Render — ~0.7 s p90 at step 1250 ms; ADR 0001 §Render-hardware confirmation, beads
 * aunshin-phone-jch + aunshin-phone-qid.15).
 *
 * Each call gets a FRESH binding — its own Python worker subprocess — so one call's audio
 * can never reach another call's worker. That per-call process boundary is the isolation
 * point for per-user isolation (HARD compliance rule #1: "User A's data can never surface in
 * user B's context"). The supervisor invokes the returned factory exactly once per call, and
 * tears the boundary down on EVERY call end: MediaStreamBridge.close() (driven by CallSupervisor
 * .endCall + the Media Streams socket-close handler, as well as a clean Twilio stop frame) calls
 * SttAdapter.close() → binding.free(), terminating the worker so it cannot outlive the call
 * (bead aunshin-phone-c1x).
 *
 * GATING (does NOT belong here): constructing this factory does NOT turn live transcription
 * ON. Whether live transcription runs at all is gated upstream on Anthropic ZDR being enabled
 * (bead aunshin-phone-be5) and the Render deploy carrying onnxruntime + the moonshine model
 * (bead aunshin-phone-t9w). This module is the wiring; the deploy + the upstream gate flip it
 * live. Keeping the ZDR/egress gate out of the STT factory keeps the two concerns un-conflated.
 *
 * The BATCH / post-call path (bead aunshin-phone-qid.13) is a separate factory over
 * {@link WhisperCppWorkerBinding}; it is not wired here.
 */
import { Logger } from '../log/index.js';
import { SttWorkerAdapter, type SttAdapter } from './stt-adapter.js';
import { MoonshineWorkerBinding } from './stt-worker-binding.js';

export interface LiveSttConfig {
  /** Absolute path to the Python interpreter (the stt-bakeoff venv in dev; the image's
   *  python on Render). */
  readonly pythonPath: string;
  /** Absolute path to stt_worker.py. */
  readonly workerScript: string;
  /**
   * Partial-emit cadence (ms of arrived audio per decode). Omit to use the binding's
   * Render-confirmed-safe default (1250 ms; bead aunshin-phone-jch). Do NOT lower this
   * below the Render-validated value without re-running the cadence gate — a faster step
   * makes moonshine fall behind the live call on GPU-less x86.
   */
  readonly stepMs?: number;
  /** Trailing audio window decoded each step (ms). Omit for the binding default (10000). */
  readonly windowMs?: number;
  /** Max worker respawns before a binding stays in degraded (empty) mode. Omit for default (5). */
  readonly maxRestarts?: number;
  /** Injectable PII-safe logger shared by every per-call binding. Default: a new {@link Logger}. */
  readonly logger?: Logger;
}

/**
 * Build the live `sttFactory` the {@link CallSupervisor} consumes. Returns a function that
 * mints a fresh moonshine-backed {@link SttAdapter} per call (per-call worker isolation).
 *
 * `callId` is unused in adapter construction (the bridge owns call-scoped logging, and the
 * worker binding logs no call identifier) but is part of the supervisor's factory contract —
 * accepted and ignored.
 */
/**
 * Build a {@link LiveSttConfig} from the process environment — the seam the Render deploy
 * (bead nucleus-phone-rgja, Stage B3) uses to point the binding at the image's filesystem
 * layout without a hardcode. `NUCLEUS_STT_PYTHON` points at the worker venv's python and
 * `NUCLEUS_STT_WORKER` at worker/stt_worker.py. (aunshin's Landlock/no-disk-jail wrapper is
 * NOT carried into nucleus-stt — different, lower compliance bar; the worker still decodes
 * audio in-memory only.)
 *
 * Throws if a required path var is missing (fail-fast at boot beats a per-call spawn ENOENT).
 * Numeric vars are optional; an unset or unparseable value falls through to the binding's
 * Render-confirmed defaults (stepMs 1250, windowMs 10000) rather than a silent 0.
 */
export function liveSttConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  logger?: Logger,
): LiveSttConfig {
  const pythonPath = env['NUCLEUS_STT_PYTHON'];
  const workerScript = env['NUCLEUS_STT_WORKER'];
  if (!pythonPath || !workerScript) {
    const missing = [!pythonPath && 'NUCLEUS_STT_PYTHON', !workerScript && 'NUCLEUS_STT_WORKER']
      .filter(Boolean)
      .join(', ');
    throw new Error(`live STT config missing required env: ${missing}`);
  }
  const posInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const stepMs = posInt(env['NUCLEUS_STT_STEP_MS']);
  const windowMs = posInt(env['NUCLEUS_STT_WINDOW_MS']);
  const maxRestarts = posInt(env['NUCLEUS_STT_MAX_RESTARTS']);
  return {
    pythonPath,
    workerScript,
    ...(stepMs !== undefined ? { stepMs } : {}),
    ...(windowMs !== undefined ? { windowMs } : {}),
    ...(maxRestarts !== undefined ? { maxRestarts } : {}),
    ...(logger !== undefined ? { logger } : {}),
  };
}

export function createLiveSttFactory(config: LiveSttConfig): (callId: string) => SttAdapter {
  const logger = config.logger ?? new Logger();
  return (_callId: string): SttAdapter =>
    new SttWorkerAdapter(
      new MoonshineWorkerBinding({
        pythonPath: config.pythonPath,
        workerScript: config.workerScript,
        logger,
        ...(config.stepMs !== undefined ? { stepMs: config.stepMs } : {}),
        ...(config.windowMs !== undefined ? { windowMs: config.windowMs } : {}),
        ...(config.maxRestarts !== undefined ? { maxRestarts: config.maxRestarts } : {}),
      }),
    );
}
