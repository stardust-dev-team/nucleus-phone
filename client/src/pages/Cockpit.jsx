import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
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
import LastCallCard from '../components/cockpit/LastCallCard';
import QualScript from '../components/cockpit/QualScript';
import CompanyIntel from '../components/cockpit/CompanyIntel';
import ProductReference from '../components/cockpit/ProductReference';
import LiveAnalysis from '../components/cockpit/LiveAnalysis';
import CallControls from '../components/cockpit/CallControls';
import PracticeCallButton from '../components/cockpit/PracticeCallButton';
import PracticeHistory from '../components/cockpit/PracticeHistory';
import SignalBadges from '../components/cockpit/SignalBadges';
import EmailEngagement from '../components/cockpit/EmailEngagement';
import CareerContext from '../components/cockpit/CareerContext';
import CompanyVernacular from '../components/cockpit/CompanyVernacular';
import DataSourceIndicator from '../components/ui/DataSourceIndicator';
import useLiveAnalysis from '../hooks/useLiveAnalysis';
import TestScenarioButton from '../components/cockpit/TestScenarioButton';

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

const SCORE_COLORS = {
  amber:  { bg: 'var(--cockpit-amber-50)', text: 'var(--cockpit-amber-600)', border: 'var(--cockpit-amber-100)' },
  blue:   { bg: 'var(--cockpit-blue-50)', text: 'var(--cockpit-blue-500)', border: 'var(--cockpit-blue-border)' },
  green:  { bg: 'var(--cockpit-green-50)', text: 'var(--cockpit-green-500)', border: 'var(--cockpit-green-500-20)' },
  orange: { bg: 'var(--cockpit-orange-50)', text: 'var(--cockpit-orange-500)', border: 'var(--cockpit-orange-50)' },
  purple: { bg: 'var(--cockpit-purple-50)', text: 'var(--cockpit-purple-500)', border: 'var(--cockpit-purple-border)' },
};

