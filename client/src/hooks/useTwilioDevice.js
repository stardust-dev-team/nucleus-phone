import { useState, useEffect, useRef, useCallback } from 'react';
import { Device } from '@twilio/voice-sdk';
import { getToken } from '../lib/api';

// Backstop for a stuck reconnect. The SDK normally resolves a network blip with
// `reconnected` or gives up with `disconnect` well within this window; the watchdog
// only fires in the pathological case where it does NEITHER, so the UI can't freeze
// on a dead call. Deliberately longer than the SDK's own media-reconnect timeout so
// we never preempt a recovery that was still in progress.
const RECONNECT_WATCHDOG_MS = 30000;

export default function useTwilioDevice(identity) {
  const [device, setDevice] = useState(null);
  const [call, setCall] = useState(null);
  const [status, setStatus] = useState('initializing');
  const deviceRef = useRef(null);
  const reconnectWatchdogRef = useRef(null);

  useEffect(() => {
    if (!identity) return;

    let destroyed = false;
    let gestureHandler = null;

    async function init() {
      try {
        const { token } = await getToken(identity);

        if (destroyed) return;

        const dev = new Device(token, {
          edge: 'ashburn',
          logLevel: 'warn',
        });

        dev.on('registered', () => {
          if (!destroyed) setStatus('ready');
        });

        let reregisterAttempts = 0;
        const MAX_REREGISTER = 4;

        dev.on('unregistered', () => {
          if (destroyed) return;
          reregisterAttempts++;
          if (reregisterAttempts > MAX_REREGISTER) {
            console.error(`Twilio Device: gave up after ${MAX_REREGISTER} re-register attempts`);
            setStatus('error');
            return;
          }
          const delay = Math.min(2000 * Math.pow(2, reregisterAttempts - 1), 30000);
          console.warn(`Twilio Device unregistered, attempt ${reregisterAttempts}/${MAX_REREGISTER} in ${delay}ms`);
          setStatus('initializing');
          setTimeout(async () => {
            if (destroyed) return;
            try {
              const { token: freshToken } = await getToken(identity);
              dev.updateToken(freshToken);
              await dev.register();
              reregisterAttempts = 0; // reset on success
            } catch (err) {
              console.error('Re-register failed:', err);
              if (!destroyed) setStatus('error');
            }
          }, delay);
        });

        dev.on('error', (err) => {
          console.error('Twilio Device error:', err);
          if (!destroyed) setStatus('error');
        });

        // tokenWillExpire fires once ~10s before Twilio considers the JWT
        // expired. The single-attempt refresh that lived here pre-ln18
        // would set status='error' on the first network blip — a mid-deploy
        // 502 from nucleus-tristar at hour 23 of a shift would end Britt's
        // queue, with no operator-visible recourse besides reload. Mirror
        // the `unregistered` handler's exponential backoff: 4 attempts,
        // 2s/4s/8s/16s, capped at 30s. On total failure the natural
        // unregister chain still fires once Twilio actually drops the
        // token — that handler retries again from zero. Two layers of
        // recovery, both bounded.
        let refreshAttempts = 0;
        const MAX_REFRESH = 4;

        async function attemptRefresh() {
          if (destroyed) return;
          try {
            const { token: newToken } = await getToken(identity);
            dev.updateToken(newToken);
            refreshAttempts = 0; // reset on success
          } catch (err) {
            refreshAttempts++;
            if (refreshAttempts > MAX_REFRESH) {
              console.error(`Token refresh: gave up after ${MAX_REFRESH} attempts`, err);
              // Don't flip to 'error' here — the natural token-expiry →
              // unregistered chain will fire and run its own 4-attempt
              // backoff. Setting 'error' now would hide that this is a
              // refresh issue (the device is still operational for ~10s).
              return;
            }
            const delay = Math.min(2000 * Math.pow(2, refreshAttempts - 1), 30000);
            console.warn(`Token refresh failed, attempt ${refreshAttempts}/${MAX_REFRESH} in ${delay}ms:`, err.message || err);
            setTimeout(attemptRefresh, delay);
          }
        }

        dev.on('tokenWillExpire', attemptRefresh);

        deviceRef.current = dev;
        if (!destroyed) setDevice(dev);

        // Browsers block AudioContext until a user gesture. Register
        // immediately if a gesture has already occurred, otherwise
        // wait for the first click/tap before calling register().
        async function doRegister() {
          try {
            await dev.register();
          } catch (err) {
            console.error('Device register failed:', err);
            if (!destroyed) setStatus('error');
          }
        }

        if (navigator.userActivation?.hasBeenActive) {
          await doRegister();
        } else {
          gestureHandler = () => doRegister();
          document.addEventListener('click', gestureHandler, { once: true });
        }
      } catch (err) {
        console.error('Device init failed:', err);
        if (!destroyed) setStatus('error');
      }
    }

    init();

    return () => {
      destroyed = true;
      clearTimeout(reconnectWatchdogRef.current);
      reconnectWatchdogRef.current = null;
      if (gestureHandler) {
        document.removeEventListener('click', gestureHandler);
      }
      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }
    };
  }, [identity]);

  const makeCall = useCallback(async (params) => {
    if (!deviceRef.current) throw new Error('Device not ready');

    setStatus('connecting');

    const activeCall = await deviceRef.current.connect({ params });

    activeCall.on('ringing', (hasEarlyMedia) => {
      setStatus(hasEarlyMedia ? 'ringing' : 'connecting');
    });

    activeCall.on('accept', () => setStatus('connected'));

    activeCall.on('mute', (isMuted) => {
      setMuted(isMuted);
    });

    activeCall.on('disconnect', () => {
      clearTimeout(reconnectWatchdogRef.current);
      reconnectWatchdogRef.current = null;
      setStatus('disconnected');
      setCall(null);
      // Reset to ready after a brief pause so Dialer can detect 'disconnected'
      // and navigate to CallComplete before we flip back
      setTimeout(() => setStatus('ready'), 1500);
    });

    activeCall.on('cancel', () => {
      clearTimeout(reconnectWatchdogRef.current);
      reconnectWatchdogRef.current = null;
      setStatus('ready');
      setCall(null);
    });

    // Twilio fires Call `error` for transient, recoverable conditions (ICE/media
    // renegotiation, the 31xxx/53xxx signaling warnings) as well as fatal ones. We do
    // NOT classify by code — that list is unstable and was internally inconsistent with
    // the SDK's own reconnect machinery. The old code flipped EVERY error to status
    // 'error', which knocked callPhase out of 'active' and tore the live-analysis socket
    // down mid-call (close(1000, 'disabled')) while the voice call itself recovered.
    // Now: log every error, let the SDK recover (reconnecting → reconnected), and rely on
    // `disconnect` to end the call. Note: the reconnect watchdog below is armed only by
    // the `reconnecting` event, so it backstops a stuck reconnect — NOT the rarer case of
    // an error that fires neither `reconnecting` nor `disconnect` (uncovered today; the
    // SDK routes media/signaling failures through one of those events in practice).
    activeCall.on('error', (err) => {
      console.warn('Call error (logged; recovery handled by reconnect/disconnect):', err?.code, err?.message || err);
    });

    // Network blip: the SDK is renegotiating media/signaling. Keep the call 'connected'
    // through the blip (don't downgrade callPhase) so transcription survives — but arm a
    // watchdog so a reconnect that never resolves can't leave the UI frozen on a dead call.
    activeCall.on('reconnecting', (err) => {
      console.warn('Call reconnecting:', err?.code, err?.message || err);
      clearTimeout(reconnectWatchdogRef.current);
      reconnectWatchdogRef.current = setTimeout(() => {
        reconnectWatchdogRef.current = null;
        // Only intervene if the SDK is genuinely still stuck — not if it quietly
        // recovered ('open') or already ended ('closed') without clearing the timer.
        const state = activeCall.status();
        if (state !== 'open' && state !== 'closed') {
          console.error('Call reconnect timed out — forcing disconnect');
          activeCall.disconnect(); // fires 'disconnect' → the normal teardown path
        }
      }, RECONNECT_WATCHDOG_MS);
    });

    activeCall.on('reconnected', () => {
      console.log('Call reconnected');
      clearTimeout(reconnectWatchdogRef.current);
      reconnectWatchdogRef.current = null;
      // Guard against a late `reconnected` resurrecting a call that already ended:
      // only re-assert 'connected' if the SDK call is genuinely open.
      if (activeCall.status() === 'open') setStatus('connected');
    });

    setCall(activeCall);
    return activeCall;
  }, []);

  const hangUp = useCallback(() => {
    if (call) call.disconnect();
  }, [call]);

  const [muted, setMuted] = useState(false);

  const toggleMute = useCallback(() => {
    if (call) {
      // Read from the Twilio Call object, not React state — avoids stale
      // closure when rapid double-taps outpace React renders.
      const nowMuted = call.isMuted();
      call.mute(!nowMuted);
      setMuted(!nowMuted);
      return !nowMuted;
    }
    return false;
  }, [call]);

  // Reset mute state when call ends
  useEffect(() => {
    if (!call) setMuted(false);
  }, [call]);

  const sendDigits = useCallback((digits) => {
    if (call) call.sendDigits(digits);
  }, [call]);

  return { device, call, status, setStatus, muted, makeCall, hangUp, toggleMute, sendDigits };
}
