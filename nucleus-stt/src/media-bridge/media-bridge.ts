/**
 * Media-bridge: Twilio Media Streams → per-track transcript. Copy-forked from
 * aunshin-phone (qid.8) for nucleus-phone (bead nucleus-phone-rgja.4).
 *
 * nucleus-phone runs TWO {@link MediaStreamBridge} instances per call on the same
 * Media Streams socket — one `{counterpartyTrack:'outbound', speakerLabel:'agent'}`
 * (the rep) and one `{counterpartyTrack:'inbound', speakerLabel:'customer'}` (the
 * lead). Each is a PURE message processor: `handleMessage(frame)` consumes Twilio
 * JSON frames; both bridges see EVERY frame and each decodes ONLY its configured
 * track, dropping the other's (its sibling handles that one). The WS transport is a
 * thin wrapper (see {@link attachMediaStream}), so the core is testable against a
 * synthesized fixture with no socket.
 *
 * Pipeline per matching media frame:
 *   base64 → μ-law bytes → decodeMulawToFloat32 (IN MEMORY) → SttAdapter →
 *   TranscriptChunk{ speaker: <speakerLabel>, text, utt_start_ms, utt_end_ms }.
 *
 * Handling:
 *   - AUDIO is decoded to a transient Float32Array and discarded; it is NEVER
 *     written to disk/DB/temp. This module imports no `fs`.
 *   - Frames for any track other than this bridge's `counterpartyTrack` are dropped.
 *   - Logs carry the nucleus-phone conference_name only — never the Twilio CallSid
 *     (which the `start` frame carries) and never transcript text (the Logger guards both).
 *
 * Clock domain: offsets are stream-time ms (Twilio's per-frame `media.timestamp`,
 * ms since stream start) plus `streamStartOffsetMs` — the offset from call start to
 * stream start (0 when the stream opens at call start).
 */
import { decodeMulawToFloat32 } from '../audio/mulaw.js';
import { Logger } from '../log/index.js';
import type { Speaker, TranscriptChunk } from '../merge/contract.js';
import type { SttAdapter, SttResult } from './stt-adapter.js';
import {
  MULAW_ENCODING,
  parseTwilioMessage,
  type TwilioMediaStreamMessage,
} from './twilio-events.js';

export interface MediaBridgeOptions {
  /** The call identifier we log + key chunks on (nucleus-phone conference_name). */
  readonly callId: string;
  /**
   * Which Twilio track this bridge decodes. nucleus-phone runs TWO bridges per
   * call on the same socket — one `{counterpartyTrack:'outbound'}` and one
   * `{counterpartyTrack:'inbound'}` — each dropping the other's frames. Default
   * 'inbound'.
   */
  readonly counterpartyTrack?: string;
  /**
   * The speaker label this bridge stamps on every emitted chunk. REQUIRED for
   * nucleus-stt (the copy-fork's one behavioural edit vs aunshin, which
   * hardcoded 'counterparty'): the outbound-track bridge passes 'agent', the
   * inbound-track bridge passes 'customer'. Bead nucleus-phone-rgja.4.
   */
  readonly speakerLabel: Speaker;
  /**
   * Call-start wall-clock (epoch ms) — the offset-0 of the single clock domain
   * (same `call_start_wall_ms` the device got in its qid.7 handshake). When set,
   * the bridge AUTO-CAPTURES `streamStartOffsetMs = now() − callStartWallMs` at the
   * `start` frame, so counterparty offsets land in the SAME call-relative domain as
   * the user feed. This is the production path — pass it, and the clock domains
   * can't silently diverge. (Twilio's per-frame `media.timestamp` is ms-since-STREAM
   * -start, which is NOT call-start; the stream opens hundreds of ms–seconds after
   * the call, so a 0 default would skew every counterparty utterance too early.)
   */
  readonly callStartWallMs?: number;
  /** Injectable clock for the auto-capture above. Default Date.now. */
  readonly now?: () => number;
  /**
   * Static override for the call-start→stream-start offset (ms). Used by tests and
   * any caller that already knows the delta. Ignored when `callStartWallMs` is set
   * (auto-capture wins). Default 0.
   */
  readonly streamStartOffsetMs?: number;
  /** Called with each finalized counterparty transcript chunk. */
  readonly onChunk?: (chunk: TranscriptChunk) => void;
  /**
   * Called when a counterparty media frame is processed — a liveness ping that
   * audio is FLOWING (independent of whether STT finalized any text). The live
   * channel uses it to tell an STT stall (audio in, no text out) apart from the
   * counterparty simply not talking (bead qid.12). Carries no audio, no PII.
   */
  readonly onAudioActivity?: () => void;
  /** Injectable logger (PII-safe). Default: a new {@link Logger}. */
  readonly logger?: Logger;
}

