/**
 * Twilio Media Streams WebSocket message types + parsing (bead: aunshin-phone-qid.8).
 *
 * Twilio sends newline-free JSON frames over the Media Streams WS. We only care
 * about `start` (carries the media format + track list), `media` (a base64 μ-law
 * payload on a named track), and `stop`. `connected`, `mark`, and `dtmf` are
 * acknowledged and ignored.
 *
 * COMPLIANCE: the `start` event carries Twilio SIDs (accountSid, callSid,
 * streamSid). These are correlatable to a person via Twilio's own logs and MUST
 * NEVER be logged (invariant #7) — the bridge maps the stream to the internal
 * aunshin calls.id UUID and logs only that. They are typed here so the parser can
 * read them, not so they can be emitted.
 */

export interface TwilioMediaFormat {
  readonly encoding: string; // expected 'audio/x-mulaw'
  readonly sampleRate: number; // expected 8000
  readonly channels: number; // expected 1
}

export interface TwilioConnected {
  readonly event: 'connected';
  readonly protocol: string;
  readonly version: string;
}

export interface TwilioStart {
  readonly event: 'start';
  readonly sequenceNumber: string;
  readonly streamSid: string;
  readonly start: {
    readonly streamSid: string;
    readonly accountSid: string;
    readonly callSid: string;
    readonly tracks: readonly string[];
    readonly mediaFormat: TwilioMediaFormat;
    readonly customParameters?: Readonly<Record<string, string>>;
  };
}

export interface TwilioMedia {
  readonly event: 'media';
  readonly sequenceNumber: string;
  readonly streamSid: string;
  readonly media: {
    /** 'inbound' | 'outbound' — which leg this 20ms frame belongs to. */
    readonly track: string;
    readonly chunk: string;
    /** ms since stream start (string per Twilio's wire format). */
    readonly timestamp: string;
    /** base64-encoded μ-law (PCMU) payload. */
    readonly payload: string;
  };
}

export interface TwilioStop {
  readonly event: 'stop';
  readonly sequenceNumber: string;
  readonly streamSid: string;
  readonly stop: { readonly accountSid: string; readonly callSid: string };
}

export interface TwilioMark {
  readonly event: 'mark';
  readonly sequenceNumber: string;
  readonly streamSid: string;
  readonly mark: { readonly name: string };
}

export type TwilioMediaStreamMessage =
  | TwilioConnected
  | TwilioStart
  | TwilioMedia
  | TwilioStop
  | TwilioMark;

/**
 * Parse + minimally validate one Twilio frame (string or already-parsed object).
 * Returns null for malformed JSON or an unrecognized/incomplete event, so the
 * bridge can skip it without throwing on a hostile or truncated frame.
 */
export function parseTwilioMessage(raw: string | object): TwilioMediaStreamMessage | null {
  let msg: unknown;
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    msg = raw;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;

  switch (m['event']) {
    case 'connected':
      return m as unknown as TwilioConnected;
    case 'start': {
      const s = m['start'];
      if (typeof s !== 'object' || s === null) return null;
      const st = s as Record<string, unknown>;
      if (typeof st['mediaFormat'] !== 'object' || st['mediaFormat'] === null) return null;
      if (!Array.isArray(st['tracks'])) return null;
      return m as unknown as TwilioStart;
    }
    case 'media': {
      const md = m['media'];
      if (typeof md !== 'object' || md === null) return null;
      const mm = md as Record<string, unknown>;
      if (typeof mm['track'] !== 'string' || typeof mm['payload'] !== 'string') return null;
      return m as unknown as TwilioMedia;
    }
    case 'stop':
      return m as unknown as TwilioStop;
    case 'mark':
      return m as unknown as TwilioMark;
    default:
      return null;
  }
}

/** Twilio's μ-law encoding label. */
export const MULAW_ENCODING = 'audio/x-mulaw';
