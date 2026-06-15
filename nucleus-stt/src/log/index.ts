/**
 * Public surface of the PII-safe structured logger (bead: aunshin-phone-qid.6).
 * Plan §Security invariant #7.
 *
 *   import { Logger } from './log/index.js';
 *   const log = new Logger();
 *   log.info('call.start', { callId });   // callId is the internal aunshin.calls.id UUID
 *
 * Never pass the Twilio CallSid or transcript text — the logger refuses both.
 */
export { Logger, PiiInLogError } from './logger.js';
export type { LoggerOptions } from './logger.js';
export type { LogContext, LogLevel, LogSink } from './types.js';
