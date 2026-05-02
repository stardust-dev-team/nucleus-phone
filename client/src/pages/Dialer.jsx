import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { formatTime } from '../lib/format';
import ContactIdentity from '../components/cockpit/ContactIdentity';
import RapportOpener from '../components/cockpit/RapportOpener';
import RapportTags from '../components/cockpit/RapportTags';
import IntelNuggets from '../components/cockpit/IntelNuggets';
import InteractionTimeline from '../components/cockpit/InteractionTimeline';
import QualScript from '../components/cockpit/QualScript';
import CompanyIntel from '../components/cockpit/CompanyIntel';
import SignalBadges from '../components/cockpit/SignalBadges';
import ProductReference from '../components/cockpit/ProductReference';

const STATUS_TEXT = {
  connecting: 'Connecting...',
  ringing: 'Ringing...',
  connected: 'Connected',
  disconnected: 'Call Ended',
};

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export default function Dialer({ identity, twilioHook, callState }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, muted, toggleMute, sendDigits } = twilioHook;
  const { callData, elapsed, endCurrentCall, clearCallData } = callState;
  const [showKeypad, setShowKeypad] = useState(false);

  // Cockpit data: prefer router state, fall back to sessionStorage (survives refresh)
  const [cockpitData] = useState(() => {
    const fromNav = location.state?.cockpitData;
    if (fromNav) {
      sessionStorage.setItem('dialer_cockpit', JSON.stringify(fromNav));
      return fromNav;
    }
    try {
      const stored = sessionStorage.getItem('dialer_cockpit');
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });

  // Navigate when disconnected + clean up cockpit cache
  useEffect(() => {
    if (status === 'disconnected' && callData) {
      sessionStorage.removeItem('dialer_cockpit');
      if (callData.joined) {
        clearCallData();
        navigate('/');
      } else {
        const timer = setTimeout(() => navigate('/complete'), 500);
        return () => clearTimeout(timer);
      }
    }
  }, [status, callData, clearCallData, navigate]);

  // No call data — clean up and redirect
  useEffect(() => {
    if (!callData) {
      sessionStorage.removeItem('dialer_cockpit');
      navigate('/');
    }
  }, [callData, navigate]);

  if (!callData) return null;

  const contact = callData.contact;
  const props = contact?.properties || {};
  const name = `${props.firstname || ''} ${props.lastname || ''}`.trim() || 'Unknown';

  return (
    <div className="relative flex flex-col h-full">
      {/* Compact call bar — always visible */}
      <div className="shrink-0 bg-jv-card border-b border-jv-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-jv-elevated flex items-center justify-center shrink-0">
              <span className="text-lg font-semibold text-jv-amber">
                {(props.firstname || '?')[0].toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <p className="font-medium truncate text-sm">{name}</p>
              <p className="text-xs text-jv-muted truncate">{props.company || ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <p className={`text-xs ${status === 'connected' ? 'text-jv-green' : 'text-jv-amber'}`}>
                {STATUS_TEXT[status] || status}
              </p>
              <p className="text-lg font-mono font-light tracking-wider">
                {formatTime(elapsed)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable content — cockpit panels or basic view */}
      <div className="flex-1 overflow-y-auto scroll-container px-4 py-4 space-y-4 pb-28">
        {cockpitData ? (
          <div
            data-theme="dark" /* Hardcoded: Dialer chrome uses jv-* dark, so panels must match */
            className="bg-cp-bg text-cp-text rounded-lg"
          >
            <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-6 px-4 py-4">
              {/* Left column — Rapport */}
              <div>
                <ContactIdentity identity={cockpitData.identity} />
                <SignalBadges domain={cockpitData.identity?.company_domain || cockpitData.companyData?.domain} />
                <RapportOpener openingLine={cockpitData.rapport?.opening_line} />
                <RapportTags tags={cockpitData.rapport?.rapport_starters} />
                <IntelNuggets
                  nuggets={cockpitData.rapport?.intel_nuggets}
                  watchOuts={cockpitData.rapport?.watch_outs}
                />
                <InteractionTimeline
                  interactionHistory={cockpitData.interactionHistory}
                  priorCalls={cockpitData.priorCalls}
                />
              </div>
              {/* Right column — Business */}
              <div>
                <QualScript adaptedScript={cockpitData.rapport?.adapted_script} />
                <CompanyIntel
                  companyData={cockpitData.companyData}
                  icpScore={cockpitData.icpScore}
                  pipelineData={cockpitData.pipelineData}
                />
                <ProductReference productReference={cockpitData.rapport?.product_reference} />
              </div>
            </div>
          </div>
        ) : (
          /* Fallback: basic call screen for quick-dial / shadow joins */
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-20 h-20 rounded-full bg-jv-elevated flex items-center justify-center mb-4">
              <span className="text-3xl font-semibold text-jv-amber">
                {(props.firstname || '?')[0].toUpperCase()}
              </span>
            </div>
            <h2 className="text-xl font-semibold">{name}</h2>
            <p className="text-jv-muted">{props.company || ''}</p>
            <p className="text-sm text-jv-muted mt-1">{props.phone || props.mobilephone || ''}</p>
          </div>
        )}
      </div>

      {/* Keypad overlay */}
      {showKeypad && (
        <div className="fixed inset-0 bg-jv-bg/95 flex items-center justify-center z-10">
          <div className="text-center">
            <div className="grid grid-cols-3 gap-3 w-56 mb-6">
              {DIGITS.map((d) => (
                <button
                  key={d}
                  onClick={() => sendDigits(d)}
                  className="w-16 h-16 rounded-full bg-jv-elevated text-xl font-medium flex items-center justify-center hover:bg-jv-card transition-colors mx-auto"
                >
                  {d}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowKeypad(false)}
              className="text-sm text-jv-muted hover:text-white"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Sticky bottom controls */}
      <div className="sticky bottom-0 bg-jv-bg border-t border-jv-border px-4 py-3">
        <div className="flex justify-center gap-6">
          {/* Mute */}
          <button
            onClick={toggleMute}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              muted ? 'bg-jv-red/20 text-jv-red' : 'bg-jv-elevated text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              {muted ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              )}
            </svg>
          </button>

          {/* Keypad toggle */}
          <button
            onClick={() => setShowKeypad(!showKeypad)}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              showKeypad ? 'bg-jv-amber/20 text-jv-amber' : 'bg-jv-elevated text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
            </svg>
          </button>

          {/* End call */}
          <button
            onClick={endCurrentCall}
            className="w-14 h-14 rounded-full bg-jv-red flex items-center justify-center hover:bg-red-600 transition-colors"
          >
            <svg className="w-7 h-7 text-white rotate-[135deg]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
