/**
 * μ-law decode tests (bead: aunshin-phone-9gt). Table-tested against canonical
 * G.711 reference anchors PLUS structural invariants that don't depend on a
 * hardcoded table (so the test can't pass vacuously against a wrong decoder).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INT16_MAX,
  INT16_MIN,
  clampUnit,
  decodeMulaw,
  decodeMulawByte,
  decodeMulawToFloat32,
  pcm16SampleToUnitFloat,
} from './mulaw.js';

// ── canonical reference anchors (independently published G.711 values) ────────

test('decodes the four canonical μ-law anchor codes', () => {
  assert.equal(decodeMulawByte(0x00), -32124); // max-magnitude negative
  assert.equal(decodeMulawByte(0x80), 32124); // max-magnitude positive
  assert.equal(decodeMulawByte(0xff), 0); // +0
  assert.equal(decodeMulawByte(0x7f), 0); // −0 (both zero codes decode to 0)
});

// ── structural invariants (do not depend on the reference table) ──────────────

test('the sign bit mirrors magnitude: decode(b) === -decode(b ^ 0x80) for all bytes', () => {
  // `+ 0` normalizes the IEEE-754 negative zero that negating +0 produces, so
  // the two zero codes (0x7f/0xff) compare equal under assert's Object.is.
  for (let b = 0; b < 256; b++) {
    assert.equal(decodeMulawByte(b) + 0, -decodeMulawByte(b ^ 0x80) + 0, `byte ${b}`);
  }
});

test('every decoded sample stays within the Int16 fixed-point boundary', () => {
  for (let b = 0; b < 256; b++) {
    const s = decodeMulawByte(b);
    assert.ok(s >= INT16_MIN && s <= INT16_MAX, `byte ${b} -> ${s} out of range`);
  }
});

test('bytes 0x00..0x7f are non-positive, 0x80..0xff are non-negative', () => {
  for (let b = 0x00; b <= 0x7f; b++) assert.ok(decodeMulawByte(b) <= 0, `byte ${b}`);
  for (let b = 0x80; b <= 0xff; b++) assert.ok(decodeMulawByte(b) >= 0, `byte ${b}`);
});

// ── buffer decode ─────────────────────────────────────────────────────────────

test('decodeMulaw decodes a frame buffer element-wise into Int16Array', () => {
  const frames = Uint8Array.from([0x00, 0x80, 0xff, 0x7f]);
  const pcm = decodeMulaw(frames);
  assert.ok(pcm instanceof Int16Array);
  assert.deepEqual(Array.from(pcm), [-32124, 32124, 0, 0]);
});

// ── overshoot clamp at the fixed-point boundary ───────────────────────────────

test('pcm16SampleToUnitFloat normalizes by 32768 (INT16_MIN -> exactly -1.0)', () => {
  assert.equal(pcm16SampleToUnitFloat(INT16_MIN), -1);
  assert.equal(pcm16SampleToUnitFloat(0), 0);
  assert.equal(pcm16SampleToUnitFloat(16384), 0.5);
});

test('overshoot clamp: out-of-boundary samples saturate to ±1.0, never wrap', () => {
  assert.equal(pcm16SampleToUnitFloat(-40000), -1); // below the boundary
  assert.equal(pcm16SampleToUnitFloat(40000), 1); // above the boundary
  assert.equal(clampUnit(1.0001), 1);
  assert.equal(clampUnit(-1.0001), -1);
});

test('decodeMulawToFloat32 produces whisper-ready unit floats in [-1, 1]', () => {
  const frames = Uint8Array.from([0x00, 0x80, 0xff]);
  const f = decodeMulawToFloat32(frames);
  assert.ok(f instanceof Float32Array);
  for (const x of f) assert.ok(x >= -1 && x <= 1);
  // -32124/32768 ≈ -0.98, +32124/32768 ≈ +0.98, 0
  assert.ok(Math.abs((f[0] ?? 0) - -32124 / 32768) < 1e-6);
  assert.ok(Math.abs((f[1] ?? 0) - 32124 / 32768) < 1e-6);
  assert.equal(f[2], 0);
});

// ── no-tempfile enforcement (P2 hardening) — documented stub ──────────────────

test('TODO(P2): STT subprocess cannot open a temp file (seccomp/Landlock/ro-/tmp)', () => {
  // Placeholder until the media-bridge deploys the STT subprocess. The
  // PROGRAMMATIC half of 9gt (the overshoot clamp above) is done; the OS-level
  // guarantee that the whisper.cpp process physically cannot write /tmp during
  // inference is platform-specific (Linux seccomp syscall filter / Landlock LSM
  // / read-only /tmp mount in the container) and is asserted at deploy time.
  // This test is the landing spot for that assertion. See plan §Security #1.
  assert.ok(true);
});
