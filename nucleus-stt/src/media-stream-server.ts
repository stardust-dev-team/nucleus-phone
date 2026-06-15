/**
 * nucleus-stt composition root + per-call orchestration (bead nucleus-phone-rgja.5,
 * Stage B2). The seam between "the forked bridge exists" and "Render can run a service":
 * a WS `/media-stream` endpoint Twilio Media Streams connects to, a `GET /healthz` the
 * render.yaml healthCheckPath answers, and — per Twilio connection — the TWO-bridge
 * fan-out + bounded drain the plan pins here.
 *
 * Unlike aunshin-phone (whose CallSupervisor owns per-call lifecycle and the callId
 * rides a URL query), nucleus-phone has NO supervisor in the fork and keys on the
 * **conference_name carried as a `<Stream><Parameter>`** — so this module reads it off
 * the Twilio `start` frame's `customParameters`, mints the two bridges THEN, and owns
 * teardown. `callId = conference_name` everywhere (plan review #9): no separate UUID.
 *
 * Per call (one Twilio Media Streams socket):
 *   - on the `start` frame: read conference_name; build bridgeAgent
 *     {counterpartyTrack:'outbound', speakerLabel:'agent'} + bridgeCustomer
 *     {counterpartyTrack:'inbound', speakerLabel:'customer'}, each over its OWN moonshine
 *     worker (per-call spawn isolation; createLiveSttFactory minted twice);
 *   - FAN every frame (start/media/stop) to BOTH bridges — each bridge's counterpartyTrack
 *     filter drops the track it doesn't own (plan R2 NEW-2: do NOT route by track field);
 *   - each finalized chunk's onChunk POSTs to the main service via the {@link IngestClient};
 *   - on `stop` (or socket close): the **drain-before-finalize** (plan review #1) — FINISH
 *     both bridges, await their trailing ingest POSTs, THEN POST `finalize`; if a worker
 *     hasn't drained within ~5s, proceed and finalize on whatever landed (plan R2 #1a/S1).
 *     The ~5s `Promise.race` lives HERE (plan R3), wrapping both bridge closes — never
 *     inside MediaStreamBridge or the worker binding.
 *
 * If the `start` frame carries no conference_name the audio is unroutable (nowhere to
 * deliver chunks): log a no-PII warning and close the socket rather than decode into a void.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Logger } from './log/index.js';
import { MediaStreamBridge, wsFrameToText } from './media-bridge/index.js';
import type { SttAdapter } from './media-bridge/index.js';
import { createLiveSttFactory, liveSttConfigFromEnv } from './media-bridge/index.js';
import { parseTwilioMessage, type TwilioMediaStreamMessage } from './media-bridge/twilio-events.js';
import type { TranscriptChunk } from './merge/contract.js';
import { HttpIngestClient, type IngestClient } from './ingest-client.js';

/** Twilio Media Streams upgrade path (set `<Stream url="wss://<svc>/media-stream">`). */
export const DEFAULT_MEDIA_PATH = '/media-stream';
/** The render.yaml healthCheckPath — 200 the moment the port binds. */
export const HEALTH_PATH = '/healthz';
/** Default bound on the per-call drain (plan R2 #1a). */
const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
/**
 * The shape of a nucleus-phone conference_name (outbound `nucleus-call-<uuid>`,
 * inbound `nucleus-inbound-<uuid>`). We refuse anything else as unroutable: the value
 * becomes the `callId` on every log line + dead-letter, and the Logger allowlists the
 * FIELD but cannot vet the VALUE — so a misconfigured `<Parameter>` carrying PII (a phone
 * number) would otherwise leak (review #3, invariant #7). Trailing chars are bounded by
 * the Logger's 64-char callId cap.
 */
const CONFERENCE_NAME_RE = /^nucleus-(call|inbound)-[A-Za-z0-9._-]+$/;