export class MediaStreamBridge {
  private readonly callId: string;
  private readonly counterpartyTrack: string;
  private readonly speakerLabel: Speaker;
  /** Mutable: auto-captured at the `start` frame when callStartWallMs is set. */
  private streamStartOffsetMs: number;
  private readonly callStartWallMs: number | undefined;
  private readonly now: () => number;
  private readonly onChunk: ((chunk: TranscriptChunk) => void) | undefined;
  private readonly onAudioActivity: (() => void) | undefined;
  private readonly log: Logger;

  private started = false;
  private stopped = false;
  private mulawOk = true;
  private droppedOtherTrack = 0;
  /** Finalized counterparty chunks (TEXT only — no audio). Ephemeral, in-memory.
   *  PRIVATE (bead aunshin-phone-cwq): counterparty transcript text must not sit on a
   *  publicly-readable field. The sanctioned text egress is the `onChunk` callback; the
   *  supervisor reads only numeric offsets via {@link offsets}. */
  private readonly chunks: TranscriptChunk[] = [];

  constructor(
    private readonly stt: SttAdapter,
    opts: MediaBridgeOptions,
  ) {
    this.callId = opts.callId;
    this.counterpartyTrack = opts.counterpartyTrack ?? 'inbound';
    this.speakerLabel = opts.speakerLabel;
    this.streamStartOffsetMs = opts.streamStartOffsetMs ?? 0;
    this.callStartWallMs = opts.callStartWallMs;
    this.now = opts.now ?? Date.now;
    this.onChunk = opts.onChunk;
    this.onAudioActivity = opts.onAudioActivity;
    this.log = opts.logger ?? new Logger();
  }

  /** Handle one Twilio frame (raw string or pre-parsed object). */
  async handleMessage(raw: string | object): Promise<void> {
    const msg = parseTwilioMessage(raw);
    if (msg === null) {
      this.log.warn('media.frame.unparseable', { callId: this.callId });
      return;
    }
    await this.dispatch(msg);
  }

  private async dispatch(msg: TwilioMediaStreamMessage): Promise<void> {
    switch (msg.event) {
      case 'start': {
        this.started = true;
        const fmt = msg.start.mediaFormat;
        this.mulawOk = fmt.encoding === MULAW_ENCODING && fmt.sampleRate === 8000;
        if (!this.mulawOk) {
          // Decoding assumes 8 kHz μ-law; refuse to mis-decode anything else.
          this.log.error('media.format.unsupported', { callId: this.callId, code: fmt.encoding });
          return;
        }
        // Auto-capture the call-start→stream-start offset so counterparty offsets
        // share the user feed's call-relative clock domain. The `start` frame
        // arrives ~at stream open, so now() − callStartWallMs is that delta. Clamp
        // ≥0 against a skewed clock. Without this, counterparty utterances would be
        // stamped too early and the merge buffer would drop them as "late".
        if (this.callStartWallMs !== undefined) {
          this.streamStartOffsetMs = Math.max(0, this.now() - this.callStartWallMs);
          this.log.info('media.stream.start', {
            callId: this.callId,
            durationMs: this.streamStartOffsetMs,
          });
        } else {
          this.log.info('media.stream.start', { callId: this.callId });
        }
        // Surface a misconfigured Stream (counterparty track not present) as a
        // diagnostic instead of a silent dead call that decodes nothing.
        if (!msg.start.tracks.includes(this.counterpartyTrack)) {
          this.log.warn('media.track.absent', { callId: this.callId, code: this.counterpartyTrack });
        }
        return;
      }
      case 'media':
        await this.onMedia(msg.media);
        return;
      case 'stop':
        await this.close();
        return;
      case 'connected':
      case 'mark':
        return; // acknowledged, no action
    }
  }

