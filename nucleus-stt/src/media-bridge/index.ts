/**
 * Public surface of the media-bridge (bead: aunshin-phone-qid.8).
 * Plan §Security invariants #1, #2, #7.
 *
 * Production wiring (per call) — LIVE counterparty path (qid.8 injects the moonshine binding;
 * ADR 0001 §Render-hardware confirmation). The composition root uses {@link createLiveSttFactory}
 * to hand the CallSupervisor a per-call adapter; under the hood that is:
 *   const bridge = new MediaStreamBridge(
 *     new SttWorkerAdapter(new MoonshineWorkerBinding({ pythonPath, workerScript })),
 *     { callId, onChunk: (c) => mergeBuffer.push(c) },
 *   );
 *   attachMediaStream(twilioWs, bridge);
 * The BATCH / post-call path (qid.13) uses WhisperCppWorkerBinding instead. The
 * SttWorkerAdapter is engine-neutral (it only re-anchors chunk-relative offsets to stream time).
 *
 * Tests swap SttWorkerAdapter → MockSttAdapter and drive handleMessage directly.
 */
export { MediaStreamBridge, attachMediaStream, wsFrameToText } from './media-bridge.js';
export type { MediaBridgeOptions, RawMediaSocket } from './media-bridge.js';
export {
  MockSttAdapter,
  SttWorkerAdapter,
  SAMPLE_RATE_HZ,
} from './stt-adapter.js';
export type {
  MockSttOptions,
  SttAdapter,
  SttBinding,
  SttChunk,
  SttResult,
  SttSegment,
} from './stt-adapter.js';
export {
  SttWorkerBinding,
  WhisperCppWorkerBinding,
  MoonshineWorkerBinding,
} from './stt-worker-binding.js';
export { createLiveSttFactory, liveSttConfigFromEnv } from './live-stt-factory.js';
export type { LiveSttConfig } from './live-stt-factory.js';
export type {
  SttWorkerOptions,
  SttEngine,
  WhisperCppWorkerOptions,
} from './stt-worker-binding.js';
export {
  MULAW_ENCODING,
  parseTwilioMessage,
} from './twilio-events.js';
export type {
  TwilioConnected,
  TwilioMedia,
  TwilioMediaFormat,
  TwilioMediaStreamMessage,
  TwilioStart,
  TwilioStop,
  TwilioMark,
} from './twilio-events.js';
