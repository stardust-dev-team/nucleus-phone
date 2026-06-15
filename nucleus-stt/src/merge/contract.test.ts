import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTranscriptChunk } from './contract.js';

test('isTranscriptChunk accepts a well-formed agent/customer chunk', () => {
  assert.equal(
    isTranscriptChunk({ speaker: 'agent', text: 'hi', utt_start_ms: 0, utt_end_ms: 10 }),
    true,
  );
  assert.equal(
    isTranscriptChunk({ speaker: 'customer', text: 'hello', utt_start_ms: 100, utt_end_ms: 100 }),
    true,
  );
});

test('isTranscriptChunk rejects malformed chunks', () => {
  assert.equal(isTranscriptChunk(null), false);
  assert.equal(isTranscriptChunk({ speaker: 'user', text: 'x', utt_start_ms: 0, utt_end_ms: 1 }), false); // wrong label
  assert.equal(isTranscriptChunk({ speaker: 'agent', text: 5, utt_start_ms: 0, utt_end_ms: 1 }), false); // text not string
  assert.equal(isTranscriptChunk({ speaker: 'agent', text: 'x', utt_start_ms: 10, utt_end_ms: 5 }), false); // end < start
  assert.equal(isTranscriptChunk({ speaker: 'agent', text: 'x', utt_start_ms: NaN, utt_end_ms: 1 }), false);
});