export interface CallMediaSessionOptions {
  /** Mints a fresh per-call moonshine adapter (createLiveSttFactory). Called TWICE per
   *  call — once per bridge — so each track has its own isolated worker. */
  readonly sttFactory: (callId: string) => SttAdapter;
  /** Where finalized chunks + the end-of-call finalize POST. */
  readonly ingest: IngestClient;
  /** PII-safe logger. */
  readonly logger?: Logger;
  /** Drain bound (ms). Default {@link DEFAULT_DRAIN_TIMEOUT_MS}. */
  readonly drainTimeoutMs?: number;
  /** Injectable timer for the drain race (default setTimeout). Tests drive both
   *  outcomes by making this resolve immediately (timeout wins) or never (drain wins). */
  readonly delay?: (ms: number) => Promise<void>;
  /** Called when a `start` frame carries no conference_name (audio is unroutable). The
   *  WS layer closes the socket; in unit tests it records the unroutable signal. */
  readonly onUnroutable?: () => void;
}

/**
 * One Twilio Media Streams connection's lifecycle. Pure of any socket — `handleMessage`
 * takes a frame (string or parsed object) and `close()` is the socket-drop drain — so
 * unit tests drive it with a MockSttAdapter and a mock IngestClient, no WS, no network.
 */
export class CallMediaSession {
  private readonly sttFactory: (callId: string) => SttAdapter;
  private readonly ingest: IngestClient;
  private readonly log: Logger;
  private readonly drainTimeoutMs: number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly onUnroutable: (() => void) | undefined;

