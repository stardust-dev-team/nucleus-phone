import { useState, useEffect, useRef } from 'react';
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
import SignalBadges from '../components/cockpit/SignalBadges';
import EmailEngagement from '../components/cockpit/EmailEngagement';
import CareerContext from '../components/cockpit/CareerContext';
import CompanyVernacular from '../components/cockpit/CompanyVernacular';
import DataSourceIndicator from '../components/ui/DataSourceIndicator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
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

const SCORE_COLORS = {
  amber:  { bg: 'var(--cockpit-amber-50)', text: 'var(--cockpit-amber-600)', border: 'var(--cockpit-amber-100)' },
  blue:   { bg: 'var(--cockpit-blue-50)', text: 'var(--cockpit-blue-500)', border: 'var(--cockpit-blue-border)' },
  green:  { bg: 'var(--cockpit-green-50)', text: 'var(--cockpit-green-500)', border: 'var(--cockpit-green-500-20)' },
  orange: { bg: 'var(--cockpit-orange-50)', text: 'var(--cockpit-orange-500)', border: 'var(--cockpit-orange-50)' },
  purple: { bg: 'var(--cockpit-purple-50)', text: 'var(--cockpit-purple-500)', border: 'var(--cockpit-purple-border)' },
};

function ScoreSection({ label, weight, color, children }) {
  const c = SCORE_COLORS[color] || SCORE_COLORS.blue;
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span
          className="inline-flex items-center px-2 py-[2px] rounded text-[10px] font-bold uppercase tracking-wider"
          style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}` }}
        >
          {label}
        </span>
        <span className="text-[10px] font-semibold" style={{ color: c.text }}>{weight}</span>
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

function RealCallLayout({ d, callPhase, liveAnalysis, liveCallId }) {
  const [tab, setTab] = useState('briefing');
  const [userOverride, setUserOverride] = useState(false);
  const prevPhaseRef = useRef(callPhase);

  // Auto-switch tabs based on call phase — suppressed if user manually changed tab
  useEffect(() => {
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = callPhase;

    // Reset override when returning to pre-call after post-call completes
    if (callPhase === 'pre' && prevPhase === 'post') {
      setUserOverride(false);
    }

    if (userOverride) return;
    if (callPhase === 'active') setTab('live');
    else setTab('briefing');
  }, [callPhase, userOverride]);

  function handleTabChange(value) {
    setTab(value);
    setUserOverride(true);
  }

  return (
    <>
      {/* Contact identity + signal badges — always visible above tabs */}
      <div className="px-5 pt-3 pb-1">
        <ContactIdentity identity={d.identity} />
        <div className="flex items-center justify-between">
          <SignalBadges signalMetadata={d.signalMetadata} domain={d.icpScore?.domain} />
          <DataSourceIndicator sources={dataSources(d)} />
        </div>
      </div>

      <Tabs value={tab} onValueChange={handleTabChange} className="flex-1 flex flex-col min-h-0">
        <div className="px-5">
          <TabsList>
            <TabsTrigger value="briefing">Briefing</TabsTrigger>
            <TabsTrigger value="company">Company</TabsTrigger>
            <TabsTrigger value="live">Live</TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
          {/* ── Tab 1: Briefing (pre-call intelligence) ── */}
          <TabsContent value="briefing">
            <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-4">
              <div className="min-w-0">
                <RapportOpener openingLine={d.rapport?.opening_line} />
                <RapportTags tags={d.rapport?.rapport_starters} />
                <IntelNuggets nuggets={d.rapport?.intel_nuggets} watchOuts={d.rapport?.watch_outs} />
                <ProductReference productReference={d.rapport?.product_reference} />
              </div>
              <div className="min-w-0">
                <CareerContext pbContactData={d.identity?.pbContactData} />
                <InteractionTimeline interactionHistory={d.interactionHistory} priorCalls={d.priorCalls} />
                <EmailEngagement emailEngagement={d.emailEngagement} />
              </div>
            </div>
          </TabsContent>

          {/* ── Tab 2: Company (company-level intelligence) ── */}
          <TabsContent value="company">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-4">
              <div className="min-w-0">
                <CompanyVernacular vernacular={d.companyVernacular} />
                <CompanyIntel
                  companyData={d.companyData}
                  icpScore={d.icpScore}
                  pipelineData={d.pipelineData}
                  signalMetadata={d.signalMetadata}
                  pbContactData={d.identity?.pbContactData}
                />
              </div>
              <div className="min-w-0">
                <InteractionTimeline interactionHistory={d.interactionHistory} priorCalls={d.priorCalls} />
                <EmailEngagement emailEngagement={d.emailEngagement} />
              </div>
            </div>
          </TabsContent>

          {/* ── Tab 3: Live (during-call tools) ── */}
          <TabsContent value="live">
            <LiveAnalysis data={liveAnalysis} active={callPhase === 'active'} contact={d.identity} callId={liveCallId} />
            <QualScript adaptedScript={d.rapport?.adapted_script} />
          </TabsContent>
        </div>
      </Tabs>
    </>
  );
}

export default function Cockpit({ identity, callState, twilioStatus, forcedId }) {
  const params = useParams();
  const id = forcedId || params.id;
  const navigate = useNavigate();
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
                </div>

                {/* Bridge layout: 3-column with viewscreen center */}
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr_1fr] gap-3 px-5 pb-3" style={{ minHeight: '320px' }}>

                  {/* Left stations — Rapport + Discovery */}
                  <div className="min-w-0 flex flex-col gap-0">
                    <ScoreSection label="Rapport" weight="20%" color="amber">
                      <RapportOpener openingLine={d.rapport?.opening_line} />
                      <RapportTags tags={d.rapport?.rapport_starters} />
                    </ScoreSection>
                    <ScoreSection label="Discovery" weight="25%" color="blue">
                      <QualScript adaptedScript={d.rapport?.adapted_script} />
                      <IntelNuggets nuggets={d.rapport?.intel_nuggets} />
                    </ScoreSection>
                    <CareerContext pbContactData={d.identity?.pbContactData} />
                  </div>

                  {/* CENTER — Main Viewscreen */}
                  <div className="min-w-0 flex flex-col">
                    <LiveAnalysis data={liveAnalysis} active={!!activeSimCallId} contact={d.identity} callId={liveCallId} />
                  </div>

                  {/* Right stations — Objections + Product */}
                  <div className="min-w-0 flex flex-col gap-0">
                    <ScoreSection label="Objection Handling" weight="25%" color="orange">
                      <IntelNuggets watchOuts={d.rapport?.watch_outs} />
                    </ScoreSection>
                    <ScoreSection label="Product & Close" weight="30%" color="green">
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
            />
          )}
        </>
      )}
    </div>
  );
}
