/**
 * PII-safe structured logging — types (bead: aunshin-phone-qid.6).
 * Plan §Security invariant #7: log lines carry the internal `calls.id` UUID ONLY
 * — never the Twilio CallSid, never transcript text.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The allowlist of fields a log line may carry. Every field is a short,
 * non-PII operational value.
 *
 * There is deliberately NO field for free text / transcript / message body:
 * the only way to attach data to a log line is through this typed allowlist, so
 * transcript content has no *structural* path into the logs (the primary control
 * behind invariant #7). The runtime guards in {@link Logger} are defense-in-depth
 * on top of this — they catch a Twilio SID or an over-long string that a careless
 * call site tries to push through one of these fields anyway.
 *
 * `callId`/`userId` are the INTERNAL `aunshin.calls.id` / `aunshin.users.id`
 * UUIDs — never the Twilio CallSid. The id↔person mapping lives only in
 * `aunshin.audit_log` (src/db/data-store.ts).
 */
export interface LogContext {
  /** Internal aunshin.calls.id (UUID). NEVER the Twilio CallSid. */
  readonly callId?: string;
  /** Internal aunshin.users.id (UUID). */
  readonly userId?: string;
  /** Which side of the call an event concerns. */
  readonly speaker?: 'user' | 'counterparty';
  /** Outbound host, for allowlist diagnostics (e.g. 'api.anthropic.com'). */
  readonly host?: string;
  /** Short status / error code (e.g. 'stt_timeout', 'ws_closed'). */
  readonly code?: string;
  /** Latency of an operation, milliseconds. */
  readonly latencyMs?: number;
  /** Duration of an operation, milliseconds. */
  readonly durationMs?: number;
  /** Utterance offset of a late merge-arrival that was dropped (P4). */
  readonly droppedMs?: number;
  /** A small operational count (e.g. retries, buffered chunks). */
  readonly count?: number;
}

/** A destination for a finished, serialized log line. */
export type LogSink = (line: string) => void;