  private conferenceName: string | undefined;
  private bridgeAgent: MediaStreamBridge | undefined;
  private bridgeCustomer: MediaStreamBridge | undefined;
  /** The two per-call STT adapters (one per bridge). Held so a drain-timeout can force
   *  their worker subprocesses dead even when bridge.close()'s flush() is the thing
   *  wedged — bridge.close() awaits flush() BEFORE stt.close(), so a hung flush would
   *  otherwise leave the worker alive past the bound (review #2; binding.free() is
   *  idempotent + SIGKILLs within 1s). */
  private adapterAgent: SttAdapter | undefined;
  private adapterCustomer: SttAdapter | undefined;
  private started = false;
  private finalized = false;
  /** In-flight ingest POSTs (one per emitted chunk) — awaited in the drain so finalize
   *  cannot race ahead of the trailing chunks moonshine holds in its 1250ms window. A Set
   *  with self-removal (not an append-only array) so a long call doesn't retain a pointer
   *  to every POST it ever made (review #4). */
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: CallMediaSessionOptions) {
    this.sttFactory = opts.sttFactory;
    this.ingest = opts.ingest;
    this.log = opts.logger ?? new Logger();
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onUnroutable = opts.onUnroutable;
  }

  /** Diagnostics for /healthz and tests (no PII). */
  get isStarted(): boolean {
    return this.started;
  }

  /** Handle one Twilio frame. start → build bridges + fan; media/mark → fan to both;
   *  stop → drain + finalize. Frames before `start` (connected) are ignored. */
  async handleMessage(raw: string | object): Promise<void> {
    const msg = parseTwilioMessage(raw);
    if (msg === null) {
      this.log.warn('media.frame.unparseable');
      return;
    }
    if (msg.event === 'start') {
      await this.onStart(msg);
      return;
    }
    if (!this.started) return; // nothing to route until the start frame builds the bridges
    if (msg.event === 'stop') {
      await this.drainAndFinalize(msg);
      return;
    }
    // media / mark — every frame goes to BOTH bridges; each drops its non-owned track.
    await this.fan(msg);
  }

  /** Socket-drop teardown (no Twilio `stop` frame). Idempotent with the stop path. */
  async close(): Promise<void> {
    await this.drainAndFinalize(undefined);
  }

  private async onStart(msg: Extract<TwilioMediaStreamMessage, { event: 'start' }>): Promise<void> {
    if (this.started) return; // a duplicate start frame must not re-spawn workers
    const conf = msg.start.customParameters?.['conference_name'];
    if (!conf || !CONFERENCE_NAME_RE.test(conf)) {
      // No/!valid conference_name → no safe ingest key → audio has nowhere to go. Fail
      // loud-but-safe: a no-PII warning + close the socket, never a silent decode-into-void
      // and never echo a possibly-PII value (we don't log `conf` itself).
      this.log.warn('media.start.no_conference');
      this.onUnroutable?.();
      return;
    }
    this.conferenceName = conf;
    const onChunk = (chunk: TranscriptChunk): void => {
      // Synchronous push; the POST runs in the background and is awaited at drain. POST
      // never throws (it dead-letters internally), so pending always settles. Self-remove
      // on settle so the Set tracks only in-flight POSTs, not the call's whole history.
      const p = this.ingest.postChunk(conf, chunk).finally(() => {
        this.pending.delete(p);
      });
      this.pending.add(p);
    };
    this.adapterAgent = this.sttFactory(conf);
    this.adapterCustomer = this.sttFactory(conf);
    this.bridgeAgent = new MediaStreamBridge(this.adapterAgent, {
      callId: conf,
      counterpartyTrack: 'outbound',
      speakerLabel: 'agent',
      onChunk,
      logger: this.log,
    });
    this.bridgeCustomer = new MediaStreamBridge(this.adapterCustomer, {
      callId: conf,
      counterpartyTrack: 'inbound',
      speakerLabel: 'customer',
      onChunk,
      logger: this.log,
    });
    this.started = true;
    await this.fan(msg); // both bridges see the start frame (captures format + track list)
  }

  /** Deliver one frame to both bridges. */
  private async fan(msg: TwilioMediaStreamMessage): Promise<void> {
    if (!this.bridgeAgent || !this.bridgeCustomer) return;
    await Promise.all([this.bridgeAgent.handleMessage(msg), this.bridgeCustomer.handleMessage(msg)]);
  }

  /**
   * Drain-before-finalize (plan review #1), bounded by the ~5s race (plan R3). At-most-once
   * via the `finalized` guard, so a `stop` frame and a socket-close can't double-finalize.
   * With a `stop` frame we fan it to both bridges (they FINISH-drain in handleMessage); on a
   * bare socket close we call close() directly — both paths flush + emit trailing chunks,
   * whose POSTs we then await. If the workers haven't drained within the bound, we proceed
   * and finalize on whatever landed (a wedged worker can't pin the call dark).
   */
  private async drainAndFinalize(
    stopMsg: Extract<TwilioMediaStreamMessage, { event: 'stop' }> | undefined,
  ): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const conf = this.conferenceName;
    // Stream ended before a usable start frame (no conference_name) — nothing to finalize.
    if (!conf || !this.bridgeAgent || !this.bridgeCustomer) return;

    const closes = stopMsg
      ? [this.bridgeAgent.handleMessage(stopMsg), this.bridgeCustomer.handleMessage(stopMsg)]
      : [this.bridgeAgent.close(), this.bridgeCustomer.close()];
    // FINISH both, THEN await the trailing ingest POSTs the flush emitted.
    const drain = Promise.all(closes).then(() => Promise.allSettled([...this.pending]));

    let timedOut = false;
    await Promise.race([
      drain,
      this.delay(this.drainTimeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut) {
      this.log.warn('media.drain.timeout', { callId: conf });
      // The drain is abandoned but bridge.close() awaits flush() BEFORE stt.close(), so a
      // wedged flush would leave the worker alive. Force the adapters closed directly
      // (idempotent; binding.free() SIGKILLs within 1s) so the per-call worker subprocess
      // can't outlive the call — the isolation boundary holds even on a hung decode.
      void Promise.resolve(this.adapterAgent?.close()).catch(() => {});
      void Promise.resolve(this.adapterCustomer?.close()).catch(() => {});
    }

    await this.ingest.postFinalize(conf);
  }
}

