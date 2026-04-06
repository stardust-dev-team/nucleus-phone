/**
 * lib/inflight.js — Track in-flight async operations for graceful shutdown.
 *
 * Usage:
 *   const { track } = require('./inflight');
 *   track(uploadToFireflies(url, meta));   // fire-and-forget, but tracked
 *   track(syncInteraction(payload));        // won't be orphaned on SIGTERM
 *
 * On shutdown, drain() waits up to the timeout for all tracked promises
 * to settle before allowing process.exit().
 */

const pending = new Set();

/** Track a promise. Returns the same promise for chaining. */
function track(promise) {
  if (!promise || typeof promise.then !== 'function') return promise;
  pending.add(promise);
  const cleanup = () => pending.delete(promise);
  promise.then(cleanup, cleanup);
  return promise;
}

/** Wait for all in-flight ops to settle, up to timeoutMs. */
async function drain(timeoutMs = 8000) {
  if (pending.size === 0) return;
  console.log(`inflight: draining ${pending.size} operations (${timeoutMs}ms budget)`);

  const deadline = new Promise(r => { const t = setTimeout(r, timeoutMs); t.unref(); });
  const allSettled = Promise.allSettled([...pending]);

  await Promise.race([allSettled, deadline]);

  if (pending.size > 0) {
    console.warn(`inflight: ${pending.size} operations still pending after ${timeoutMs}ms — abandoning`);
  } else {
    console.log('inflight: all operations drained');
  }
}

module.exports = { track, drain };
