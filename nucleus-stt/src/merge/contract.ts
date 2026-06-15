/**
 * Transcript contract for nucleus-stt.
 *
 * Copy-forked from aunshin-phone's merge/contract.ts (bead nucleus-phone-rgja.4)
 * and trimmed to what the server-side, both-tracks bridge actually needs: the
 * chunk shape it emits. aunshin's device↔server NTP clock-sync machinery
 * (correctedAnchor / syncDeviceClock / measureRtt …) is dropped — nucleus-phone
 * transcribes BOTH legs server-side (no device feed), so there is one clock
 * domain (Twilio's per-frame stream-time) and no cross-clock correction.
 *
 * Speaker labels are the nucleus-phone domain values: the rep is `agent`
 * (Twilio outbound_track), the customer is `customer` (inbound_track). These
 * match what /api/live-analysis broadcasts and what lib/transcript-ingest.js
 * expects.
 */

export type Speaker = 'agent' | 'customer';

/**
 * A finalized transcript chunk emitted by a {@link MediaStreamBridge}.
 * `utt_start_ms`/`utt_end_ms` are ms-since-call-start (Twilio stream-time +
 * streamStartOffsetMs); ordering, if any, is by `utt_start_ms`.
 */
export interface TranscriptChunk {
  readonly speaker: Speaker;
  readonly text: string;
  /** Utterance start, ms since call start. */
  readonly utt_start_ms: number;
  /** Utterance end, ms since call start. utt_end_ms >= utt_start_ms. */
  readonly utt_end_ms: number;
}

/** Runtime guard for a chunk crossing a boundary (e.g. worker → bridge → POST). */
export function isTranscriptChunk(v: unknown): v is TranscriptChunk {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    (c['speaker'] === 'agent' || c['speaker'] === 'customer') &&
    typeof c['text'] === 'string' &&
    typeof c['utt_start_ms'] === 'number' &&
    Number.isFinite(c['utt_start_ms']) &&
    typeof c['utt_end_ms'] === 'number' &&
    Number.isFinite(c['utt_end_ms']) &&
    (c['utt_end_ms'] as number) >= (c['utt_start_ms'] as number)
  );
}
