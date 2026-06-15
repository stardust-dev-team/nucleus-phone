/**
 * Ingest client: the cross-service hop from nucleus-stt back to the main
 * nucleus-phone service's `/api/stt-ingest` (bead nucleus-phone-rgja.5, Stage B2).
 *
 * Each finalized {@link TranscriptChunk} a {@link MediaStreamBridge} emits is POSTed
 * here, and a single `finalize` is POSTed when a call's stream ends. This is the one
 * network hop the original Twilio-RT webhook never had (Twilio POSTed straight into
 * the main service), so it carries what that hop needs to survive a transient blip:
 *   - **retry** on a network error or a 5xx (the main service redeploying / a brief
 *     blip) with a bounded backoff;
 *   - a **dead-letter log** when retries are exhausted, so a dropped chunk is visible
 *     in ops instead of silently lost.
 * A 4xx is NOT retried — it is a stable client/config error (bad bearer = 401, unknown
 * conference = 404, gate-off shadow path = 4xx); retrying can't fix it, so it goes
 * straight to the dead-letter log.
 *
 * NEITHER method throws: the per-call drain orchestration in media-stream-server.ts
 * awaits these, and a throw there would wedge the finalize. A permanently-failing POST
 * dead-letters and resolves — the call still finalizes on whatever landed.
 *
 * PII (invariant #7): the dead-letter log carries the conference_name (the allowed
 * `callId`) + an HTTP status `code` + an attempt `count` ONLY — never the transcript
 * text. The text lives only in the request body, never in a log line.
 */
import { Logger } from './log/index.js';
import type { TranscriptChunk } from './merge/contract.js';

/** The seam the per-call orchestration posts through. Mock it in unit tests. */
export interface IngestClient {
  /** POST one finalized chunk. Resolves even on permanent failure (dead-lettered). */
  postChunk(conferenceName: string, chunk: TranscriptChunk): Promise<void>;
  /** POST the idempotent end-of-call finalize. Resolves even on permanent failure. */
  postFinalize(conferenceName: string): Promise<void>;
}

/** Minimal `fetch` shape so tests inject a fake without DOM/undici types. */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface HttpIngestClientOptions {
  /** Base URL of the main nucleus-phone service (MAIN_INGEST_URL), no trailing slash. */
  readonly baseUrl: string;
  /** Shared service-to-service bearer (STT_INGEST_SECRET); mirrors the main apiKeyAuth. */
  readonly secret: string;
  /** Injectable fetch (default global fetch). */
  readonly fetchFn?: FetchFn;
  /** Total attempts for a retryable failure (network / 5xx). Default 3. */
  readonly maxAttempts?: number;
  /** Backoff before retry N (ms). Injectable for deterministic tests. Default expo 200·2^n. */
  readonly delay?: (ms: number) => Promise<void>;
  /** PII-safe logger. Default a new {@link Logger}. */
  readonly logger?: Logger;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class HttpIngestClient implements IngestClient {
  private readonly endpoint: string;
  private readonly secret: string;
  private readonly fetchFn: FetchFn;
  private readonly maxAttempts: number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: Logger;

  constructor(opts: HttpIngestClientOptions) {
    // Trim a trailing slash so `${baseUrl}/api/stt-ingest` never double-slashes.
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/api/stt-ingest`;
    this.secret = opts.secret;
    // The cast is sound, not lazy: the real `fetch` returns a `Response` whose `ok`/`status`
    // superset the tiny {ok,status} shape FetchFn needs — we deliberately avoid pulling in
    // DOM/undici lib types for a two-field read.
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchFn>);
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.logger ?? new Logger();
  }

  postChunk(conferenceName: string, chunk: TranscriptChunk): Promise<void> {
    // Only finalized chunks reach a bridge's onChunk (emit() drops interim), so isFinal
    // is structurally true here; sent explicitly so the main-service ingest contract is
    // stable if an interim path is ever added.
    return this.post('chunk', conferenceName, {
      conferenceName,
      text: chunk.text,
      speaker: chunk.speaker,
      isFinal: true,
      uttStartMs: chunk.utt_start_ms,
      uttEndMs: chunk.utt_end_ms,
    });
  }

  postFinalize(conferenceName: string): Promise<void> {
    return this.post('finalize', conferenceName, { conferenceName, event: 'finalize' });
  }

  /**
   * POST with bounded retry. Retries a network throw or a 5xx; a 4xx is a stable
   * client/config error (bad bearer, unknown conference, gate-off) and dead-letters
   * without retry. Always resolves.
   */
  private async post(kind: 'chunk' | 'finalize', conferenceName: string, body: object): Promise<void> {
    const payload = JSON.stringify(body);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchFn(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
          body: payload,
        });
        if (res.ok) return;
        if (res.status < 500) {
          // 4xx — retrying won't help. Dead-letter immediately.
          this.deadLetter(kind, conferenceName, String(res.status), attempt);
          return;
        }
        // 5xx — fall through to retry/backoff.
        if (attempt >= this.maxAttempts) {
          this.deadLetter(kind, conferenceName, String(res.status), attempt);
          return;
        }
      } catch {
        // Network-level failure (DNS, connection reset, main service down).
        if (attempt >= this.maxAttempts) {
          this.deadLetter(kind, conferenceName, 'network', attempt);
          return;
        }
      }
      await this.delay(200 * 2 ** (attempt - 1));
    }
  }

  /** PII-safe: conference_name (callId) + status code + attempt count only — never text. */
  private deadLetter(kind: string, conferenceName: string, code: string, attempts: number): void {
    this.log.error(`ingest.deadletter.${kind}`, { callId: conferenceName, code, count: attempts });
  }
}