export interface MediaStreamServerOptions {
  readonly sttFactory: (callId: string) => SttAdapter;
  readonly ingest: IngestClient;
  readonly logger?: Logger;
  readonly mediaPath?: string;
  readonly drainTimeoutMs?: number;
}

export interface MediaStreamServer {
  readonly http: Server;
  /** Count of live Media Streams connections (for /healthz). */
  activeCalls(): number;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Build the HTTP + WS server around injected deps. Pure composition (no env, no
 * network) — the seam integration tests (Stage C) and unit tests drive.
 */
export function createMediaStreamServer(opts: MediaStreamServerOptions): MediaStreamServer {
  const log = opts.logger ?? new Logger();
  const mediaPath = opts.mediaPath ?? DEFAULT_MEDIA_PATH;
  const sessions = new Set<CallMediaSession>();

  const http = createServer((req, res) => {
    if (req.method === 'GET' && pathOf(req) === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', activeCalls: sessions.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  // noServer: we route upgrades ourselves so a non-media path is destroyed, not upgraded.
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOf(req) !== mediaPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const session = new CallMediaSession({
        sttFactory: opts.sttFactory,
        ingest: opts.ingest,
        logger: log,
        ...(opts.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : {}),
        onUnroutable: () => ws.close(1011, 'no conference_name'),
      });
      sessions.add(session);
      ws.on('message', (data) => {
        // Fire-and-forget per frame: one malformed/failed frame must not tear down the call.
        session.handleMessage(wsFrameToText(data)).catch(() => {});
      });
      ws.on('close', () => {
        session.close().catch(() => {});
        sessions.delete(session);
      });
    });
  });

  return {
    http,
    activeCalls: () => sessions.size,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.removeListener('error', reject);
          const addr = http.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close() {
      // `wss.close()` only stops ACCEPTING sockets; live call sockets stay open and
      // `http.close()` waits for them to drain — an upgraded WS never "drains", so this
      // would hang the SIGTERM (Render redeploy) AND leak the per-call workers. Terminate
      // each live socket first: its 'close' handler runs session.close() → worker teardown
      // (review #1).
      for (const client of wss.clients) client.terminate();
      wss.close();
      return new Promise((resolve) => http.close(() => resolve()));
    },
  };
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`).pathname;
  } catch {
    return '';
  }
}

/**
 * Build the real server from the environment and bind it. Fails CLOSED:
 * liveSttConfigFromEnv throws if NUCLEUS_STT_PYTHON / NUCLEUS_STT_WORKER are unset,
 * and the ingest client requires MAIN_INGEST_URL + STT_INGEST_SECRET — a per-call
 * spawn ENOENT or a silent unauthenticated POST later is worse than a loud boot fail.
 */
export function main(env: NodeJS.ProcessEnv = process.env): Promise<MediaStreamServer> {
  const logger = new Logger();
  const baseUrl = env['MAIN_INGEST_URL'];
  const secret = env['STT_INGEST_SECRET'];
  if (!baseUrl || !secret) {
    const missing = [!baseUrl && 'MAIN_INGEST_URL', !secret && 'STT_INGEST_SECRET'].filter(Boolean).join(', ');
    throw new Error(`media-stream-server missing required env: ${missing}`);
  }
  const sttFactory = createLiveSttFactory(liveSttConfigFromEnv(env, logger));
  const ingest = new HttpIngestClient({ baseUrl, secret, logger });
  const server = createMediaStreamServer({ sttFactory, ingest, logger });
  const port = Number(env['PORT']) || 8080;
  return server.listen(port, '0.0.0.0').then((bound) => {
    logger.info('media.server.listening', { count: bound });
    return server;
  });
}

// Run main() only when executed directly (Dockerfile CMD), never on import (tests import
// the factory). A boot failure exits non-zero so Render surfaces it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let server: MediaStreamServer | undefined;
  const shutdown = (): void => {
    void server?.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  main()
    .then((s) => {
      server = s;
    })
    .catch((err: unknown) => {
      console.error('nucleus-stt failed to start:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
