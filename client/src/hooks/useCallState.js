import { useState, useRef, useCallback, useEffect } from 'react';
import { initiateCall, joinCall, endCall } from '../lib/api';

function toE164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (phone.startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

export default function useCallState(twilioHook) {
  const { makeCall, hangUp, status } = twilioHook;

  const [callData, setCallData] = useState(null); // { conferenceName, callId, contact }
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);

  const startTimeRef = useRef(null);

  // Timer for call duration — start on connected, stop otherwise
  useEffect(() => {
    if (status === 'connected') {
      if (!startTimeRef.current) startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    }

    if (status === 'disconnected' || status === 'ready') {
      startTimeRef.current = null;
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  const startCall = useCallback(async (contact, identity) => {
    const rawPhone = contact.properties?.phone || contact.properties?.mobilephone;
    if (!rawPhone) throw new Error('Contact has no phone number');
    const phone = toE164(rawPhone);
    if (!phone) throw new Error(`Phone "${rawPhone}" could not be converted to E.164 format`);

    const { conferenceName, callId } = await initiateCall({
      to: phone,
      contactName: `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim(),
      companyName: contact.properties.company || '',
      contactId: contact.id,
      callerIdentity: identity,
    });

    setCallData({ conferenceName, callId, contact });
    setElapsed(0);

    await makeCall({
      To: phone,
      ConferenceName: conferenceName,
      CallerIdentity: identity,
      Action: 'initiate',
    });
  }, [makeCall]);

  const joinExistingCall = useCallback(async (conferenceName, identity, muted = true) => {
    await joinCall({ conferenceName, callerIdentity: identity, muted });

    setCallData((prev) => ({ ...prev, conferenceName, joined: true }));
    setElapsed(0);

    const activeCall = await makeCall({
      ConferenceName: conferenceName,
      CallerIdentity: identity,
      Action: 'join',
      Muted: muted ? 'true' : 'false',
    });

    // Belt-and-suspenders: mute the browser mic directly via Voice SDK
    // in case the TwiML muted attribute doesn't apply reliably
    if (muted && activeCall) {
      activeCall.mute(true);
    }
  }, [makeCall]);

  const endCurrentCall = useCallback(() => {
    // If primary caller (not shadow join), end the entire conference
    // so shadow joiners get disconnected too
    if (callData?.conferenceName && !callData?.joined) {
      endCall(callData.conferenceName).catch(() => {});
    }
    hangUp();
    // callData preserved for disposition screen
  }, [hangUp, callData]);

  const clearCallData = useCallback(() => {
    setCallData(null);
    setElapsed(0);
  }, []);

  return {
    callData, elapsed, startCall, joinExistingCall, endCurrentCall, clearCallData,
  };
}