  private async onMedia(media: { track: string; timestamp: string; payload: string }): Promise<void> {
    // Only decode after a validated start frame (Twilio always sends start first;
    // enforce the invariant rather than relying on it).
    if (!this.started || this.stopped || !this.mulawOk) return;
    // Drop every track except the counterparty — the user's own (outbound) audio
    // is never processed server-side (invariant #2).
    if (media.track !== this.counterpartyTrack) {
      this.droppedOtherTrack++;
      return;
    }
    // Liveness ping: counterparty audio is flowing (even if STT finalizes nothing).
    this.onAudioActivity?.();

    // base64 → μ-law bytes → Float32 PCM, all in memory. No file is created.
    const mulaw = Buffer.from(media.payload, 'base64');
    const pcm = decodeMulawToFloat32(mulaw);
    // Stream-time only (ms since stream start). The single conversion to
    // call-time (adding streamStartOffsetMs) happens once, in emit().
    const offsetMs = safeNumber(media.timestamp);
    // A frame whose timestamp is missing/garbage coerces to 0 and would sort to
    // call start (and likely be dropped as late). Surface it instead of letting a
    // misbehaving stream go invisible. `media.timestamp.trim() !== '0'` guards the
    // legitimate first frame.
    if (offsetMs === 0 && media.timestamp.trim() !== '0') {
      this.log.warn('media.timestamp.bad', { callId: this.callId });
    }

    const results = await this.stt.write({ pcm, offsetMs });
    this.emit(results);
  }

  /**
   * Flush the final transcript and release the STT worker — AT MOST ONCE. Driven by a
   * Twilio `stop` frame (clean end) AND by the supervisor on every other call end
   * (app-side hangup via `endCall`, or a Media Streams socket drop). Tearing the worker
   * down on EVERY end — not just a clean stop — is what makes the per-call worker
   * subprocess an actual isolation boundary instead of a leaked process still holding a
   * call's in-flight audio (compliance invariant #1; bead aunshin-phone-c1x). Idempotent:
   * the `stopped` guard makes a stop-frame / close() race safe in either order, so the
   * binding is never double-freed.
   */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Only drain the engine if audio actually started: flushing an unused binding would
    // spawn a worker just to finalize nothing (close() can fire before any `start` frame
    // when a call is torn down early).
    if (this.started) this.emit(await this.stt.flush());
    await this.stt.close();
    this.log.info('media.stream.stop', { callId: this.callId, count: this.chunks.length });
  }

  /** Map finalized STT results to counterparty TranscriptChunks in the clock domain. */
  private emit(results: SttResult[]): void {
    for (const r of results) {
      if (!r.isFinal || r.text.length === 0) continue;
      const chunk: TranscriptChunk = {
        speaker: this.speakerLabel,
        text: r.text,
        utt_start_ms: Math.round(this.streamStartOffsetMs + r.startMs),
        utt_end_ms: Math.round(this.streamStartOffsetMs + r.endMs),
      };
      this.chunks.push(chunk);
      this.onChunk?.(chunk);
    }
  }

  /**
   * Counterparty utterance start-offsets (ms-since-call-start), numbers ONLY — the one
   * sanctioned read of the private `chunks` for the supervisor's clock-domain assertions
   * (bead aunshin-phone-cwq). Exposes no text or speaker, so counterparty transcript text
   * can never leave through this path.
   */
  offsets(): number[] {
    return this.chunks.map((c) => c.utt_start_ms);
  }

  /** Diagnostics (no PII): did we see a start, how many non-counterparty frames dropped. */
  stats(): { started: boolean; stopped: boolean; droppedOtherTrack: number; chunks: number } {
    return {
      started: this.started,
      stopped: this.stopped,
      droppedOtherTrack: this.droppedOtherTrack,
      chunks: this.chunks.length,
    };
  }
}

/** Twilio's `media.timestamp` is a string; coerce defensively (bad/negative → 0). */
function safeNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Minimal WS-socket seam so the bridge needs no `ws` import to be typed/tested.
 * Production passes a real `ws` WebSocket (which satisfies this shape); tests
 * drive {@link MediaStreamBridge.handleMessage} directly.
 */
export interface RawMediaSocket {
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
}

/**
 * Wire a live Media Streams socket to a bridge. `ws` may deliver a string, a
 * Buffer, an array of Buffers (a fragmented message), or an ArrayBuffer depending
 * on `binaryType` — decode all of them to UTF-8 text before parsing. A per-frame
 * processing error is caught and dropped so one bad frame can't kill the call;
 * the `.catch` (not bare `void`) is what actually swallows an async rejection.
 * Production-only glue.
 */
export function attachMediaStream(socket: RawMediaSocket, bridge: MediaStreamBridge): void {
  socket.on('message', (data: unknown) => {
    const text = wsFrameToText(data);
    bridge.handleMessage(text).catch(() => {
      /* a single malformed/failed frame must not tear down the call */
    });
  });
}

/** Decode a `ws` message payload (string | Buffer | Buffer[] | ArrayBuffer) to text.
 *  Exported so the media-stream-server's connection glue shares the one decoder
 *  (bead nucleus-phone-rgja.5) rather than carrying a second copy that could drift. */
export function wsFrameToText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}
