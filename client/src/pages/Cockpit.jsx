import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useCockpit from '../hooks/useCockpit';
import useCockpitTheme from '../hooks/useCockpitTheme';
import useScoreboard from '../hooks/useScoreboard';
import usePracticeScoreboard from '../hooks/usePracticeScoreboard';
import { SIM_ID_PREFIX } from '../lib/constants';
import CockpitHeader from '../components/cockpit/CockpitHeader';
import ContactIdentity from '../components/cockpit/ContactIdentity';
import RapportOpener from '../components/cockpit/RapportOpener';
import RapportTags from '../components/cockpit/RapportTags';
import IntelNuggets from '../components/cockpit/IntelNuggets';
import InteractionTimeline from '../components/cockpit/InteractionTimeline';
import QualScript from '../components/cockpit/QualScript';
import CompanyIntel from '../components/cockpit/CompanyIntel';
import ProductReference from '../components/cockpit/ProductReference';
import LiveAnalysis from '../components/cockpit/LiveAnalysis';
import CallControls from '../components/cockpit/CallControls';
import PracticeCallButton from '../components/cockpit/PracticeCallButton';
import PracticeHistory from '../components/cockpit/PracticeHistory';
import useLiveAnalysis from '../hooks/useLiveAnalysis';

function deriveCallPhase(twilioStatus, callData) {
  if (twilioStatus === 'connecting' || twilioStatus === 'ringing' || twilioStatus === 'connected')
    return 'active';
  if (callData && (twilioStatus === 'disconnected' || twilioStatus === 'ready'))
    return 'post';
  return 'pre';
}

function Skeleton() {
  return (
    <div className="space-y-2 p-4 animate-pulse">
      <div className="h-10 rounded-lg bg-cp-card" />
      <div className="h-16 rounded-lg" style={{ background: 'var(--cockpit-amber-50)' }} />
      <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-3">
        <div className="h-40 rounded-lg bg-cp-card min-w-0" />
        <div className="h-40 rounded-lg bg-cp-card min-w-0" />
      </div>
    </div>
  );
}

export default function Cockpit({ identity, callState, twilioStatus, forcedId }) {
  const params = useParams();
  const id = forcedId || params.id;
  const navigate = useNavigate();
  const isPractice = id?.startsWith(SIM_ID_PREFIX);
  const { data, loading, error, refreshing, refresh } = useCockpit(id);
  const { theme, toggle } = useCockpitTheme();
  const scoreboard = useScoreboard();
  const practiceBoard = usePracticeScoreboard(isPractice);
  const [historyKey, setHistoryKey] = useState(0);
  const [activeSimCallId, setActiveSimCallId] = useState(null);

  const callPhase = deriveCallPhase(twilioStatus, callState.callData);

  // Live analysis: subscribe by practice sim ID or real call conference name
  const liveCallId = isPractice
    ? (activeSimCallId ? `sim-${activeSimCallId}` : null)
    : callState.callData?.conferenceName || null;
  const liveAnalysis = useLiveAnalysis(liveCallId, callPhase === 'active' || !!activeSimCallId);

  // Find current user's practice stats from the leaderboard
  const myPracticeStats = practiceBoard.data?.leaderboard?.find(e => e.identity === identity);

  function handleBack() {
    navigate('/');
  }

  async function handleCallNow() {
    if (twilioStatus !== 'ready' || !data?.identity) return;
    const contact = {
      id: data.identity.hubspotContactId || id,
      properties: {
        firstname: data.identity.name?.split(' ')[0] || '',
        lastname: data.identity.name?.split(' ').slice(1).join(' ') || '',
        phone: data.identity.phone,
        company: data.identity.company,
      },
    };
    try {
      await callState.startCall(contact, identity);
    } catch (err) {
      alert('Call failed: ' + err.message);
    }
  }

  function handleEndCall() {
    callState.endCurrentCall();
  }

  function handleSaveNext() {
    navigate('/complete');
  }

  function handleScoreComplete() {
    setHistoryKey(k => k + 1);
    practiceBoard.refresh();
  }

  const d = data || {};

  return (
    <div
      data-theme={theme}
      className="flex flex-col h-full transition-colors duration-300 bg-cp-bg text-cp-text"
    >
      <CockpitHeader
        callPhase={callPhase}
        timer={callState.elapsed}
        onThemeToggle={toggle}
        theme={theme}
        onBack={handleBack}
        onRefresh={refresh}
        refreshing={refreshing}
        leaderboard={scoreboard.data?.leaderboard}
        currentUser={identity}
        isPractice={isPractice}
        practiceStats={myPracticeStats}
      />

      {loading ? (
        <Skeleton />
      ) : error ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 p-4">
          <p style={{ color: 'var(--cockpit-red-text)' }}>{error}</p>
          <button onClick={handleBack} style={{ color: 'var(--cockpit-blue-500)' }}>
            &larr; Back to contacts
          </button>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-4 px-5 py-4">
              {/* Left column — Rapport */}
              <div className="min-w-0">
                <ContactIdentity identity={d.identity} />
                <RapportOpener openingLine={d.rapport?.opening_line} />
                <RapportTags tags={d.rapport?.rapport_starters} />
                <IntelNuggets
                  nuggets={d.rapport?.intel_nuggets}
                  watchOuts={d.rapport?.watch_outs}
                />
                <ProductReference productReference={d.rapport?.product_reference} />
                <LiveAnalysis data={liveAnalysis} active={callPhase === 'active' || !!activeSimCallId} />
              </div>

              {/* Right column — Timeline + Business */}
              <div className="min-w-0">
                <InteractionTimeline
                  interactionHistory={d.interactionHistory}
                  priorCalls={d.priorCalls}
                />
                <QualScript adaptedScript={d.rapport?.adapted_script} />
                <CompanyIntel
                  companyData={d.companyData}
                  icpScore={d.icpScore}
                  pipelineData={d.pipelineData}
                />
              </div>
            </div>

            {/* Practice history (below the grid, inside scrollable area) */}
            {isPractice && (
              <PracticeHistory identity={identity} refreshKey={historyKey} />
            )}
          </div>

          {/* Bottom bar: practice button or real call controls */}
          {isPractice ? (
            <div
              className="sticky bottom-0 z-10 flex items-center justify-center px-4 py-3 shrink-0 transition-colors duration-300"
              style={{
                background: 'var(--cockpit-footer-bg)',
                borderTop: '1px solid var(--cockpit-card-border)',
              }}
            >
              <PracticeCallButton
                identity={identity}
                onScoreComplete={handleScoreComplete}
                onCallStart={(simId) => setActiveSimCallId(simId)}
                onCallEnd={() => setActiveSimCallId(null)}
              />
            </div>
          ) : (
            <CallControls
              callPhase={callPhase}
              timer={callState.elapsed}
              onCallNow={handleCallNow}
              onEndCall={handleEndCall}
              onSaveNext={handleSaveNext}
              disabled={twilioStatus !== 'ready'}
            />
          )}
        </>
      )}
    </div>
  );
}