function ScoreSection({ label, weight, color, isPractice, children }) {
  const c = SCORE_COLORS[color] || SCORE_COLORS.blue;
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span
          className="inline-flex items-center px-2 py-[2px] rounded cp-label"
          style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}` }}
        >
          {label}
        </span>
        {isPractice && <span className="cp-detail font-semibold" style={{ color: c.text }}>{weight}</span>}
        <div className="flex-1 h-px" style={{ background: c.border }} />
      </div>
      {children}
    </div>
  );
}

function dataSources(d) {
  return {
    pb: !!d.identity?.pbContactData,
    signal: !!d.signalMetadata,
    hubspot: !!d.companyData,
    email: !!(d.emailEngagement?.length),
    calls: !!(d.priorCalls?.length),
  };
}

function isTestCompany(d) {
  const company = (d.identity?.company || '').toLowerCase();
  return company.includes('joruva');
}

function RealCallLayout({ d, callPhase, liveAnalysis, liveCallId, testCallId, onTestCallId, confParam }) {
  return (
    <>
      {/* Contact identity + signal context — ship status bar */}
      <div className="px-5 pt-3 pb-1">
        <ContactIdentity identity={d.identity} />
        <div className="flex items-center justify-between">
          <SignalBadges signalMetadata={d.signalMetadata} domain={d.icpScore?.domain} />
          <DataSourceIndicator sources={dataSources(d)} />
        </div>
        <LastCallCard priorCalls={d.priorCalls} />
      </div>

      {/* Bridge layout: 3-column — fills remaining viewport, no scroll */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr_1fr] gap-3 px-5 pb-3" style={{ height: 'calc(100vh - 180px)' }}>

        {/* Left — Rapport + Career + Discovery + Intel (scrollable) */}
        <div className="min-w-0 flex flex-col gap-0 overflow-y-auto">
          <ScoreSection label="Rapport" weight="20%" color="amber">
            <RapportOpener openingLine={d.rapport?.opening_line} />
            <RapportTags tags={d.rapport?.rapport_starters} />
          </ScoreSection>
          <CareerContext pbContactData={d.identity?.pbContactData} />
          <ScoreSection label="Discovery" weight="25%" color="blue">
            <IntelNuggets nuggets={d.rapport?.intel_nuggets} />
          </ScoreSection>
          <EmailEngagement emailEngagement={d.emailEngagement} />
        </div>

        {/* CENTER — Viewscreen fills height, Company Intel anchored to bottom */}
        <div className="min-w-0 flex flex-col">
          <div className="cockpit-viewscreen">
            <LiveAnalysis data={liveAnalysis} active={callPhase === 'active' || !!testCallId || !!confParam} contact={d.identity} callId={liveCallId} isPractice={false} />
          </div>
          {isTestCompany(d) && (
            <div className="flex items-center gap-2 mt-1">
              <TestScenarioButton onCallIdReady={onTestCallId} />
              {testCallId && (
                <button
                  onClick={() => onTestCallId(null)}
                  className="text-[11px] px-2 py-1 rounded"
                  style={{ color: 'var(--cockpit-text-muted)', background: 'var(--cockpit-card)', border: '1px solid var(--cockpit-card-border)' }}
                >
                  Reset
                </button>
              )}
            </div>
          )}
          <div className="mt-auto">
            <CompanyVernacular vernacular={d.companyVernacular} />
            <CompanyIntel
              companyData={d.companyData}
              icpScore={d.icpScore}
              pipelineData={d.pipelineData}
              signalMetadata={d.signalMetadata}
              pbContactData={d.identity?.pbContactData}
            />
          </div>
        </div>

        {/* Right — Objections + Qual Script + Product + Timeline (scrollable) */}
        <div className="min-w-0 flex flex-col gap-0 overflow-y-auto">
          <ScoreSection label="Objection Handling" weight="25%" color="orange">
            <IntelNuggets watchOuts={d.rapport?.watch_outs} />
          </ScoreSection>
          <QualScript adaptedScript={d.rapport?.adapted_script} />
          <ScoreSection label="Product & Close" weight="30%" color="green">
            <ProductReference productReference={d.rapport?.product_reference} />
          </ScoreSection>
          <InteractionTimeline interactionHistory={d.interactionHistory} priorCalls={d.priorCalls} />
        </div>
      </div>
    </>
  );
}

export default function Cockpit({ identity, callState, twilioStatus, forcedId, onSendDigits, onToggleMute, muted }) {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const id = forcedId || params.id;
  const navigate = useNavigate();
  const confParam = searchParams.get('conf');
  const isPractice = id?.startsWith(SIM_ID_PREFIX);
  const [practiceDifficulty, setPracticeDifficulty] = useState(null);
  const { data, loading, error, refreshing, refresh } = useCockpit(id, {
    difficulty: isPractice ? practiceDifficulty : undefined,
  });
  const { theme, toggle } = useCockpitTheme();
  const scoreboard = useScoreboard();
  const practiceBoard = usePracticeScoreboard(isPractice);
  const [historyKey, setHistoryKey] = useState(0);
  const [activeSimCallId, setActiveSimCallId] = useState(null);
  const [testCallId, setTestCallId] = useState(null);

  const callPhase = deriveCallPhase(twilioStatus, callState.callData);

  // Live analysis: subscribe by test scenario, practice sim ID, conf query param (inbound deep link), or real call conference name
  const liveCallId = testCallId
    || (isPractice
      ? (activeSimCallId ? `sim-${activeSimCallId}` : null)
      : confParam || callState.callData?.conferenceName || null);
  const liveAnalysis = useLiveAnalysis(liveCallId, !!testCallId || callPhase === 'active' || !!activeSimCallId || !!confParam);

  // Clear conf search param when observed conference ends (WebSocket disconnects after being connected)
  const wasConnected = useRef(false);
  useEffect(() => {
    if (liveAnalysis.connected) wasConnected.current = true;
    else if (wasConnected.current && confParam) {
      wasConnected.current = false;
      setSearchParams(prev => { prev.delete('conf'); return prev; }, { replace: true });
    }
  }, [liveAnalysis.connected, confParam, setSearchParams]);

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
            {isPractice ? (
              /* ── Practice layout: Bridge — viewscreen center, stations flanking ── */
              <>
                {/* Contact identity + signal context — ship status bar */}
                <div className="px-5 pt-3 pb-1">
                  <ContactIdentity identity={d.identity} />
                  <SignalBadges
                    signalMetadata={d.signalMetadata}
                    domain={d.icpScore?.domain}
                  />
                  <LastCallCard priorCalls={d.priorCalls} />
                </div>

                {/* Bridge layout: 3-column with viewscreen center */}
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr_1fr] gap-3 px-5 pb-3">

                  {/* Left — Rapport + Career + Discovery + Intel */}
                  <div className="min-w-0 flex flex-col gap-0">
                    <ScoreSection label="Rapport" weight="20%" color="amber" isPractice>
                      <RapportOpener openingLine={d.rapport?.opening_line} />
                      <RapportTags tags={d.rapport?.rapport_starters} />
                    </ScoreSection>
                    <CareerContext pbContactData={d.identity?.pbContactData} />
                    <ScoreSection label="Discovery" weight="25%" color="blue" isPractice>
                      <IntelNuggets nuggets={d.rapport?.intel_nuggets} />
                    </ScoreSection>
                  </div>

                  {/* CENTER — Viewscreen */}
                  <div className="min-w-0 flex flex-col">
                    <div className="cockpit-viewscreen">
                      <LiveAnalysis data={liveAnalysis} active={!!activeSimCallId} contact={d.identity} callId={liveCallId} />
                    </div>
                  </div>

                  {/* Right — Objections + Qual Script + Product */}
                  <div className="min-w-0 flex flex-col gap-0">
                    <ScoreSection label="Objection Handling" weight="25%" color="orange" isPractice>
                      <IntelNuggets watchOuts={d.rapport?.watch_outs} />
                    </ScoreSection>
                    <QualScript adaptedScript={d.rapport?.adapted_script} />
                    <ScoreSection label="Product & Close" weight="30%" color="green" isPractice>
                      <ProductReference productReference={d.rapport?.product_reference} />
                    </ScoreSection>
                  </div>
                </div>

                <PracticeHistory identity={identity} refreshKey={historyKey} />
              </>
            ) : (
              /* ── Real call layout: tabbed interface ── */
              <RealCallLayout
                d={d}
                callPhase={callPhase}
                liveAnalysis={liveAnalysis}
                liveCallId={liveCallId}
                testCallId={testCallId}
                onTestCallId={setTestCallId}
                confParam={confParam}
              />
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
                onDifficultySelect={setPracticeDifficulty}
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
              onSendDigits={onSendDigits}
              onToggleMute={onToggleMute}
              muted={muted}
            />
          )}
        </>
      )}
    </div>
  );
}
