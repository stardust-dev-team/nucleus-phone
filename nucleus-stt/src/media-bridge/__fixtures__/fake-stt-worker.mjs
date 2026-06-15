// Protocol-compatible STT worker STUB for WhisperCppWorkerBinding resilience tests.
// Speaks the exact stdio framing of stt_worker.py (see that file for the spec) but does
// no transcription — so the binding's spawn/ready/FIFO/crash-restart logic can be tested
// on `node` alone, with no Python/whisper/model. NOT a production artifact.
//
// Behaviour:
//   - emits {"type":"ready"} on start
//   - AUDIO (0x01): replies one interim segment; UNLESS the first float32 ≈ 666 (exit(1) to
//     simulate a mid-call crash), ≈ 777 (reply with the WRONG seq to simulate a protocol
//     desync), or ≈ 555 (WEDGE: stop replying to ALL further AUDIO, simulating a hung decode so
//     backpressure can build) — each lets a test prove the binding's recovery/backpressure path
//   - FINISH (0x02): replies one final segment
//   - CLOSE  (0x03): exit(0)
import process from 'node:process';

const CRASH_SENTINEL = 666;
const DESYNC_SENTINEL = 777;
const STALL_SENTINEL = 555;
let stalled = false; // once wedged, AUDIO frames are consumed but never answered
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const HDR = 9; // opcode(1) + seq(4 BE) + len(4 BE)
let buf = Buffer.alloc(0);
emit({ type: 'ready' });

process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= HDR) {
    const opcode = buf.readUInt8(0);
    const seq = buf.readUInt32BE(1);
    const len = buf.readUInt32BE(5);
    if (buf.length < HDR + len) break; // wait for the full payload
    const payload = buf.subarray(HDR, HDR + len);
    buf = buf.subarray(HDR + len);

    if (opcode === 0x03) process.exit(0); // CLOSE
    if (opcode === 0x01) {
      const marker = len >= 4 ? Math.round(payload.readFloatLE(0)) : 0;
      if (marker === CRASH_SENTINEL) process.exit(1);
      if (marker === STALL_SENTINEL) stalled = true;
      if (stalled) continue; // wedged: consume the AUDIO frame but never reply (hung decode)
      const replySeq = marker === DESYNC_SENTINEL ? (seq + 1000) >>> 0 : seq; // wrong seq → desync
      emit({ type: 'segments', seq: replySeq, final: false, segments: [{ text: 'frame', t0Ms: 0, t1Ms: 20 }] });
    } else if (opcode === 0x02) {
      emit({ type: 'segments', seq, final: true, segments: [{ text: 'final', t0Ms: -10, t1Ms: 0 }] });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
