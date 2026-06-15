/**
 * PII-safe structured logger (bead: aunshin-phone-qid.6).
 * Plan §Security invariant #7.
 *
 * Emits one JSON object per log line, built ONLY from an allowlist of short
 * operational fields ({@link LogContext}). Three runtime guards enforce the
 * "no linkable PII" invariant as defense-in-depth over that structural allowlist:
 *
 *   1. callId / userId is a capped, SID-free string (nucleus-phone fork: the
 *      callId is the conference_name like `nucleus-call-<uuid>`, not a bare
 *      UUID). A Twilio CallSid is refused by guard #2; free text by the cap (#3).
 *   2. NO string value anywhere — a field OR the event name — may contain a
 *      Twilio SID (CallSid, AccountSid, RecordingSid, …): two letters + 32 hex.
 *   3. String fields are length-capped: short operational tokens pass, long
 *      free text (the shape of transcript content) is refused.
 *
 * On a violation the logger THROWS {@link PiiInLogError} and emits NOTHING —
 * fail-closed. For a security invariant during the foundation phase we prefer
 * fail-loud (a leaking call site surfaces in CI) over silent redaction (which
 * can hide the leak). This is a revisitable policy — see the bead discussion.
 */
import type { LogContext, LogLevel, LogSink } from './types.js';

export class PiiInLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiiInLogError';
  }
}

/**
 * A Twilio SID: a two-letter type prefix (CA call, AC account, RE recording, …)
 * followed by 32 hex. Matched ANYWHERE in the string — deliberately NOT anchored
 * with `\b`: a deny-filter must catch a SID even when it is glued to other
 * characters (`twilio_CAxxxx…_failed`) or embedded in a longer hex blob, not
 * exempt it. Case-insensitive to catch lowercased copies. Over-matching here is
 * safe-side (a false rejection, never a leak); UUIDs never reach this guard.
 */
const TWILIO_SID_RE = /[A-Za-z]{2}[0-9a-f]{32}/i;

/**
 * Allowlisted short-string keys (SID- and length-checked). nucleus-phone fork
 * (rgja.4): `callId` is the conference_name (e.g. `nucleus-call-<uuid>`), NOT a
 * bare UUID, so it's validated as a capped, SID-free string rather than a UUID —
 * the real threat (logging a Twilio CallSid) is still refused by assertNoSid.
 */
const STRING_KEYS = ['callId', 'userId', 'speaker', 'host', 'code'] as const;
/** Allowlisted numeric keys (emitted as-is). */
const NUMBER_KEYS = ['latencyMs', 'durationMs', 'droppedMs', 'count'] as const;

/**
 * Per-key max string length. Operational tokens are short; a tight per-key cap
 * shrinks the window for hiding free text (transcript fragments) in a field to
 * near zero. `host` gets DNS-name headroom; everything else is small.
 * NB: the cap is a defense-in-depth BACKSTOP — the PRIMARY control against
 * transcript text is structural (LogContext has no text field). Sub-cap text in
 * an operational field is still possible only via deliberate misuse.
 */
const STRING_KEY_MAX: Record<(typeof STRING_KEYS)[number], number> = {
  callId: 64,
  userId: 64,
  speaker: 16,
  code: 64,
  host: 253,
};
const EVENT_MAX = 64;

export interface LoggerOptions {
  /** Where finished lines go. Default: a single JSON line to stdout. */
  readonly sink?: LogSink;
  /** Timestamp source (injectable for deterministic tests). */
  readonly now?: () => string;
  /** Optional global ceiling applied on top of the per-key caps (takes the min). */
  readonly maxFieldLen?: number;
}

export class Logger {
  private readonly sink: LogSink;
  private readonly now: () => string;
  private readonly maxFieldLen: number | undefined;

  constructor(opts: LoggerOptions = {}) {
    this.sink = opts.sink ?? ((line) => process.stdout.write(line + '\n'));
    this.now = opts.now ?? (() => new Date().toISOString());
    this.maxFieldLen = opts.maxFieldLen;
  }

  debug(event: string, ctx?: LogContext): void {
    this.emit('debug', event, ctx);
  }
  info(event: string, ctx?: LogContext): void {
    this.emit('info', event, ctx);
  }
  warn(event: string, ctx?: LogContext): void {
    this.emit('warn', event, ctx);
  }
  error(event: string, ctx?: LogContext): void {
    this.emit('error', event, ctx);
  }

  private emit(level: LogLevel, event: string, ctx?: LogContext): void {
    this.assertNoSid('event', event);
    this.assertLen('event', event, EVENT_MAX);

    const record: Record<string, unknown> = {
      ts: this.now(),
      level,
      event,
    };

    if (ctx) {
      for (const key of STRING_KEYS) {
        const v = ctx[key];
        if (v === undefined) continue;
        // typeof guard: the runtime deny-filters exist for UNtyped call sites
        // (`as any` / plain JS), so a non-string in a string field is refused
        // rather than coerced — coercion would defeat the SID/length checks.
        if (typeof v !== 'string') {
          throw new PiiInLogError(`log field "${key}" must be a string`);
        }
        this.assertNoSid(key, v);
        this.assertLen(key, v, STRING_KEY_MAX[key]);
        record[key] = v;
      }
      for (const key of NUMBER_KEYS) {
        const v = ctx[key];
        if (v === undefined) continue;
        // The number path skips the string deny-filters, so it must prove the
        // value really is a finite number — otherwise an untyped caller could
        // route free text (or NaN/Infinity) through it unchecked.
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new PiiInLogError(`log field "${key}" must be a finite number`);
        }
        record[key] = v;
      }
      // Any other key is non-allowlisted and is dropped (never emitted).
    }

    this.sink(JSON.stringify(record));
  }

  private assertNoSid(where: string, value: string): void {
    if (TWILIO_SID_RE.test(value)) {
      throw new PiiInLogError(`log ${where} contains a Twilio SID — refused (invariant #7)`);
    }
  }

  private assertLen(where: string, value: string, keyMax: number): void {
    const cap = this.maxFieldLen !== undefined ? Math.min(keyMax, this.maxFieldLen) : keyMax;
    if (value.length > cap) {
      throw new PiiInLogError(
        `log ${where} is ${value.length} chars (> ${cap}) — refused; ` +
          `structured logs carry short operational tokens only, never free text`,
      );
    }
  }
}
