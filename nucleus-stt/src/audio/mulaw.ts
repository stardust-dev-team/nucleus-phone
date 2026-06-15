/**
 * G.711 μ-law (PCMU) decode (bead: aunshin-phone-9gt).
 * Plan §Security invariant #1: counterparty audio is decoded IN MEMORY ONLY —
 * never a temp file. This module is the in-memory decode primitive the
 * media-bridge (qid.8) feeds straight into the streaming STT adapter; the
 * decoded PCM lives only as a transient typed array and is never written to disk.
 *
 * Twilio Media Streams deliver counterparty audio as base64'd 8 kHz μ-law
 * (PCMU) frames. STT engines (whisper.cpp) want linear PCM — Int16 or, for
 * whisper, Float32 normalized to [-1, 1]. This is the canonical Sun/ITU-T G.711
 * decode: complement, un-bias, segment-shift.
 *
 * `═══ no-tempfile enforcement (P2 hardening, this bead's other half) ═══`
 * The PROGRAMMATIC part — the overshoot clamp — is here now. The OS-level
 * guarantee that the STT subprocess physically cannot open a temp file
 * (seccomp on Linux / Landlock LSM / a read-only-/tmp mount in the container)
 * is platform-specific and lands with the media-bridge deployment. See the
 * documented TODO + test stub in `mulaw.test.ts` and `counterparty-audio.test.ts`.
 */

// Canonical G.711 constants (Sun reference implementation).
const BIAS = 0x84; // 132 — the add-in bias for 16-bit samples
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_MASK = 0x70;
const SEG_SHIFT = 4;

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

/** Clamp to the signed-16-bit fixed-point boundary. */
function clampInt16(s: number): number {
  return s < INT16_MIN ? INT16_MIN : s > INT16_MAX ? INT16_MAX : s;
}

/** Clamp to the unit interval [-1, 1] (the float-sample boundary whisper expects). */
export function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/**
 * Decode a single μ-law byte (0–255) to a linear PCM Int16 sample.
 *
 * Canonical μ-law never decodes beyond ±32124, comfortably inside Int16 — but we
 * still clamp at the fixed-point boundary so a malformed or sign-extended byte
 * can't yield an out-of-range number that a downstream `Int16Array` store would
 * silently WRAP (e.g. 32768 → −32768, a loud audio glitch). The clamp is the
 * "overshoot clamp at the fixed-point boundary" this bead calls for.
 */
export function decodeMulawByte(uByte: number): number {
  const u = ~uByte & 0xff; // complement to obtain the normal μ-law value
  let t = ((u & QUANT_MASK) << 3) + BIAS;
  t <<= (u & SEG_MASK) >> SEG_SHIFT;
  const sample = u & SIGN_BIT ? BIAS - t : t - BIAS;
  return clampInt16(sample);
}

/** Decode a μ-law frame buffer to linear PCM Int16. Allocates one output array. */
export function decodeMulaw(frames: Uint8Array): Int16Array {
  const out = new Int16Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    // frames[i] is always in [0,255] (Uint8Array); the `!` satisfies
    // noUncheckedIndexedAccess without a runtime branch in the hot loop.
    out[i] = decodeMulawByte(frames[i]!);
  }
  return out;
}

/**
 * Normalize a (possibly out-of-range) fixed-point sample to a unit Float32 in
 * [-1, 1]. Divides by 32768 so INT16_MIN maps to exactly −1.0; the
 * {@link clampUnit} guard catches any caller that hands in a sample beyond the
 * boundary (the overshoot case). Float32, not Float64 — whisper.cpp ingests
 * `pcmf32`.
 */
export function pcm16SampleToUnitFloat(s: number): number {
  return clampUnit(s / 32768);
}

/** Decode a μ-law frame buffer straight to whisper-ready Float32 PCM in [-1, 1]. */
export function decodeMulawToFloat32(frames: Uint8Array): Float32Array {
  const out = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    out[i] = pcm16SampleToUnitFloat(decodeMulawByte(frames[i]!));
  }
  return out;
}
